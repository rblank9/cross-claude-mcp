#!/usr/bin/env node

/**
 * Integration test for the Server-Sent Events (SSE) endpoint.
 * Starts the server in HTTP mode and tests the /api/stream endpoint.
 */

import { spawn, spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "server.mjs");
const PORT = 9877;

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
  console.log("Starting SSE API test suite...\n");

  const server = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), HOME: TEST_DB_DIR, STREAM_HEARTBEAT_MS: "500", CROSS_CLAUDE_DEV: "1" },
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
    // Helper to open SSE stream
    const openStream = async (query) => {
      const controller = new AbortController();
      const signal = controller.signal;

      const res = await fetch(`${BASE}/stream?${query}`, {
        signal, // no auth: like test-rest.mjs, the test server runs without MCP_API_KEY
      });

      if (!res.ok) {
        throw new Error(`Unexpected status: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const events = [];

      // Parse SSE blocks field by field; runs in the background so openStream returns at once.
      const parseBlock = (block) => {
        const ev = { event: null, id: null, data: null, comment: false };
        for (const l of block.split("\n")) {
          if (l.startsWith(":")) ev.comment = true;
          else if (l.startsWith("event: ")) ev.event = l.slice(7);
          else if (l.startsWith("id: ")) ev.id = l.slice(4);
          else if (l.startsWith("data: ")) { try { ev.data = JSON.parse(l.slice(6)); } catch { ev.data = null; } }
        }
        return ev;
      };
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split("\n\n");
            buffer = blocks.pop() || "";
            for (const b of blocks) if (b.trim()) events.push(parseBlock(b));
          }
        } catch { /* aborted on close */ }
      })();

      return {
        events,
        close: () => {
          controller.abort();
          try {
            reader.releaseLock();
          } catch (e) {
            // Swallow error on close
          }
        },
        waitFor: (predicate, timeoutMs) => {
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              resolve(null);
            }, timeoutMs);

            const check = () => {
              const match = events.find(predicate);
              if (match) {
                clearTimeout(timer);
                resolve(match);
              } else {
                setTimeout(check, 100);
              }
            };

            check();
          });
        },
      };
    };

    // a. GET /api/stream with no channels -> status 400.
    console.log("a. No channels in query");
    const r = await api("GET", "/stream?channels=");
    assert(r.status === 400, "No channels returns 400");

    // b. Open stream channels=alpha&instance_id=me. POST alpha from "other" content "hello-b" -> a message event with data.content "hello-b" arrives within 1000 ms.
    console.log("b. Stream with channels=alpha and instance_id=me");
    const stream = await openStream("channels=alpha&instance_id=me");
    const postRes = await api("POST", "/messages", {
      channel: "alpha",
      sender: "other",
      content: "hello-b",
      message_type: "message",
    });
    assert(postRes.status === 200 && postRes.data.id, "Message posted successfully");
    const event = await stream.waitFor(e => e.event === "message" && e.data && e.data.content === "hello-b", 1000);
    assert(event !== null, "Message event received within 1000 ms");

    // c. POST alpha from "me" content "echo-c", wait 700 ms, POST alpha from "other" content "after-c"; assert "after-c" arrives and "echo-c" never appears.
    console.log("c. Message from self is not sent");
    await api("POST", "/messages", {
      channel: "alpha",
      sender: "me",
      content: "echo-c",
      message_type: "message",
    });
    await new Promise(r => setTimeout(r, 700));
    const postRes2 = await api("POST", "/messages", {
      channel: "alpha",
      sender: "other",
      content: "after-c",
      message_type: "message",
    });
    assert(postRes2.status === 200 && postRes2.data.id, "Message posted successfully");
    const event2 = await stream.waitFor(e => e.event === "message" && e.data && e.data.content === "after-c", 1000);
    assert(event2 !== null, "Message event for 'after-c' received");
    const event3 = await stream.waitFor(e => e.event === "message" && e.data && e.data.content === "echo-c", 1000);
    assert(event3 === null, "Message from self is not sent");

    // d. POST beta from "other" content "beta-d"; wait 700 ms; assert "beta-d" never appears on the alpha stream.
    console.log("d. Message on beta channel not sent to alpha stream");
    const stream2 = await openStream("channels=alpha&instance_id=me");
    await api("POST", "/messages", {
      channel: "beta",
      sender: "other",
      content: "beta-d",
      message_type: "message",
    });
    await new Promise(r => setTimeout(r, 700));
    const event4 = await stream2.waitFor(e => e.event === "message" && e.data && e.data.content === "beta-d", 1000);
    assert(event4 === null, "Message on beta channel not sent to alpha stream");

    // e. Catch-up: note id X of the last message sent so far; POST alpha "cu-1" and "cu-2" from "other"; open a NEW stream channels=alpha&after_id=X; assert the first two message events are cu-1 then cu-2 (ids ascending) and both come before the ready event.
    console.log("e. Catch-up with after_id");
    const lastId = postRes2.data.id;
    await api("POST", "/messages", {
      channel: "alpha",
      sender: "other",
      content: "cu-1",
      message_type: "message",
    });
    await api("POST", "/messages", {
      channel: "alpha",
      sender: "other",
      content: "cu-2",
      message_type: "message",
    });
    const stream3 = await openStream(`channels=alpha&after_id=${lastId}&instance_id=me`);
    const event5 = await stream3.waitFor(e => e.event === "message" && e.data && e.data.content === "cu-1", 1000);
    const event6 = await stream3.waitFor(e => e.event === "message" && e.data && e.data.content === "cu-2", 1000);
    const event7 = await stream3.waitFor(e => e.event === "ready", 1000);
    assert(event5 !== null && event6 !== null && event7 !== null, "Catch-up events received");
    assert(event5.data.id < event6.data.id, "cu-1 has lower id than cu-2");
    const pos = (e) => stream3.events.indexOf(e);
    assert(pos(event5) < pos(event7), "cu-1 comes before ready event");
    assert(pos(event6) < pos(event7), "cu-2 comes before ready event");
    assert(event7.data.last_id === event6.data.id, "ready.last_id equals the last caught-up id");

    // f. A heartbeat comment arrives on a stream within 1500 ms.
    console.log("f. Heartbeat comment");
    const event8 = await stream3.waitFor(e => e.comment === true, 1500);
    assert(event8 !== null, "Heartbeat comment received within 1500 ms");

    // g. Close all streams, wait 300 ms, open a fresh stream and assert a new POST still arrives (server healthy after aborts).
    console.log("g. Server healthy after stream abort");
    stream.close();
    stream2.close();
    stream3.close();
    await new Promise(r => setTimeout(r, 300));
    const stream4 = await openStream("channels=alpha&instance_id=me");
    const postRes3 = await api("POST", "/messages", {
      channel: "alpha",
      sender: "other",
      content: "fresh-post",
      message_type: "message",
    });
    assert(postRes3.status === 200 && postRes3.data.id, "Message posted successfully");
    const event9 = await stream4.waitFor(e => e.event === "message" && e.data && e.data.content === "fresh-post", 1000);
    assert(event9 !== null, "Fresh message received after stream restart");

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
