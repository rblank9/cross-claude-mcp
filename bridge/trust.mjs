// Bridge trust primitives (docs/plans/bridge-trust.md, gates 2-5, client side).
// Pure functions plus small file I/O. Imported by the bridge and by cc-bridge-keys.
// Paths honor CROSS_CLAUDE_CONFIG_DIR / CROSS_CLAUDE_STATE_DIR, read at call time.

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export const REASONS = [
  "ok", "unsigned", "malformed", "unknown_key", "bad_sig", "channel_mismatch",
  "stale", "replay", "key_mismatch", "killed", "oversize", "out_of_scope", "team_denied",
];
export const ALARM_REASONS = ["bad_sig", "unknown_key", "key_mismatch", "replay", "unsigned", "out_of_scope"];
// Sessions in these cwd basenames, or with OP_SERVICE_ACCOUNT_TOKEN set, never listen on or send to team channels.
export const TEAM_DENY_CWD = ["security-guard", "security-guard-2", "hr", "cfo", "bookkeeper", "syb-quickbooks-mcp", "claude-optimization"];

const BODY_CAP = 65536;
const STALE_MS = 10 * 60 * 1000;
const NONCE_TTL_MS = 15 * 60 * 1000;
const ALARM_WINDOW_MS = 10 * 60 * 1000;
const ALARM_THRESHOLD = 5;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const slug = (s) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function assertId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("invalid identity id");
  return id;
}

const resolveHome = (home) => home || process.env.HOME || os.homedir();

export function configDir(env = process.env, home) {
  if (env.CROSS_CLAUDE_CONFIG_DIR) return env.CROSS_CLAUDE_CONFIG_DIR;
  return path.join(resolveHome(home), ".config", "cross-claude");
}

export function stateDir(env = process.env, home) {
  if (env.CROSS_CLAUDE_STATE_DIR) return env.CROSS_CLAUDE_STATE_DIR;
  return path.join(resolveHome(home), ".local", "state", "cross-claude");
}

export const killFile = (env, home) => path.join(configDir(env, home), "KILL");
export const isKilled = (env, home) => fs.existsSync(killFile(env, home));
export const trustedPath = (env, home) => path.join(configDir(env, home), "trusted_keys.json");

export function defaultIdentity(env, home, hostname) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(resolveHome(home), ".claude");
  return `${slug(String(hostname).split(".")[0])}-${slug(path.basename(dir))}`;
}

export function identityFor(home, ppid, hostname) {
  if (process.env.BRIDGE_IDENTITY) return assertId(process.env.BRIDGE_IDENTITY);
  let entries = [];
  try {
    entries = fs.readdirSync(home).filter((n) => n.startsWith(".claude")).sort();
  } catch {
    return null;
  }
  for (const entry of entries) {
    try {
      JSON.parse(fs.readFileSync(path.join(home, entry, "sessions", `${ppid}.json`), "utf-8"));
    } catch {
      continue;
    }
    return `${slug(String(hostname).split(".")[0])}-${slug(entry)}`;
  }
  return null;
}

