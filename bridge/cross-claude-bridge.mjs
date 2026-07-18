import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Channel-less live-delivery bridge.
//
// Loads with NO channel and sits idle until a session asks it to listen. The model turns live
// delivery on/off mid-session with the listen_live / stop_listening tools; each active channel
// runs its own poll loop that pushes notifications/claude/channel into the session. This removes
// the old launch-only constraint where the channel had to be chosen before the session started.
//
// Backward-compatible: set BRIDGE_CHANNEL (+ optional BRIDGE_AUTOSTART=1, the default when
// BRIDGE_CHANNEL is present) to auto-start one channel at launch — that's how cc-listen works.

const CROSS_CLAUDE_URL = process.env.CROSS_CLAUDE_URL || "https://cross-claude-mcp-production.up.railway.app";
const CROSS_CLAUDE_API_KEY = process.env.CROSS_CLAUDE_API_KEY;
const BRIDGE_INSTANCE = process.env.BRIDGE_INSTANCE || null;
const BRIDGE_POLL_MS = Math.max(2000, parseInt(process.env.BRIDGE_POLL_MS) || 5000);
const BRIDGE_CHANNEL = process.env.BRIDGE_CHANNEL || null;
const BRIDGE_AUTOSTART = process.env.BRIDGE_AUTOSTART === "1" || (BRIDGE_CHANNEL && process.env.BRIDGE_AUTOSTART !== "0");

if (!CROSS_CLAUDE_API_KEY) {
  console.error("Error: CROSS_CLAUDE_API_KEY is required");
  process.exit(1);
}

console.error(`cross-claude-bridge starting (channel-less):`);
console.error(`  URL: ${CROSS_CLAUDE_URL}`);
console.error(`  Instance filter: ${BRIDGE_INSTANCE || "none"}`);
console.error(`  Poll interval: ${BRIDGE_POLL_MS}ms`);
console.error(`  Auto-start channel: ${BRIDGE_AUTOSTART ? BRIDGE_CHANNEL : "none (idle until listen_live)"}`);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers, "Authorization": `Bearer ${CROSS_CLAUDE_API_KEY}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return await res.json();
}

// channel -> { cursor, running, startedAt, pollMs } for each live push loop.
const loops = new Map();
let mcp; // set in main()

async function initCursor(channel) {
  const res = await fetchJson(`${CROSS_CLAUDE_URL}/api/messages/${channel}?limit=1`);
  return res.last_id ?? 0;
}

async function runLoop(channel) {
  const state = loops.get(channel);
  if (!state) return;
  while (state.running) {
    try {
      await sleep(state.pollMs);
      if (!state.running) break;
      const url = new URL(`${CROSS_CLAUDE_URL}/api/messages/${channel}`);
      url.searchParams.set("after_id", state.cursor);
      if (BRIDGE_INSTANCE) url.searchParams.set("instance_id", BRIDGE_INSTANCE);
      const res = await fetchJson(url.href);
      for (const m of res.messages) {
        await mcp.server.notification({
          method: "notifications/claude/channel",
          params: {
            content: `[#${channel}] ${m.sender} (${m.message_type}): ${m.content}`,
            meta: { channel, sender: m.sender, id: String(m.id), message_type: m.message_type },
          },
        });
        console.error(`bridged #${m.id} from ${m.sender} on #${channel}`);
      }
      if (typeof res.last_id === "number") state.cursor = res.last_id;
      state.pollMs = BRIDGE_POLL_MS; // reset backoff after a good poll
    } catch (err) {
      console.error(`poll error on #${channel}: ${err.message}`);
      state.pollMs = Math.min(state.pollMs * 2, 60000); // bounded backoff, never a tight loop
    }
  }
  console.error(`stopped listening on #${channel}`);
}

async function startListening(channel) {
  if (loops.has(channel) && loops.get(channel).running) {
    return { already: true };
  }
  const cursor = await initCursor(channel);
  const state = { cursor, running: true, startedAt: Date.now(), pollMs: BRIDGE_POLL_MS };
  loops.set(channel, state);
  runLoop(channel); // fire-and-forget; loop self-terminates when running=false
  return { already: false, cursor };
}

