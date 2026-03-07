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

/**
 * @param {object} db - Database instance (SqliteDB or PostgresDB)
 * @returns {Router}
 */
export function createRestRouter(db) {
  const router = Router();
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
      await db.registerInstance(instance_id, description || null);
      res.json({ ok: true, instance_id });
    } catch (e) { next(e); }
  });

  router.get("/instances", async (req, res, next) => {
    try {
      await db.markStaleOffline(STALE_THRESHOLD_SECONDS);
      const instances = await db.listInstances();
      res.json({ instances });
    } catch (e) { next(e); }
  });

  // --- Channels ---

  router.post("/channels", async (req, res, next) => {
    try {
      const { name, description } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });
      await db.createChannel(name, description || null);
      res.json({ ok: true, channel: name });
    } catch (e) { next(e); }
  });

  router.get("/channels", async (req, res, next) => {
    try {
      const channels = await db.listChannels();
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
      // Auto-create channel if it doesn't exist
      await db.createChannel(channel, null);
      const id = await db.sendMessage(channel, sender, content, message_type, in_reply_to || null);
      res.json({ ok: true, id: Number(id), channel, message_type });
    } catch (e) { next(e); }
  });

  router.get("/messages/:channel", async (req, res, next) => {
    try {
      const { channel } = req.params;
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
      const parent = await db.getMessage(id);
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
      const messages = await db.searchMessages(q, limit);
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

  // --- Error handler ---

  router.use((err, req, res, _next) => {
    console.error("REST API error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return router;
}
