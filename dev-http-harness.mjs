// Throwaway harness: does dev-channel-probe-http.mjs actually deliver an
// out-of-band `notifications/claude/channel` push to a streamable-HTTP MCP client?
// Spawns the probe, connects via the SDK's StreamableHTTPClientTransport, listens
// ~13s for the channel notification, reports PASS/FAIL, cleans up. Bounded; no loops.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const PORT = 8791;
const probe = spawn("node", ["dev-channel-probe-http.mjs"], {
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, CHANNEL_PROBE_PORT: String(PORT) },
});

let got = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = new URL(`http://127.0.0.1:${PORT}/mcp`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "http-harness", version: "0.0.1" }, { capabilities: {} });
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") {
      got = true;
      console.error("[harness] >>> GOT channel push over HTTP:", JSON.stringify(n.params));
    } else {
      console.error("[harness] other notification:", n.method);
    }
  };

  let connected = false;
  for (let i = 0; i < 25 && !connected; i++) {
    try {
      await client.connect(transport);
      connected = true;
    } catch (e) {
      await sleep(300);
    }
  }
  if (!connected) {
    console.error("[harness] RESULT: ERROR - could not connect to probe over HTTP");
    probe.kill("SIGTERM");
    process.exit(2);
  }
  console.error("[harness] connected over streamable-HTTP; waiting 13s for channel push...");
  await sleep(13000);
  console.error(
    got
      ? "[harness] RESULT: PASS - streamable-HTTP delivered the server channel push to the SDK client"
      : "[harness] RESULT: FAIL - no channel push received over streamable-HTTP"
  );
  try { await client.close(); } catch {}
  probe.kill("SIGTERM");
  process.exit(got ? 0 : 1);
}

main().catch((e) => {
  console.error("[harness] fatal:", e?.message || e);
  probe.kill("SIGTERM");
  process.exit(3);
});
