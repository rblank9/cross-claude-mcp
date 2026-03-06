#!/usr/bin/env node

/**
 * Cross-Claude MCP Server
 *
 * Modes (auto-detected):
 * - Local (stdio + SQLite): when no PORT env var is set
 * - Remote (HTTP + PostgreSQL): when PORT and DATABASE_URL are set (Railway)
 *
 * Remote endpoints:
 * - POST /mcp — Streamable HTTP (Claude.ai, Claude Code via mcp-remote, Claude Desktop)
 * - GET  /mcp — SSE stream for Streamable HTTP
 * - GET  /sse — Legacy SSE transport (backward compat)
 * - POST /messages — Legacy SSE message endpoint
 * - GET  /health — Health check
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDB } from "./db.mjs";

const STALE_THRESHOLD_SECONDS = 120;

// --- Tool Registration (shared between all transport modes) ---

function registerTools(server, db) {
  // Track instance per-connection for shutdown cleanup
  let currentInstanceId = null;

  function touchHeartbeat() {
    if (!currentInstanceId) return;
    try { db.heartbeat(currentInstanceId); } catch { /* ignore */ }
  }

  server.tool(
    "register",
    "Register this Claude Code instance with an identity. Call this first before using other tools.",
    {
      instance_id: z.string().describe("Unique name for this instance (e.g., 'alice', 'builder', 'reviewer')"),
      description: z.string().optional().describe("What this instance is working on"),
    },
    async ({ instance_id, description }) => {
      if (currentInstanceId && currentInstanceId !== instance_id) {
        await db.markOffline(currentInstanceId);
      }
      currentInstanceId = instance_id;
      await db.registerInstance(instance_id, description || null);
      return {
        content: [{ type: "text", text: `Registered as "${instance_id}". You can now send and receive messages. Use 'check_messages' to see if anyone has sent you anything.` }],
      };
    }
  );

  server.tool(
    "send_message",
    "Send a message to a channel for other Claude Code instances to read.",
    {
      channel: z.string().default("general").describe("Channel to post to (default: 'general')"),
      sender: z.string().describe("Your instance_id"),
      content: z.string().describe("The message content"),
      message_type: z.enum(["message", "request", "response", "status", "handoff", "done"]).default("message")
        .describe("Type: message, request, response, status, handoff, done (signals no more replies)"),
      in_reply_to: z.number().optional().describe("Message ID this is replying to"),
    },
    async ({ channel, sender, content, message_type, in_reply_to }) => {
      await db.createChannel(channel, null);
      touchHeartbeat();
      const id = await db.sendMessage(channel, sender, content, message_type, in_reply_to || null);
      return {
        content: [{ type: "text", text: `Message #${id} sent to #${channel} as "${sender}" [${message_type}]` }],
      };
    }
  );

  server.tool(
    "check_messages",
    "Check for new messages in a channel. Use after_id to only get messages newer than a specific message.",
    {
      channel: z.string().default("general").describe("Channel to check"),
      after_id: z.number().optional().describe("Only show messages after this ID (for polling)"),
      limit: z.number().default(20).describe("Max messages to return"),
      instance_id: z.string().optional().describe("Your instance_id - filters out your own messages"),
    },
    async ({ channel, after_id, limit, instance_id }) => {
      touchHeartbeat();
      let messages;
      if (instance_id && after_id !== undefined) {
        messages = await db.getUnread(channel, after_id, instance_id);
      } else if (after_id !== undefined) {
        messages = await db.getMessagesSince(channel, after_id);
      } else {
        messages = await db.getMessages(channel, limit);
        messages.reverse();
      }

      if (messages.length === 0) {
        return { content: [{ type: "text", text: `No ${after_id !== undefined ? "new " : ""}messages in #${channel}.` }] };
      }

      const formatted = messages.map((m) =>
        `#${m.id} [${m.message_type}] ${m.sender} (${m.created_at})${m.in_reply_to ? ` (reply to #${m.in_reply_to})` : ""}${m.reply_count > 0 ? ` [${m.reply_count} replies]` : ""}:\n${m.content}`
      ).join("\n\n---\n\n");

      const lastId = messages[messages.length - 1].id;
      return {
        content: [{ type: "text", text: `${messages.length} message(s) in #${channel}:\n\n${formatted}\n\n---\nLast message ID: ${lastId} (use as after_id to poll for new messages)` }],
      };
    }
  );

  server.tool(
    "wait_for_reply",
    "Poll a channel until a new message arrives from another instance, or until timeout. Stops early on 'done' messages.",
    {
      channel: z.string().default("general").describe("Channel to poll"),
      after_id: z.number().describe("Only look for messages after this ID"),
      instance_id: z.string().describe("Your instance_id (filters out your own messages)"),
      timeout_seconds: z.number().default(90).describe("Max seconds to wait (default: 90)"),
      poll_interval_seconds: z.number().default(5).describe("Seconds between polls (default: 5)"),
    },
    async ({ channel, after_id, instance_id, timeout_seconds, poll_interval_seconds }) => {
      const deadline = Date.now() + timeout_seconds * 1000;

      while (Date.now() < deadline) {
        touchHeartbeat();
        const messages = await db.getUnread(channel, after_id, instance_id);

        if (messages.length > 0) {
          const hasDone = messages.some((m) => m.message_type === "done");
          const formatted = messages.map((m) =>
            `#${m.id} [${m.message_type}] ${m.sender} (${m.created_at})${m.in_reply_to ? ` (reply to #${m.in_reply_to})` : ""}:\n${m.content}`
          ).join("\n\n---\n\n");
          const lastId = messages[messages.length - 1].id;
          return {
            content: [{ type: "text", text: `${messages.length} new message(s) in #${channel}:\n\n${formatted}\n\n---\nLast message ID: ${lastId}${hasDone ? "\n\nThe other instance signaled DONE — no further replies expected." : ""}` }],
          };
        }

        await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
      }

      return {
        content: [{ type: "text", text: `No new messages in #${channel} after waiting ${timeout_seconds}s. The other instance may be busy or offline. You can try again or check list_instances.` }],
      };
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
      await db.createChannel(name, description || null);
      return { content: [{ type: "text", text: `Channel #${name} created.${description ? ` Purpose: ${description}` : ""}` }] };
    }
  );

  server.tool("list_channels", "List all available channels.", {}, async () => {
    const channels = await db.listChannels();
    const formatted = channels.map((c) => `#${c.name}${c.description ? ` - ${c.description}` : ""}`).join("\n");
    return { content: [{ type: "text", text: `Channels:\n${formatted}` }] };
  });

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

  // --- Shared Data tools (for large payloads) ---

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
        content: [{ type: "text", text: `Shared data "${key}" (by ${data.created_by}, ${data.created_at})${data.description ? ` — ${data.description}` : ""}:\n\n${data.content}` }],
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
        return `"${d.key}" (${sizeKb} KB, by ${d.created_by}, ${d.created_at})${d.description ? ` — ${d.description}` : ""}`;
      }).join("\n");
      return { content: [{ type: "text", text: `Shared data:\n${formatted}` }] };
    }
  );

  // Return cleanup function for shutdown
  return () => {
    if (currentInstanceId) {
      db.markOffline(currentInstanceId);
    }
  };
}

