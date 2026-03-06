#!/usr/bin/env node

/**
 * Integration test for cross-claude-mcp server.
 * Tests the MCP server by spawning it as a child process and sending JSON-RPC messages.
 */

import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync, existsSync } from "fs";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "server.mjs");

// Clean test database
const DB_PATH = join(homedir(), ".cross-claude-mcp", "messages.db");
const DB_WAL = DB_PATH + "-wal";
const DB_SHM = DB_PATH + "-shm";
for (const f of [DB_PATH, DB_WAL, DB_SHM]) {
  if (existsSync(f)) unlinkSync(f);
}

let msgId = 0;
let passed = 0;
let failed = 0;

function jsonRpcRequest(method, params = {}) {
  msgId++;
  return {
    jsonrpc: "2.0",
    id: msgId,
    method,
    params,
  };
}

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

async function runTests() {
  console.log("Starting cross-claude-mcp test suite...\n");

  const server = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const responses = new Map();
  const pending = new Map();

  server.stdout.on("data", (data) => {
    buffer += data.toString();
    // MCP uses newline-delimited JSON
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          responses.set(msg.id, msg);
          pending.get(msg.id)();
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  });

  server.stderr.on("data", (data) => {
    // Suppress stderr unless debugging
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const req = jsonRpcRequest(method, params);
      pending.set(req.id, () => resolve(responses.get(req.id)));
      server.stdin.write(JSON.stringify(req) + "\n");
      setTimeout(() => reject(new Error(`Timeout waiting for response to ${method}`)), 5000);
    });
  }

  try {
    // 1. Initialize
    console.log("1. Initialize server");
    const initResp = await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    assert(initResp.result?.serverInfo?.name === "cross-claude-mcp", "Server identifies itself");
    assert(initResp.result?.capabilities?.tools !== undefined, "Has tools capability");

    // Send initialized notification (no response expected)
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    // 2. List tools
    console.log("\n2. List tools");
    const toolsResp = await send("tools/list", {});
    const toolNames = toolsResp.result.tools.map((t) => t.name);
    assert(toolNames.includes("register"), "Has register tool");
    assert(toolNames.includes("send_message"), "Has send_message tool");
    assert(toolNames.includes("check_messages"), "Has check_messages tool");
    assert(toolNames.includes("create_channel"), "Has create_channel tool");
    assert(toolNames.includes("list_channels"), "Has list_channels tool");
    assert(toolNames.includes("list_instances"), "Has list_instances tool");
    assert(toolNames.includes("search_messages"), "Has search_messages tool");
    assert(toolNames.includes("get_replies"), "Has get_replies tool");
    console.log(`   Tools found: ${toolNames.join(", ")}`);

    // 3. Register instance
    console.log("\n3. Register instance");
    const regResp = await send("tools/call", {
      name: "register",
      arguments: { instance_id: "test-alice", description: "Running tests" },
    });
    const regText = regResp.result.content[0].text;
    assert(regText.includes("test-alice"), "Registration confirms identity");

    // 4. Register second instance
    console.log("\n4. Register second instance");
    const reg2Resp = await send("tools/call", {
      name: "register",
      arguments: { instance_id: "test-bob", description: "Also testing" },
    });
    assert(reg2Resp.result.content[0].text.includes("test-bob"), "Second instance registered");

    // 5. List instances
    console.log("\n5. List instances");
    const listResp = await send("tools/call", {
      name: "list_instances",
      arguments: {},
    });
    const listText = listResp.result.content[0].text;
    assert(listText.includes("test-alice"), "Alice in instance list");
    assert(listText.includes("test-bob"), "Bob in instance list");

    // 6. Create channel
    console.log("\n6. Create channel");
    const chanResp = await send("tools/call", {
      name: "create_channel",
      arguments: { name: "test-channel", description: "For testing" },
    });
    assert(chanResp.result.content[0].text.includes("test-channel"), "Channel created");

    // 7. List channels
    console.log("\n7. List channels");
    const chansResp = await send("tools/call", {
      name: "list_channels",
      arguments: {},
    });
    const chansText = chansResp.result.content[0].text;
    assert(chansText.includes("general"), "General channel exists");
    assert(chansText.includes("test-channel"), "Test channel exists");

    // 8. Send messages
    console.log("\n8. Send messages");
    const msg1 = await send("tools/call", {
      name: "send_message",
      arguments: {
        channel: "general",
        sender: "test-alice",
        content: "Hello Bob! Can you review my code?",
        message_type: "request",
      },
    });
    assert(msg1.result.content[0].text.includes("Message #"), "Message sent with ID");

    const msg2 = await send("tools/call", {
      name: "send_message",
      arguments: {
        channel: "general",
        sender: "test-bob",
        content: "Sure Alice, I'll take a look.",
        message_type: "response",
        in_reply_to: 1,
      },
    });
    assert(msg2.result.content[0].text.includes("Message #"), "Reply sent");

    // 9. Check messages
    console.log("\n9. Check messages");
    const msgsResp = await send("tools/call", {
      name: "check_messages",
      arguments: { channel: "general" },
    });
    const msgsText = msgsResp.result.content[0].text;
    assert(msgsText.includes("Hello Bob"), "Alice's message visible");
    assert(msgsText.includes("Sure Alice"), "Bob's reply visible");
    assert(msgsText.includes("reply to #1"), "Reply reference shown");

    // 10. Check messages with after_id (polling)
    console.log("\n10. Poll for new messages");
    const pollResp = await send("tools/call", {
      name: "check_messages",
      arguments: { channel: "general", after_id: 2 },
    });
    assert(pollResp.result.content[0].text.includes("No new messages"), "No new messages after last");

    // Send another and poll
    await send("tools/call", {
      name: "send_message",
      arguments: {
        channel: "general",
        sender: "test-alice",
        content: "Thanks Bob!",
        message_type: "message",
      },
    });

    const poll2 = await send("tools/call", {
      name: "check_messages",
      arguments: { channel: "general", after_id: 2 },
    });
    assert(poll2.result.content[0].text.includes("Thanks Bob"), "New message found via polling");

    // 11. Get replies
    console.log("\n11. Get replies");
    const repliesResp = await send("tools/call", {
      name: "get_replies",
      arguments: { message_id: 1 },
    });
    const repliesText = repliesResp.result.content[0].text;
    assert(repliesText.includes("Sure Alice"), "Reply found");
    assert(repliesText.includes("Hello Bob"), "Original message shown");

    // 12. Search messages
    console.log("\n12. Search messages");
    const searchResp = await send("tools/call", {
      name: "search_messages",
      arguments: { query: "review" },
    });
    assert(searchResp.result.content[0].text.includes("review my code"), "Search finds message");

    // 13. Unread filtering
    console.log("\n13. Unread filtering (exclude own messages)");
    const unreadResp = await send("tools/call", {
      name: "check_messages",
      arguments: { channel: "general", after_id: 0, instance_id: "test-alice" },
    });
    const unreadText = unreadResp.result.content[0].text;
    assert(unreadText.includes("Sure Alice"), "Shows Bob's message to Alice");
    assert(!unreadText.includes("Hello Bob! Can you review"), "Filters out Alice's own messages");

    console.log(`\n${"=".repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${"=".repeat(40)}`);
  } catch (err) {
    console.error("Test error:", err.message);
    failed++;
  } finally {
    server.kill();
    // Clean up test database
    for (const f of [DB_PATH, DB_WAL, DB_SHM]) {
      if (existsSync(f)) unlinkSync(f);
    }
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();
