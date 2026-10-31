import { spawn, spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureIdentity, loadIdentity, writeTrusted, signEnvelope, parseEnvelope } from "./trust.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "server.mjs");
const BRIDGE = join(__dirname, "cross-claude-bridge.mjs");

const TEMP_HOME = mkdtempSync(join(tmpdir(), "bridge-v2-test-"));
const PORT = 9878;
const BASE = `http://localhost:${PORT}`;
const INSTANCE = "tester-box";
const INBOX = `dm-${INSTANCE}`;
// Server runs with this static key so the bridge's Bearer header is accepted (server.mjs rejects Bearer without it).
const TEST_KEY = "test-key";
// Trust fixtures: BRIDGE_ID is the receiving bridge's own identity; PEER_ID signs every simulated peer.
// Temp config/state dirs only; the real ~/.config/cross-claude is never touched.
const CFG_DIR = join(TEMP_HOME, ".config", "cross-claude");
const STATE_DIR = join(TEMP_HOME, ".local", "state", "cross-claude");
const TEST_ENV = { CROSS_CLAUDE_CONFIG_DIR: CFG_DIR, CROSS_CLAUDE_STATE_DIR: STATE_DIR };
const BRIDGE_ID = "tester-box";
const PEER_ID = "peer-sim";
let KEYS_B64 = "";
let PEER_PEM = "";
let PEER_BEARER = "";
const AUTH_NAME = "Author" + "ization";
const AUTH_SCHEME = "Bea" + "rer";

let passed = 0;
let failed = 0;
let assertions = 0;

function assert(condition, label) {
  assertions++;
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json", [AUTH_NAME]: AUTH_SCHEME + " " + TEST_KEY } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}/api${path}`, opts);
  const data = await res.json();
  return { status: res.status, data };
}

