// Self-test: verify channels feature — when one MCP client calls send_message,
// OTHER registered clients receive a notifications/claude/channel push.
// Spawns real server (HTTP mode on 8799, channels on, SQLite), connects two clients
// (receiver + sender), tests message delivery, reports PASS/FAIL, cleans up.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry(name) {
  for (let i = 0; i < 25; i++) {
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL("http://127.0.0.1:8799/mcp")
      );
      const client = new Client(
        { name, version: "0.0.1" },
        { capabilities: {} }
      );
      await client.connect(transport);
      return client;
    } catch (e) {
      await sleep(300);
    }
  }
  throw new Error(`Failed to connect client "${name}" after 25 retries`);
}

let gotPush = false;

async function main() {
  // Spawn server
  const server = spawn("node", ["server.mjs"], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: "8799", CHANNELS_ENABLED: "1" },
  });

  let receiverClient, senderClient;

  try {
    // Wait a bit for server to start listening
    await sleep(500);

    // Connect RECEIVER
    console.error("[test] Connecting receiver client...");
    receiverClient = await connectWithRetry("receiver");
    console.error("[test] Receiver connected.");

    // Set up notification handler BEFORE registering
    receiverClient.fallbackNotificationHandler = async (n) => {
      if (n.method === "notifications/claude/channel") {
        gotPush = true;
        console.error(
          "[test] RECEIVER GOT PUSH:",
          JSON.stringify(n.params)
        );
      }
    };

    // Register receiver
    const registerResult = await receiverClient.callTool({
      name: "register",
      arguments: { instance_id: "cc-test" },
    });
    console.error("[test] Register result (receiver):", registerResult.text);

    // Connect SENDER
    console.error("[test] Connecting sender client...");
    senderClient = await connectWithRetry("sender");
    console.error("[test] Sender connected.");

    // Register sender
    const senderRegisterResult = await senderClient.callTool({
      name: "register",
      arguments: { instance_id: "tester" },
    });
    console.error("[test] Register result (sender):", senderRegisterResult.text);

    // Send message
    const sendResult = await senderClient.callTool({
      name: "send_message",
      arguments: {
        channel: "chtest",
        sender: "tester",
        content: "hello from tester via real server",
      },
    });
    console.error("[test] Send result:", sendResult.text);

    // Wait for push to arrive
    await sleep(2500);

    // Report
    console.error(
      gotPush
        ? "[test] RESULT: PASS - send_message delivered notifications/claude/channel to the other registered instance"
        : "[test] RESULT: FAIL - receiver got no channel push"
    );
  } catch (e) {
    console.error("[test] fatal:", e?.message || e);
    server.kill("SIGTERM");
    process.exit(3);
  }

  // Cleanup
  try {
    if (receiverClient) await receiverClient.close();
  } catch {}
  try {
    if (senderClient) await senderClient.close();
  } catch {}
  server.kill("SIGTERM");
  process.exit(gotPush ? 0 : 1);
}

main();
