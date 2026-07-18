/**
 * MCP tool registration — shared between open-source and SaaS modes.
 * Both server.mjs and saas/server-saas.mjs import this.
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import { normalizeChannelName } from "./db.mjs";

// --- Experimental Claude Code "channels" push (env-gated, reversible) ---
// When CHANNELS_ENABLED=1, send_message ALSO pushes notifications/claude/channel to the
// live sessions of instances that have SUBSCRIBED to that channel (explicit opt-in via
// the `subscribe` tool) — event-driven delivery. The poll-based wait_for_reply path is
// untouched and remains the universal fallback for non-channel clients. Off by default.
const CHANNELS_ENABLED = process.env.CHANNELS_ENABLED === "1";
const channelSessions = new Map();       // instance_id -> McpServer for that instance's live session
const channelSubscriptions = new Map();  // channel -> Set<instance_id> opted in to pushes
function subscribersOf(channel) { return channelSubscriptions.get(channel) || new Set(); }

export const STALE_THRESHOLD_SECONDS = 120;

const MUTUAL_WAIT_DETECT = process.env.MUTUAL_WAIT_DETECT !== '0';
const GRACE_MS = parseInt(process.env.MUTUAL_WAIT_GRACE_MS) || 30000; // consider a wait "long-running" after this (overridable for tests)
// SaaS insurance: cap concurrent waits per tenant so one tenant can't monopolize poll load.
const MAX_WAITS_PER_TENANT = Math.max(1, parseInt(process.env.MAX_WAITS_PER_TENANT) || 100);
const activeWaiters = new Map();
// key: `${tenantKey}\0${channel}\0${instance}` -> { startedAt: Date, token: string, role: 'active'|'parked' }
// role 'parked' waiters still receive delivery but are NOT counted as a mutual-wait party:
// they never appear in another waiter's peer list, and they themselves never yield.

/**
 * Pure function: decide whether to yield to a peer in a mutual-wait scenario.
 * Testability seam for late-waiter-yields logic.
 *
 * @param {string} myId - this instance's ID
 * @param {number} myWaitMs - how long this instance has been waiting
 * @param {Array<{peerId: string, peerWaitMs: number}>} peers - live, non-ghost peers
 * @param {number} graceMs - threshold to consider a wait "long-running"
 * @returns {string|null} - peerId to yield to, or null if no yield decision
 */
export function decideYield({ myId, myWaitMs, peers, graceMs }) {
  // Find first peer that has waited >= graceMs
  for (const { peerId, peerWaitMs } of peers) {
    if (peerWaitMs >= graceMs) {
      // Peer has waited long enough. Do we yield?
      if (myWaitMs < graceMs) {
        // I'm the late one (I just entered the grace period, peer was waiting before me)
        return peerId;
      }
      // Both in grace period: tie-break by id (lexicographically GREATER yields)
      if (myId > peerId) {
        return peerId;
      }
      // else: my id is smaller, so I keep waiting; don't yield
    }
  }
  return null; // No yield condition met
}

/** Simple check: are two strings within edit distance 2? Good enough for channel name typos. */
function levenshteinClose(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = a[i - 1] === b[j - 1]
        ? matrix[i - 1][j - 1]
        : 1 + Math.min(matrix[i - 1][j], matrix[i][j - 1], matrix[i - 1][j - 1]);
    }
  }
  return matrix[a.length][b.length] <= 2;
}

/**
 * Register all Cross-Claude MCP tools on a server instance.
 * @param {McpServer} server - The MCP server to register tools on
 * @param {object} db - Database instance (SqliteDB, PostgresDB, or TenantDB)
 * @param {Function|null} planChecker - Optional async (action) => {allowed, message} for SaaS plan limits
 * @returns {Function} cleanup - Call on shutdown to mark instance offline
 */
