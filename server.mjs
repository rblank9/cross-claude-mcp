#!/usr/bin/env node

/**
 * Cross-Claude MCP Server
 *
 * Modes (auto-detected):
 * - Local (stdio + SQLite): when no PORT env var is set
 * - Remote (HTTP + PostgreSQL): when PORT and DATABASE_URL are set (Railway)
 *
 * Remote endpoints:
 * - POST /mcp -- Streamable HTTP (Claude.ai, Claude Code via mcp-remote, Claude Desktop)
 * - GET  /mcp -- SSE stream for Streamable HTTP
 * - GET  /sse -- Legacy SSE transport (backward compat)
 * - POST /messages -- Legacy SSE message endpoint
 * - GET  /health -- Health check
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDB } from "./db.mjs";
import { registerTools } from "./tools.mjs";
import { createRestRouter } from "./rest-api.mjs";
import { InviteCodeOAuthProvider, createAuthorizeSubmitHandler } from "./auth.mjs";
import { requestContext } from "./request-context.mjs";
import { createHash, timingSafeEqual } from "crypto";

// Parses CROSS_CLAUDE_KEYS (raw JSON object, or base64 of one) into [id, sha256 digest] pairs.
// Malformed input logs an error and yields no keys; it never throws.
function loadKeyEntries(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    } catch {
      console.error("[AUTH] CROSS_CLAUDE_KEYS is neither JSON nor base64 JSON; treated as empty");
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("[AUTH] CROSS_CLAUDE_KEYS must be a JSON object; treated as empty");
    return [];
  }
  const entries = [];
  for (const [id, hex] of Object.entries(parsed)) {
    if (typeof hex === "string" && /^[0-9a-f]{64}$/i.test(hex)) {
      entries.push([id, Buffer.from(hex, "hex")]);
    } else {
      console.error(`[AUTH] CROSS_CLAUDE_KEYS entry "${id}" is not a sha256 hex digest; skipped`);
    }
  }
  return entries;
}

// --- Transport: Stdio (local) ---

async function startStdio(db) {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" }, { capabilities: { tools: {}, experimental: { "claude/channel": {} } } });
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

  // --- CORS (required for Claude Desktop custom connectors) ---

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // --- OAuth 2.1 (for Claude Desktop custom connectors) ---

  const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
  const oauthProvider = new InviteCodeOAuthProvider(db);

  const { mcpAuthRouter } = await import("@modelcontextprotocol/sdk/server/auth/router.js");
  const { requireBearerAuth } = await import("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
  const { getOAuthProtectedResourceMetadataUrl } = await import("@modelcontextprotocol/sdk/server/auth/router.js");

  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(SERVER_URL),
    resourceServerUrl: new URL("/mcp", SERVER_URL),
    scopesSupported: [],
    resourceName: "Cross-Claude MCP",
    serviceDocumentationUrl: new URL("/readme", SERVER_URL),
  }));

  // Invite code form submission (url-encoded form POST)
  const urlencoded = (await import("express")).default.urlencoded({ extended: false });
  app.post("/authorize/submit", urlencoded, createAuthorizeSubmitHandler(db));

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL("/mcp", SERVER_URL));

  // --- Health check + README (no auth) ---

  app.get("/health", (req, res) => {
    const memUsage = process.memoryUsage();
    const poolStats = db.pool ? {
      total: db.pool.totalCount,
      idle: db.pool.idleCount,
      waiting: db.pool.waitingCount,
    } : null;

    res.json({
      status: "ok",
      server: "cross-claude-mcp",
      version: "2.0.0",
      memory: {
        rss: memUsage.rss,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
      },
      sessions: sessions.size,
      sseTransports: sseTransports.size,
      pool: poolStats,
      killed,
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

  // --- OpenAPI spec (no auth, needed for ChatGPT Custom GPT Actions) ---

  app.get("/openapi.json", async (req, res) => {
    const { readFileSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    res.type("json").send(readFileSync(join(__dirname, "openapi.json"), "utf-8"));
  });

  // --- Auth: static API key (CLI/REST) OR OAuth bearer token (Claude Desktop) ---

  const API_TOKEN = process.env.MCP_API_KEY;
  const idDigests = loadKeyEntries(process.env.CROSS_CLAUDE_KEYS || "");
  const legacyDigest = API_TOKEN ? createHash("sha256").update(API_TOKEN).digest() : null;
  const devOpen = !API_TOKEN && !process.env.CROSS_CLAUDE_KEYS && process.env.CROSS_CLAUDE_DEV === "1";
  const killed = process.env.CROSS_CLAUDE_KILL === "1";
  if (!API_TOKEN && !process.env.CROSS_CLAUDE_KEYS && !devOpen) {
    console.error("no keys configured and CROSS_CLAUDE_DEV unset: all API requests will be refused");
  }

  const oauthBearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl,
  });

  app.use((req, res, next) => {
    // Skip auth for public endpoints
    if (req.path === "/health" || req.path === "/readme" || req.path.startsWith("/openapi.json")) return next();
    // Skip auth for OAuth endpoints (handled by mcpAuthRouter)
    if (req.path.startsWith("/.well-known/") || req.path === "/authorize" || req.path === "/authorize/submit" || req.path === "/token" || req.path === "/register" || req.path === "/revoke") return next();

    const hdr = req.headers.authorization || "";
    const presented = hdr.startsWith("Bearer ")
      ? hdr.slice(7)
      : (typeof req.query.api_key === "string" ? req.query.api_key : null);

    // Admit with an identity: req.keyId + AsyncLocalStorage so db.sendMessage stamps sender_key_id.
    const admit = (kid, how) => {
      req.keyId = kid;
      console.log(`[AUTH OK] ${req.method} ${req.path} (${how})`);
      return requestContext.run({ keyId: kid }, () => next());
    };

    // Per-identity keys first (constant-time compare of sha256 digests), then the legacy shared key.
    if (presented) {
      const d = createHash("sha256").update(presented).digest();
      let hit = null;
      for (const [id, ref] of idDigests) {
        if (timingSafeEqual(d, ref)) hit = id;
      }
      if (hit !== null) return admit(hit, `key:${hit}`);
      if (legacyDigest && timingSafeEqual(d, legacyDigest)) return admit("legacy", "key:legacy");
    }

    // OAuth bearer (Claude Desktop)
    if (hdr.startsWith("Bearer ")) {
      return oauthBearerAuth(req, res, (err) => {
        if (err) return next(err);
        admit("oauth", "key:oauth");
      });
    }

    // Fail CLOSED: unauthenticated access only with an explicit CROSS_CLAUDE_DEV=1 and no keys configured.
    if (devOpen) return admit(null, "dev");
    console.log(`[AUTH FAIL] ${req.method} ${req.path}`);
    return res.status(401).json({ error: "Unauthorized" });
  });

  // Fleet-wide kill switch (Gate 5): CROSS_CLAUDE_KILL=1 stops every message route, incl. legacy transports.
  app.use(["/api", "/mcp", "/sse", "/messages"], (req, res, next) => {
    if (killed) return res.status(503).json({ error: "killed" });
    next();
  });

  // --- REST API (for ChatGPT, Gemini, curl, etc.) ---

  app.use("/api", express.json(), createRestRouter(db));

  // --- Streamable HTTP transport ---

  const sessions = new Map();

  // TTL eviction: sweep idle sessions every 60s
  const SESSION_IDLE_MS = 24 * 60 * 60 * 1000; // 24 hours
  const sweepSessions = () => {
    const now = Date.now();
    for (const [sid, entry] of sessions.entries()) {
      // Check if transport response is destroyed
      if (entry.transport._response?.destroyed === true) {
        console.log(`[SESSION EVICT] ${sid} (destroyed)`);
        entry.cleanup();
        try { entry.transport.close(); } catch {}
        sessions.delete(sid);
        continue;
      }
      // Check idle timeout
      if (now - entry.lastActivity > SESSION_IDLE_MS) {
        console.log(`[SESSION EVICT] ${sid} (idle ${Math.round((now - entry.lastActivity) / 1000)}s)`);
        entry.cleanup();
        try { entry.transport.close(); } catch {}
        sessions.delete(sid);
      }
    }
  };
  const sessionSweepInterval = setInterval(sweepSessions, 60_000);

  app.post("/mcp", express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    let session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" }, { capabilities: { tools: {}, experimental: { "claude/channel": {} } } });
      const cleanup = registerTools(server, db);

      await server.connect(transport);

      const sessionEntry = { server, transport, cleanup, lastActivity: Date.now() };

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

    // Update lastActivity on every request
    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      res.status(400).json({ error: "No session. Send POST /mcp first to initialize." });
      return;
    }

    session.lastActivity = Date.now();
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

  // TTL eviction: sweep idle SSE transports every 60s
  const sweepSSE = () => {
    const now = Date.now();
    for (const [sid, entry] of sseTransports.entries()) {
      // Check if transport response is destroyed
      if (entry.transport._response?.destroyed === true) {
        console.log(`[SSE EVICT] ${sid} (destroyed)`);
        entry.cleanup();
        try { entry.transport.close(); } catch {}
        sseTransports.delete(sid);
        continue;
      }
      // Check idle timeout
      if (now - entry.lastActivity > SESSION_IDLE_MS) {
        console.log(`[SSE EVICT] ${sid} (idle ${Math.round((now - entry.lastActivity) / 1000)}s)`);
        entry.cleanup();
        try { entry.transport.close(); } catch {}
        sseTransports.delete(sid);
      }
    }
  };
  const sseSweepInterval = setInterval(sweepSSE, 60_000);

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    const server = new McpServer({ name: "cross-claude-mcp", version: "2.0.0" }, { capabilities: { tools: {}, experimental: { "claude/channel": {} } } });
    const cleanup = registerTools(server, db);

    sseTransports.set(transport.sessionId, { server, transport, cleanup, lastActivity: Date.now() });

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

    session.lastActivity = Date.now();
    await session.transport.handlePostMessage(req, res, req.body);
  });

  // --- Start ---

  // --- Auto-cleanup: delete data older than 7 days ---

  const CLEANUP_DAYS = parseInt(process.env.CLEANUP_DAYS) || 7;
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  async function runCleanup() {
    try {
      const result = await db.cleanup(CLEANUP_DAYS);
      const total = result.messages + result.instances + result.shared_data;
      if (total > 0) {
        console.log(`[CLEANUP] Removed ${result.messages} messages, ${result.instances} instances, ${result.shared_data} shared data (older than ${CLEANUP_DAYS} days)`);
      }
    } catch (err) {
      console.error(`[CLEANUP] Error: ${err.message}`);
    }
  }

  await runCleanup();
  const cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  // Graceful shutdown: clean up intervals
  const shutdown = () => {
    clearInterval(sessionSweepInterval);
    clearInterval(sseSweepInterval);
    clearInterval(cleanupInterval);
    process.exit(0);
  };

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, shutdown);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`cross-claude-mcp v2.0.0 listening on port ${PORT}`);
    console.log(`  Mode:            Standard`);
    console.log(`  Streamable HTTP: POST/GET /mcp`);
    console.log(`  REST API:        /api/* (ChatGPT, Gemini, curl)`);
    console.log(`  Legacy SSE:      GET /sse, POST /messages`);
    console.log(`  Health:          GET /health`);
    console.log(`  Auth:            ${process.env.MCP_API_KEY ? "Bearer token required" : "NONE (set MCP_API_KEY)"}`);
    console.log(`  OAuth:           ${SERVER_URL}/.well-known/oauth-authorization-server`);
    console.log(`  Database:        ${process.env.DATABASE_URL ? "PostgreSQL" : "SQLite (local)"}`);
    console.log(`  Cleanup:         Every ${CLEANUP_DAYS} days (checks hourly)`);
  });
}

// --- Main ---

const db = await createDB();

if (process.env.PORT) {
  await startHTTP(db);
} else {
  await startStdio(db);
}
