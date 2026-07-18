#!/usr/bin/env node
/**
 * Deployed-session api check (WS1) — runs against the LIVE Railway server over the real MCP
 * HTTP transport (not a mock). Verifies the parked-role fix end-to-end:
 *   - a conductor (role active) holding wait_for_reply is NOT bounced by a parked peer past GRACE
 *   - a third instance's message wakes the conductor
 *
 * Manual/integration test (~45s, hits prod, needs CROSS_CLAUDE_API_KEY). Not in `npm test`.
 * Run: CROSS_CLAUDE_API_KEY=... node test-deployed-topology.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const KEY = process.env.CROSS_CLAUDE_API_KEY;
const URL_BASE = process.env.CROSS_CLAUDE_URL || "https://cross-claude-mcp-production.up.railway.app";
if (!KEY) { console.log("SKIP: CROSS_CLAUDE_API_KEY not set."); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.log(`  ✗ ${m}`); } };

async function connect(name) {
  const t = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } });
  const c = new Client({ name, version: "0" }, { capabilities: {} });
  await c.connect(t);
  return c;
}
const text = (r) => r.content?.[0]?.text || "";

const chan = `dep-topo-${Math.random().toString(36).slice(2, 8)}`;
const conductor = `zzz-conductor-${Math.random().toString(36).slice(2, 6)}`;
const worker = `aaa-worker-${Math.random().toString(36).slice(2, 6)}`;
const third = `mmm-third-${Math.random().toString(36).slice(2, 6)}`;

const cC = await connect("conductor");
const cW = await connect("worker");
const cT = await connect("third");

try {
  await cC.callTool({ name: "register", arguments: { instance_id: conductor } });
  await cW.callTool({ name: "register", arguments: { instance_id: worker } });
  await cT.callTool({ name: "register", arguments: { instance_id: third } });
  await cC.callTool({ name: "create_channel", arguments: { name: chan, description: "deployed topology test" } });

  // Baseline: send one message so both waiters anchor above it.
  const seed = await cT.callTool({ name: "send_message", arguments: { channel: chan, sender: third, content: "seed", message_type: "message" } });
  const baseId = parseInt((text(seed).match(/Message #(\d+)/) || [])[1] || "0", 10);

  // Worker parks first (role=parked), long ceiling; do not await.
  const pW = cW.callTool({ name: "wait_for_reply", arguments: { channel: chan, after_id: baseId, instance_id: worker, timeout_seconds: 90, poll_interval_seconds: 5, persistent: true, max_wait_minutes: 3, role: "parked" } });
  await sleep(2000);

  // Conductor waits active; do not await. GRACE on prod is 30s, so hold long enough to expose a wrong yield.
  const pC = cC.callTool({ name: "wait_for_reply", arguments: { channel: chan, after_id: baseId, instance_id: conductor, timeout_seconds: 120, poll_interval_seconds: 5, persistent: true, max_wait_minutes: 3, role: "active" } });

  // Wait past GRACE (30s) — if the parked peer wrongly counted, the conductor would yield here.
  await sleep(38000);

  // Third instance sends a real message; the conductor's wait must return it.
  await cT.callTool({ name: "send_message", arguments: { channel: chan, sender: third, content: "WAKE-CONDUCTOR", message_type: "message" } });

  const rC = await pC;
  const tC = text(rC);
  ok(!tC.includes("MUTUAL WAIT"), "conductor did NOT yield to the parked peer (no MUTUAL WAIT)");
  ok(tC.includes("WAKE-CONDUCTOR"), "conductor was woken by the third instance's message");

  // Clean up the parked waiter by superseding it with a one-shot.
  await cW.callTool({ name: "wait_for_reply", arguments: { channel: chan, after_id: 1e9, instance_id: worker, timeout_seconds: 1, poll_interval_seconds: 1, persistent: false, max_wait_minutes: 1, role: "parked" } }).catch(() => {});
  await pW.catch(() => {});
} catch (err) {
  failed++;
  console.error(`  ERROR: ${err.message}`);
} finally {
  await Promise.allSettled([cC.close(), cW.close(), cT.close()]);
}

console.log(`\n${"=".repeat(50)}\nDeployed topology — passed: ${passed}, failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
