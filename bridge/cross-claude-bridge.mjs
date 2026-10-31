import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

// Cross-claude live-delivery bridge (stdio MCP server, v0.3.0).
// Holds ONE SSE connection to the server and pushes every new message into the session
// as notifications/claude/channel. Reconnects with backoff and resumes from a cursor.

const VERSION = "0.3.0";
const DEFAULT_URL = "https://cross-claude-mcp-production.up.railway.app";
const AUTH_HEADER = "Authorization";
const SCHEME_RE = /^\S+\s+/;
const BACKFILL_MS = 10 * 60 * 1000;
const WATCHDOG_MS = 45000;
const REGISTER_MS = 5 * 60 * 1000;
const IDENTITY_MS = 60 * 1000;
const SEEN_CAP = 5000;

const log = (msg) => process.stderr.write(`cross-claude-bridge: ${msg}\n`);
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const normChannel = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");
const textResult = (text) => ({ content: [{ type: "text", text }] });

function credentialFromMcpJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const entry of Object.values(data.mcpServers || {})) {
      const value = entry?.headers?.[AUTH_HEADER];
      if (typeof value === "string") {
        const stripped = value.replace(SCHEME_RE, "");
        if (stripped) return stripped;
      }
    }
  } catch {}
  return null;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export function findApiKey(env, home) {
  if (env.CROSS_CLAUDE_API_KEY) return env.CROSS_CLAUDE_API_KEY;
  const fromConfig = credentialFromMcpJson(path.join(home, ".config", "cross-claude", "mcp.json"));
  if (fromConfig) return fromConfig;
  for (const d of listDir(home).filter((n) => n.startsWith(".claude"))) {
    const cacheDir = path.join(home, d, "plugins", "cache", "cross-claude-local", "cross-claude");
    for (const version of listDir(cacheDir)) {
      const found = credentialFromMcpJson(path.join(cacheDir, version, ".mcp.json"));
      if (found) return found;
    }
  }
  return null;
}

function sessionNameFor(home, ppid) {
  for (const d of listDir(home).filter((n) => n.startsWith(".claude"))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(home, d, "sessions", `${ppid}.json`), "utf-8"));
      if (typeof data.name === "string" && data.name.trim()) return data.name.trim();
    } catch {}
  }
  return null;
}

