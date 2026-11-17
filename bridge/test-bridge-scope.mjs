// End-to-end: the REAL bridge against a fake server that 403s out-of-scope channels (as rest-api.mjs does).
// Bug (2026-11-17 teammate calls): listen_live on an out-of-scope channel returned a false "Live push ON",
// and the bridge kept reconnecting /api/stream WITH that channel; the server 403s the whole stream, so ALL push died.
// Case 2 is the positive control. Drafted by local-runner (delegate code), reviewed and placed inline.
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureIdentity, writeTrusted } from "./trust.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.BRIDGE_UNDER_TEST || join(__dirname, "cross-claude-bridge.mjs");

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEMP_HOME = mkdtempSync(join(tmpdir(), "bridge-scope-"));
const CFG_DIR = join(TEMP_HOME, ".config", "cross-claude");
const STATE_DIR = join(TEMP_HOME, ".local", "state", "cross-claude");
const ENV = {
  CROSS_CLAUDE_CONFIG_DIR: CFG_DIR,
  CROSS_CLAUDE_STATE_DIR: STATE_DIR
};

let client = null;
let server = null;
let hbInterval = null;
const openStreams = [];
const streamReqs = [];
const outOfScope = new Set(["general"]);

const timer = setTimeout(() => {
  console.log("FAIL: timeout");
  process.exit(1);
}, 60000);
timer.unref();