function stopListening(channel) {
  const state = loops.get(channel);
  if (!state || !state.running) return false;
  state.running = false;
  loops.delete(channel);
  return true;
}

async function main() {
  mcp = new McpServer(
    { name: "cross-claude-bridge", version: "0.2.0" },
    { capabilities: { experimental: { "claude/channel": {} } } }
  );

  mcp.tool(
    "listen_live",
    "Turn ON live push delivery for a channel from THIS session onward. Starts a poll loop that injects each new message into your context as it arrives (notifications/claude/channel) — real live listening, no wait_for_reply needed, works even while idle. Call again for other channels to listen to several at once. Use stop_listening to turn a channel off.",
    { channel: z.string().describe("Channel to start live-listening to (e.g. 'general', 'bagby-launch')") },
    async ({ channel }) => {
      try {
        const { already, cursor } = await startListening(channel);
        const text = already
          ? `Already live-listening on #${channel}. New messages are pushed into this session as they arrive.`
          : `🔔 Live push ON for #${channel} (from message id ${cursor}). New messages will be injected into this session as they arrive — you are genuinely listening, even while idle. Call stop_listening to turn it off.`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Could not start live listening on #${channel}: ${err.message}. You can still poll with check_messages or block in wait_for_reply.` }] };
      }
    }
  );

  mcp.tool(
    "stop_listening",
    "Turn OFF live push delivery for a channel started with listen_live. After this, messages on that channel are no longer pushed to your session; you would need to poll or wait_for_reply to see them.",
    { channel: z.string().describe("Channel to stop live-listening to") },
    async ({ channel }) => {
      const stopped = stopListening(channel);
      const text = stopped
        ? `🔕 Live push OFF for #${channel}. New messages there are no longer delivered to this session unless you poll or wait_for_reply.`
        : `Not currently live-listening on #${channel} (nothing to stop).`;
      return { content: [{ type: "text", text }] };
    }
  );

  mcp.tool(
    "delivery_status",
    "Report, best-effort, how THIS session is currently receiving cross-claude messages: which channels have live push ON (via listen_live), versus channels you can only see by polling check_messages or blocking in wait_for_reply. Best-effort: it reports what is registered/running in this bridge, not proof that every push reaches the model — a dropped notification or a dead poll loop cannot be seen from here. Background wait_for_reply state is known only to the session that opened the wait, so it is not listed here.",
    {},
    async () => {
      const live = [...loops.entries()].filter(([, s]) => s.running);
      const lines = live.length
        ? live.map(([ch, s]) => `  • #${ch} — live push ON (since ${new Date(s.startedAt).toISOString()}, polling every ${Math.round(s.pollMs / 1000)}s)`).join("\n")
        : "  (no channels are live-pushing right now)";
      const text =
        `Delivery status (best-effort — reports what this bridge is running, not guaranteed end-to-end delivery):\n${lines}\n\n` +
        `• Live push ON = new messages are injected into this session as they arrive, even while idle.\n` +
        `• Any channel NOT listed above is poll-only from this session: you see its messages only when you call check_messages, or while blocked inside wait_for_reply.\n` +
        `• A backgrounded wait_for_reply is also real listening while it is live, but only the session holding that wait knows about it — it is not tracked here.`;
      return { content: [{ type: "text", text }] };
    }
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const shutdown = () => {
    for (const state of loops.values()) state.running = false;
    loops.clear();
    process.exit(0);
  };
  transport.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  if (BRIDGE_AUTOSTART && BRIDGE_CHANNEL) {
    try {
      await startListening(BRIDGE_CHANNEL);
      console.error(`auto-started live listening on #${BRIDGE_CHANNEL}`);
    } catch (err) {
      console.error(`auto-start failed for #${BRIDGE_CHANNEL}: ${err.message} (bridge stays up, idle)`);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