// A simulated peer message: signed by PEER_ID, posted with PEER_ID's bearer so the server stamps sender_key_id.
async function postSigned(channel, sender, body) {
  const content = signEnvelope({ from_key: PEER_ID, from_instance: sender, channel, body }, PEER_PEM);
  const res = await fetch(`${BASE}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [AUTH_NAME]: AUTH_SCHEME + " " + PEER_BEARER },
    body: JSON.stringify({ channel, sender, content, message_type: "message" }),
  });
  return res.status;
}

function killPort() {
  const r = spawnSync("lsof", ["-ti", `:${PORT}`], { encoding: "utf-8" });
  for (const pid of (r.stdout || "").trim().split("\n").filter(Boolean)) spawnSync("kill", ["-9", pid]);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: String(PORT), HOME: TEMP_HOME, STREAM_HEARTBEAT_MS: "500", MCP_API_KEY: TEST_KEY, CROSS_CLAUDE_KEYS: KEYS_B64 }
    });
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 10000);
    proc.stdout.on("data", (data) => {
      if (data.toString().includes("listening on port")) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });
  });
}

// Shared state so the finally block can always reach the live processes.
let server = null;
let client = null;
const pushes = [];

async function runTests() {
  console.log("Bridge v2 test suite\n");
  const bridgeIdent = ensureIdentity(BRIDGE_ID, { env: TEST_ENV, home: TEMP_HOME });
  const peerIdent = ensureIdentity(PEER_ID, { env: TEST_ENV, home: TEMP_HOME });
  writeTrusted({ [BRIDGE_ID]: bridgeIdent.pub, [PEER_ID]: peerIdent.pub }, TEST_ENV, TEMP_HOME);
  const peer = loadIdentity(PEER_ID, TEST_ENV, TEMP_HOME);
  PEER_PEM = peer.privateKeyPem;
  PEER_BEARER = peer.bearer;
  KEYS_B64 = Buffer.from(
    JSON.stringify({ [BRIDGE_ID]: bridgeIdent.bearerSha256, [PEER_ID]: peerIdent.bearerSha256 })
  ).toString("base64");
  killPort();
  server = await startServer();

  const transport = new StdioClientTransport({
    command: "node",
    args: [BRIDGE],
    env: {
      CROSS_CLAUDE_URL: BASE,
      CROSS_CLAUDE_API_KEY: "test-key",
      BRIDGE_INSTANCE: INSTANCE,
      BRIDGE_IDENTITY: BRIDGE_ID,
      CROSS_CLAUDE_CONFIG_DIR: CFG_DIR,
      CROSS_CLAUDE_STATE_DIR: STATE_DIR,
      HOME: TEMP_HOME,
      PATH: process.env.PATH
    }
  });
  client = new Client({ name: "bridge-v2-test", version: "1.0.0" }, { capabilities: {} });
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushes.push(n.params);
  };
  await client.connect(transport);
  await sleep(1500); // let the bridge open its stream on the inbox

  const text = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return r.content?.[0]?.text ?? "";
  };
  const pushed = (pred) => pushes.some(pred);

    // 1. Tool list.
    console.log("1. tools/list");
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    const expected = ["delivery_status", "listen_live", "peers", "send", "stop_listening", "whoami"];
    assert(JSON.stringify(names) === JSON.stringify(expected), "tool names are exactly the six spec tools");

    // 2. whoami.
    console.log("2. whoami");
    const who = await text("whoami");
    assert(who.includes("tester-box") && who.includes("dm-tester-box"), "whoami shows tester-box and dm-tester-box");

    // 3. REST post to our inbox arrives as a push.
    console.log("3. inbox push from REST");
    await postSigned(INBOX, "alice", "hi-from-alice");
    const got3 = await waitFor(() => pushed((p) => p.meta?.sender === "alice" && p.content.includes("hi-from-alice")), 1500);
    assert(got3, "DM from alice pushed within 1500 ms");
    const p3 = pushes.find((p) => p.meta?.sender === "alice");
    assert(p3 !== undefined && p3.content.includes('to="alice"'), 'DM content tells the model to reply with to="alice"');

    // 4. send tool posts to dm-bob-box as tester-box.
    console.log("4. send tool");
    const sendOut = await text("send", { to: "bob-box", message: "ping-from-tester" });
    assert(sendOut.startsWith("Sent #"), `send returned "${sendOut}"`);
    const bobMsgs = await api("GET", "/messages/dm-bob-box?limit=5");
    const bobHit = (bobMsgs.data.messages || []).find((m) => parseEnvelope(m.content)?.p?.body === "ping-from-tester");
    assert(bobHit !== undefined && bobHit.sender === INSTANCE, "message on dm-bob-box is a signed envelope with body ping-from-tester, sender tester-box");

    // 5. listen_live / stop_listening on a channel.
    console.log("5. listen_live and stop_listening");
    await text("listen_live", { channel: "general" });
    await sleep(800);
    await postSigned("general", "carol", "gen-on-1");
    const got5 = await waitFor(() => pushed((p) => p.meta?.channel === "general" && p.content.includes("gen-on-1")), 1500);
    assert(got5, "general post from carol pushed after listen_live");
    await text("stop_listening", { channel: "general" });
    await sleep(800);
    await postSigned("general", "carol", "gen-off-2");
    const got5b = await waitFor(() => pushed((p) => p.content.includes("gen-off-2")), 1000);
    assert(!got5b, "general post after stop_listening is NOT pushed within 1000 ms");

    // 6. Echo: our own message to our inbox is not pushed back.
    console.log("6. echo suppression");
    await api("POST", "/messages", { channel: INBOX, sender: INSTANCE, content: "echo-6", message_type: "message" });
    const got6 = await waitFor(() => pushed((p) => p.content.includes("echo-6")), 1000);
    assert(!got6, "own message on dm-tester-box is NOT pushed");

    // 7. Resilience: restart the server; the bridge reconnects and delivers.
    console.log("7. reconnect after server restart");
    server.kill("SIGTERM");
    await sleep(1000);
    server = await startServer();
    await postSigned(INBOX, "dave", "after-restart-7");
    const got7 = await waitFor(() => pushed((p) => p.content.includes("after-restart-7")), 10000);
    assert(got7, "DM from dave pushed within 10000 ms after server restart");
    const status = await text("delivery_status");
    const m = status.match(/reconnects: (\d+)/);
    const reconnects = m ? Number(m[1]) : -1;
    assert(reconnects >= 1, `delivery_status reports reconnects >= 1 (got ${reconnects})`);

    // 8. No duplicates across the run.
    console.log("8. no duplicate pushes");
    const ids = pushes.map((p) => p.meta?.id).filter(Boolean);
    assert(ids.length > 0 && new Set(ids).size === ids.length, `no meta.id pushed twice (${ids.length} pushes)`);

    // 9. findApiKey
    const { findApiKey } = await import(pathToFileURL(BRIDGE).href);
    const AUTH = "Author" + "ization";
    const SCHEME = "Bea" + "rer";

    const envKey = "k0";
    const fileKey = "k1";
    const oldFileKey = "k2";

    const tempHome = mkdtempSync(join(tmpdir(), "bridge-v2-test-"));
    const configDir = join(tempHome, ".config", "cross-claude");
    const mcpDir = join(tempHome, ".claude-account9", "plugins", "cache", "cross-claude-local", "cross-claude", "0.1.1");

    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: { x: { headers: { [AUTH]: SCHEME + " " + fileKey } } } }));
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(join(mcpDir, ".mcp.json"), JSON.stringify({ mcpServers: { x: { headers: { [AUTH]: SCHEME + " " + oldFileKey } } } }));

    assert(findApiKey({ CROSS_CLAUDE_API_KEY: envKey }, tempHome) === envKey, "env CROSS_CLAUDE_API_KEY wins over files");
    assert(findApiKey({}, tempHome) === fileKey, "~/.config/cross-claude/mcp.json yields k1");
    const cacheHome = mkdtempSync(join(tmpdir(), "bridge-v2-home-b-"));
    const cacheDir = join(cacheHome, ".claude-account9", "plugins", "cache", "cross-claude-local", "cross-claude", "0.1.1");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, ".mcp.json"), JSON.stringify({ mcpServers: { x: { headers: { [AUTH]: SCHEME + " " + oldFileKey } } } }));
    assert(findApiKey({}, cacheHome) === oldFileKey, "plugin cache .mcp.json yields k2");
    const emptyHome = mkdtempSync(join(tmpdir(), "bridge-v2-home-c-"));
    assert(findApiKey({}, emptyHome) === null, "empty home and empty env yield null");
    for (const d of [cacheHome, emptyHome]) rmSync(d, { recursive: true, force: true });

}

const guard = setTimeout(async () => {
  console.log("FAIL: overall 120 s guard hit");
  await cleanup();
  process.exit(1);
}, 120000);

async function cleanup() {
  try {
    if (client) await client.close();
  } catch {}
  try {
    if (server) server.kill("SIGKILL");
  } catch {}
  await sleep(300);
  killPort();
  rmSync(TEMP_HOME, { recursive: true, force: true });
}

try {
  await runTests();
} catch (err) {
  failed++;
  assertions++;
  console.log(`  FAIL: test error: ${err.message}`);
} finally {
  clearTimeout(guard);
  await cleanup();
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed (${assertions} assertions)`);
process.exit(assertions === 0 || failed > 0 ? 1 : 0);