async function main() {
  mkdirSync(CFG_DIR, {recursive:true});
  mkdirSync(STATE_DIR, {recursive:true});

  const me = ensureIdentity("me-box", { env: ENV, home: TEMP_HOME });
  writeTrusted({ "me-box": me.pub }, ENV, TEMP_HOME);

  const port = await new Promise((resolve) => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://x");
      if (req.method === "POST" && url.pathname === "/api/register") {
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({ok:true}));
      } else if (req.method === "GET" && url.pathname === "/api/instances") {
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({instances:[]}));
      } else if (req.method === "GET" && url.pathname.startsWith("/api/messages/")) {
        const channel = decodeURIComponent(url.pathname.split("/").pop());
        if (outOfScope.has(channel)) {
          res.writeHead(403, {"Content-Type": "application/json"});
          res.end(JSON.stringify({error:"out_of_scope"}));
        } else {
          res.writeHead(200, {"Content-Type": "application/json"});
          res.end(JSON.stringify({messages:[], last_id:0}));
        }
      } else if (req.method === "GET" && url.pathname === "/api/stream") {
        const channels = (url.searchParams.get("channels") || "").split(",").filter(Boolean);
        streamReqs.push(channels);
        if (channels.some(c => outOfScope.has(c))) {
          res.writeHead(403, {"Content-Type": "application/json"});
          res.end(JSON.stringify({error:"out_of_scope"}));
        } else {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          });
          res.write("event: ready\ndata: {}\n\n");
          openStreams.push(res);
          req.on("close", () => {
            const idx = openStreams.indexOf(res);
            if (idx !== -1) openStreams.splice(idx, 1);
          });
        }
      } else {
        res.writeHead(404, {"Content-Type": "application/json"});
        res.end(JSON.stringify({error:"nf"}));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });

  hbInterval = setInterval(() => {
    for (const res of openStreams) {
      try {
        res.write(": hb\n\n");
      } catch {}
    }
  }, 2000);

  const transport = new StdioClientTransport({
    command: "node",
    args: [BRIDGE],
    cwd: TEMP_HOME,
    stderr: "pipe",
    env: {
      CROSS_CLAUDE_URL: `http://127.0.0.1:${port}`,
      CROSS_CLAUDE_API_KEY: "dummy-test-key",
      BRIDGE_INSTANCE: "scope-box",
      BRIDGE_IDENTITY: "me-box",
      ...ENV,
      HOME: TEMP_HOME,
      PATH: process.env.PATH
    }
  });

  client = new Client({name:"scope-test",version:"1.0.0"},{capabilities:{}});
  await client.connect(transport);
  await sleep(800);

  // 1. listen_live on out-of-scope channel is refused up front
  console.log("1. listen_live on out-of-scope channel is refused up front");
  let t = await call("listen_live", {channel:"general"});
  assert(!t.includes("Live push ON"), `no false ON (got: ${t.slice(0,100)})`);
  assert(/refused|out of scope|out_of_scope/i.test(t), "reply says refused/out of scope");
  await sleep(1500);
  assert(!streamReqs.some(c => c.includes("general")), "no /api/stream request ever included #general");
  let ds = await call("delivery_status");
  assert(!/•\s*#general\b/.test(ds), "delivery_status does not list #general as live");

  // 2. positive control: in-scope channel
  console.log("2. positive control: in-scope channel");
  t = await call("listen_live", {channel:"team-syb"});
  assert(t.includes("Live push ON"), `listen_live accepted (got: ${t.slice(0,100)})`);
  assert(await waitFor(() => streamReqs.some(c => c.includes("team-syb")), 5000), "stream opened with #team-syb");
  ds = await call("delivery_status");
  assert(ds.includes("connected: true"), "connected: true");

  // 3. scope revoked mid-session: stream 403 drops only the refused channel
  console.log("3. scope revoked mid-session: stream 403 drops only the refused channel");
  t = await call("listen_live", {channel:"flip"});
  assert(t.includes("Live push ON"), "flip accepted while in scope");
  assert(await waitFor(() => streamReqs.some(c => c.includes("flip")), 5000), "stream opened with #flip");
  outOfScope.add("flip");

  const before = streamReqs.length;
  for (const res of openStreams) {
    try {
      res.end();
    } catch {}
  }
  openStreams.splice(0);

  assert(await waitFor(() => streamReqs.slice(before).some(c => c.includes("team-syb") && !c.includes("flip")), 15000), "bridge reconnected with #team-syb and without #flip");
  await sleep(4000);
  const n403 = streamReqs.slice(before).filter(c => c.includes("flip")).length;
  assert(n403 <= 1, `at most one stream attempt with #flip after revocation (got ${n403})`);
  ds = await call("delivery_status");
  assert(ds.includes("connected: true"), "connected: true after drop");
  assert(!/•\s*#flip\b/.test(ds), "#flip no longer listed as live");
  assert(/flip/.test(ds) && /refused|out of scope|out_of_scope/i.test(ds), "delivery_status reports #flip as refused");

  // 4. static: no false-ON path
  console.log("4. static: scope handling wired on every path that touches a channel");
  const src = readFileSync(BRIDGE, "utf8");
  // Definitions are `const x = (...) =>`, so every `x(` is a call site.
  const calls = (name) => (src.match(new RegExp(`${name}\\(`, "g")) || []).length;
  assert(calls("probeScope") >= 2, `probeScope( called ${calls("probeScope")} times (listen_live + stream-403 prune)`);
  assert(calls("refuseChannel") >= 3, `refuseChannel( called ${calls("refuseChannel")} times (initCursor + poll + prune)`);

  function call(name, args={}) {
    return client.callTool({name, arguments: args}).then(r => r.content?.[0]?.text ?? "").catch(e => `callTool error: ${e.message}`);
  }

  function waitFor(pred, ms) {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (pred()) {
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() - start > ms) {
          clearInterval(interval);
          resolve(false);
        }
      }, 100);
    });
  }
}

try {
  await main();
} catch (e) {
  console.log(`FAIL: exception ${e.message}`);
  failed++;
} finally {
  try { await client?.close(); } catch {}
  clearInterval(hbInterval);
  for (const res of openStreams) {
    try { res.end(); } catch {}
  }
  server?.close();
  rmSync(TEMP_HOME, {recursive:true, force:true});
  console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} assertions)`);
  process.exit(failed || passed === 0 ? 1 : 0);
}
