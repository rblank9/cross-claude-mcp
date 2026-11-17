// End-to-end: deterministic instance ids (security-guard A3, 2026-11-17), REAL bridge against a fake server.
//   unnamed session -> <project>-<login>-<host>; -2 only when a LIVE other session holds the base id;
//   the same session (its [session <id>] tag in the description) or an offline holder reuses the base;
//   BRIDGE_INSTANCE (teammates' fixed ids) is untouched. Case 5 is the positive control for the fixed path.
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.BRIDGE_UNDER_TEST || join(__dirname, "cross-claude-bridge.mjs");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
  if (cond) passed++;
  else failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEMP_HOME = mkdtempSync(join(tmpdir(), "bridge-instance-"));
const PROJECT = join(TEMP_HOME, "proj-a");
mkdirSync(PROJECT, { recursive: true });
const MY_TAG = `[session ${process.pid}]`; // no session file, so the bridge's session pid is its ppid: this process

// Fake server: /api/instances returns `rows`; /api/register records what the bridge claimed.
let rows = [];
const registered = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && url.pathname === "/api/instances") return json(200, { instances: rows });
    if (req.method === "POST" && url.pathname === "/api/register") {
      try {
        registered.push(JSON.parse(body));
      } catch {}
      return json(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/messages/")) return json(200, { messages: [], last_id: 0 });
    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: ready\ndata: {}\n\n");
      return; // held open; closed with the server
    }
    json(404, { error: "nf" });
  });
});
const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

async function runBridge(extraEnv = {}) {
  registered.length = 0;
  const transport = new StdioClientTransport({
    command: "node",
    args: [BRIDGE],
    cwd: PROJECT,
    stderr: "pipe",
    env: {
      CROSS_CLAUDE_URL: `http://127.0.0.1:${port}`,
      CROSS_CLAUDE_API_KEY: "dummy-test-key",
      CROSS_CLAUDE_CONFIG_DIR: join(TEMP_HOME, "cfg"),
      CROSS_CLAUDE_STATE_DIR: join(TEMP_HOME, "state"),
      CLAUDE_CONFIG_DIR: join(TEMP_HOME, ".claude-acct9"),
      HOME: TEMP_HOME,
      PATH: process.env.PATH,
      ...extraEnv,
    },
  });
  const client = new Client({ name: "instance-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await sleep(1200);
  const r = await client.callTool({ name: "whoami", arguments: {} });
  const text = r.content?.[0]?.text ?? "";
  const id = (text.match(/^instance_id: (.+)$/m) || [])[1] || "";
  const reg = [...registered];
  try {
    await client.close();
  } catch {}
  return { id, reg };
}

const timer = setTimeout(() => {
  console.log("FAIL: timeout");
  process.exit(1);
}, 90000);
timer.unref();

try {
  console.log("1. unnamed session, nothing registered: <project>-<login>-<host>");
  rows = [];
  const c1 = await runBridge();
  const base = c1.id;
  assert(base.startsWith("proj-a-claude-acct9-") && !/-\d+$/.test(base.slice("proj-a-claude-acct9-".length)), `deterministic base id (got ${base})`);
  assert(c1.reg.some((b) => b.instance_id === base && String(b.description).includes(MY_TAG)), "registered the base id with this session's tag");

  console.log("2. base held by ANOTHER live session: -2");
  rows = [{ instance_id: base, status: "online", description: "bridge v0.6.0 [session other-1]" }];
  const c2 = await runBridge();
  assert(c2.id === `${base}-2`, `picked ${base}-2 (got ${c2.id})`);

  console.log("3. base and -2 both live elsewhere: -3");
  rows = [
    { instance_id: base, status: "online", description: "[session other-1]" },
    { instance_id: `${base}-2`, status: "online", description: "[session other-2]" },
  ];
  const c3 = await runBridge();
  assert(c3.id === `${base}-3`, `picked ${base}-3 (got ${c3.id})`);

  console.log("4. base held by THIS session (restart) or offline: reuse base");
  rows = [{ instance_id: base, status: "online", description: `bridge v0.6.0 ${MY_TAG}` }];
  const c4a = await runBridge();
  assert(c4a.id === base, `same session reclaims base (got ${c4a.id})`);
  rows = [{ instance_id: base, status: "offline", description: "[session other-1]" }];
  const c4b = await runBridge();
  assert(c4b.id === base, `offline holder: base reused (got ${c4b.id})`);

  console.log("5. positive control: BRIDGE_INSTANCE (teammate fixed id) is untouched");
  rows = [{ instance_id: "vicky-pc", status: "online", description: "[session other-9]" }];
  const c5 = await runBridge({ BRIDGE_INSTANCE: "vicky-pc" });
  assert(c5.id === "vicky-pc", `fixed id kept even when listed online (got ${c5.id})`);
} catch (e) {
  console.log(`FAIL: exception ${e.message}`);
  failed++;
} finally {
  server.closeAllConnections?.();
  server.close();
  rmSync(TEMP_HOME, { recursive: true, force: true });
  console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} assertions)`);
  process.exit(failed || passed === 0 ? 1 : 0);
}
