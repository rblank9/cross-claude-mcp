#!/usr/bin/env node
/**
 * End-to-end consumer-path test for the channel-less bridge (WS3).
 * Spawns bridge/cross-claude-bridge.mjs as a real MCP stdio server, drives it as a client would,
 * and asserts live push works: listen_live → a REST message → a notifications/claude/channel push.
 *
 * Requires CROSS_CLAUDE_API_KEY (and optional CROSS_CLAUDE_URL) in the environment.
 * Skips (exit 0) if no key is set, so the offline suite still passes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const KEY = process.env.CROSS_CLAUDE_API_KEY;
const URL_BASE = process.env.CROSS_CLAUDE_URL || "https://cross-claude-mcp-production.up.railway.app";
if (!KEY) {
  console.log("SKIP test-bridge: CROSS_CLAUDE_API_KEY not set (needs the live server).");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, "bridge", "cross-claude-bridge.mjs");
const channel = `bridge-test-${Math.random().toString(36).slice(2, 8)}`;
const sender = `bridge-tester-${Math.random().toString(36).slice(2, 6)}`;

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.log(`  ✗ ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path, opts = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...opts,
    headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json", ...opts.headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.json();
}

const pushed = [];
const transport = new StdioClientTransport({
  command: "node",
  args: [bridgePath],
  env: { CROSS_CLAUDE_API_KEY: KEY, CROSS_CLAUDE_URL: URL_BASE, BRIDGE_POLL_MS: "2000", PATH: process.env.PATH },
});
const client = new Client({ name: "bridge-test", version: "0.0.0" }, { capabilities: {} });
client.fallbackNotificationHandler = async (n) => {
  if (n.method === "notifications/claude/channel") pushed.push(n.params);
};

try {
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  ok(tools.includes("listen_live") && tools.includes("stop_listening") && tools.includes("delivery_status"),
    `bridge exposes listen_live / stop_listening / delivery_status (got: ${tools.join(", ")})`);

  // Idle status before listening.
  const s0 = await client.callTool({ name: "delivery_status", arguments: {} });
  ok(/no channels are live-pushing/i.test(s0.content[0].text), "delivery_status reports idle before any listen_live");

  // Turn on live push for a fresh channel.
  const r1 = await client.callTool({ name: "listen_live", arguments: { channel } });
  ok(/Live push ON/i.test(r1.content[0].text), `listen_live turns on push for #${channel}`);

  // Status now lists the channel.
  const s1 = await client.callTool({ name: "delivery_status", arguments: {} });
  ok(s1.content[0].text.includes(`#${channel}`) && /live push ON/i.test(s1.content[0].text),
    "delivery_status lists the live channel");

  // Post a message via REST; expect it pushed into the session.
  const body = `hello-${Math.random().toString(36).slice(2, 8)}`;
  await rest("/api/messages", { method: "POST", body: JSON.stringify({ channel, sender, content: body, message_type: "message" }) });

  // Wait up to ~8s (poll is 2s) for the push.
  for (let i = 0; i < 16 && !pushed.some((p) => p.content?.includes(body)); i++) await sleep(500);
  ok(pushed.some((p) => p.content?.includes(body) && p.meta?.channel === channel),
    `a REST message was delivered as a notifications/claude/channel push (got ${pushed.length} push(es))`);

  // Stop listening.
  const r2 = await client.callTool({ name: "stop_listening", arguments: { channel } });
  ok(/Live push OFF/i.test(r2.content[0].text), "stop_listening turns off push");
  const s2 = await client.callTool({ name: "delivery_status", arguments: {} });
  ok(/no channels are live-pushing/i.test(s2.content[0].text), "delivery_status reports idle again after stop_listening");
} catch (err) {
  failed++;
  console.error(`  ERROR: ${err.message}\n${err.stack}`);
} finally {
  try { await client.close(); } catch { /* ignore */ }
}

console.log(`\n${"=".repeat(50)}\nBridge tests passed: ${passed}\nBridge tests failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
