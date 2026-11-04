/**
 * REST API layer for Cross-Claude MCP.
 *
 * Exposes the same message bus functionality as the MCP tools,
 * but via plain REST endpoints that any HTTP client can call —
 * ChatGPT Custom GPTs (Actions), Gemini, open-source agents, curl, etc.
 *
 * Mount: app.use("/api", createRestRouter(db))
 */

import { Router } from "express";
import { STALE_THRESHOLD_SECONDS } from "./tools.mjs";
import { normalizeChannelName } from "./db.mjs";
import { messageEvents } from "./message-events.mjs";
import { scopeRefuse, scopeSendAllowed, nameBound, SCOPE_CONTENT_MAX } from "./scope-guard.mjs";

// Gate 6: scoped (teammate) keys. server.mjs sets req.scope to {channels: Set, prefix} or null when unscoped.
// Fail closed: a scoped key reaches only the routes below; every other route is 403.
const SCOPED_ROUTES = [
  ["POST", /^\/register$/],
  ["POST", /^\/messages$/],
  ["GET", /^\/messages\/[^/]+$/],
  ["GET", /^\/messages\/[^/]+\/[^/]+\/replies$/],
  ["GET", /^\/stream$/],
  ["GET", /^\/channels$/],
  ["GET", /^\/channels\/search$/],
  ["GET", /^\/search$/],
  ["GET", /^\/instances$/],
];
const inScope = (req, channel) => !req.scope || req.scope.channels.has(channel);
const filterScope = (req, rows, field) => (req.scope ? rows.filter((row) => req.scope.channels.has(row[field])) : rows);
const denyScope = (req, res) => scopeRefuse(req, res, "out_of_scope", 403);

/**
 * @param {object} db - Database instance (SqliteDB or PostgresDB)
 * @returns {Router}
 */
