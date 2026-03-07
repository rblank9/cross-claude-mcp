#!/usr/bin/env node

/**
 * Cross-Claude MCP — SaaS Server
 *
 * Multi-tenant hosted version with auth, billing, admin, and plan enforcement.
 * Imports shared tool registration from ../tools.mjs.
 *
 * Endpoints:
 * - POST/GET /mcp -- Streamable HTTP (tenant-scoped via API key)
 * - GET  /sse, POST /messages -- Legacy SSE transport
 * - GET  /health, /readme -- Public
 * - GET/POST /signup, /login, /logout, /dashboard -- Account management
 * - POST /api/billing/checkout, /api/billing/portal, /api/billing/webhook -- Stripe
 * - GET  /admin, /admin/tenants, /admin/tenants/:id -- Admin panel
 */

import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { registerTools } from "../tools.mjs";
import { createSaasDB, TenantDB } from "./db-saas.mjs";
import { createSessionMiddleware, validateCsrf, extractApiKey, resolveTenant } from "./auth.mjs";
import { createWebhookHandler, createBillingRouter } from "./billing.mjs";
import { createDashboardRouter } from "./dashboard.mjs";
import { createAdminRouter } from "./admin.mjs";
import { checkRateLimit, checkPlanLimits } from "./rate-limit.mjs";

const db = await createSaasDB();

const app = express();
app.set("trust proxy", 1); // Railway terminates SSL at the edge
const PORT = parseInt(process.env.PORT) || 3000;

// --- Public routes (no auth) ---

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "cross-claude-mcp",
    version: "2.0.0",
    mode: "saas",
  });
});

app.get("/readme", async (req, res) => {
  const { readFileSync } = await import("fs");
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const md = readFileSync(join(__dirname, "..", "README.md"), "utf-8");

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

// --- Stripe webhook (raw body, before JSON middleware) ---

app.post("/api/billing/webhook", express.raw({ type: "application/json" }), createWebhookHandler(db));

// --- Session + CSRF middleware (skip MCP paths) ---

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

// --- Web UI routes ---

app.use(createDashboardRouter(db));
app.use(createBillingRouter(db));
app.use("/admin", createAdminRouter(db));

// --- MCP auth middleware: API key -> tenant ---

app.use(MCP_SKIP_PATHS, async (req, res, next) => {
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

  const rateCheck = checkRateLimit(tenant.id);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: rateCheck.message });
  }

  req.tenant = tenant;
  req.tenantDb = new TenantDB(db, tenant.id);
  next();
});

// --- Streamable HTTP transport ---

const sessions = new Map();

app.post("/mcp", express.json(), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let session = sessionId ? sessions.get(sessionId) : null;

  if (!session) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" });

    const sessionDb = req.tenantDb;
    const tenant = req.tenant;
    const planCheck = (action) => checkPlanLimits(db, tenant, action);
    const cleanup = registerTools(server, sessionDb, planCheck);

    await server.connect(transport);

    const sessionEntry = { server, transport, cleanup, tenantId: tenant.id };

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
  if (session.tenantId !== req.tenant?.id) {
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

// --- Legacy SSE transport ---

const sseTransports = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" });

  const sessionDb = req.tenantDb;
  const tenant = req.tenant;
  const planCheck = (action) => checkPlanLimits(db, tenant, action);
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
  console.log(`  Mode:            SaaS (multi-tenant)`);
  console.log(`  Streamable HTTP: POST/GET /mcp`);
  console.log(`  Legacy SSE:      GET /sse, POST /messages`);
  console.log(`  Health:          GET /health`);
  console.log(`  Web UI:          /signup, /login, /dashboard`);
  console.log(`  Admin:           /admin`);
  console.log(`  Billing webhook: POST /api/billing/webhook`);
  console.log(`  Database:        PostgreSQL`);
});
