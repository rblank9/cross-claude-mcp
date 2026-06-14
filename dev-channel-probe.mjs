#!/usr/bin/env node

/**
 * Dev Channel Probe — Diagnostic MCP Server
 *
 * Probes whether Claude Code's experimental "channels" feature is live.
 * Declares the "claude/channel" experimental capability and sends periodic
 * diagnostic notifications to the channel.
 *
 * Usage:
 *   node dev-channel-probe.mjs
 *
 * Register in .mcp.json:
 *   {
 *     "mcpServers": {
 *       "devchan": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/dev-channel-probe.mjs"]
 *       }
 *     }
 *   }
 *
 * Launch with:
 *   claude --channels devchan --dangerously-load-development-channels devchan
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Logger: all to stderr to avoid corrupting MCP stdio protocol ---
const log = (msg) => console.error(`[devchan] ${msg}`);

// --- Configuration ---
const PROBE_INITIAL_DELAY_MS = 6000; // First probe ~6 seconds after start
const PROBE_INTERVAL_MS = 15000; // Every ~15 seconds
const PROBE_COUNT_MAX = 5; // Stop after 5 sends (bounded, no infinite loop)

// --- Create low-level Server with experimental "claude/channel" capability ---
const server = new Server(
  { name: "devchan", version: "0.0.1" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {}, // Declare support for the experimental channel feature
      },
    },
  }
);

log("Server created with experimental capability: claude/channel");

// --- Register trivial "ping" tool so the server is connectable ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ping",
      description: "Simple ping tool for probe verification",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params?.name || "";
  if (toolName === "ping") {
    return { content: [{ type: "text", text: "pong" }], isError: false };
  }
  return {
    content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
    isError: true,
  };
});

log("Registered ping tool");

// --- Connect over stdio transport ---
const transport = new StdioServerTransport();
await server.connect(transport);
log("Connected over stdio transport");

// --- Timer: send diagnostic notifications ---
let probeCount = 0;
const sendProbe = async () => {
  if (probeCount >= PROBE_COUNT_MAX) {
    log(`Probe cycle complete (${PROBE_COUNT_MAX} sends)`);
    return; // Stop after 5 sends
  }

  probeCount++;
  const timestamp = new Date().toISOString();
  const message = `PROBE: hello from devchan #${probeCount} @ ${timestamp}`;

  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: message,
        meta: { source: "devchan" },
      },
    });
    log(`sent push #${probeCount}`);
  } catch (err) {
    log(`ERROR sending probe #${probeCount}: ${err.message}`);
    // Gracefully continue (transport may be closed later)
  }
};

// Schedule probes: first after 6s, then every 15s, with hard stop after 5 sends
setTimeout(sendProbe, PROBE_INITIAL_DELAY_MS);
const interval = setInterval(sendProbe, PROBE_INTERVAL_MS);

// Graceful shutdown
const cleanup = () => {
  clearInterval(interval);
  server.close?.();
  process.exit(0);
};

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    log(`Received ${signal}, shutting down`);
    cleanup();
  });
}

process.on("exit", cleanup);
process.stdin.on("end", () => {
  log("stdin ended, shutting down");
  cleanup();
});

log("Probe server ready. Sending first diagnostic in ~6s...");