async function main() {
  const home = process.env.HOME || os.homedir();
  const credential = findApiKey(process.env, home);
  if (!credential) {
    process.stderr.write("cross-claude-bridge: no API key found (checked CROSS_CLAUDE_API_KEY, ~/.config/cross-claude/mcp.json, ~/.claude*/plugins/cache/cross-claude-local/cross-claude/*/.mcp.json)\n");
    process.exit(1);
  }

  const BASE = (process.env.CROSS_CLAUDE_URL || DEFAULT_URL).replace(/\/+$/, "");
  const headers = { [AUTH_HEADER]: `Bearer ${credential}` };
  const HOST = os.hostname();
  const SHORT_HOST = slug(HOST.split(".")[0]);
  const FIXED_ID = process.env.BRIDGE_INSTANCE || null;
  const NO_INBOX = process.env.BRIDGE_NO_INBOX === "1";
  const BRIDGE_CHANNEL = process.env.BRIDGE_CHANNEL ? normChannel(process.env.BRIDGE_CHANNEL) : "";
  const AUTOSTART = process.env.BRIDGE_AUTOSTART === "1" || (!!BRIDGE_CHANNEL && process.env.BRIDGE_AUTOSTART !== "0");

  const computeIdentity = () => {
    if (FIXED_ID) return { key: FIXED_ID, name: null, instanceId: FIXED_ID };
    const name = sessionNameFor(home, process.ppid);
    const instanceId = name
      ? `${slug(name)}-${SHORT_HOST}`
      : `${slug(path.basename(process.cwd()))}-${process.ppid}-${SHORT_HOST}`;
    return { key: name || "", name, instanceId };
  };

  const first = computeIdentity();
  let identityKey = first.key;
  let sessionName = first.name;
  let instanceId = first.instanceId;
  let inbox = `dm-${instanceId}`;

  const channels = new Set();
  if (!NO_INBOX) channels.add(inbox);
  if (AUTOSTART && BRIDGE_CHANNEL) channels.add(BRIDGE_CHANNEL);

  const seen = new Set();
  let cursor = 0;
  let cursorReady = false;
  let mode = "stream";
  let connected = false;
  let lastByteAt = 0;
  let reconnects = 0;
  let lastError = "";
  let delivered = 0;
  let gen = 0;
  let ctl = null;
  let abortReason = null;
  let backoff = 1000;
  let retryTimer = null;
  let pollTimer = null;
  let pollDelay = 2000;
  let stopping = false;
  let watchdog = null;
  let identityTimer = null;
  let registerTimer = null;

  const mcp = new McpServer(
    { name: "cross-claude-bridge", version: VERSION },
    { capabilities: { experimental: { "claude/channel": {} } } }
  );

  const api = async (p, init = {}) => {
    const h = { ...headers };
    if (init.body) h["Content-Type"] = "application/json";
    const res = await fetch(`${BASE}${p}`, { ...init, headers: h });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const deliver = (m) => {
    const id = Number(m.id);
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value);
    if (id > cursor) cursor = id;
    let content = `[#${m.channel}] ${m.sender}: ${m.content}`;
    if (m.channel === inbox) {
      content += `\n\n(Direct message to you. Reply with the cross-claude-bridge "send" tool, to="${m.sender}".)`;
    }
    const meta = {
      channel: String(m.channel),
      sender: String(m.sender),
      id: String(id),
      message_type: String(m.message_type ?? "message"),
      in_reply_to: m.in_reply_to == null ? "" : String(m.in_reply_to),
    };
    mcp.server
      .notification({ method: "notifications/claude/channel", params: { content, meta } })
      .catch((e) => log(`push failed for #${id}: ${e.message}`));
    delivered++;
  };

  const backfillInbox = async () => {
    try {
      const data = await api(`/api/messages/${encodeURIComponent(inbox)}?limit=20`);
      const cutoff = Date.now() - BACKFILL_MS;
      const recent = (data.messages || [])
        .filter((m) => m.sender !== instanceId && Date.parse(m.created_at) >= cutoff)
        .sort((a, b) => Number(a.id) - Number(b.id));
      for (const m of recent) deliver(m);
    } catch (e) {
      log(`inbox backfill failed: ${e.message}`);
    }
  };

  // One attempt. Returns true when the cursor is set; the caller retries with backoff.
  const initCursor = async () => {
    try {
      let max = 0;
      for (const ch of channels) {
        const data = await api(`/api/messages/${encodeURIComponent(ch)}?limit=1`);
        max = Math.max(max, Number(data.last_id ?? 0));
      }
      cursor = max;
      cursorReady = true;
      if (!NO_INBOX) await backfillInbox();
      return true;
    } catch (e) {
      log(`initial cursor fetch failed: ${e.message}`);
      return false;
    }
  };

  const handleBlock = (block) => {
    let event = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (event === "ready") {
      backoff = 1000;
      lastError = "";
      return;
    }
    if (event === "message" && dataLines.length) {
      try {
        deliver(JSON.parse(dataLines.join("\n")));
      } catch (e) {
        log(`bad message frame: ${e.message}`);
      }
    }
  };

  const scheduleReconnect = (reason) => {
    connected = false;
    lastError = reason;
    reconnects++;
    const delay = backoff + Math.floor(Math.random() * 500);
    backoff = Math.min(backoff * 2, 30000);
    log(`reconnect #${reconnects} in ${delay} ms (${reason})`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connectNow();
    }, delay);
  };

  const pollLoop = async () => {
    if (mode !== "poll" || stopping) return;
    const batch = [];
    let failed = false;
    for (const ch of [...channels]) {
      try {
        const qs = new URLSearchParams({ after_id: String(cursor), instance_id: instanceId });
        const data = await api(`/api/messages/${encodeURIComponent(ch)}?${qs}`);
        batch.push(...(data.messages || []));
      } catch (e) {
        failed = true;
        lastError = e.message;
      }
    }
    batch.sort((a, b) => Number(a.id) - Number(b.id));
    for (const m of batch) deliver(m);
    connected = !failed;
    pollDelay = failed ? Math.min(pollDelay * 2, 30000) : 2000;
    pollTimer = setTimeout(pollLoop, pollDelay);
  };

  const switchToPoll = () => {
    mode = "poll";
    connected = false;
    log("server has no /api/stream; switching to poll mode");
    pollLoop();
  };

  const runStream = async (myGen, myCtl) => {
    let reason = "stream ended";
    try {
      if (!cursorReady) {
        const ok = await initCursor();
        if (myGen !== gen) return;
        if (!ok) throw new Error("initial cursor unavailable");
      }
      const qs = new URLSearchParams({
        channels: [...channels].join(","),
        after_id: String(cursor),
        instance_id: instanceId,
      });
      const res = await fetch(`${BASE}/api/stream?${qs}`, { headers, signal: myCtl.signal });
      if (myGen !== gen) return;
      if (res.status === 404) {
        switchToPoll();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      connected = true;
      lastByteAt = Date.now();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (myGen !== gen) return;
        if (done) break;
        lastByteAt = Date.now();
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleBlock(block);
        }
      }
    } catch (e) {
      if (myGen !== gen) return;
      reason = abortReason || e.message;
    }
    if (myGen !== gen) return;
    scheduleReconnect(reason);
  };

  // Start (or restart) the stream with the current channel set. Supersedes any live connection.
  const connectNow = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (ctl) ctl.abort();
    ctl = null;
    const myGen = ++gen;
    connected = false;
    if (mode !== "stream" || stopping || channels.size === 0) return;
    const myCtl = new AbortController();
    ctl = myCtl;
    abortReason = null;
    runStream(myGen, myCtl).catch((e) => log(`stream loop error: ${e.message}`));
  };

  const register = async () => {
    try {
      await api("/api/register", {
        method: "POST",
        body: JSON.stringify({
          instance_id: instanceId,
          description: `Claude Code session "${sessionName || instanceId}" on ${HOST} (cwd ${process.cwd()}), bridge v${VERSION}`,
        }),
      });
    } catch (e) {
      log(`register failed: ${e.message}`);
    }
  };

  const applyIdentity = (next) => {
    if (next.instanceId === instanceId) return;
    const oldInbox = inbox;
    instanceId = next.instanceId;
    sessionName = next.name;
    inbox = `dm-${instanceId}`;
    channels.delete(oldInbox);
    if (!NO_INBOX) channels.add(inbox);
    log(`identity changed to ${instanceId}`);
    register();
    connectNow();
  };

  const refreshIdentity = () => {
    if (FIXED_ID) return;
    const next = computeIdentity();
    if (next.key === identityKey) return;
    identityKey = next.key;
    applyIdentity(next);
  };

  mcp.tool(
    "send",
    "Send a message. to starting with # posts to that channel; otherwise to is an instance_id and the message goes to its inbox.",
    {
      to: z.string().describe("Instance id (e.g. 'alice-laptop') or '#channel'"),
      message: z.string().describe("Message text"),
      in_reply_to: z.number().optional().describe("Optional message id this replies to"),
    },
    async ({ to, message, in_reply_to }) => {
      try {
        const channel = to.startsWith("#") ? normChannel(to.slice(1)) : `dm-${to}`;
        if (!channel || channel === "dm-") return textResult("Send failed: empty destination");
        const r = await api("/api/messages", {
          method: "POST",
          body: JSON.stringify({
            channel,
            sender: instanceId,
            content: message,
            message_type: "message",
            ...(in_reply_to != null ? { in_reply_to } : {}),
          }),
        });
        return textResult(`Sent #${r.id} to ${to}`);
      } catch (e) {
        return textResult(`Send failed: ${e.message}`);
      }
    }
  );

  mcp.tool("peers", "List cross-claude instances, online first.", {}, async () => {
    try {
      const data = await api("/api/instances");
      const rows = [...(data.instances || [])].sort((a, b) => (b.status === "online") - (a.status === "online"));
      const lines = rows.map(
        (i) => `${i.instance_id} — ${i.status} — ${i.last_seen} — ${i.description}${i.instance_id === instanceId ? " (you)" : ""}`
      );
      lines.push('Send to any of these with send(to="<instance_id>")');
      return textResult(lines.join("\n"));
    } catch (e) {
      return textResult(`Peers lookup failed: ${e.message}`);
    }
  });

  mcp.tool("whoami", "Show this session's bridge identity, inbox, server, and delivery mode.", {}, async () =>
    textResult(
      [
        `instance_id: ${instanceId}`,
        `inbox: ${inbox}`,
        `hostname: ${HOST}`,
        `server: ${BASE}`,
        `mode: ${mode}`,
        `connected: ${connected}`,
      ].join("\n")
    )
  );

  mcp.tool(
    "listen_live",
    "Turn ON live push delivery for a channel from THIS session onward. Opens a live stream that injects each new message into your context as it arrives (notifications/claude/channel) — real live listening, no wait_for_reply needed, works even while idle. Call again for other channels to listen to several at once. Use stop_listening to turn a channel off.",
    { channel: z.string().describe("Channel to start live-listening to (e.g. 'general', 'bagby-launch')") },
    async ({ channel }) => {
      const ch = normChannel(channel);
      if (!ch) return textResult(`Could not start live listening: "${channel}" is not a valid channel name.`);
      if (channels.has(ch)) {
        return textResult(`Already live-listening on #${ch}. New messages are pushed into this session as they arrive.`);
      }
      channels.add(ch);
      connectNow();
      return textResult(
        `🔔 Live push ON for #${ch} (from message id ${cursor}). New messages will be injected into this session as they arrive — you are genuinely listening, even while idle. Call stop_listening to turn it off.`
      );
    }
  );

  mcp.tool(
    "stop_listening",
    "Turn OFF live push delivery for a channel started with listen_live. After this, messages on that channel are no longer pushed to your session; you would need to poll or wait_for_reply to see them.",
    { channel: z.string().describe("Channel to stop live-listening to") },
    async ({ channel }) => {
      const ch = normChannel(channel);
      if (ch && ch === inbox) {
        return textResult(`The inbox ${inbox} cannot be removed. Direct messages to you are always delivered.`);
      }
      if (!channels.has(ch)) return textResult(`Not currently live-listening on #${ch} (nothing to stop).`);
      channels.delete(ch);
      connectNow();
      return textResult(
        `🔕 Live push OFF for #${ch}. New messages there are no longer delivered to this session unless you poll or wait_for_reply.`
      );
    }
  );

  mcp.tool(
    "delivery_status",
    "Report, best-effort, how THIS session is currently receiving cross-claude messages: mode, connection, reconnects, last error, cursor, delivered count, and the channels listened to.",
    {},
    async () => {
      const age = lastByteAt ? Math.round((Date.now() - lastByteAt) / 1000) : "n/a";
      const chanLines = [...channels]
        .sort()
        .map((c) => `  • #${c}${c === inbox ? " (inbox)" : ""}`)
        .join("\n") || "  (none)";
      return textResult(
        `Delivery status (best-effort — reports what is registered/running in this bridge, not proof that every push reaches the model — a dropped notification or a dead stream cannot be seen from here):\n` +
          `mode: ${mode}\n` +
          `connected: ${connected}\n` +
          `seconds since last byte: ${age}\n` +
          `reconnects: ${reconnects}\n` +
          `last error: ${lastError || "none"}\n` +
          `cursor: ${cursor}\n` +
          `delivered: ${delivered}\n` +
          `channels:\n${chanLines}\n\n` +
          `• Live push ON = new messages are injected into this session as they arrive, even while idle.\n` +
          `• Any channel NOT listed above is poll-only from this session: you see its messages only when you call check_messages, or while blocked inside wait_for_reply.`
      );
    }
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const shutdown = () => {
    stopping = true;
    if (watchdog) clearInterval(watchdog);
    if (identityTimer) clearInterval(identityTimer);
    if (registerTimer) clearInterval(registerTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (ctl) ctl.abort();
    process.exit(0);
  };
  transport.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  log(`starting v${VERSION} as ${instanceId} (inbox dm-${instanceId}) against ${BASE}`);
  void register();
  watchdog = setInterval(() => {
    if (connected && ctl && Date.now() - lastByteAt > WATCHDOG_MS) {
      abortReason = "stalled";
      ctl.abort();
    }
  }, 5000);
  if (!FIXED_ID) identityTimer = setInterval(refreshIdentity, IDENTITY_MS);
  registerTimer = setInterval(() => void register(), REGISTER_MS);
  connectNow();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}
