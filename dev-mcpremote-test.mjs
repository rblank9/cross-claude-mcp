// Test: does mcp-remote forward server-initiated notifications/claude/channel push
// to its client (a faithful stand-in for Claude Code)?
//
// Spawns the real server on isolated port 8795, connects RECEIVER through mcp-remote
// (stdio <-> HTTP bridge), connects SENDER directly to HTTP server, sends a message,
// and verifies the push arrives at RECEIVER. Bounded, no infinite loops.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let gotPush = false;
const SERVER_PORT = "8795";

async function connectReceiverThroughMcpRemote() {
  // Retry loop: build a FRESH transport+client per attempt
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const recvTransport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "mcp-remote", `http://127.0.0.1:${SERVER_PORT}/mcp`],
      });

      const recv = new Client(
        { name: "cc-test-recv", version: "0.0.1" },
        { capabilities: {} }
      );

      recv.fallbackNotificationHandler = async (n) => {
        console.error("[test] notification received:", n.method);
        if (n.method === "notifications/claude/channel") {
          gotPush = true;
          console.error(
            "[test] RECEIVER (behind mcp-remote) GOT PUSH:",
            JSON.stringify(n.params)
          );
        } else {
          console.error("[test] other notification type:", n.method);
        }
      };

      await recv.connect(recvTransport);
      console.error("[test] Receiver connected through mcp-remote");
      return recv;
    } catch (e) {
      console.error(`[test] receiver connect attempt ${attempt + 1} failed:`, e.message);
      if (attempt < 39) {
        await sleep(1000);
      } else {
        throw e;
      }
    }
  }
}

async function connectSenderDirectly() {
  // Retry loop: build a FRESH transport+client per attempt
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const sendTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)
      );

      const send = new Client(
        { name: "cc-test-send", version: "0.0.1" },
        { capabilities: {} }
      );

      await send.connect(sendTransport);
      console.error("[test] Sender connected directly to HTTP server");
      return send;
    } catch (e) {
      console.error(`[test] sender connect attempt ${attempt + 1} failed:`, e.message);
      if (attempt < 24) {
        await sleep(300);
      } else {
        throw e;
      }
    }
  }
}

async function main() {
  // Spawn the real server on isolated port
  const server = spawn("node", ["server.mjs"], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: SERVER_PORT, CHANNELS_ENABLED: "1" },
  });

  let receiverClient, senderClient;

  try {
    // Wait for server to start listening
    await sleep(800);

    // Connect RECEIVER through mcp-remote
    console.error("[test] Connecting receiver through mcp-remote...");
    receiverClient = await connectReceiverThroughMcpRemote();

    // Register receiver
    console.error("[test] Registering receiver...");
    const recvRegister = await receiverClient.callTool({
      name: "register",
      arguments: { instance_id: "cc-test" },
    });
    console.error("[test] Receiver registered. Tool result:", JSON.stringify(recvRegister, null, 2));

    // Connect SENDER directly
    console.error("[test] Connecting sender directly to HTTP server...");
    senderClient = await connectSenderDirectly();

    // Register sender
    console.error("[test] Registering sender...");
    const sendRegister = await senderClient.callTool({
      name: "register",
      arguments: { instance_id: "tester" },
    });
    console.error("[test] Sender registered. Tool result:", JSON.stringify(sendRegister, null, 2));

    // Send message
    console.error("[test] Sending message...");
    const sendResult = await senderClient.callTool({
      name: "send_message",
      arguments: {
        channel: "chtest",
        sender: "tester",
        content: "hello via mcp-remote path",
      },
    });
    console.error("[test] Message sent. Tool result:", JSON.stringify(sendResult, null, 2));

    // Wait for push to traverse server -> mcp-remote -> receiver
    console.error("[test] Waiting 5s for push to arrive...");
    await sleep(5000);

    // Report result
    console.error(
      gotPush
        ? "[test] RESULT: PASS - mcp-remote FORWARDED the channel push to the client"
        : "[test] RESULT: FAIL - push did NOT survive mcp-remote"
    );
  } catch (e) {
    console.error("[test] fatal:", e?.message || e);
    console.error(e.stack);
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

  // Safety net: pkill any lingering mcp-remote
  try {
    await new Promise((resolve) => {
      const pkill = spawn("pkill", ["-f", "mcp-remote"], {
        stdio: "ignore",
      });
      pkill.on("close", resolve);
    });
  } catch {}

  process.exit(gotPush ? 0 : 1);
}

main();