export function canonical(obj) {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(",")}]`;
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(obj);
}

function sha256hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writeSecret(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const idPaths = (id, env, home) => {
  assertId(id);
  const base = configDir(env, home);
  return {
    pem: path.join(base, "identity", `${id}.pem`),
    pub: path.join(base, "identity", `${id}.pub`),
    token: path.join(base, "bearer", `${id}.token`),
    base,
    identityDir: path.join(base, "identity"),
    bearerDir: path.join(base, "bearer"),
  };
};

export function ensureIdentity(id, { force = false, env = process.env, home } = {}) {
  const p = idPaths(id, env, home);
  const exist = fs.existsSync(p.pem) && fs.existsSync(p.pub) && fs.existsSync(p.token);
  if (exist && !force) {
    const pub = fs.readFileSync(p.pub, "utf-8").trim();
    const token = fs.readFileSync(p.token, "utf-8").trim();
    return { id, pub, bearerSha256: sha256hex(token), created: false };
  }
  ensureDir(p.base);
  ensureDir(p.identityDir);
  ensureDir(p.bearerDir);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const token = crypto.randomBytes(32).toString("hex");
  writeSecret(p.pem, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeSecret(p.pub, `${pubB64}\n`);
  writeSecret(p.token, `${token}\n`);
  return { id, pub: pubB64, bearerSha256: sha256hex(token), created: true };
}

export function loadIdentity(id, env = process.env, home) {
  const p = idPaths(id, env, home);
  try {
    return {
      id,
      privateKeyPem: fs.readFileSync(p.pem, "utf-8"),
      pub: fs.readFileSync(p.pub, "utf-8").trim(),
      bearer: fs.readFileSync(p.token, "utf-8").trim(),
    };
  } catch {
    return null;
  }
}

export function readBearer(id, env = process.env, home) {
  try {
    return fs.readFileSync(idPaths(id, env, home).token, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function bearerSha256(id, env = process.env, home) {
  const p = idPaths(id, env, home);
  try {
    return sha256hex(fs.readFileSync(p.token, "utf-8").trim());
  } catch {
    return null;
  }
}

// Entry shapes: "<pub>" = full trust; {pub, tier:"teammate", channels:[exact names]} = scoped.
// Returns id -> {pub, tier, channels}. Malformed or empty-scope object entries are dropped (unknown_key).
export function loadTrusted(env = process.env, home) {
  try {
    const data = JSON.parse(fs.readFileSync(trustedPath(env, home), "utf-8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") out[k] = { pub: v, tier: "full", channels: null };
      else if (v && typeof v === "object" && !Array.isArray(v) && typeof v.pub === "string" && v.tier === "teammate" && Array.isArray(v.channels)) {
        const channels = v.channels.filter((c) => typeof c === "string" && c.length > 0 && !c.startsWith("dm-") && !c.includes("*"));
        if (channels.length > 0) out[k] = { pub: v.pub, tier: "teammate", channels };
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Union of channels across all teammate entries.
export function teamChannelsOf(trusted) {
  const set = new Set();
  for (const e of Object.values(trusted)) if (e.tier === "teammate") for (const c of e.channels) set.add(c);
  return set;
}

// Returns "team_denied" when this session must not touch team channels, else null. cwd and env injectable.
export function teamDenyReason(cwd = process.cwd(), env = process.env) {
  if (TEAM_DENY_CWD.includes(path.basename(cwd))) return "team_denied";
  if (env.OP_SERVICE_ACCOUNT_TOKEN && env.OP_SERVICE_ACCOUNT_TOKEN.length > 0) return "team_denied";
  return null;
}

// Marker that this session is team-listening; presence only, file mode 0600.
export const teamMarkerPath = (sessionId, env = process.env, home) =>
  path.join(stateDir(env, home), "team-listening", String(sessionId));
export function setTeamMarker(sessionId, on, env = process.env, home) {
  const file = teamMarkerPath(sessionId, env, home);
  if (on) {
    ensureDir(path.dirname(file));
    writeSecret(file, "1\n");
  } else {
    fs.rmSync(file, { force: true });
  }
}

// Raw file contents (string and object entries as written). Use for writes so entries round-trip unchanged.
export function loadTrustedRaw(env = process.env, home) {
  try {
    const data = JSON.parse(fs.readFileSync(trustedPath(env, home), "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function writeTrusted(obj, env = process.env, home) {
  ensureDir(configDir(env, home));
  writeSecret(trustedPath(env, home), `${JSON.stringify(obj, null, 2)}\n`);
}

export function signEnvelope({ from_key, from_instance, channel, body }, privateKeyPem) {
  const p = {
    v: 1,
    from_key,
    from_instance,
    channel,
    body,
    ts: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  const sig = crypto.sign(null, Buffer.from(`ccsig1\n${canonical(p)}`, "utf8"), privateKeyPem);
  const payload = JSON.stringify({ p, s: sig.toString("base64") });
  return `ccsig1:${Buffer.from(payload, "utf8").toString("base64url")}`;
}

export function parseEnvelope(content) {
  if (typeof content !== "string" || !content.startsWith("ccsig1:")) return null;
  try {
    const obj = JSON.parse(Buffer.from(content.slice(7), "base64url").toString("utf8"));
    if (!obj || typeof obj !== "object" || !obj.p || typeof obj.p !== "object" || typeof obj.s !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}

function wellFormed(p) {
  return (
    p.v === 1 &&
    typeof p.from_key === "string" &&
    typeof p.from_instance === "string" &&
    typeof p.channel === "string" &&
    typeof p.body === "string" &&
    typeof p.ts === "number" && Number.isFinite(p.ts) &&
    typeof p.nonce === "string" && /^[0-9a-f]{32}$/.test(p.nonce)
  );
}

function signatureOk(p, s, pubB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(`ccsig1\n${canonical(p)}`, "utf8"), key, Buffer.from(s, "base64"));
  } catch {
    return false;
  }
}

export function verifyEnvelope(content, { channel, trusted, nonceStore, now = Date.now(), serverKeyId = null } = {}) {
  if (typeof content !== "string" || !content.startsWith("ccsig1:")) return { ok: false, reason: "unsigned" };
  const env = parseEnvelope(content);
  if (!env || !wellFormed(env.p)) return { ok: false, reason: "malformed" };
  const { p, s } = env;
  if (Buffer.byteLength(p.body, "utf8") > BODY_CAP) return { ok: false, reason: "oversize" };
  if (!Object.prototype.hasOwnProperty.call(trusted, p.from_key)) return { ok: false, reason: "unknown_key" };
  const ent = trusted[p.from_key];
  if (!signatureOk(p, s, ent.pub)) return { ok: false, reason: "bad_sig" };
  if (ent.tier === "teammate" && (!ent.channels.includes(p.channel) || p.channel.startsWith("dm-"))) {
    return { ok: false, reason: "out_of_scope" };
  }
  if (p.channel !== channel) return { ok: false, reason: "channel_mismatch" };
  if (Math.abs(now - p.ts) > STALE_MS) return { ok: false, reason: "stale" };
  const nonceKey = `${p.from_key}:${p.nonce}`;
  if (nonceStore.has(nonceKey)) return { ok: false, reason: "replay" };
  nonceStore.add(nonceKey, p.ts);
  if (serverKeyId != null && serverKeyId !== p.from_key) return { ok: false, reason: "key_mismatch" };
  return { ok: true, p, tier: ent.tier };
}

export function createNonceStore(env = process.env, home) {
  const dir = stateDir(env, home);
  const file = path.join(dir, "nonces.json");
  let map = {};
  const prune = (now) => {
    for (const k of Object.keys(map)) if (now - map[k] > NONCE_TTL_MS) delete map[k];
  };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (data && typeof data === "object" && !Array.isArray(data)) map = data;
  } catch {}
  prune(Date.now());
  const save = () => {
    try {
      prune(Date.now());
      ensureDir(dir);
      writeSecret(file, JSON.stringify(map));
    } catch (e) {
      process.stderr.write(`cross-claude trust: nonce save failed: ${e.message}\n`);
    }
  };
  return {
    has: (key) => Object.prototype.hasOwnProperty.call(map, key),
    add: (key, ts) => {
      map[key] = ts;
      save();
    },
    size: () => Object.keys(map).length,
  };
}

export const sha8 = (s) => sha256hex(String(s)).slice(0, 8);

export function audit(event, fields = {}, env = process.env, home) {
  try {
    const line = { v: 2, ts: new Date().toISOString(), host: os.hostname(), identity: fields.identity ?? null, event };
    for (const [k, v] of Object.entries(fields)) {
      if (k === "identity" || v === undefined) continue;
      line[k] = v;
    }
    const dir = stateDir(env, home);
    ensureDir(dir);
    const file = path.join(dir, "audit.jsonl");
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (e) {
    process.stderr.write(`cross-claude audit write failed: ${e.message}\n`);
  }
}

const alarmWindow = [];
let lastAlarmAt = 0;

export function recordDrop(reason, fields = {}, env = process.env, home) {
  if (!REASONS.includes(reason)) throw new Error(`unknown drop reason: ${reason}`);
  audit("drop", { ...fields, reason }, env, home);
  if (!ALARM_REASONS.includes(reason)) return;
  const now = Date.now();
  alarmWindow.push({ t: now, reason });
  while (alarmWindow.length && now - alarmWindow[0].t > ALARM_WINDOW_MS) alarmWindow.shift();
  if (alarmWindow.length < ALARM_THRESHOLD) return;
  if (lastAlarmAt && now - lastAlarmAt < ALARM_WINDOW_MS) return;
  const counts = {};
  for (const e of alarmWindow) counts[e.reason] = (counts[e.reason] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  lastAlarmAt = now;
  audit("alarm", { identity: fields.identity, reason: top, count: alarmWindow.length }, env, home);
  process.stderr.write(`cross-claude ALARM: ${alarmWindow.length} signature/allowlist drops in 10 min (top: ${top})\n`);
}