// --- Transport: Stdio (local) ---

async function startStdio(db) {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" });
  const cleanup = registerTools(server, db);

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => { cleanup(); process.exit(0); });
  }
  process.on("exit", cleanup);
  process.stdin.on("end", () => { cleanup(); process.exit(0); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// --- Transport: HTTP (Railway) ---

async function startHTTP(db) {
  const express = (await import("express")).default;
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
  const { randomUUID } = await import("crypto");

  const app = express();
  const PORT = parseInt(process.env.PORT) || 3000;
  const API_TOKEN = process.env.MCP_API_KEY;

  // Bearer token auth middleware (skip for health check)
  app.use((req, res, next) => {
    if (req.path === "/health") return next();

    if (API_TOKEN) {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7)
        : req.query.api_key || null;
      if (!token || token !== API_TOKEN) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }
    next();
  });

  // --- Streamable HTTP transport (Claude.ai, Claude Code, Claude Desktop) ---

  // Map of session ID -> { server, transport, cleanup }
  const sessions = new Map();

  // POST /mcp — handle JSON-RPC messages
  app.post("/mcp", express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    let session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      // New session — create server + transport
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" });
      const cleanup = registerTools(server, db);

      await server.connect(transport);

      // Store session once we know its ID (after handleRequest sets it)
      const sessionEntry = { server, transport, cleanup };

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          cleanup();
          sessions.delete(sid);
        }
      };

      await transport.handleRequest(req, res, req.body);

      // Now the transport has a session ID
      if (transport.sessionId) {
        sessions.set(transport.sessionId, sessionEntry);
      }
      return;
    }

    await session.transport.handleRequest(req, res, req.body);
  });

  // GET /mcp — SSE stream for Streamable HTTP
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      res.status(400).json({ error: "No session. Send POST /mcp first to initialize." });
      return;
    }

    await session.transport.handleRequest(req, res);
  });

  // DELETE /mcp — close session
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const session = sessionId ? sessions.get(sessionId) : null;

    if (session) {
      session.cleanup();
      await session.transport.close();
      sessions.delete(sessionId);
    }
    res.status(200).json({ ok: true });
  });

  // --- Legacy SSE transport (backward compat for older mcp-remote) ---

  const sseTransports = new Map();

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" });
    const cleanup = registerTools(server, db);

    sseTransports.set(transport.sessionId, { server, transport, cleanup });

    transport.onclose = () => {
      cleanup();
      sseTransports.delete(transport.sessionId);
    };

    await server.connect(transport);
    await transport.start();
  });

  app.post("/messages", express.json(), async (req, res) => {
    const sessionId = req.query.sessionId;
    const session = sessionId ? sseTransports.get(sessionId) : null;

    if (!session) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    await session.transport.handlePostMessage(req, res, req.body);
  });

  // --- Health check ---

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      server: "cross-claude-mcp",
      version: "2.0.0",
      sessions: sessions.size,
      sseSessions: sseTransports.size,
    });
  });

  // --- Start ---

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`cross-claude-mcp v2.0.0 listening on port ${PORT}`);
    console.log(`  Streamable HTTP: POST/GET /mcp`);
    console.log(`  Legacy SSE:      GET /sse, POST /messages`);
    console.log(`  Health:          GET /health`);
    console.log(`  Auth:            ${API_TOKEN ? "Bearer token required" : "NONE (set MCP_API_KEY)"}`);
    console.log(`  Database:        ${process.env.DATABASE_URL ? "PostgreSQL" : "SQLite (local)"}`);
  });
}

// --- Main ---

const db = await createDB();

if (process.env.PORT) {
  await startHTTP(db);
} else {
  await startStdio(db);
}