export function createRestRouter(db) {
  const router = Router();
  router.use((req, res, next) => {
    if (!req.scope) return next();
    if (SCOPED_ROUTES.some(([method, re]) => method === req.method && re.test(req.path))) return next();
    return denyScope(req, res);
  });
  router.use((req, res, next) => {
    // express.json() should already be applied, but ensure it
    if (req.is("application/json") && !req.body) {
      return res.status(400).json({ error: "Request body must be JSON" });
    }
    next();
  });

  // --- Instances ---

  router.post("/register", async (req, res, next) => {
    try {
      const { instance_id, description } = req.body;
      if (!instance_id) return res.status(400).json({ error: "instance_id is required" });
      if (req.scope && !nameBound(req.scope, instance_id)) return denyScope(req, res);
      await db.registerInstance(instance_id, description || null, null);
      res.json({ ok: true, instance_id });
    } catch (e) { next(e); }
  });

  router.get("/instances", async (req, res, next) => {
    try {
      await db.markStaleOffline(STALE_THRESHOLD_SECONDS);
      const instances = req.scope ? await db.listInstancesPostedIn([...req.scope.channels]) : await db.listInstances();
      res.json({ instances });
    } catch (e) { next(e); }
  });

  // --- Channels ---

  router.post("/channels", async (req, res, next) => {
    try {
      const { name, description } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });
      const normalized = normalizeChannelName(name);
      if (!normalized) return res.status(400).json({ error: `Invalid channel name "${name}"` });
      await db.createChannel(normalized, description || null);
      res.json({ ok: true, channel: normalized });
    } catch (e) { next(e); }
  });

  router.get("/channels", async (req, res, next) => {
    try {
      const channels = filterScope(req, await db.listChannelsWithActivity(), "name");
      res.json({ channels });
    } catch (e) { next(e); }
  });

  router.get("/channels/search", async (req, res, next) => {
    try {
      const { q } = req.query;
      if (!q) return res.status(400).json({ error: "q (query) parameter is required" });
      const channels = filterScope(req, await db.findChannels(q), "name");
      res.json({ channels });
    } catch (e) { next(e); }
  });

  // --- Messages ---

  router.post("/messages", async (req, res, next) => {
    try {
      const { channel = "general", sender, content, message_type = "message", in_reply_to } = req.body;
      if (!sender) return res.status(400).json({ error: "sender is required" });
      if (!content) return res.status(400).json({ error: "content is required" });
      const validTypes = ["message", "request", "response", "status", "handoff", "done"];
      if (!validTypes.includes(message_type)) {
        return res.status(400).json({ error: `message_type must be one of: ${validTypes.join(", ")}` });
      }
      const normalized = normalizeChannelName(channel);
      if (!normalized) return res.status(400).json({ error: `Invalid channel name "${channel}"` });
      if (!inScope(req, normalized)) return denyScope(req, res);
      if (req.scope) {
        if (!nameBound(req.scope, sender)) return denyScope(req, res);
        if (Buffer.byteLength(String(content)) > SCOPE_CONTENT_MAX) return scopeRefuse(req, res, "payload_too_large", 413);
        if (!scopeSendAllowed(req.keyId)) return scopeRefuse(req, res, "rate_limited", 429);
      }
      // Auto-create channel if it doesn't exist
      await db.createChannel(normalized, null);
      const id = await db.sendMessage(normalized, sender, content, message_type, in_reply_to || null);
      res.json({ ok: true, id: Number(id), channel: normalized, message_type });
    } catch (e) { next(e); }
  });

  router.get("/messages/:channel", async (req, res, next) => {
    try {
      const { channel } = req.params;
      if (!inScope(req, channel)) return denyScope(req, res);
      const after_id = req.query.after_id ? parseInt(req.query.after_id) : undefined;
      const instance_id = req.query.instance_id;
      const limit = parseInt(req.query.limit) || 20;

      let messages;
      if (instance_id && after_id !== undefined) {
        messages = await db.getUnread(channel, after_id, instance_id);
      } else if (after_id !== undefined) {
        messages = await db.getMessagesSince(channel, after_id);
      } else {
        messages = await db.getMessages(channel, limit);
        messages.sort((a, b) => a.id - b.id);
      }

      const last_id = messages.length > 0 ? Number(messages[messages.length - 1].id) : null;
      res.json({ messages, last_id });
    } catch (e) { next(e); }
  });

  router.get("/messages/:channel/:id/replies", async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      if (!inScope(req, req.params.channel)) return denyScope(req, res);
      const parent = await db.getMessage(id);
      if (req.scope && (!parent || !inScope(req, parent.channel))) return denyScope(req, res);
      if (!parent) return res.status(404).json({ error: `Message #${id} not found` });
      const replies = await db.getReplies(id);
      res.json({ parent, replies });
    } catch (e) { next(e); }
  });

  router.get("/search", async (req, res, next) => {
    try {
      const { q } = req.query;
      if (!q) return res.status(400).json({ error: "q (query) parameter is required" });
      const limit = parseInt(req.query.limit) || 10;
      const messages = filterScope(req, await db.searchMessages(q, limit), "channel");
      res.json({ messages });
    } catch (e) { next(e); }
  });

  // --- Shared Data ---

  router.post("/data", async (req, res, next) => {
    try {
      const { key, content, sender, description } = req.body;
      if (!key) return res.status(400).json({ error: "key is required" });
      if (!content) return res.status(400).json({ error: "content is required" });
      if (!sender) return res.status(400).json({ error: "sender is required" });
      await db.shareData(key, content, sender, description || null);
      const size_bytes = Buffer.byteLength(content);
      res.json({ ok: true, key, size_bytes });
    } catch (e) { next(e); }
  });

  router.get("/data", async (req, res, next) => {
    try {
      const items = await db.listSharedData();
      res.json({ items });
    } catch (e) { next(e); }
  });

  router.get("/data/:key", async (req, res, next) => {
    try {
      const data = await db.getSharedData(req.params.key);
      if (!data) return res.status(404).json({ error: `No shared data for key "${req.params.key}"` });
      res.json(data);
    } catch (e) { next(e); }
  });

  // --- Live stream (SSE) ---

  router.get("/stream", async (req, res, next) => {
    let cleanup = () => {};
    try {
      const channels = [].concat(req.query.channels ?? []).join(",").split(",")
        .map((c) => normalizeChannelName(c.trim())).filter(Boolean);
      if (channels.length === 0) return res.status(400).json({ error: "channels query parameter is required (comma-separated)" });
      if (channels.length > 20) return res.status(400).json({ error: "at most 20 channels per stream" });
      if (channels.some((c) => !inScope(req, c))) return denyScope(req, res);
      let afterId;
      if (req.query.after_id !== undefined && req.query.after_id !== "") {
        afterId = parseInt(req.query.after_id, 10);
        if (Number.isNaN(afterId)) return res.status(400).json({ error: "after_id must be an integer" });
      }
      const instanceId = typeof req.query.instance_id === "string" && req.query.instance_id ? req.query.instance_id : null;
      const wanted = new Set(channels);
      const heartbeatMs = parseInt(process.env.STREAM_HEARTBEAT_MS, 10) || 15000;

      const formatMessage = (m) => {
        const payload = {
          id: Number(m.id), channel: m.channel, sender: m.sender, content: m.content,
          message_type: m.message_type, in_reply_to: m.in_reply_to ?? null, sender_key_id: m.sender_key_id ?? null, created_at: m.created_at,
        };
        return `id: ${payload.id}\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`;
      };

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      let catchingUp = true;
      const pending = [];
      let lastSentId = afterId ?? null;
      let closed = false;
      // Dedupe by id SET, not by max id: on Postgres two concurrent sends can commit out of
      // id order, so a lower id can arrive after a higher one and must still be delivered.
      const seen = new Set();
      const write = (chunk) => { if (!closed) res.write(chunk); };
      const deliver = (msg) => {
        const id = Number(msg.id);
        if (afterId !== undefined && id <= afterId) return;
        if (seen.has(id)) return;
        seen.add(id);
        if (seen.size > 5000) seen.delete(seen.values().next().value);
        if (lastSentId === null || id > lastSentId) lastSentId = id;
        if (instanceId !== null && msg.sender === instanceId) return;
        write(formatMessage(msg));
      };
      const onMessage = (msg) => {
        if (!wanted.has(msg.channel)) return;
        if (catchingUp) pending.push(msg);
        else deliver(msg);
      };
      messageEvents.on("message", onMessage);
      const heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), heartbeatMs);
      // res "close" (not req): on Node 16+ req emits "close" as soon as the GET body is consumed.
      cleanup = () => {
        if (closed) return;
        closed = true;
        messageEvents.off("message", onMessage);
        clearInterval(heartbeat);
      };
      res.on("close", cleanup);

      let rows = [];
      if (afterId !== undefined) {
        for (const ch of channels) rows = rows.concat(await db.getMessagesSince(ch, afterId));
      }
      rows.sort((a, b) => Number(a.id) - Number(b.id));
      for (const row of rows) deliver(row);
      catchingUp = false;
      pending.sort((a, b) => Number(a.id) - Number(b.id));
      for (const msg of pending.splice(0)) deliver(msg);
      write(`event: ready\ndata: ${JSON.stringify({ last_id: lastSentId ?? null })}\n\n`);
    } catch (e) {
      cleanup();
      if (!res.headersSent) return next(e);
      console.error("REST /stream error:", e);
      res.end();
    }
  });

  // --- Error handler ---

  router.use((err, req, res, _next) => {
    console.error("REST API error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return router;
}
