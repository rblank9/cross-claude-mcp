import { spawn, spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, rmSync, existsSync } from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = 9879;
const TEST_HOME = mkdtempSync(join(tmpdir(), "cross-claude-trust-test-"));
const BASE = `http://localhost:${PORT}`;
const TOK_A = "tok-" + "a";
const TOK_B = "tok-" + "b";
const LEGACY = "legacy-" + "test";
const TOK_BAD = "tok-" + "x";

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const KEYS_JSON = JSON.stringify({ "host-a": sha256hex(TOK_A), "host-b": sha256hex(TOK_B) });
const CROSS_CLAUDE_KEYS = Buffer.from(KEYS_JSON).toString('base64');

const assert = (cond, label) => {
  if (cond) {
    console.log(`  PASS: ${label}`);
    return { passed: true };
  } else {
    console.log(`  FAIL: ${label}`);
    return { passed: false };
  }
};

const killPort = () => {
  const pids = spawnSync('lsof', ['-ti', `:${PORT}`], { encoding: 'utf8' });
  if (pids.stdout) {
    const pidsList = pids.stdout.trim().split('\n');
    for (const pid of pidsList) {
      if (pid) {
        try {
          process.kill(parseInt(pid), 'SIGKILL');
        } catch (e) {
          // Ignore if process not found
        }
      }
    }
  }
};

const startServer = async (extraEnv) => {
  killPort();
  const env = {
    PATH: process.env.PATH,
    HOME: TEST_HOME,
    PORT: String(PORT),
    STREAM_HEARTBEAT_MS: "500",
    ...extraEnv
  };
  const proc = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  proc.stderr.on('data', (data) => {
    stderr += data;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Server timeout'));
    }, 10000);

    proc.stdout.on('data', (data) => {
      if (data.toString().includes('listening on port')) {
        clearTimeout(timeout);
        resolve({ proc, stderr: () => stderr });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
};

const stopServer = (proc) => {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill();
  });
};

const req = async (method, path, { token, body, headers } = {}) => {
  const url = BASE + path;
  const init = {
    method,
    headers: {
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  };

  if (body) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }

  try {
    const res = await fetch(url, init);
    const text = await res.text();
    const json = res.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(text) : null;
    return { status: res.status, text, json };
  } catch (e) {
    return { status: 500, text: e.message, json: null };
  }
};

const readSSE = async (path, token, untilPredicate, timeoutMs, onEvent) => {
  const url = BASE + path;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const init = {
    signal: controller.signal,
    headers: { Authorization: `Bearer ${token}` }
  };

  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      return null;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      for (let i = 0; i < events.length - 1; i++) {
        const event = events[i];
        const lines = event.split('\n');
        let eventData = {};
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventData.event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            eventData.data = line.slice(5).trim();
          }
        }
        if (eventData.event && eventData.data) {
          try {
            eventData.data = JSON.parse(eventData.data);
          } catch (e) {
            // Ignore if not JSON
          }
          if (onEvent) onEvent(eventData);
          if (untilPredicate(eventData)) {
            clearTimeout(timeout);
            controller.abort();
            return eventData;
          }
        }
      }
      buffer = events[events.length - 1];
    }
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
  return null;
};

