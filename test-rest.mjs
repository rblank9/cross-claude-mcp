#!/usr/bin/env node

/**
 * Integration test for the REST API layer.
 * Starts the server in HTTP mode and tests all /api/* endpoints.
 */

import { spawn, spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "server.mjs");
const PORT = 9876;

// Kill any lingering process on our test port
const lsof = spawnSync("lsof", ["-ti", `:${PORT}`], { encoding: "utf-8" });
if (lsof.stdout.trim()) {
  for (const pid of lsof.stdout.trim().split("\n")) {
    spawnSync("kill", ["-9", pid]);
  }
}

// Use isolated temp directory for test DB
const TEST_DB_DIR = mkdtempSync(join(tmpdir(), "cross-claude-test-"));

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

const BASE = `http://localhost:${PORT}/api`;

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  return { status: res.status, data };
}

async function runTests() {
  console.log("Starting REST API test suite...\n");

  const server = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), HOME: TEST_DB_DIR },
  });

  // Wait for server to start
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server start timeout")), 10000);
    server.stdout.on("data", (data) => {
      if (data.toString().includes("listening on port")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.stderr.on("data", (data) => {
      // Uncomment to debug: console.error("STDERR:", data.toString());
    });
  });

  try {
    // 1. Register instances
    console.log("1. Register instances");
    let r = await api("POST", "/register", { instance_id: "chatgpt-1", description: "ChatGPT Custom GPT" });
    assert(r.status === 200 && r.data.ok, "Register chatgpt-1");
    assert(r.data.instance_id === "chatgpt-1", "Returns instance_id");

    r = await api("POST", "/register", { instance_id: "claude-1", description: "Claude Code" });
    assert(r.status === 200 && r.data.ok, "Register claude-1");

    // Validation
    r = await api("POST", "/register", {});
    assert(r.status === 400, "Rejects missing instance_id");

    // 2. List instances
    console.log("\n2. List instances");
    r = await api("GET", "/instances");
    assert(r.data.instances.length === 2, "Both instances listed");
    assert(r.data.instances.some(i => i.instance_id === "chatgpt-1"), "chatgpt-1 in list");
    assert(r.data.instances.some(i => i.instance_id === "claude-1"), "claude-1 in list");

    // 3. Create channel
    console.log("\n3. Create channel");
    r = await api("POST", "/channels", { name: "cross-model", description: "Claude + ChatGPT collab" });
    assert(r.status === 200 && r.data.ok, "Channel created");

    // Validation
    r = await api("POST", "/channels", {});
    assert(r.status === 400, "Rejects missing channel name");

    // 4. List channels
    console.log("\n4. List channels");
    r = await api("GET", "/channels");
    assert(r.data.channels.some(c => c.name === "general"), "Has general channel");
    assert(r.data.channels.some(c => c.name === "cross-model"), "Has cross-model channel");

    // 5. Send messages
    console.log("\n5. Send messages");
    r = await api("POST", "/messages", {
      channel: "cross-model",
      sender: "chatgpt-1",
      content: "Hey Claude, can you review this Python code?",
      message_type: "request",
    });
    assert(r.status === 200 && r.data.id, "ChatGPT sends message");
    const msg1Id = r.data.id;

    r = await api("POST", "/messages", {
      channel: "cross-model",
      sender: "claude-1",
      content: "Sure! Send it over.",
      message_type: "response",
      in_reply_to: msg1Id,
    });
    assert(r.status === 200 && r.data.id, "Claude replies");
    const msg2Id = r.data.id;

    // Validation
    r = await api("POST", "/messages", { channel: "general", sender: "test" });
    assert(r.status === 400, "Rejects missing content");

    r = await api("POST", "/messages", { channel: "general", content: "hi" });
    assert(r.status === 400, "Rejects missing sender");

    r = await api("POST", "/messages", {
      channel: "general", sender: "test", content: "hi", message_type: "invalid",
    });
    assert(r.status === 400, "Rejects invalid message_type");

    // 6. Get messages
    console.log("\n6. Get messages");
    r = await api("GET", "/messages/cross-model");
    assert(r.data.messages.length === 2, "Both messages returned");
    assert(r.data.last_id === msg2Id, "last_id is correct");

    // 7. Polling with after_id
    console.log("\n7. Poll with after_id");
    r = await api("GET", `/messages/cross-model?after_id=${msg1Id}`);
    assert(r.data.messages.length === 1, "Only new message returned");
    assert(r.data.messages[0].sender === "claude-1", "Correct message returned");

    // 8. Unread filtering (exclude own)
    console.log("\n8. Unread filtering");
    r = await api("GET", `/messages/cross-model?after_id=0&instance_id=chatgpt-1`);
    assert(r.data.messages.length === 1, "Filters out own messages");
    assert(r.data.messages[0].sender === "claude-1", "Only shows others' messages");

    // 9. Get replies
    console.log("\n9. Get replies");
    r = await api("GET", `/messages/cross-model/${msg1Id}/replies`);
    assert(r.data.parent.sender === "chatgpt-1", "Parent message correct");
    assert(r.data.replies.length === 1, "One reply found");
    assert(r.data.replies[0].sender === "claude-1", "Reply sender correct");

    // 404 for missing message
    r = await api("GET", "/messages/cross-model/99999/replies");
    assert(r.status === 404, "404 for nonexistent message");

    // 10. Search
    console.log("\n10. Search messages");
    r = await api("GET", "/search?q=Python");
    assert(r.data.messages.length === 1, "Search finds message");
    assert(r.data.messages[0].content.includes("Python"), "Correct result");

    // Validation
    r = await api("GET", "/search");
    assert(r.status === 400, "Rejects missing query");

    // 11. Shared data
    console.log("\n11. Shared data");
    r = await api("POST", "/data", {
      key: "code-review",
      content: "def hello():\n  print('world')",
      sender: "chatgpt-1",
      description: "Code for review",
    });
    assert(r.status === 200 && r.data.ok, "Data shared");
    assert(r.data.size_bytes > 0, "Size reported");

    // Validation
    r = await api("POST", "/data", { content: "x", sender: "y" });
    assert(r.status === 400, "Rejects missing key");

    // 12. List shared data
    console.log("\n12. List shared data");
    r = await api("GET", "/data");
    assert(r.data.items.length === 1, "One item in shared data");
    assert(r.data.items[0].key === "code-review", "Correct key");

    // 13. Get shared data
    console.log("\n13. Get shared data");
    r = await api("GET", "/data/code-review");
    assert(r.data.content.includes("def hello"), "Content retrieved");
    assert(r.data.created_by === "chatgpt-1", "Creator correct");

    // 404 for missing key
    r = await api("GET", "/data/nonexistent");
    assert(r.status === 404, "404 for missing key");

    // 14. Auto-create channel on message send
    console.log("\n14. Auto-create channel");
    r = await api("POST", "/messages", {
      channel: "auto-created",
      sender: "chatgpt-1",
      content: "This should auto-create the channel",
    });
    assert(r.status === 200, "Message sent to new channel");
    r = await api("GET", "/channels");
    assert(r.data.channels.some(c => c.name === "auto-created"), "Channel auto-created");

    // 15. Empty channel returns empty array
    console.log("\n15. Empty channel");
    await api("POST", "/channels", { name: "empty-chan" });
    r = await api("GET", "/messages/empty-chan");
    assert(r.data.messages.length === 0, "Empty channel returns empty array");
    assert(r.data.last_id === null, "last_id is null for empty channel");

    console.log(`\n${"=".repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${"=".repeat(40)}`);
  } catch (err) {
    console.error("Test error:", err);
    failed++;
  } finally {
    server.kill("SIGKILL");
    // Wait a moment for process to die before cleaning temp dir
    await new Promise(r => setTimeout(r, 500));
    rmSync(TEST_DB_DIR, { recursive: true, force: true });
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();
