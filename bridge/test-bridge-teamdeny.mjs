// End-to-end: the REAL bridge refuses listen_live on a team channel for deny-listed sessions
// (cwd basename or OP_SERVICE_ACCOUNT_TOKEN), writes no team-listening marker, and audits team_denied.
// Case 3 is the positive control. No network: the server URL is unreachable on purpose.
// Drafted by gateway/code (delegate code), completed and fixed inline.
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureIdentity, writeTrusted } from "./trust.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.BRIDGE_UNDER_TEST || join(__dirname, "cross-claude-bridge.mjs");
const SESSION_ID = "sess-teamdeny-1";

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

const TEMP_HOME = mkdtempSync(join(tmpdir(), "bridge-teamdeny-"));
const CFG_DIR = join(TEMP_HOME, ".config", "cross-claude");
const STATE_DIR = join(TEMP_HOME, ".local", "state", "cross-claude");
const ENV = { CROSS_CLAUDE_CONFIG_DIR: CFG_DIR, CROSS_CLAUDE_STATE_DIR: STATE_DIR };
const MARKER = join(STATE_DIR, "team-listening", SESSION_ID);
const AUDIT = join(STATE_DIR, "audit.jsonl");

async function runCase({ cwd, extraEnv = {} }) {
  rmSync(join(STATE_DIR, "team-listening"), { recursive: true, force: true });
  writeFileSync(AUDIT, "");
  const transport = new StdioClientTransport({
    command: "node",
    args: [BRIDGE],
    cwd,
    stderr: "pipe",
    env: {
      CROSS_CLAUDE_URL: "http://127.0.0.1:9",
      CROSS_CLAUDE_API_KEY: "dummy-test-key",
      BRIDGE_INSTANCE: "teamdeny-box",
      BRIDGE_IDENTITY: "me-box",
      ...ENV,
      HOME: TEMP_HOME,
      PATH: process.env.PATH,
      ...extraEnv,
    },
  });
  const client = new Client({ name: "teamdeny-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  await sleep(800);
  let text = "";
  try {
    const r = await client.callTool({ name: "listen_live", arguments: { channel: "team-syb" } });
    text = r.content?.[0]?.text ?? "";
  } catch (e) {
    text = `callTool error: ${e.message}`;
  }
  await sleep(300);
  const markerExists = existsSync(MARKER);
  const auditLines = readFileSync(AUDIT, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
  try {
    await client.close();
  } catch {}
  return { text, markerExists, auditLines };
}

const teamDenied = (lines) => lines.some((l) => l.event === "drop" && l.reason === "team_denied");

async function main() {
  mkdirSync(CFG_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  const me = ensureIdentity("me-box", { env: ENV, home: TEMP_HOME });
  const vicky = ensureIdentity("vicky-mac-claude", { env: ENV, home: TEMP_HOME });
  writeTrusted(
    { "me-box": me.pub, "vicky-mac-claude": { pub: vicky.pub, tier: "teammate", channels: ["team-syb"] } },
    ENV,
    TEMP_HOME
  );
  // The bridge's ppid is this process (spawned directly by StdioClientTransport).
  const sessDir = join(TEMP_HOME, ".claude-test", "sessions");
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(join(sessDir, `${process.pid}.json`), JSON.stringify({ sessionId: SESSION_ID, name: "teamdeny" }));
  const dirs = {};
  for (const d of ["security-guard", "neutral-a", "neutral-b"]) mkdirSync((dirs[d] = join(TEMP_HOME, d)));

  console.log("1. cwd security-guard: refused");
  const c1 = await runCase({ cwd: dirs["security-guard"] });
  assert(c1.text.includes("Refused"), `listen_live refused (got: ${c1.text.slice(0, 80)})`);
  assert(!c1.markerExists, "no team-listening marker");
  assert(teamDenied(c1.auditLines), "audit has drop/team_denied");

  console.log("2. OP_SERVICE_ACCOUNT_TOKEN set: refused");
  const c2 = await runCase({ cwd: dirs["neutral-a"], extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: "dummy-not-a-secret" } });
  assert(c2.text.includes("Refused"), `listen_live refused (got: ${c2.text.slice(0, 80)})`);
  assert(!c2.markerExists, "no team-listening marker");
  assert(teamDenied(c2.auditLines), "audit has drop/team_denied");

  console.log("3. positive control: neutral cwd, no token");
  const c3 = await runCase({ cwd: dirs["neutral-b"] });
  assert(!c3.text.includes("Refused") && c3.text.includes("Live push ON"), `listen_live accepted (got: ${c3.text.slice(0, 80)})`);
  assert(c3.markerExists, "team-listening marker written");
  assert(!teamDenied(c3.auditLines), "no team_denied in audit");

  console.log("4. static: teamRefusal wired at startup, send and listen_live");
  const src = readFileSync(join(__dirname, "cross-claude-bridge.mjs"), "utf8");
  const n = (src.match(/teamRefusal\(/g) || []).length;
  // Definition is `const teamRefusal = (ch) =>`, so every `teamRefusal(` is a call site.
  assert(n >= 3, `teamRefusal( called ${n} times (startup + send + listen_live)`);
}

const timer = setTimeout(() => {
  console.log("FAIL: timeout");
  process.exit(1);
}, 60000);
timer.unref();

try {
  await main();
} catch (e) {
  console.log(`FAIL: exception ${e.message}`);
  failed++;
} finally {
  rmSync(TEMP_HOME, { recursive: true, force: true });
}
console.log(`\nRESULT: ${passed} passed, ${failed} failed (${passed + failed} assertions)`);
process.exit(failed || passed === 0 ? 1 : 0);