export function registerTools(server, db, planChecker = null) {
  let currentInstanceId = null;
  const sessionToken = randomUUID();

  function touchHeartbeat() {
    if (!currentInstanceId) return;
    try { db.heartbeat(currentInstanceId); } catch { /* ignore */ }
  }

  // Per-(channel, instance) read high-water mark. Advanced ONLY when messages are
  // SHOWN to an instance — never by a send. This closes the "after_id blind spot":
  // when two instances send near-simultaneously, the one whose message landed with
  // the HIGHER id would otherwise poll from its own send id and never see the lower-id
  // message that crossed it (it sits in that instance's "past"), hanging until the
  // ceiling. We poll from the read cursor instead of trusting a too-high client after_id.
  // Closure-scoped (per connection/tenant), so it's correctly isolated in SaaS multi-tenant
  // mode and resets on reconnect/restart — degrading to legacy behavior, never worse.
  const readCursors = new Map(); // key: `${channel}\0${instance}` -> last shown message id
  const cursorKey = (channel, instance) => `${channel}\0${instance}`;
  function effectiveAfter(channel, instance, clientAfterId) {
    if (!instance) return clientAfterId;
    const c = readCursors.get(cursorKey(channel, instance));
    // A cursor we hold is authoritative: a send never advanced it, so a crossing
    // message still sits above it. Take the lower of the two so we never poll past
    // an unread message from another instance. No cursor (fresh/post-restart) → trust client.
    return c === undefined ? clientAfterId : Math.min(c, clientAfterId);
  }

  // Helper functions nested inside registerTools for closure over db, readCursors, etc.
  async function getTenantKey() {
    if (db.tenantId) return db.tenantId;
    if (typeof db.tenantKey === 'function') return await db.tenantKey();
    return '';
  }

  function logWaitEvent(type, { channel, instance, elapsedMs, reason }) {
    const entry = { type, channel, instance, timestamp: new Date().toISOString() };
    if (elapsedMs !== undefined) entry.elapsedMs = elapsedMs;
    if (reason) entry.reason = reason;
    console.error(JSON.stringify(entry));
  }

  // Resolve the floor of the poll cursor, considering durable read_cursors if available.
  // Called at the START of each poll operation (check_messages, wait_for_reply).
  async function resolveFloor(channel, instance, clientAfterId) {
    // In-memory cursor (hot cache, always synchronous)
    const inMemoryCursor = readCursors.get(cursorKey(channel, instance));

    // Durable cursor (if db supports it, otherwise undefined)
    let durableCursor;
    if (typeof db.getReadCursor === 'function') {
      durableCursor = await db.getReadCursor(channel, instance);
    }

    // Floor = minimum of all three sources (never poll past any of them)
    const floor = Math.min(
      clientAfterId ?? Infinity,
      inMemoryCursor ?? Infinity,
      durableCursor ?? Infinity
    );

    // Always return a finite number (better-sqlite3/pg reject Infinity)
    return floor === Infinity ? 0 : floor;
  }

  async function advanceCursor(channel, instance, lastShownId) {
    if (!instance || lastShownId === undefined) return;
    const key = cursorKey(channel, instance);
    const current = readCursors.get(key) ?? -Infinity;
    // Only advance if strictly monotonic increase
    if (lastShownId > current) {
      readCursors.set(key, lastShownId);
      // Persist to DB if available (feature-detect)
      if (typeof db.setReadCursor === 'function') {
        await db.setReadCursor(channel, instance, lastShownId);
      }
    }
  }

  server.tool(
    "register",
    "Register this Claude Code instance with an identity. Call this first before using other tools. Each instance_id must be unique — if another active session already owns that ID, you'll be asked to pick a different name.",
    {
      instance_id: z.string().describe("Unique name for this instance (e.g., 'alice', 'builder', 'reviewer')"),
      description: z.string().optional().describe("What this instance is working on"),
    },
    async ({ instance_id, description }) => {
      if (planChecker) {
        const check = await planChecker("register");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }

      // Check for duplicate registration by a different session
      const existing = await db.getInstance(instance_id);
      if (existing && existing.session_token && existing.session_token !== sessionToken) {
        const lastSeen = new Date(existing.last_seen);
        const secondsAgo = (Date.now() - lastSeen.getTime()) / 1000;
        if (existing.status === "online" && secondsAgo < STALE_THRESHOLD_SECONDS) {
          return {
            content: [{ type: "text", text: `❌ Instance ID "${instance_id}" is already in use by another active session (last seen ${Math.round(secondsAgo)}s ago)${existing.description ? `: ${existing.description}` : ""}.\n\nPick a different name to avoid message conflicts. For example: "${instance_id}-2", "${instance_id}-${Date.now().toString(36).slice(-4)}", or a descriptive name like "${instance_id}-reviewer".` }],
          };
        }
      }

      if (currentInstanceId && currentInstanceId !== instance_id) {
        await db.markOffline(currentInstanceId);
        if (CHANNELS_ENABLED) channelSessions.delete(currentInstanceId);
      }
      currentInstanceId = instance_id;
      await db.registerInstance(instance_id, description || null, sessionToken);
      // Associate this instance with its live session so others can push to it.
      if (CHANNELS_ENABLED) channelSessions.set(instance_id, server);

      // Provide context: active channels and online instances
      const channels = await db.listChannelsWithActivity();
      const activeChannels = channels.filter(c => c.message_count > 0);
      const channelSummary = activeChannels.length > 0
        ? "\n\nActive channels:\n" + activeChannels.map(c =>
            `  #${c.name} (${c.message_count} msgs, last: ${c.last_message_at})${c.description ? ` - ${c.description}` : ""}`
          ).join("\n")
        : "\n\nNo active channels yet. Create a topic-specific channel with 'create_channel', or use 'general' for initial contact.";

      await db.markStaleOffline(STALE_THRESHOLD_SECONDS);
      const instances = await db.listInstances();
      const others = instances.filter(i => i.instance_id !== instance_id && i.status === "online");
      const instanceSummary = others.length > 0
        ? "\n\nOnline instances:\n" + others.map(i =>
            `  ${i.instance_id}${i.description ? ` - ${i.description}` : ""}`
          ).join("\n")
        : "\n\nNo other instances online.";

      return {
        content: [{ type: "text", text: `Registered as "${instance_id}".${channelSummary}${instanceSummary}\n\nNEXT STEPS: Call 'list_channels' to find the right channel for your work, then 'check_messages' on that channel. Do NOT default to 'general' if a more specific channel exists.` }],
      };
    }
  );

  server.tool(
    "send_message",
    "Send a message to a channel for other instances to read. IMPORTANT: Before your first send in a session, call list_channels or find_channel to pick the right channel. Do NOT default to 'general' without checking — there is usually a more specific channel. If you move to a different channel mid-conversation, notify your collaborators in the old channel first.",
    {
      channel: z.string().default("general").describe("Channel to post to. Check list_channels first — only use 'general' if no better channel exists"),
      sender: z.string().describe("Your instance_id"),
      content: z.string().describe("The message content"),
      message_type: z.enum(["message", "request", "response", "status", "handoff", "done"]).default("message")
        .describe("Type: message, request, response, status, handoff, done (signals no more replies)"),
      in_reply_to: z.number().optional().describe("Message ID this is replying to"),
    },
    async ({ channel, sender, content, message_type, in_reply_to }) => {
      if (planChecker) {
        const check = await planChecker("send_message");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }
      const normalized = normalizeChannelName(channel);
      if (!normalized) {
        return { content: [{ type: "text", text: `Invalid channel name "${channel}". Use lowercase letters, numbers, and hyphens.` }] };
      }

      // Check if this channel already exists
      const existingChannels = await db.listChannels();
      const exists = existingChannels.some(c => c.name === normalized);
      let warning = "";

      if (!exists) {
        // Find similar existing channels to warn about
        const similar = existingChannels.filter(c => {
          const n = c.name;
          return n.includes(normalized) || normalized.includes(n)
            || levenshteinClose(n, normalized);
        });
        if (similar.length > 0) {
          warning = `\n\n⚠️ New channel #${normalized} created. Did you mean one of these? ${similar.map(c => `#${c.name}`).join(", ")}`;
        }
      }

      await db.createChannel(normalized, null);
      touchHeartbeat();
      const id = await db.sendMessage(normalized, sender, content, message_type, in_reply_to || null);
      // Channels push: deliver inbound to instances SUBSCRIBED to this channel (event-driven).
      if (CHANNELS_ENABLED) {
        const pushText = `[#${normalized}] ${sender}: ${content}`;
        for (const instId of subscribersOf(normalized)) {
          if (instId === sender) continue;
          const sess = channelSessions.get(instId);
          if (!sess) continue; // subscribed but no live session right now
          try {
            sess.server.notification({
              method: "notifications/claude/channel",
              params: { content: pushText, meta: { channel: normalized, sender, id: String(id), message_type } },
            });
          } catch { /* best-effort push; never break a send on push failure */ }
        }
      }
      const nameNote = normalized !== channel ? ` (normalized from "${channel}")` : "";
      const doneHint = message_type === "response"
        ? `\n\n💡 If this is your final reply, send a follow-up "done" message so the other instance stops polling.`
        : "";
      return {
        content: [{ type: "text", text: `Message #${id} sent to #${normalized}${nameNote} as "${sender}" [${message_type}]${warning}${doneHint}` }],
      };
    }
  );

  server.tool(
    "subscribe",
    "Register interest in a channel. Whether this gets you live delivery depends on how YOUR session was launched. Channels-enabled session (Claude Code started via cc-listen, or with --channels / --dangerously-load-development-channels naming this server): new messages ARE injected into your context live and will wake you when idle. Any OTHER session (the default): your client drops these notifications — subscribing alone is NOT listening, you will never see a message because of it, and your only options are blocking inside wait_for_reply or polling check_messages on a later turn. Only tell the user you are receiving live messages if you KNOW the session was launched channels-enabled; if unsure, assume it was not. Call 'register' first with the same instance_id.",
    {
      channel: z.string().describe("Channel to subscribe to (e.g. 'general', 'cro-compare')"),
      instance_id: z.string().describe("Your instance_id (must match your register)"),
    },
    async ({ channel, instance_id }) => {
      const normalized = normalizeChannelName(channel);
      if (!normalized) {
        return { content: [{ type: "text", text: `Invalid channel name "${channel}". Use lowercase letters, numbers, and hyphens.` }] };
      }
      currentInstanceId = instance_id;
      touchHeartbeat();
      if (CHANNELS_ENABLED) {
        channelSessions.set(instance_id, server);
        if (!channelSubscriptions.has(normalized)) channelSubscriptions.set(normalized, new Set());
        channelSubscriptions.get(normalized).add(instance_id);
      }
      const honesty = `⚠️ IMPORTANT — whether you will actually receive messages depends on how THIS session was launched. Channels-enabled (cc-listen, or --channels / --dangerously-load-development-channels): live delivery is real — messages will be injected into your context, even while idle. Any other session (assume this if unsure): nothing is delivered passively, and once your turn ends you are deaf to this channel — do NOT tell the user you are "listening", "watching", "standing by", or "staying subscribed"; either call wait_for_reply NOW and stay blocked inside it, or say plainly that you will only see new messages the next time they prompt you and you poll check_messages.`;
      const note = CHANNELS_ENABLED
        ? `Subscribed "${instance_id}" to #${normalized} (interest registered; server-side notifications enabled, but turn-based clients drop them).\n\n${honesty}`
        : `Subscribed "${instance_id}" to #${normalized} (interest registered; server push disabled — CHANNELS_ENABLED is off).\n\n${honesty}`;
      return { content: [{ type: "text", text: note }] };
    }
  );

  server.tool(
    "unsubscribe",
    "Remove this instance's subscription record for a channel. You can still read the channel via check_messages / wait_for_reply.",
    {
      channel: z.string().describe("Channel to unsubscribe from"),
      instance_id: z.string().describe("Your instance_id"),
    },
    async ({ channel, instance_id }) => {
      const normalized = normalizeChannelName(channel);
      const set = channelSubscriptions.get(normalized);
      if (set) set.delete(instance_id);
      return { content: [{ type: "text", text: `Unsubscribed "${instance_id}" from #${normalized}. Polling via check_messages / wait_for_reply still works.` }] };
    }
  );

  server.tool(
    "check_messages",
    "Check for new messages in a channel. Use after_id to only get messages newer than a specific message. If you're unsure which channel to check, call list_channels first.",
    {
      channel: z.string().default("general").describe("Channel to check — call list_channels first if unsure"),
      after_id: z.number().optional().describe("Only show messages after this ID (for polling)"),
      limit: z.number().default(20).describe("Max messages to return"),
      instance_id: z.string().optional().describe("Your instance_id - filters out your own messages"),
    },
    async ({ channel, after_id, limit, instance_id }) => {
      const normalized = normalizeChannelName(channel);
      touchHeartbeat();
      let messages;
      if (instance_id && after_id !== undefined) {
        const floor = await resolveFloor(normalized, instance_id, after_id);
        messages = await db.getUnread(normalized, floor, instance_id);
      } else if (after_id !== undefined) {
        messages = await db.getMessagesSince(normalized, after_id);
      } else {
        messages = await db.getMessages(normalized, limit);
        messages.reverse();
      }

      if (messages.length === 0) {
        return { content: [{ type: "text", text: `No ${after_id !== undefined ? "new " : ""}messages in #${normalized}.` }] };
      }

      const formatted = messages.map((m) =>
        `#${m.id} [${m.message_type}] ${m.sender} (${m.created_at})${m.in_reply_to ? ` (reply to #${m.in_reply_to})` : ""}${m.reply_count > 0 ? ` [${m.reply_count} replies]` : ""}:\n${m.content}`
      ).join("\n\n---\n\n");

      const lastId = messages[messages.length - 1].id;
      await advanceCursor(normalized, instance_id, lastId);
      return {
        content: [{ type: "text", text: `${messages.length} message(s) in #${normalized}:\n\n${formatted}\n\n---\nLast message ID: ${lastId} (use as after_id to poll for new messages)\nReminder: unless this session was launched channels-enabled (cc-listen / --channels), you only see messages when you poll. If this collaboration is ongoing, either block in wait_for_reply now or tell the user you'll check again next time they prompt you — do not claim to be "listening".` }],
      };
    }
  );

  server.tool(
    "wait_for_reply",
    "Block inside this tool call, polling a channel until a new message arrives from another instance. Persistent by default — the call itself keeps polling across cycles until a message arrives, a 'done' signal is received, or max_wait_minutes is reached (default 24h); pass persistent: false for one-shot polling.\n\nBEING BACKGROUNDED IS EXPECTED AND IS THE LISTEN: Claude Code auto-backgrounds any MCP call that runs past ~120s. When that happens this wait keeps running and genuinely WAKES your session when a message arrives — that is real listening, not a failure. So 'a background wait is live and will wake me when a message arrives (until <expiry>)' is a TRUE statement. Once this call RETURNS (message, done, or ceiling) the wait is over: you are deaf until you start another. (Sessions launched channels-enabled via cc-listen / --channels get live pushes without this call.)\n\nROLE: pass role='parked' if you are a background/worker agent who wants to keep listening but must never pull an active coordinator out of ITS wait. Parked waiters still receive every message; they just don't count as a mutual-wait party. Default role='active'.\n\nONE WAIT PER CHANNEL: starting a new wait on a channel you're already waiting on supersedes the old one (the old call returns a clear 'superseded' result). No stacking.",
    {
      channel: z.string().default("general").describe("Channel to poll"),
      after_id: z.number().describe("Only look for messages after this ID"),
      instance_id: z.string().describe("Your instance_id (filters out your own messages)"),
      timeout_seconds: z.number().default(90).describe("Seconds per poll cycle (default: 90)"),
      poll_interval_seconds: z.number().default(5).describe("Seconds between polls within a cycle (default: 5)"),
      persistent: z.boolean().default(true).describe("Keep listening across poll cycles until a message arrives (default: true). Pass false for one-shot polling."),
      max_wait_minutes: z.number().default(1440).describe("Hard ceiling in minutes for persistent mode (default: 1440 = 24h). An idle waiter costs one DB poll every few seconds and zero tokens until woken."),
      role: z.enum(["active", "parked"]).default("active").describe("'active' (default) = a normal coordinator; counts as a mutual-wait party. 'parked' = a background listener that receives every message but never counts as a mutual-wait party, so it can never bounce an active waiter out of its wait and never yields itself."),
    },
    async ({ channel, after_id, instance_id, timeout_seconds, poll_interval_seconds, persistent, max_wait_minutes, role }, extra) => {
      const normalized = normalizeChannelName(channel);
      const tenantKey = await getTenantKey();
      const waiterKey = `${tenantKey}\0${normalized}\0${instance_id}`;
      const token = randomUUID();
      const start = Date.now();
      const hardDeadline = start + max_wait_minutes * 60 * 1000;
      const KEEPALIVE_INTERVAL_MS = 30_000;
      let lastKeepalive = Date.now();
      let pollCount = 0;
      const isParked = role === "parked";

      // === SaaS insurance: reject if this tenant is already at its concurrent-wait ceiling ===
      if (MUTUAL_WAIT_DETECT) {
        let tenantWaits = 0;
        for (const key of activeWaiters.keys()) {
          if (key.split('\0')[0] === tenantKey) tenantWaits++;
        }
        // A superseding wait for an existing (tenant,channel,instance) key doesn't add load —
        // only count as over-ceiling if this is a genuinely new key.
        if (tenantWaits >= MAX_WAITS_PER_TENANT && !activeWaiters.has(waiterKey)) {
          return {
            content: [{ type: "text", text: `⚠️ Too many concurrent waits for this account (${tenantWaits}/${MAX_WAITS_PER_TENANT}). Let an existing wait finish, or poll with check_messages instead.` }],
          };
        }
      }

      // === Register this waiter (for late-waiter-yields detection) ===
      // One wait per (tenant, channel, instance): overwriting the map entry with a fresh token
      // supersedes any prior wait on the same key — the old loop detects the token change and returns.
      if (MUTUAL_WAIT_DETECT) {
        activeWaiters.set(waiterKey, { startedAt: start, token, role });
        logWaitEvent('wait_enter', { channel: normalized, instance: instance_id, reason: role });
      }

      async function sendKeepalive() {
        if (!extra?.sendNotification) return;
        const elapsed = Math.round((Date.now() - start) / 1000);
        try {
          if (extra._meta?.progressToken !== undefined) {
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken: extra._meta.progressToken,
                progress: elapsed,
                total: max_wait_minutes * 60,
                message: `Polling #${normalized} (${elapsed}s, ${pollCount} checks)`,
              },
            });
          } else {
            await extra.sendNotification({
              method: "notifications/message",
              params: { level: "debug", data: `Polling #${normalized} (${elapsed}s, ${pollCount} checks)`, logger: "wait_for_reply" },
            });
          }
        } catch { /* connection may already be dead — ignore */ }
        lastKeepalive = Date.now();
      }

      async function checkYield() {
        // Run late-waiter-yields detector to break mutual-wait (D2)
        if (!MUTUAL_WAIT_DETECT) return null; // detector disabled

        // A parked waiter is not a mutual-wait party — it never yields.
        if (isParked) return null;

        const elapsedMs = Date.now() - start;
        const otherWaiters = Array.from(activeWaiters.entries())
          .filter(([key, entry]) => {
            const [tk, ch, inst] = key.split('\0');
            // Exclude parked peers: they receive delivery but never count as a mutual-wait party,
            // so they must never cause an active waiter to yield.
            return tk === tenantKey && ch === normalized && inst !== instance_id && entry.role !== 'parked';
          });

        // Drop stale / dead peer waiters and gather live peer info.
        // Ghost detection is heartbeat-based (STALE_THRESHOLD), NOT wait-age: with a 24h ceiling a
        // wait-age check would keep a crashed peer "alive" for 24h. A live waiter heartbeats every
        // poll; a crashed one stops, so peerOnline goes false within STALE_THRESHOLD_SECONDS.
        const livePeers = [];
        for (const [key, { startedAt }] of otherWaiters) {
          const [, , peerId] = key.split('\0');

          const peerInst = await db.getInstance(peerId);
          const peerOnline = peerInst?.status === 'online' && (Date.now() - new Date(peerInst.last_seen).getTime()) / 1000 < STALE_THRESHOLD_SECONDS;

          if (peerOnline) {
            livePeers.push({ peerId, peerWaitMs: Date.now() - startedAt });
          } else {
            // Peer's heartbeat is stale (crashed or gone) — evict from the waiter pool.
            activeWaiters.delete(key);
          }
        }

        // Use pure function to decide whether to yield
        const yieldToPeerId = decideYield({
          myId: instance_id,
          myWaitMs: elapsedMs,
          peers: livePeers,
          graceMs: GRACE_MS
        });

        if (yieldToPeerId) {
          logWaitEvent('mutual_wait_yield', {
            channel: normalized,
            instance: instance_id,
            elapsedMs,
            reason: `peer ${yieldToPeerId} waiting`
          });
          return {
            content: [{
              type: "text",
              text: `🔓 MUTUAL WAIT: peer "${yieldToPeerId}" is also waiting on #${normalized}, so neither of you will speak first. Send a message to break the tie instead of waiting. (If "${yieldToPeerId}" is a background/worker agent that should never bounce you, have it wait with role='parked'.)`
            }]
          };
        }

        return null; // No yield condition met
      }

      // Snapshot the poll floor ONCE at entry and never re-resolve it. If a sibling turn's
      // check_messages advances the durable cursor mid-wait, re-resolving would raise our floor
      // and skip the messages between the old and new floor (the cursor-swallow bug). Snapshotting
      // re-permits duplicate delivery within THIS instance (a message may be seen by both
      // check_messages and this wait) — hearing twice beats sleeping through. Cross-instance
      // de-dup is unaffected: floors are per-instance.
      const floor = await resolveFloor(normalized, instance_id, after_id);

      try {
        while (true) {
          const cycleDeadline = Date.now() + timeout_seconds * 1000;

          while (Date.now() < cycleDeadline && Date.now() < hardDeadline) {
            // One-wait enforcement: if a newer wait for the same (tenant, channel, instance) has
            // replaced our activeWaiters entry, this wait has been superseded — return cleanly so
            // waits never stack or tangle.
            if (MUTUAL_WAIT_DETECT) {
              const cur = activeWaiters.get(waiterKey);
              if (cur && cur.token !== token) {
                logWaitEvent('wait_exit', { channel: normalized, instance: instance_id, elapsedMs: Date.now() - start, reason: 'superseded' });
                return {
                  content: [{ type: "text", text: `This wait on #${normalized} was superseded by a newer wait_for_reply from "${instance_id}" on the same channel. Only the newest wait stays live — this one has stopped, nothing was lost, and the newer wait is listening.` }],
                };
              }
            }
            touchHeartbeat();
            pollCount++;
            const messages = await db.getUnread(normalized, floor, instance_id);

            if (messages.length > 0) {
              const hasDone = messages.some((m) => m.message_type === "done");
              const formatted = messages.map((m) =>
                `#${m.id} [${m.message_type}] ${m.sender} (${m.created_at})${m.in_reply_to ? ` (reply to #${m.in_reply_to})` : ""}:\n${m.content}`
              ).join("\n\n---\n\n");
              const lastId = messages[messages.length - 1].id;
              await advanceCursor(normalized, instance_id, lastId);
              logWaitEvent('wait_exit', {
                channel: normalized,
                instance: instance_id,
                elapsedMs: Date.now() - start,
                reason: 'message_received'
              });
              return {
                content: [{ type: "text", text: `${messages.length} new message(s) in #${normalized}:\n\n${formatted}\n\n---\nLast message ID: ${lastId}${hasDone ? "\n\nThe other instance signaled DONE -- no further replies expected." : ""}` }],
              };
            }

            // Keep SSE stream alive through proxies
            if (Date.now() - lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
              await sendKeepalive();
            }

            // Run checkYield inside inner loop once elapsed >= GRACE (for responsiveness)
            if (MUTUAL_WAIT_DETECT && (Date.now() - start) >= GRACE_MS) {
              const yieldResult = await checkYield();
              if (yieldResult) {
                logWaitEvent('wait_exit', {
                  channel: normalized,
                  instance: instance_id,
                  elapsedMs: Date.now() - start,
                  reason: 'mutual_wait_yield'
                });
                return yieldResult;
              }
            }

            await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
          }

          // Cycle finished with no messages — check for late-waiter-yields before continuing
          if (MUTUAL_WAIT_DETECT) {
            const yieldResult = await checkYield();
            if (yieldResult) {
              logWaitEvent('wait_exit', {
                channel: normalized,
                instance: instance_id,
                elapsedMs: Date.now() - start,
                reason: 'mutual_wait_yield'
              });
              return yieldResult;
            }
          }

          // If not persistent, return (non-persistent timeout)
          if (!persistent) {
            logWaitEvent('wait_exit', {
              channel: normalized,
              instance: instance_id,
              elapsedMs: Date.now() - start,
              reason: 'timeout_nonpersistent'
            });
            return {
              content: [{ type: "text", text: `No new messages in #${normalized} after waiting ${timeout_seconds}s. The other instance may be busy or offline, or the other instance may also be waiting — send a message to break the tie instead of waiting. You can try again, send a message to prompt them, or check list_instances.` }],
            };
          }

          // Persistent mode: check hard ceiling
          if (Date.now() >= hardDeadline) {
            logWaitEvent('wait_exit', {
              channel: normalized,
              instance: instance_id,
              elapsedMs: Date.now() - start,
              reason: 'hard_ceiling'
            });
            const elapsed = Math.round((Date.now() - start) / 60000);
            return {
              content: [{ type: "text", text: `No new messages in #${normalized} after ${elapsed} minute(s). The other instance may also be waiting — send a message rather than waiting again, or check list_instances.` }],
            };
          }

          // Persistent mode: restart cycle
          await sendKeepalive();
        }
      } finally {
        // Deregister from activeWaiters if token matches (protects overlapping same-instance waits)
        if (MUTUAL_WAIT_DETECT) {
          const entry = activeWaiters.get(waiterKey);
          if (entry && entry.token === token) {
            activeWaiters.delete(waiterKey);
          }
        }
      }
    }
  );

  server.tool(
    "get_replies",
    "Get all replies to a specific message.",
    { message_id: z.number().describe("The message ID to get replies for") },
    async ({ message_id }) => {
      const parent = await db.getMessage(message_id);
      if (!parent) return { content: [{ type: "text", text: `Message #${message_id} not found.` }] };

      const replies = await db.getReplies(message_id);
      if (replies.length === 0) return { content: [{ type: "text", text: `No replies to message #${message_id}.` }] };

      const formatted = replies.map((r) => `#${r.id} [${r.message_type}] ${r.sender} (${r.created_at}):\n${r.content}`).join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `Original #${parent.id} from ${parent.sender}: ${parent.content}\n\n${replies.length} replies:\n\n${formatted}` }],
      };
    }
  );

  server.tool(
    "create_channel",
    "Create a named channel for organizing communication.",
    {
      name: z.string().describe("Channel name (lowercase, hyphens, no spaces)"),
      description: z.string().optional().describe("What this channel is for"),
    },
    async ({ name, description }) => {
      if (planChecker) {
        const check = await planChecker("create_channel");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }
      const normalized = normalizeChannelName(name);
      if (!normalized) {
        return { content: [{ type: "text", text: `Invalid channel name "${name}". Use lowercase letters, numbers, and hyphens.` }] };
      }

      // Check for similar existing channels
      const existing = await db.listChannels();
      const similar = existing.filter(c => c.name !== normalized && (
        c.name.includes(normalized) || normalized.includes(c.name) || levenshteinClose(c.name, normalized)
      ));

      await db.createChannel(normalized, description || null);
      const nameNote = normalized !== name ? ` (normalized from "${name}")` : "";
      const similarNote = similar.length > 0
        ? `\nNote: similar channels exist: ${similar.map(c => `#${c.name}`).join(", ")}`
        : "";
      return { content: [{ type: "text", text: `Channel #${normalized} created${nameNote}.${description ? ` Purpose: ${description}` : ""}${similarNote}` }] };
    }
  );

  server.tool(
    "list_channels",
    "List all channels with activity stats (message count, last activity, participants). CALL THIS before your first send_message in any session to find the right channel.",
    {},
    async () => {
      const channels = await db.listChannelsWithActivity();
      if (channels.length === 0) return { content: [{ type: "text", text: "No channels exist yet." }] };
      const formatted = channels.map((c) => {
        const parts = [`#${c.name}`];
        if (c.description) parts.push(`- ${c.description}`);
        if (c.message_count > 0) {
          parts.push(`(${c.message_count} msgs, last: ${c.last_message_at})`);
          if (c.active_senders) parts.push(`[participants: ${c.active_senders}]`);
        } else {
          parts.push("(empty)");
        }
        return parts.join(" ");
      }).join("\n");
      return { content: [{ type: "text", text: `Channels:\n${formatted}` }] };
    }
  );

  server.tool(
    "find_channel",
    "Search for channels by keyword. Matches against channel names and descriptions. Use this when you're not sure which channel to use.",
    {
      query: z.string().describe("Keyword to search for in channel names and descriptions"),
    },
    async ({ query }) => {
      const channels = await db.findChannels(query);
      if (channels.length === 0) {
        // Suggest listing all channels
        const allChannels = await db.listChannels();
        const suggestion = allChannels.length > 0
          ? `\n\nAvailable channels: ${allChannels.map(c => `#${c.name}`).join(", ")}`
          : "\n\nNo channels exist yet. Create one with create_channel.";
        return { content: [{ type: "text", text: `No channels matching "${query}".${suggestion}` }] };
      }
      const formatted = channels.map(c => {
        const parts = [`#${c.name}`];
        if (c.description) parts.push(`- ${c.description}`);
        if (c.message_count > 0) parts.push(`(${c.message_count} msgs, last: ${c.last_message_at})`);
        else parts.push("(empty)");
        return parts.join(" ");
      }).join("\n");
      return { content: [{ type: "text", text: `${channels.length} channel(s) matching "${query}":\n${formatted}` }] };
    }
  );

  server.tool("list_instances", "See all registered Claude Code instances.", {}, async () => {
    touchHeartbeat();
    await db.markStaleOffline(STALE_THRESHOLD_SECONDS);
    const instances = await db.listInstances();
    if (instances.length === 0) return { content: [{ type: "text", text: "No instances registered yet." }] };
    const formatted = instances.map((i) =>
      `${i.instance_id} [${i.status}] - last seen: ${i.last_seen}${i.description ? ` - ${i.description}` : ""}`
    ).join("\n");
    return { content: [{ type: "text", text: `Registered instances:\n${formatted}` }] };
  });

  server.tool(
    "search_messages",
    "Search message content across all channels.",
    {
      query: z.string().describe("Text to search for"),
      limit: z.number().default(10).describe("Max results"),
    },
    async ({ query, limit }) => {
      const messages = await db.searchMessages(query, limit);
      if (messages.length === 0) return { content: [{ type: "text", text: `No messages matching "${query}".` }] };
      const formatted = messages.map((m) =>
        `#${m.id} [#${m.channel}] ${m.sender} (${m.created_at}) [${m.message_type}]:\n${m.content}`
      ).join("\n\n---\n\n");
      return { content: [{ type: "text", text: `${messages.length} result(s) for "${query}":\n\n${formatted}` }] };
    }
  );

  server.tool(
    "share_data",
    "Store large data (tables, plans, analysis) in a shared store instead of packing it into a message. Other instances can retrieve it by key. Use this for anything over ~500 chars.",
    {
      key: z.string().describe("Unique key for this data (e.g., 'cannibal-analysis', 'faraday-plan')"),
      content: z.string().describe("The data content to share"),
      sender: z.string().describe("Your instance_id"),
      description: z.string().optional().describe("Brief description of what this data is"),
    },
    async ({ key, content, sender, description }) => {
      if (planChecker) {
        const check = await planChecker("share_data");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }
      touchHeartbeat();
      await db.shareData(key, content, sender, description || null);
      const sizeKb = (Buffer.byteLength(content) / 1024).toFixed(1);
      return {
        content: [{ type: "text", text: `Shared data stored as "${key}" (${sizeKb} KB). Other instances can retrieve it with get_shared_data.` }],
      };
    }
  );

  server.tool(
    "get_shared_data",
    "Retrieve data that another instance shared via share_data.",
    {
      key: z.string().describe("The key of the shared data to retrieve"),
    },
    async ({ key }) => {
      touchHeartbeat();
      const data = await db.getSharedData(key);
      if (!data) return { content: [{ type: "text", text: `No shared data found for key "${key}". Use list_shared_data to see available keys.` }] };
      return {
        content: [{ type: "text", text: `Shared data "${key}" (by ${data.created_by}, ${data.created_at})${data.description ? ` -- ${data.description}` : ""}:\n\n${data.content}` }],
      };
    }
  );

  server.tool(
    "list_shared_data",
    "List all shared data keys with their descriptions and sizes.",
    {},
    async () => {
      touchHeartbeat();
      const items = await db.listSharedData();
      if (items.length === 0) return { content: [{ type: "text", text: "No shared data stored yet." }] };
      const formatted = items.map((d) => {
        const sizeKb = (Number(d.size_bytes) / 1024).toFixed(1);
        return `"${d.key}" (${sizeKb} KB, by ${d.created_by}, ${d.created_at})${d.description ? ` -- ${d.description}` : ""}`;
      }).join("\n");
      return { content: [{ type: "text", text: `Shared data:\n${formatted}` }] };
    }
  );

  // --- MCP Prompt: Collaboration Protocol ---
  // Delivered automatically to any connected client (Claude Desktop, Claude.ai, Claude Code)

  server.prompt(
    "cross-claude-protocol",
    "Best practices for collaborating with other AI instances via Cross-Claude MCP",
    () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `# Cross-Claude MCP — Collaboration Protocol

## Session Startup (do this every time)
1. Call \`register\` with a descriptive instance_id (e.g., "builder", "reviewer", "data-analyst")
2. Call \`list_channels\` to see all active channels
3. Pick the most relevant channel — only use \`general\` if nothing more specific exists
4. Call \`check_messages\` on that channel to see what's been discussed

## Channel Discipline
- NEVER send to a channel without calling \`list_channels\` or \`find_channel\` first
- Before creating a new channel, check if one already exists with \`find_channel\`
- If you switch channels mid-conversation, notify collaborators in the old channel first
- Stay in one channel per conversation thread

## Message Protocol
- After sending a \`request\` or message expecting a reply, call \`wait_for_reply\` immediately
- When a \`done\` message is received, stop polling
- ALWAYS send a separate \`done\` message when you're finished — a \`response\` alone does NOT signal completion
- For long-running tasks (>30s), send periodic \`status\` messages
- For large data (>500 chars), use \`share_data\` to store by key, then reference the key in a message
- Use descriptive message_type values: request, response, handoff, status, done
- Keep your instance_id consistent within a session

## Connection Behavior
- \`wait_for_reply\` is persistent by default — it keeps listening until a message arrives, a \`done\` is received, or \`max_wait_minutes\` (default 24h) elapses
- Being auto-backgrounded past ~120s is EXPECTED and IS the listen: a backgrounded wait keeps running and wakes your session when a message arrives. "A background wait is live and will wake me when a message arrives (until <expiry>)" is a true statement; once the call returns you are deaf until you start another wait
- ONE wait per channel: starting a new wait on a channel you're already waiting on supersedes the old one — no stacking
- ROLES: an active coordinator waits with \`role='active'\` (default); a background/worker agent that must never pull the coordinator out of its wait should use \`role='parked'\` — parked agents still receive every message but never count as a mutual-wait party
- Do NOT treat silence as disconnection — the other instance may be working on a complex task
- For quick one-shot messages (e.g., "just tell them X"), pass \`persistent: false\` to \`wait_for_reply\`
- Only stop listening when: you receive a \`done\` message, the user says to disconnect, or you've sent your own \`done\``,
        },
      }],
    })
  );

  // Return cleanup function for shutdown
  return () => {
    if (currentInstanceId) {
      db.markOffline(currentInstanceId);
      if (CHANNELS_ENABLED) {
        channelSessions.delete(currentInstanceId);
        for (const set of channelSubscriptions.values()) set.delete(currentInstanceId);
      }
    }
  };
}
