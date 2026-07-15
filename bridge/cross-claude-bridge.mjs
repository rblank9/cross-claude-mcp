import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const CROSS_CLAUDE_URL = process.env.CROSS_CLAUDE_URL || "https://cross-claude-mcp-production.up.railway.app";
const CROSS_CLAUDE_API_KEY = process.env.CROSS_CLAUDE_API_KEY;
const BRIDGE_CHANNEL = process.env.BRIDGE_CHANNEL || "general";
const BRIDGE_INSTANCE = process.env.BRIDGE_INSTANCE;
const BRIDGE_POLL_MS = Math.max(2000, parseInt(process.env.BRIDGE_POLL_MS) || 5000);

if (!CROSS_CLAUDE_API_KEY) {
  console.error("Error: CROSS_CLAUDE_API_KEY is required");
  process.exit(1);
}

console.error(`Starting cross-claude-bridge with config:`);
console.error(`  URL: ${CROSS_CLAUDE_URL}`);
console.error(`  Channel: ${BRIDGE_CHANNEL}`);
console.error(`  Instance: ${BRIDGE_INSTANCE || "none"}`);
console.error(`  Poll interval: ${BRIDGE_POLL_MS}ms`);

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      "Authorization": `Bearer ${CROSS_CLAUDE_API_KEY}`
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return await res.json();
}

async function main() {
  const mcp = new McpServer(
    { name: "cross-claude-bridge", version: "0.1.0" },
    { capabilities: { experimental: { "claude/channel": {} } } }
  );
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  let cursor;
  try {
    const initRes = await fetchJson(`${CROSS_CLAUDE_URL}/api/messages/${BRIDGE_CHANNEL}?limit=1`);
    cursor = initRes.last_id ?? 0;
  } catch (err) {
    console.error(`Failed to initialize cursor: ${err.message}`);
    process.exit(1);
  }

  let stopped = false;
  let backoffMs = BRIDGE_POLL_MS;

  transport.onclose = () => {
    stopped = true;
    process.exit(0);
  };

  process.stdin.on("end", () => {
    stopped = true;
    process.exit(0);
  });

  process.stdin.on("close", () => {
    stopped = true;
    process.exit(0);
  });

  while (!stopped) {
    try {
      await sleep(backoffMs);
      const url = new URL(`${CROSS_CLAUDE_URL}/api/messages/${BRIDGE_CHANNEL}`);
      url.searchParams.set("after_id", cursor);
      if (BRIDGE_INSTANCE) url.searchParams.set("instance_id", BRIDGE_INSTANCE);

      const res = await fetchJson(url.href);
      for (const m of res.messages) {
        await mcp.server.notification({
          method: "notifications/claude/channel",
          params: {
            content: `[#${BRIDGE_CHANNEL}] ${m.sender} (${m.message_type}): ${m.content}`,
            meta: { channel: BRIDGE_CHANNEL, sender: m.sender, id: String(m.id), message_type: m.message_type }
          }
        });
        console.error(`bridged message #${m.id} from ${m.sender}`);
      }
      if (typeof res.last_id === "number") cursor = res.last_id;
      backoffMs = BRIDGE_POLL_MS;
    } catch (err) {
      console.error(`Poll error: ${err.message}`);
      backoffMs = Math.min(backoffMs * 2, 60000);
    }
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