const main = async () => {
  let passed = 0;
  let failed = 0;
  let serverProc = null;

  try {
    // Scenario MAIN
    const mainEnv = {
      MCP_API_KEY: LEGACY,
      CROSS_CLAUDE_KEYS: CROSS_CLAUDE_KEYS
    };

    const { proc, stderr } = await startServer(mainEnv);
    serverProc = proc;

    // a. No auth
    const aRes = await req('GET', '/api/messages/trust-ch?limit=5', {});
    const a = assert(aRes.status === 401, 'a. No auth: 401');
    passed += a.passed ? 1 : 0;
    failed += a.passed ? 0 : 1;

    // b. Wrong token
    const bRes = await req('GET', '/api/messages/trust-ch?limit=5', { token: TOK_BAD });
    const b = assert(bRes.status === 401, 'b. Wrong token: 401');
    passed += b.passed ? 1 : 0;
    failed += b.passed ? 0 : 1;

    // Setup: POST /api/channels
    const setupRes = await req('POST', '/api/channels', {
      token: LEGACY,
      body: { name: "trust-ch" }
    });
    const setup = assert(setupRes.status === 200, 'Setup: POST /api/channels');
    passed += setup.passed ? 1 : 0;
    failed += setup.passed ? 0 : 1;

    // c. POST with TOK_A
    const unique = randomBytes(8).toString('hex');
    const cPostRes = await req('POST', '/api/messages', {
      token: TOK_A,
      body: {
        channel: "trust-ch",
        sender: "alpha-sender",
        content: "body-from-a-" + unique
      }
    });
    const cGetRes = await req('GET', '/api/messages/trust-ch?limit=5', { token: TOK_A });
    const c = assert(cGetRes.status === 200 && cGetRes.json?.messages?.some(m => m.content === "body-from-a-" + unique && m.sender_key_id === "host-a"), 'c. TOK_A message sender_key_id');
    passed += c.passed ? 1 : 0;
    failed += c.passed ? 0 : 1;

    // c. GET /health
    const healthRes = await req('GET', '/health', {});
    const health = assert(healthRes.status === 200 && healthRes.json?.killed === false, 'c. /health: killed false');
    passed += health.passed ? 1 : 0;
    failed += health.passed ? 0 : 1;

    // d. POST with TOK_B
    const uniqueD = randomBytes(8).toString('hex');
    const dPostRes = await req('POST', '/api/messages', {
      token: TOK_B,
      body: {
        channel: "trust-ch",
        sender: "beta-sender",
        content: "body-from-b-" + uniqueD
      }
    });
    const dGetRes = await req('GET', '/api/messages/trust-ch?limit=5', { token: TOK_B });
    const d = assert(dGetRes.status === 200 && dGetRes.json?.messages?.some(m => m.content === "body-from-b-" + uniqueD && m.sender_key_id === "host-b"), 'd. TOK_B message sender_key_id');
    passed += d.passed ? 1 : 0;
    failed += d.passed ? 0 : 1;

    // d2. POST with LEGACY
    const uniqueD2 = randomBytes(8).toString('hex');
    const d2PostRes = await req('POST', '/api/messages', {
      token: LEGACY,
      body: {
        channel: "trust-ch",
        sender: "legacy-sender",
        content: "body-from-legacy-" + uniqueD2
      }
    });
    const d2GetRes = await req('GET', '/api/messages/trust-ch?limit=5', { token: LEGACY });
    const d2 = assert(d2GetRes.status === 200 && d2GetRes.json?.messages?.some(m => m.content === "body-from-legacy-" + uniqueD2 && m.sender_key_id === "legacy"), 'd2. LEGACY message sender_key_id');
    passed += d2.passed ? 1 : 0;
    failed += d2.passed ? 0 : 1;

    // e. SSE stream
    // One stream (TOK_A), opened once. After its "ready" event, TOK_B posts; the stream must deliver it.
    const uniqueE = randomBytes(8).toString('hex');
    let ePosted = false;
    const eEvent = await readSSE('/api/stream?channels=trust-ch', TOK_A,
      (event) => event.event === 'message' && event.data?.content === "stream-from-b-" + uniqueE,
      5000,
      async (event) => {
        if (event.event === 'ready' && !ePosted) {
          ePosted = true;
          await req('POST', '/api/messages', {
            token: TOK_B,
            body: { channel: "trust-ch", sender: "beta-sender", content: "stream-from-b-" + uniqueE }
          });
        }
      });
    const e = assert(eEvent !== null && eEvent.data?.sender_key_id === "host-b", 'e. SSE stream (TOK_A) message from TOK_B has sender_key_id host-b');
    passed += e.passed ? 1 : 0;
    failed += e.passed ? 0 : 1;

    // Scenario KILL
    const killEnv = {
      ...mainEnv,
      CROSS_CLAUDE_KILL: "1"
    };

    await stopServer(serverProc);
    serverProc = null;
    const { proc: killProc, stderr: killStderr } = await startServer(killEnv);
    serverProc = killProc;

    // f1. GET /api/messages/trust-ch?limit=5 with TOK_A
    const f1Res = await req('GET', '/api/messages/trust-ch?limit=5', { token: TOK_A });
    const f1 = assert(f1Res.status === 503 && f1Res.json?.error === "killed", 'f1. GET /api/messages with TOK_A: 503 killed');
    passed += f1.passed ? 1 : 0;
    failed += f1.passed ? 0 : 1;

    // f2. GET /api/stream?channels=trust-ch with TOK_A
    const f2Res = await req('GET', '/api/stream?channels=trust-ch', { token: TOK_A });
    const f2 = assert(f2Res.status === 503 && f2Res.json?.error === "killed", 'f2. GET /api/stream with TOK_A: 503 killed');
    passed += f2.passed ? 1 : 0;
    failed += f2.passed ? 0 : 1;

    // f3. POST /mcp with TOK_A
    const f3Res = await req('POST', '/mcp', { token: TOK_A, body: {} });
    const f3 = assert(f3Res.status === 503 && f3Res.json?.error === "killed", 'f3. POST /mcp with TOK_A: 503 killed');
    passed += f3.passed ? 1 : 0;
    failed += f3.passed ? 0 : 1;

    // f4. GET /health
    const f4Res = await req('GET', '/health', {});
    const f4 = assert(f4Res.status === 200 && f4Res.json?.killed === true, 'f4. /health: killed true');
    passed += f4.passed ? 1 : 0;
    failed += f4.passed ? 0 : 1;

    // f5. No token
    const f5Res = await req('GET', '/api/messages/trust-ch?limit=5', {});
    const f5 = assert(f5Res.status === 401, 'f5. No token: 401');
    passed += f5.passed ? 1 : 0;
    failed += f5.passed ? 0 : 1;

    // Scenario MALFORMED
    await stopServer(serverProc);
    serverProc = null;
    const malformedEnv = {
      MCP_API_KEY: LEGACY,
      CROSS_CLAUDE_KEYS: "not-json!!"
    };

    const { proc: malformedProc, stderr: malformedStderr } = await startServer(malformedEnv);
    serverProc = malformedProc;

    // g1. Server started
    const g1 = assert(true, 'g1. Server started');
    passed += g1.passed ? 1 : 0;
    failed += g1.passed ? 0 : 1;

    // g2. GET with LEGACY
    const g2Res = await req('GET', '/api/messages/trust-ch?limit=5', { token: LEGACY });
    const g2 = assert(g2Res.status === 200, 'g2. GET with LEGACY: 200');
    passed += g2.passed ? 1 : 0;
    failed += g2.passed ? 0 : 1;

    // g3. GET with TOK_A
    const g3Res = await req('GET', '/api/messages/trust-ch?limit=5', { token: TOK_A });
    const g3 = assert(g3Res.status === 401, 'g3. GET with TOK_A: 401');
    passed += g3.passed ? 1 : 0;
    failed += g3.passed ? 0 : 1;

    // Scenario NOKEYS
    await stopServer(serverProc);
    serverProc = null;
    const nokeysEnv = {};

    const { proc: nokeysProc, stderr: nokeysStderr } = await startServer(nokeysEnv);
    serverProc = nokeysProc;

    // h1. GET with no token
    const h1Res = await req('GET', '/api/messages/trust-ch?limit=5', {});
    const h1 = assert(h1Res.status === 401, 'h1. GET with no token: 401');
    passed += h1.passed ? 1 : 0;
    failed += h1.passed ? 0 : 1;

    // h2. GET /health
    const h2Res = await req('GET', '/health', {});
    const h2 = assert(h2Res.status === 200, 'h2. /health: 200');
    passed += h2.passed ? 1 : 0;
    failed += h2.passed ? 0 : 1;

    // h3. stderr contains warning (stderr may trail the stdout "listening" line by a tick)
    await new Promise((r) => setTimeout(r, 300));
    const h3 = assert(nokeysStderr().includes("no keys configured and CROSS_CLAUDE_DEV unset: all API requests will be refused"), 'h3. stderr contains warning');
    passed += h3.passed ? 1 : 0;
    failed += h3.passed ? 0 : 1;

    // Final cleanup
    await stopServer(serverProc);
    serverProc = null;

    // Remove TEST_HOME
    if (existsSync(TEST_HOME)) {
      try {
        await rmSync(TEST_HOME, { recursive: true, force: true });
      } catch (e) {
        console.error(`Failed to remove TEST_HOME: ${e.message}`);
      }
    }

    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failed > 0 || passed + failed === 0) {
      process.exitCode = 1;
    } else {
      process.exitCode = 0;
    }
  } catch (e) {
    console.error(`FAIL: uncaught ${e.message}`);
    failed += 1;
    process.exitCode = 1;
  } finally {
    if (serverProc) {
      await stopServer(serverProc);
    }
    if (existsSync(TEST_HOME)) {
      try {
        await rmSync(TEST_HOME, { recursive: true, force: true });
      } catch (e) {
        console.error(`Failed to remove TEST_HOME: ${e.message}`);
      }
    }
  }
};

main();
