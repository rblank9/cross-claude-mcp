// Self-test: verify explicit-subscribe channel targeting — a subscriber receives pushes
// ONLY for channels it subscribed to. Spawns real server (HTTP mode on 8796, channels on, SQLite),
// connects receiver (subscribes to "cha" only) and sender, sends messages to "cha" and "chb",
// asserts receiver got "cha" but NOT "chb". Reports PASS/FAIL, cleans up.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry(name) {
  for (let i = 0; i < 25; i++) {
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL("http://127.0.0.1:8796/mcp")
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

async function main() {
  // Spawn server
  const server = spawn("node", ["server.mjs"], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: "8796", CHANNELS_ENABLED: "1" },
  });

  let receiverClient, senderClient;
  const pushes = [];
  let gotA = false, gotB = false;

  try {
    // Wait a bit for server to start listening
    await sleep(500);

    // Connect RECEIVER
    console.error("[test] Connecting receiver client...");
    receiverClient = await connectWithRetry("receiver");
    console.error("[test] Receiver connected.");

    // Set up notification handler BEFORE registering/subscribing
    receiverClient.fallbackNotificationHandler = async (n) => {
      if (n.method === "notifications/claude/channel") {
        pushes.push(n.params);
        console.error(
          "[test] RECEIVER PUSH:",
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

    // Subscribe receiver to "cha" ONLY (not "chb")
    const subscribeResult = await receiverClient.callTool({
      name: "subscribe",
      arguments: { channel: "cha", instance_id: "cc-test" },
    });
    console.error("[test] Subscribe result (receiver to 'cha'):", subscribeResult.text);

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

    // Send message to "cha" (receiver subscribed to this)
    const sendResultA = await senderClient.callTool({
      name: "send_message",
      arguments: {
        channel: "cha",
        sender: "tester",
        content: "msg for A",
      },
    });
    console.error("[test] Send result (cha):", sendResultA.text);

    // Send message to "chb" (receiver did NOT subscribe to this)
    const sendResultB = await senderClient.callTool({
      name: "send_message",
      arguments: {
        channel: "chb",
        sender: "tester",
        content: "msg for B",
      },
    });
    console.error("[test] Send result (chb):", sendResultB.text);

    // Wait for pushes to arrive
    await sleep(3000);

    // Check scoping: did we get push for "cha" but NOT "chb"?
    gotA = pushes.some(p => p.meta && p.meta.channel === "cha");
    gotB = pushes.some(p => p.meta && p.meta.channel === "chb");

    console.error(`[test] gotA=${gotA} gotB=${gotB}`);
    console.error(
      (gotA && !gotB)
        ? "[test] RESULT: PASS - push scoped correctly to subscribed channel only"
        : "[test] RESULT: FAIL - scoping wrong (expected gotA=true gotB=false)"
    );
  } catch (e) {
    console.error("[test] fatal:", e?.message || e);
    try {
      if (receiverClient) await receiverClient.close();
    } catch {}
    try {
      if (senderClient) await senderClient.close();
    } catch {}
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
  process.exit((gotA && !gotB) ? 0 : 1);
}

main();
