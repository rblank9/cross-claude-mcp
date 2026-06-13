#!/usr/bin/env node

/**
 * Dev Channel Probe — HTTP Transport Diagnostic MCP Server (THROWAWAY)
 *
 * Proves whether a server->client `notifications/claude/channel` push survives
 * streamable-HTTP + the mcp-remote bridge. Same channel logic as the stdio probe,
 * but over StreamableHTTP on POST/GET /mcp.
 *
 *   node dev-channel-probe-http.mjs           # 127.0.0.1:8791 (or $CHANNEL_PROBE_PORT)
 *
 * .mcp.json (via mcp-remote):
 *   "devchanhttp": { "command": "npx", "args": ["-y","mcp-remote","http://127.0.0.1:8791/mcp"] }
 * Launch: ccx --dangerously-load-development-channels server:devchanhttp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { randomUUID } from "crypto";

const log = (msg) => console.error(`[devchanhttp] ${msg}`);

const PORT = parseInt(process.env.CHANNEL_PROBE_PORT || "8791");
const PROBE_INITIAL_DELAY_MS = 6000;
const PROBE_INTERVAL_MS = 10000;
const PROBE_COUNT_MAX = 8;

// One MCP Server PER session (a Server can only bind to a single transport).
function createServer() {
  const s = new Server(
    { name: "devchanhttp", version: "0.0.1" },
    { capabilities: { tools: {}, experimental: { "claude/channel": {} } } }
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ping",
        description: "Simple ping tool for probe verification",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
  }));
  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params?.name || "";
    if (toolName === "ping") return { content: [{ type: "text", text: "pong" }], isError: false };
    return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true };
  });
  return s;
}

const app = express();
app.use(express.json());

const sessions = new Map();
let probeCount = 0;

// Only DELIVERED pushes consume the cap.
function sendProbeToSession(sessionEntry, label) {
  if (probeCount >= PROBE_COUNT_MAX) {
    log(`cap reached (${PROBE_COUNT_MAX}), skipping ${label} push`);
    return;
  }
  probeCount++;
  const message = `PROBE-HTTP: hello from devchanhttp #${probeCount} (${label}) @ ${new Date().toISOString()}`;
  try {
    sessionEntry.server.notification({
      method: "notifications/claude/channel",
      params: { content: message, meta: { source: "devchanhttp", transport: "streamable-http", label } },
    });
    log(`sent ${label} push #${probeCount}`);
  } catch (err) {
    log(`ERROR sending ${label} push #${probeCount}: ${err?.message || err}`);
  }
}

function sendTimerProbe() {
  if (probeCount >= PROBE_COUNT_MAX) return;
  let target = null;
  let maxActivity = 0;
  for (const [, entry] of sessions) {
    if (entry.lastActivity > maxActivity) {
      maxActivity = entry.lastActivity;
      target = entry;
    }
  }
  if (!target) {
    log(`timer: no active session yet (count ${probeCount}/${PROBE_COUNT_MAX})`);
    return; // does NOT consume the cap
  }
  sendProbeToSession(target, "timer");
}

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const existing = sessionId ? sessions.get(sessionId) : null;

  if (existing) {
    existing.lastActivity = Date.now();
    await existing.transport.handleRequest(req, res, req.body);
    return;
  }

  // New session: fresh transport + fresh Server (one Server per transport).
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  const s = createServer();
  await s.connect(transport);
  const entry = { server: s, transport, lastActivity: Date.now() };

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && sessions.has(sid)) {
      sessions.delete(sid);
      log(`SESSION CLOSED: ${sid}`);
    }
  };

  await transport.handleRequest(req, res, req.body); // SDK assigns sessionId here

  if (transport.sessionId) {
    sessions.set(transport.sessionId, entry);
    log(`NEW SESSION: ${transport.sessionId}`);
    // Fire one push the moment the session exists, so mcp-remote connect latency
    // can't make us miss the window.
    setTimeout(() => {
      if (sessions.has(transport.sessionId)) sendProbeToSession(entry, "on-connect");
    }, 300);
  } else {
    log("WARNING: no sessionId after handleRequest");
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    res.status(400).json({ error: "No session. Send POST /mcp (initialize) first." });
    return;
  }
  session.lastActivity = Date.now();
  await session.transport.handleRequest(req, res);
});

setTimeout(sendTimerProbe, PROBE_INITIAL_DELAY_MS);
const probeInterval = setInterval(sendTimerProbe, PROBE_INTERVAL_MS);

const cleanup = () => {
  clearInterval(probeInterval);
  for (const [, entry] of sessions) {
    try { entry.transport.close?.(); } catch {}
  }
  sessions.clear();
  try { httpServer.close?.(); } catch {}
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => { log(`Received ${signal}, shutting down`); cleanup(); process.exit(0); });
}

const httpServer = app.listen(PORT, "127.0.0.1", () => {
  log(`listening on 127.0.0.1:${PORT} (POST/GET /mcp, StreamableHTTP)`);
  log(`capability: claude/channel; first push ~6s after a session connects`);
});
