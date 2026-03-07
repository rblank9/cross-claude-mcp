#!/usr/bin/env node

/**
 * Cross-Claude MCP Server
 *
 * Modes (auto-detected):
 * - Local (stdio + SQLite): when no PORT env var is set
 * - Remote (HTTP + PostgreSQL): when PORT and DATABASE_URL are set (Railway)
 * - SaaS (HTTP + PostgreSQL + Stripe): when STRIPE_SECRET_KEY is also set
 *
 * Remote endpoints:
 * - POST /mcp -- Streamable HTTP (Claude.ai, Claude Code via mcp-remote, Claude Desktop)
 * - GET  /mcp -- SSE stream for Streamable HTTP
 * - GET  /sse -- Legacy SSE transport (backward compat)
 * - POST /messages -- Legacy SSE message endpoint
 * - GET  /health -- Health check
 *
 * SaaS endpoints (only when STRIPE_SECRET_KEY is set):
 * - GET/POST /signup, /login, /logout, /dashboard
 * - POST /api/billing/checkout, /api/billing/portal
 * - POST /api/billing/webhook (raw body)
 * - GET  /admin, /admin/tenants, /admin/tenants/:id
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDB, isSaasMode, TenantDB } from "./db.mjs";

const STALE_THRESHOLD_SECONDS = 120;

// --- Tool Registration (shared between all transport modes) ---
// planChecker is optional — only set in SaaS mode. Called before tool execution.

function registerTools(server, db, planChecker = null) {
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
      if (planChecker) {
        const check = await planChecker("register");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }
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
      if (planChecker) {
        const check = await planChecker("send_message");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }
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
            content: [{ type: "text", text: `${messages.length} new message(s) in #${channel}:\n\n${formatted}\n\n---\nLast message ID: ${lastId}${hasDone ? "\n\nThe other instance signaled DONE -- no further replies expected." : ""}` }],
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
      if (planChecker) {
        const check = await planChecker("create_channel");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }
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
  app.set("trust proxy", 1); // Railway terminates SSL at the edge
  const PORT = parseInt(process.env.PORT) || 3000;
  const saas = isSaasMode();

  // --- Health check + README (no auth, before any middleware) ---

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      server: "cross-claude-mcp",
      version: "2.0.0",
      mode: saas ? "saas" : "standard",
    });
  });

  app.get("/readme", async (req, res) => {
    const { readFileSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const md = readFileSync(join(__dirname, "README.md"), "utf-8");

    const escaped = md
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cross-Claude MCP</title>
<style>body{max-width:800px;margin:40px auto;padding:0 20px;font-family:-apple-system,system-ui,sans-serif;line-height:1.6;color:#333}
code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:0.9em}
pre{background:#f4f4f4;padding:16px;border-radius:6px;overflow-x:auto}
h1{border-bottom:2px solid #eee;padding-bottom:8px}h2{border-bottom:1px solid #eee;padding-bottom:4px;margin-top:2em}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f4f4f4}
li{margin:4px 0}</style></head>
<body><p>${escaped}</p></body></html>`);
  });

  // --- SaaS setup (session, billing webhook with raw body, CSRF, routes) ---
  if (saas) {
    const { createSessionMiddleware, validateCsrf, extractApiKey, resolveTenant } = await import("./auth.mjs");
    const { createWebhookHandler } = await import("./billing.mjs");
    const { createBillingRouter } = await import("./billing.mjs");
    const { createDashboardRouter } = await import("./dashboard.mjs");
    const { createAdminRouter } = await import("./admin.mjs");
    const { checkRateLimit, checkPlanLimits } = await import("./rate-limit.mjs");

    // Stripe webhook MUST be registered before express.json() / urlencoded
    app.post("/api/billing/webhook", express.raw({ type: "application/json" }), createWebhookHandler(db));

    // Session + CSRF middleware (skip for MCP/API paths — they use Bearer token auth)
    const sessionMw = createSessionMiddleware(db.pool);
    const MCP_SKIP_PATHS = ["/mcp", "/sse", "/messages"];

    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
      if (MCP_SKIP_PATHS.includes(req.path)) return next();
      sessionMw(req, res, next);
    });
    app.use((req, res, next) => {
      if (MCP_SKIP_PATHS.includes(req.path)) return next();
      validateCsrf(req, res, next);
    });

    // Mount web UI routes
    app.use(createDashboardRouter(db));
    app.use(createBillingRouter(db));
    app.use("/admin", createAdminRouter(db));

    // --- MCP auth middleware: resolve API key -> tenant ---
    const MCP_PATHS = ["/mcp", "/sse", "/messages"];

    app.use(MCP_PATHS, async (req, res, next) => {
      const apiKey = extractApiKey(req);
      if (!apiKey) {
        return res.status(401).json({ error: "API key required. Get one at /signup" });
      }

      const tenant = await resolveTenant(db, apiKey);
      if (!tenant) {
        return res.status(401).json({ error: "Invalid API key" });
      }
      if (tenant.status !== "active") {
        return res.status(403).json({ error: "Account suspended" });
      }

      // Per-tenant rate limit
      const rateCheck = checkRateLimit(tenant.id);
      if (!rateCheck.allowed) {
        return res.status(429).json({ error: rateCheck.message });
      }

      req.tenant = tenant;
      req.tenantDb = new TenantDB(db, tenant.id);
      next();
    });

    console.log("SaaS mode enabled: multi-tenant, billing, web UI");
  } else {
    // Non-SaaS: simple Bearer token auth
    const API_TOKEN = process.env.MCP_API_KEY;
    app.use((req, res, next) => {
      if (req.path === "/health" || req.path === "/readme") return next();

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
  }

  // --- Streamable HTTP transport (Claude.ai, Claude Code, Claude Desktop) ---

  const sessions = new Map();

  app.post("/mcp", express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    let session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" });

      // In SaaS mode, use tenant-scoped DB; otherwise use shared DB
      const sessionDb = req.tenantDb || db;
      let planCheck = null;
      if (saas && req.tenant) {
        const { checkPlanLimits } = await import("./rate-limit.mjs");
        const tenant = req.tenant;
        planCheck = (action) => checkPlanLimits(db, tenant, action);
      }
      const cleanup = registerTools(server, sessionDb, planCheck);

      await server.connect(transport);

      const sessionEntry = { server, transport, cleanup, tenantId: req.tenant?.id || null };

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          cleanup();
          sessions.delete(sid);
        }
      };

      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, sessionEntry);
      }
      return;
    }

    // Verify the resuming client owns this session
    if (saas && session.tenantId !== req.tenant?.id) {
      return res.status(403).json({ error: "Session tenant mismatch" });
    }

    await session.transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      res.status(400).json({ error: "No session. Send POST /mcp first to initialize." });
      return;
    }

    await session.transport.handleRequest(req, res);
  });

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

    const sessionDb = req.tenantDb || db;
    let planCheck = null;
    if (saas && req.tenant) {
      const { checkPlanLimits } = await import("./rate-limit.mjs");
      const tenant = req.tenant;
      planCheck = (action) => checkPlanLimits(db, tenant, action);
    }
    const cleanup = registerTools(server, sessionDb, planCheck);

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

  // --- Start ---

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`cross-claude-mcp v2.0.0 listening on port ${PORT}`);
    console.log(`  Mode:            ${saas ? "SaaS (multi-tenant)" : "Standard"}`);
    console.log(`  Streamable HTTP: POST/GET /mcp`);
    console.log(`  Legacy SSE:      GET /sse, POST /messages`);
    console.log(`  Health:          GET /health`);
    if (saas) {
      console.log(`  Web UI:          /signup, /login, /dashboard`);
      console.log(`  Admin:           /admin`);
      console.log(`  Billing webhook: POST /api/billing/webhook`);
    } else {
      console.log(`  Auth:            ${process.env.MCP_API_KEY ? "Bearer token required" : "NONE (set MCP_API_KEY)"}`);
    }
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
