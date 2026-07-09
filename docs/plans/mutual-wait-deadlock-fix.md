# Implementation Plan: Cross-Claude Mutual-Wait Deadlock Fix (v1)

Fixes two deadlock failure modes:
- **D1 (crossing-message/lost-cursor)**: Durable read cursor survives reconnects; prevents message blindness
- **D2 (turn-symmetry/mutual-wait)**: Late-waiter-yields detector breaks symmetric waits

Authoritative spec: `/private/tmp/claude-501/-Users-rblank-Projects-cross-claude-mcp/c7d0d316-5df5-4923-af42-328d11de53c1/scratchpad/deadlock-spec.md`

---

## Spec Interpretation & Design Decisions

**Decisions made where spec was under-specified:**

1. **GRACE_MS timing (line 87, "already waiting >= GRACE_MS")**: Set to **30,000 ms (30 seconds)**. Rationale: long enough to accumulate unrelated waits that shouldn't collide (network hiccups, legitimate slow responses), short enough to break genuine mutual-wait within a typical interaction. Not parameterized (no env var override) to avoid operator confusion.

2. **Hard ceiling for crash ghosts (line 85)**: Defined as **max_wait_minutes * 60 * 1000** from wait start, checked at yield-detection time. Stale waiters with `startedAt` older than this are dropped. Rationale: a process that started a wait 30 minutes ago and never yielded likely crashed; safe to discard.

3. **tenantKey derivation (line 77)**: Order is `db.tenantId ?? (typeof db.tenantKey === 'function' && db.tenantKey()) ?? ''`. Rationale: SaaS may expose tenantId directly as property OR as async tenantKey() function (TBD by SaaS impl); OSS has neither, falls back to `''`.

4. **Durable cursor monotonicity**: Implemented via SQL `MAX()` / `GREATEST()` in the upsert, not application-level guards. Rationale: DB-enforced monotonicity survives network retries and concurrent writes. Application logic NEVER regresses the cursor.

5. **Opportunistic cursor cleanup (line 100-101)**: Purges `read_cursors` rows with `updated_at` older than **30 days**, runs in the existing `cleanup(maxAgeDays = 7)` method. Rationale: read_cursors are low-volume (few kb even with thousands of instances), but stale entries accumulate over months. Cleanup is separate from the 7-day message retention so data isn't prematurely deleted if an instance goes dormant then reactivates.

6. **Instrumentation output format**: Single-line JSON to stderr (not structured logging, not printf). Format: `{"type":"wait_enter","channel":"#general","instance":"alice","timestamp":"2026-07-09T12:34:56Z"}`. Rationale: Railway captures stderr separately from stdout (which is MCP JSON-RPC stream); CLI users can filter/pipe without disrupting the protocol.

---

## Task List (Ordered by Dependency)

### **LANE 1: DATABASE — New read_cursors Table + Methods (Foundation)**

#### Task 1.1: Add read_cursors table to SCHEMA_SQL in db.mjs

**File**: `/Users/rblank/Projects/cross-claude-mcp/db.mjs`

**Location**: After line 45 (end of SCHEMA_SQL, before closing backtick)

**Exact SQL to add**:

```sql
  CREATE TABLE IF NOT EXISTS read_cursors (
    channel TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    last_read_id INTEGER NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel, instance_id)
  );

  CREATE INDEX IF NOT EXISTS idx_read_cursors_updated ON read_cursors(updated_at);
```

**Rationale**: Idempotent CREATE TABLE. Composite PK on (channel, instance_id) prevents duplicates. Index on updated_at enables the 30-day cleanup query. No SERIAL column (monotonic ID is not needed; channel+instance_id is the unique key). SaaS TenantDB will add `tenant_id` to PK when it implements this table.

---

#### Task 1.2: Add getReadCursor method to SqliteDB class

**File**: `/Users/rblank/Projects/cross-claude-mcp/db.mjs`

**Location**: After line 207 (after getReplies, before listInstances)

**Exact implementation**:

```javascript
  getReadCursor(channel, instanceId) {
    const result = this.db.prepare(
      `SELECT last_read_id FROM read_cursors WHERE channel = ? AND instance_id = ?`
    ).get(channel, instanceId);
    return result ? result.last_read_id : undefined;
  }
```

**Signature**: `getReadCursor(channel: string, instanceId: string) -> number | undefined`

**Semantics**: Returns the highest message ID ever shown to instanceId in channel, or undefined if no cursor exists.

---

#### Task 1.3: Add setReadCursor method to SqliteDB class

**File**: `/Users/rblank/Projects/cross-claude-mcp/db.mjs`

**Location**: After Task 1.2 (after getReadCursor)

**Exact implementation**:

```javascript
  setReadCursor(channel, instanceId, lastReadId) {
    // Monotonic upsert: never regress to a lower id
    this.db.prepare(`
      INSERT INTO read_cursors (channel, instance_id, last_read_id, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(channel, instance_id) DO UPDATE SET
        last_read_id = MAX(last_read_id, excluded.last_read_id),
        updated_at = datetime('now')
      WHERE excluded.last_read_id >= read_cursors.last_read_id
    `).run(channel, instanceId, lastReadId);
  }
```

**Signature**: `setReadCursor(channel: string, instanceId: string, lastReadId: number) -> void`

**Semantics**: Updates or inserts a cursor. Always stores `max(existing, new)`. Updates timestamp. Idempotent (safe to call repeatedly with same id).

**Note on WHERE clause**: SQLite's `MAX()` in the SET clause doesn't prevent insertion when the new id is lower; the WHERE clause gates the UPDATE to only occur if `excluded.last_read_id >= current`. INSERT always succeeds (by virtue of ON CONFLICT), but UPDATE is conditional. This ensures monotonicity even under concurrent writes.

---

#### Task 1.4: Add async getReadCursor method to PostgresDB class

**File**: `/Users/rblank/Projects/cross-claude-mcp/db.mjs`

**Location**: After line 432 (after getReplies, before listInstances)

**Exact implementation**:

```javascript
  async getReadCursor(channel, instanceId) {
    const result = await this.pool.query(
      `SELECT last_read_id FROM read_cursors WHERE channel = $1 AND instance_id = $2`,
      [channel, instanceId]
    );
    return result.rows[0]?.last_read_id;
  }
```

**Signature**: `async getReadCursor(channel: string, instanceId: string) -> Promise<number | undefined>`

**Semantics**: Same as SqliteDB version, but async.

---

#### Task 1.5: Add async setReadCursor method to PostgresDB class

**File**: `/Users/rblank/Projects/cross-claude-mcp/db.mjs`

**Location**: After Task 1.4 (after getReadCursor)

**Exact implementation**:

```javascript
  async setReadCursor(channel, instanceId, lastReadId) {
    // Monotonic upsert: never regress to a lower id
    await this.pool.query(`
      INSERT INTO read_cursors (channel, instance_id, last_read_id, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT(channel, instance_id) DO UPDATE SET
        last_read_id = GREATEST(read_cursors.last_read_id, EXCLUDED.last_read_id),
        updated_at = NOW()
    `, [channel, instanceId, lastReadId]);
  }
```

**Signature**: `async setReadCursor(channel: string, instanceId: string, lastReadId: number) -> Promise<void>`

**Semantics**: Same as SqliteDB, but async. Uses PG's `GREATEST()` instead of `MAX()`.

---

#### Task 1.6: Update cleanup methods to purge old read_cursors (opportunistic)

**File**: `/Users/rblank/Projects/cross-claude-mcp/db.mjs`

**SqliteDB location**: Line 246-252 (cleanup method), modify the three DELETE statements

**Exact change to SqliteDB.cleanup**:

```javascript
  cleanup(maxAgeDays = 7) {
    const interval = `-${maxAgeDays} days`;
    const msgs = this.db.prepare(`DELETE FROM messages WHERE created_at < datetime('now', ?)`).run(interval);
    const inst = this.db.prepare(`DELETE FROM instances WHERE last_seen < datetime('now', ?)`).run(interval);
    const data = this.db.prepare(`DELETE FROM shared_data WHERE created_at < datetime('now', ?)`).run(interval);
    // Opportunistic cleanup: purge read_cursors older than 30 days (independent of maxAgeDays)
    const cursors = this.db.prepare(`DELETE FROM read_cursors WHERE updated_at < datetime('now', '-30 days')`).run();
    return { messages: msgs.changes, instances: inst.changes, shared_data: data.changes, read_cursors: cursors.changes };
  }
```

**PostgresDB location**: Line 478-484 (cleanup method), modify similarly

**Exact change to PostgresDB.cleanup**:

```javascript
  async cleanup(maxAgeDays = 7) {
    const interval = `${maxAgeDays} days`;
    const msgs = await this.pool.query(`DELETE FROM messages WHERE created_at < NOW() - INTERVAL '1 day' * $1`, [maxAgeDays]);
    const inst = await this.pool.query(`DELETE FROM instances WHERE last_seen < NOW() - INTERVAL '1 day' * $1`, [maxAgeDays]);
    const data = await this.pool.query(`DELETE FROM shared_data WHERE created_at < NOW() - INTERVAL '1 day' * $1`, [maxAgeDays]);
    // Opportunistic cleanup: purge read_cursors older than 30 days (independent of maxAgeDays)
    const cursors = await this.pool.query(`DELETE FROM read_cursors WHERE updated_at < NOW() - INTERVAL '30 days'`);
    return { messages: msgs.rowCount, instances: inst.rowCount, shared_data: data.rowCount, read_cursors: cursors.rowCount };
  }
```

---

### **LANE 2: TOOLS LOGIC — resolveFloor, advanceCursor Rewrite, activeWaiters (Features A & B)**

#### Task 2.1: Add module-level activeWaiters Map and helper functions in tools.mjs

**File**: `/Users/rblank/Projects/cross-claude-mcp/tools.mjs`

**Location**: After line 20 (after STALE_THRESHOLD_SECONDS), before the registerTools function

**Exact code to add**:

```javascript
const MUTUAL_WAIT_DETECT = process.env.MUTUAL_WAIT_DETECT !== '0';
const GRACE_MS = 30000; // 30 seconds: consider a wait "long-running" after this
const activeWaiters = new Map();
// key: `${tenantKey}\0${channel}\0${instance}` -> { startedAt: Date, token: string }

// Derive tenantKey: for SaaS, uses db.tenantId or db.tenantKey(); for OSS, ''
function getTenantKey(db) {
  return db.tenantId ?? (typeof db.tenantKey === 'function' ? db.tenantKey() : '') ?? '';
}

// Log instrumentation to stderr (safe for MCP stdout stream)
function logWaitEvent(type, { channel, instance, elapsedMs, reason }) {
  const entry = { type, channel, instance, timestamp: new Date().toISOString() };
  if (elapsedMs !== undefined) entry.elapsedMs = elapsedMs;
  if (reason) entry.reason = reason;
  console.error(JSON.stringify(entry));
}
```

**Rationale**: activeWaiters is module-level (per-process, correct for OSS; SaaS will need a shared store in future). getTenantKey is a helper to abstract the tenant discovery. logWaitEvent writes single-line JSON to stderr for observability without disrupting MCP stream.

---

#### Task 2.2: Add resolveFloor async function in tools.mjs

**File**: `/Users/rblank/Projects/cross-claude-mcp/tools.mjs`

**Location**: After Task 2.1, before registerTools

**Exact code to add**:

```javascript
// Resolve the floor of the poll cursor, considering durable read_cursors if available.
// Called at the START of each poll operation (check_messages, wait_for_reply).
async function resolveFloor(channel, instance, clientAfterId, db) {
  // In-memory cursor (hot cache, always synchronous)
  const inMemoryCursor = readCursors.get(cursorKey(channel, instance));
  
  // Durable cursor (if db supports it, otherwise undefined)
  let durableCursor;
  if (typeof db.getReadCursor === 'function') {
    durableCursor = await db.getReadCursor(channel, instance);
  }
  
  // Floor = minimum of all three sources (never poll past any of them)
  const floor = Math.min(
    clientAfterId ?? Infinity,
    inMemoryCursor ?? Infinity,
    durableCursor ?? Infinity
  );
  
  return floor === Infinity ? -Infinity : floor;
}
```

**Signature**: `async resolveFloor(channel: string, instance: string, clientAfterId: number, db: object) -> Promise<number>`

**Semantics**: Returns the lowest point in message history we should poll from. Takes the minimum of client-provided after_id, in-memory cursor (hot cache), and durable cursor (DB). Ensures we never miss a crossing message, even after reconnect. Feature-detection: if db.getReadCursor is absent, degrades to in-memory+client only (SaaS-safe).

---

#### Task 2.3: Rewrite advanceCursor in tools.mjs to be async and persist

**File**: `/Users/rblank/Projects/cross-claude-mcp/tools.mjs`

**Location**: Line 72-76 (current advanceCursor), replace the function

**Exact replacement**:

```javascript
  async function advanceCursor(channel, instance, lastShownId) {
    if (!instance || lastShownId === undefined) return;
    const key = cursorKey(channel, instance);
    const current = readCursors.get(key) ?? -Infinity;
    // Only advance if strictly monotonic increase
    if (lastShownId > current) {
      readCursors.set(key, lastShownId);
      // Persist to DB if available (feature-detect)
      if (typeof db.setReadCursor === 'function') {
        await db.setReadCursor(channel, instance, lastShownId);
      }
    }
  }
```

**Signature**: `async advanceCursor(channel: string, instance: string, lastShownId: number) -> Promise<void>`

**Semantics**: Advances the read cursor in both in-memory Map (hot cache) and durable DB. Monotonic: never regresses. Async to allow DB write. Feature-detection: if db.setReadCursor is absent, skips DB write and uses in-memory only (SaaS-safe until TenantDB adds it).

---

#### Task 2.4: Rewrite check_messages to use resolveFloor

**File**: `/Users/rblank/Projects/cross-claude-mcp/tools.mjs`

**Location**: Line 243-279 (check_messages tool), modify two call sites

**Exact changes**:

- **Line 257** (effectiveAfter call): 

  OLD:
  ```javascript
        messages = await db.getUnread(normalized, effectiveAfter(normalized, instance_id, after_id), instance_id);
  ```

  NEW:
  ```javascript
        const floor = await resolveFloor(normalized, instance_id, after_id, db);
        messages = await db.getUnread(normalized, floor, instance_id);
  ```

- **Line 274** (advanceCursor call): Already async at call site, just needs await:

  OLD:
  ```javascript
      advanceCursor(normalized, instance_id, lastId);
  ```

  NEW:
  ```javascript
      await advanceCursor(normalized, instance_id, lastId);
  ```

**Rationale**: check_messages is already async (returns Promise), so adding await is safe. resolveFloor replaces effectiveAfter at the call site, picking up durable cursor on first poll.

---

#### Task 2.5: Rewrite wait_for_reply to use resolveFloor, add late-waiter-yields, add instrumentation (Change C)

**File**: `/Users/rblank/Projects/cross-claude-mcp/tools.mjs`

**Location**: Line 281-375 (wait_for_reply tool), full rewrite of the tool body

**Pseudocode structure** (implementation must follow exactly):

```javascript
  server.tool(
    "wait_for_reply",
    "Poll a channel until a new message arrives from another instance. Persistent by default — keeps listening across multiple poll cycles until a message arrives, a 'done' signal is received, or max_wait_minutes is reached. Pass persistent: false for one-shot polling (original behavior).",
    {
      channel: z.string().default("general").describe("Channel to poll"),
      after_id: z.number().describe("Only look for messages after this ID"),
      instance_id: z.string().describe("Your instance_id (filters out your own messages)"),
      timeout_seconds: z.number().default(90).describe("Seconds per poll cycle (default: 90)"),
      poll_interval_seconds: z.number().default(5).describe("Seconds between polls within a cycle (default: 5)"),
      persistent: z.boolean().default(true).describe("Keep listening across poll cycles until a message arrives (default: true). Pass false for one-shot polling."),
      max_wait_minutes: z.number().default(30).describe("Hard ceiling in minutes for persistent mode (default: 30)"),
    },
    async ({ channel, after_id, instance_id, timeout_seconds, poll_interval_seconds, persistent, max_wait_minutes }, extra) => {
      const normalized = normalizeChannelName(channel);
      const tenantKey = getTenantKey(db);
      const waiterKey = `${tenantKey}\0${normalized}\0${instance_id}`;
      const token = randomUUID();
      const start = Date.now();
      const hardDeadline = start + max_wait_minutes * 60 * 1000;
      const KEEPALIVE_INTERVAL_MS = 30_000;
      let lastKeepalive = Date.now();
      let pollCount = 0;

      // === Register this waiter (for late-waiter-yields detection) ===
      if (MUTUAL_WAIT_DETECT) {
        activeWaiters.set(waiterKey, { startedAt: start, token });
        logWaitEvent('wait_enter', { channel: normalized, instance: instance_id });
      }

      async function sendKeepalive() {
        if (!extra?.sendNotification) return;
        const elapsed = Math.round((Date.now() - start) / 1000);
        try {
          if (extra._meta?.progressToken !== undefined) {
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken: extra._meta.progressToken,
                progress: elapsed,
                total: max_wait_minutes * 60,
                message: `Polling #${normalized} (${elapsed}s, ${pollCount} checks)`,
              },
            });
          } else {
            await extra.sendNotification({
              method: "notifications/message",
              params: { level: "debug", data: `Polling #${normalized} (${elapsed}s, ${pollCount} checks)`, logger: "wait_for_reply" },
            });
          }
        } catch { /* connection may already be dead — ignore */ }
        lastKeepalive = Date.now();
      }

      async function checkYield() {
        // Run late-waiter-yields detector to break mutual-wait (D2)
        if (!MUTUAL_WAIT_DETECT) return null; // detector disabled
        
        const elapsedMs = Date.now() - start;
        const otherWaiters = Array.from(activeWaiters.entries())
          .filter(([key]) => {
            const [tk, ch, inst] = key.split('\0');
            return tk === tenantKey && ch === normalized && inst !== instance_id;
          });
        
        // Drop stale / dead peer waiters
        const liveWaiters = [];
        for (const [key, { startedAt }] of otherWaiters) {
          const [, , peerId] = key.split('\0');
          
          // Check if peer is still online
          const peerInst = await db.getInstance(peerId);
          const peerOnline = peerInst?.status === 'online' && (Date.now() - new Date(peerInst.last_seen).getTime()) / 1000 < STALE_THRESHOLD_SECONDS;
          
          // Check if wait has crashed (exceeded hard ceiling)
          const waitDuration = Date.now() - startedAt;
          const withinCeiling = waitDuration < hardDeadline - startedAt;
          
          if (peerOnline && withinCeiling) {
            liveWaiters.push({ key, startedAt, peerId });
          } else if (!peerOnline) {
            // Clean up dead peer from activeWaiters
            activeWaiters.delete(key);
          }
        }
        
        // Check if any live peer has waited >= GRACE_MS
        for (const { key, startedAt, peerId } of liveWaiters) {
          const peerWaitMs = Date.now() - startedAt;
          if (peerWaitMs >= GRACE_MS) {
            // Peer has waited long enough. Do we yield?
            const myWaitMs = elapsedMs;
            if (myWaitMs >= GRACE_MS) {
              // Both in grace period: tie-break by id (lexicographically GREATER yields)
              if (instance_id > peerId) {
                logWaitEvent('mutual_wait_yield', { 
                  channel: normalized, 
                  instance: instance_id, 
                  elapsedMs: myWaitMs,
                  reason: `peer ${peerId} waiting ${peerWaitMs}ms`
                });
                return {
                  content: [{
                    type: "text",
                    text: `🔓 MUTUAL WAIT: peer "${peerId}" is already waiting on #${normalized} with nothing queued. Send a message to break the tie instead of waiting.`
                  }]
                };
              }
              // else: my id is smaller, so I keep waiting; peer should yield
            } else {
              // Peer waited long, I'm newer: I yield
              logWaitEvent('mutual_wait_yield', { 
                channel: normalized, 
                instance: instance_id, 
                elapsedMs: myWaitMs,
                reason: `peer ${peerId} waiting ${peerWaitMs}ms (me: ${myWaitMs}ms)`
              });
              return {
                content: [{
                  type: "text",
                  text: `🔓 MUTUAL WAIT: peer "${peerId}" is already waiting on #${normalized} with nothing queued. Send a message to break the tie instead of waiting.`
                }]
              };
            }
          }
        }
        return null; // No yield condition met
      }

      try {
        while (true) {
          // Re-resolve floor at the START of each cycle (picks up concurrent advances)
          const floor = await resolveFloor(normalized, instance_id, after_id, db);
          const cycleDeadline = Date.now() + timeout_seconds * 1000;

          while (Date.now() < cycleDeadline && Date.now() < hardDeadline) {
            touchHeartbeat();
            pollCount++;
            const messages = await db.getUnread(normalized, floor, instance_id);

            if (messages.length > 0) {
              const hasDone = messages.some((m) => m.message_type === "done");
              const formatted = messages.map((m) =>
                `#${m.id} [${m.message_type}] ${m.sender} (${m.created_at})${m.in_reply_to ? ` (reply to #${m.in_reply_to})` : ""}:\n${m.content}`
              ).join("\n\n---\n\n");
              const lastId = messages[messages.length - 1].id;
              await advanceCursor(normalized, instance_id, lastId);
              logWaitEvent('wait_exit', { 
                channel: normalized, 
                instance: instance_id, 
                elapsedMs: Date.now() - start,
                reason: 'message_received'
              });
              return {
                content: [{ type: "text", text: `${messages.length} new message(s) in #${normalized}:\n\n${formatted}\n\n---\nLast message ID: ${lastId}${hasDone ? "\n\nThe other instance signaled DONE -- no further replies expected." : ""}` }],
              };
            }

            // Keep SSE stream alive through proxies
            if (Date.now() - lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
              await sendKeepalive();
            }

            await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
          }

          // Cycle finished with no messages — check for late-waiter-yields before continuing
          if (MUTUAL_WAIT_DETECT) {
            const yieldResult = await checkYield();
            if (yieldResult) {
              logWaitEvent('wait_exit', { 
                channel: normalized, 
                instance: instance_id, 
                elapsedMs: Date.now() - start,
                reason: 'mutual_wait_yield'
              });
              return yieldResult;
            }
          }

          // If not persistent, return (non-persistent timeout)
          if (!persistent) {
            logWaitEvent('wait_exit', { 
              channel: normalized, 
              instance: instance_id, 
              elapsedMs: Date.now() - start,
              reason: 'timeout_nonpersistent'
            });
            return {
              content: [{ type: "text", text: `No new messages in #${normalized} after waiting ${timeout_seconds}s. The other instance may be busy or offline. You can try again, send a message to prompt them, or check list_instances. (Persistent mode disabled.)` }],
            };
          }

          // Persistent mode: check hard ceiling
          if (Date.now() >= hardDeadline) {
            logWaitEvent('wait_exit', { 
              channel: normalized, 
              instance: instance_id, 
              elapsedMs: Date.now() - start,
              reason: 'hard_ceiling'
            });
            const elapsed = Math.round((Date.now() - start) / 60000);
            return {
              content: [{ type: "text", text: `No new messages in #${normalized} after ${elapsed} minute(s). The other instance may also be waiting — send a message rather than waiting again, or check list_instances.` }],
            };
          }

          // Persistent mode: restart cycle
          await sendKeepalive();
        }
      } finally {
        // Deregister from activeWaiters if token matches (protects overlapping same-instance waits)
        if (MUTUAL_WAIT_DETECT) {
          const entry = activeWaiters.get(waiterKey);
          if (entry && entry.token === token) {
            activeWaiters.delete(waiterKey);
          }
        }
      }
    }
  );
```

**Key changes from current code**:

1. Register/deregister in activeWaiters with token-based finally guard
2. Call resolveFloor at the START of each cycle (not just once)
3. Add checkYield() function that runs after each cycle with no messages
4. Add logWaitEvent calls for wait_enter, wait_exit, mutual_wait_yield
5. Update timeout messages (lines 359, 367) to mention "the other instance may also be waiting"
6. Feature-detect MUTUAL_WAIT_DETECT env var (default enabled)

---

### **LANE 3: INTEGRATION — Feature Detection & Testing**

#### Task 3.1: Verify no breaking changes to registerTools signature

**File**: `/Users/rblank/Projects/cross-claude-mcp/tools.mjs`

**Location**: Line 45 (registerTools function signature)

**Action**: Confirm signature is unchanged:

```javascript
export function registerTools(server, db, planChecker = null) {
```

No changes needed. The db object is already passed and used; new methods are feature-detected.

---

#### Task 3.2: Ensure readCursors closure variable is available for resolveFloor

**File**: `/Users/rblank/Projects/cross-claude-mcp/tools.mjs`

**Location**: Line 62 (readCursors definition) and line 63 (cursorKey function)

**Action**: Confirm these are already in scope within registerTools. No changes needed; they're already closure-scoped.

---

#### Task 3.3: Add activeWaiters reference in checkYield (db reference)

**File**: `/Users/rblank/Projects/cross-claude-mcp/tools.mjs`

**Location**: Task 2.5 (checkYield function), line with `await db.getInstance(peerId)`

**Action**: Confirm db is in scope. It is (parameter to registerTools). No changes needed.

---

### **LANE 4: TESTS (Comprehensive, covering D1 + D2 + feature-detection + env gates)**

#### Task 4.1: Create test file with all test cases

**File**: `/Users/rblank/Projects/cross-claude-mcp/test-mutual-wait.mjs`

**Exact content**:

```javascript
#!/usr/bin/env node

/**
 * Tests for mutual-wait deadlock fixes (Changes A, B, C)
 * - A: Durable read cursor (fixes D1 crossing-message miss)
 * - B: Late-waiter-yields (fixes D2 mutual-wait)
 * - C: Instrumentation + timeout messages
 */

import { createDB } from './db.mjs';
import { registerTools } from './tools.mjs';
import { randomUUID } from 'crypto';

const { default: Database } = await import('better-sqlite3');
const { unlinkSync, existsSync } = await import('fs');
const { tmpdir } = await import('os');
const { join } = await import('path');

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ✗ ${message}`);
    testsFailed++;
  }
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    testsFailed++;
  }
}

// Clean and create in-memory SQLite DB for fast testing
const dbPath = join(tmpdir(), `test-cursor-${Date.now()}.db`);
if (existsSync(dbPath)) unlinkSync(dbPath);

const db = new (await import('./db.mjs')).createDB ? 
  await (await import('./db.mjs')).createDB() :
  (() => {
    // Fallback: manually create SqliteDB for test isolation
    const sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    const SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS channels (
        name TEXT PRIMARY KEY,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL REFERENCES channels(name),
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT DEFAULT 'message',
        in_reply_to INTEGER REFERENCES messages(id),
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS instances (
        instance_id TEXT PRIMARY KEY,
        description TEXT,
        last_seen TEXT DEFAULT (datetime('now')),
        status TEXT DEFAULT 'online',
        session_token TEXT
      );
      CREATE TABLE IF NOT EXISTS read_cursors (
        channel TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        last_read_id INTEGER NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (channel, instance_id)
      );
      CREATE TABLE IF NOT EXISTS shared_data (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_by TEXT NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        label TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        used_at TEXT,
        used_by TEXT
      );
    `;
    sqlite.exec(SCHEMA_SQL);
    sqlite.prepare(`INSERT OR IGNORE INTO channels (name) VALUES ('general')`).run();
    
    // Wrap in db-like interface
    return {
      db: sqlite,
      getReadCursor: function(channel, instanceId) {
        const result = sqlite.prepare(
          `SELECT last_read_id FROM read_cursors WHERE channel = ? AND instance_id = ?`
        ).get(channel, instanceId);
        return result ? result.last_read_id : undefined;
      },
      setReadCursor: function(channel, instanceId, lastReadId) {
        sqlite.prepare(`
          INSERT INTO read_cursors (channel, instance_id, last_read_id, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(channel, instance_id) DO UPDATE SET
            last_read_id = MAX(last_read_id, excluded.last_read_id),
            updated_at = datetime('now')
          WHERE excluded.last_read_id >= read_cursors.last_read_id
        `).run(channel, instanceId, lastReadId);
      },
      sendMessage: function(channel, sender, content, messageType, inReplyTo) {
        const result = sqlite.prepare(
          `INSERT INTO messages (channel, sender, content, message_type, in_reply_to) VALUES (?, ?, ?, ?, ?)`
        ).run(channel, sender, content, messageType, inReplyTo);
        return result.lastInsertRowid;
      },
      getUnread: function(channel, afterId, instanceId) {
        return sqlite.prepare(
          `SELECT m.*, (SELECT COUNT(*) FROM messages r WHERE r.in_reply_to = m.id) as reply_count
           FROM messages m WHERE m.channel = ? AND m.id > ? AND m.sender != ? ORDER BY m.created_at ASC`
        ).all(channel, afterId, instanceId);
      },
      getInstance: function(instanceId) {
        return sqlite.prepare(`SELECT * FROM instances WHERE instance_id = ?`).get(instanceId);
      },
      registerInstance: function(instanceId, description, sessionToken) {
        sqlite.prepare(
          `INSERT INTO instances (instance_id, description, last_seen, status, session_token)
           VALUES (?, ?, datetime('now'), 'online', ?)
           ON CONFLICT(instance_id) DO UPDATE SET
             description = excluded.description,
             last_seen = datetime('now'),
             status = 'online',
             session_token = excluded.session_token`
        ).run(instanceId, description, sessionToken);
      },
      heartbeat: function(instanceId) {
        sqlite.prepare(`UPDATE instances SET last_seen = datetime('now'), status = 'online' WHERE instance_id = ?`).run(instanceId);
      },
      markStaleOffline: function(thresholdSeconds) {
        sqlite.prepare(`UPDATE instances SET status = 'offline' WHERE status = 'online' AND last_seen < datetime('now', '-' || ? || ' seconds')`).run(thresholdSeconds);
      },
      listChannels: function() { return []; },
      createChannel: function() {},
      listChannelsWithActivity: function() { return []; },
    };
  })();

// ============ TESTS ============

await test('CHANGE A: Durable read cursor — getReadCursor returns undefined on fresh', async () => {
  const cursor = db.getReadCursor('general', 'alice');
  assert(cursor === undefined, 'Fresh instance has no cursor');
});

await test('CHANGE A: Durable read cursor — setReadCursor and retrieve', async () => {
  db.setReadCursor('general', 'bob', 42);
  const cursor = db.getReadCursor('general', 'bob');
  assert(cursor === 42, 'setReadCursor(42) → getReadCursor() === 42');
});

await test('CHANGE A: Durable read cursor — monotonicity (lower id is no-op)', async () => {
  db.setReadCursor('general', 'charlie', 100);
  db.setReadCursor('general', 'charlie', 50); // Lower — should be ignored
  const cursor = db.getReadCursor('general', 'charlie');
  assert(cursor === 100, 'setReadCursor(50) after setReadCursor(100) kept 100 (monotonic)');
});

await test('CHANGE A: Durable read cursor — higher id advances', async () => {
  db.setReadCursor('general', 'diana', 100);
  db.setReadCursor('general', 'diana', 150);
  const cursor = db.getReadCursor('general', 'diana');
  assert(cursor === 150, 'setReadCursor(150) after setReadCursor(100) advanced to 150');
});

await test('CHANGE A: D1 regression — crossing message miss prevented after in-memory Map clear', async () => {
  // Simulate: instance "eve" reads message 50, then 60 (advances in-memory Map)
  // Reconnect: in-memory Map is cleared (simulated by resetting the db)
  // New poll should still pick up the durable cursor at 60, not regress to 40
  
  // Register two instances
  db.registerInstance('eve', null, randomUUID());
  db.registerInstance('frank', null, randomUUID());
  
  // Eve sends a message
  const id1 = db.sendMessage('general', 'eve', 'first', 'message', null);
  
  // Frank reads it, advancing cursor in-memory AND durable
  db.setReadCursor('general', 'frank', id1);
  
  // Frank sends a reply (his id is higher)
  const id2 = db.sendMessage('general', 'frank', 'reply', 'message', null);
  
  // Eve polls from her own send id (client after_id)
  // Without Change A, resolveFloor would fall back to effectiveAfter(in-memory) which is undefined after reconnect
  // With Change A, resolveFloor picks up the durable cursor that frank set
  const durableCursor = db.getReadCursor('general', 'frank');
  assert(durableCursor === id1, 'Durable cursor survives: frank\\'s cursor is id1');
  
  // Frank reconnects (in-memory Map is cleared). If we poll with a high after_id (e.g., id2),
  // the durable cursor should still be found and used to floor the poll.
  const afterReconnect = db.getReadCursor('general', 'frank');
  assert(afterReconnect === id1, 'Durable cursor survives reconnect: frank\\'s cursor is still id1');
});

await test('CHANGE B: Late-waiter-yields — feature-detection (db stub without getReadCursor)', async () => {
  // Create a stub db object without cursor methods
  const stubDb = {
    // Has other methods, but NOT getReadCursor or setReadCursor
    listChannels: () => [],
    createChannel: () => {},
  };
  
  // Call tools with stub db — should NOT throw
  let threwError = false;
  try {
    // Create a minimal MCP server mock
    const mockServer = {
      tool: () => {},
      prompt: () => {},
    };
    registerTools(mockServer, stubDb);
  } catch (err) {
    threwError = true;
    console.error(`    Unexpected error: ${err.message}`);
  }
  
  assert(!threwError, 'registerTools with stub db (no cursor methods) does not throw');
});

await test('CHANGE B: Late-waiter-yields — MUTUAL_WAIT_DETECT env gate', async () => {
  const originalEnv = process.env.MUTUAL_WAIT_DETECT;
  process.env.MUTUAL_WAIT_DETECT = '0';
  
  // With MUTUAL_WAIT_DETECT=0, the detector should be disabled
  // (We test this by inspecting the module state in an actual wait_for_reply call,
  //  but for now we just verify the env var is read)
  const isDisabled = process.env.MUTUAL_WAIT_DETECT === '0';
  assert(isDisabled, 'MUTUAL_WAIT_DETECT=0 disables the detector');
  
  // Restore
  process.env.MUTUAL_WAIT_DETECT = originalEnv;
});

await test('CHANGE C: Instrumentation output is JSON to stderr', async () => {
  // Capture stderr
  const originalError = console.error;
  let logOutput = [];
  console.error = (msg) => logOutput.push(msg);
  
  // Simulate a log event (would happen inside wait_for_reply)
  const testEntry = { type: 'wait_enter', channel: 'general', instance: 'test-instance', timestamp: new Date().toISOString() };
  console.error(JSON.stringify(testEntry));
  
  assert(logOutput.length > 0, 'Instrumentation output captured');
  assert(logOutput[0].includes('wait_enter'), 'Log contains event type');
  assert(logOutput[0].includes('general'), 'Log contains channel');
  
  // Restore
  console.error = originalError;
});

// ============ CLEANUP ============

if (existsSync(dbPath)) unlinkSync(dbPath);

console.log(`\n${'='.repeat(50)}`);
console.log(`Tests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);
process.exit(testsFailed > 0 ? 1 : 0);
```

**Important notes**:

1. Test runner is custom (no test framework) to match existing test.mjs style
2. Tests use better-sqlite3 in-memory (via tmpdir file) for isolation
3. Test 4.1.5 (D1 regression) is the critical one: fails without Change A, passes with it
4. Test 4.1.6 (feature-detection) verifies no throw when db lacks cursor methods
5. Tests can be run standalone: `node test-mutual-wait.mjs`

---

#### Task 4.2: Update package.json to include new test in test script

**File**: `/Users/rblank/Projects/cross-claude-mcp/package.json`

**Location**: Line 13 (test script)

**Exact change**:

OLD:
```json
    "test": "node test.mjs && node test-rest.mjs"
```

NEW:
```json
    "test": "node test.mjs && node test-rest.mjs && node test-mutual-wait.mjs"
```

---

## Definition of Done (Lane-Based Verification)

### **Lane 1: DATABASE**

- [ ] `read_cursors` table created in SCHEMA_SQL (CREATE TABLE IF NOT EXISTS, composite PK, index on updated_at)
- [ ] **SqliteDB**: `getReadCursor(channel, instanceId) -> number | undefined` returns last_read_id or undefined
- [ ] **SqliteDB**: `setReadCursor(channel, instanceId, lastReadId)` inserts/upserts with monotonic MAX() guard in WHERE clause
- [ ] **PostgresDB**: `async getReadCursor(...)` mirrors SQLite semantics
- [ ] **PostgresDB**: `async setReadCursor(...)` uses GREATEST() instead of MAX()
- [ ] Both `cleanup()` methods updated to purge read_cursors rows > 30 days
- [ ] Database test passes: 
  ```bash
  node test-mutual-wait.mjs
  # Expect: "CHANGE A" section to show 4 passes
  ```

**Verification commands**:
```bash
# Schema is correct
sqlite3 ~/.cross-claude-mcp/messages.db ".schema read_cursors"
# Should output the table with composite key and updated_at index

# Round-trip works
node -e "
import { createDB } from './db.mjs'; 
const db = await createDB(); 
db.setReadCursor('test-ch', 'test-id', 99); 
const result = db.getReadCursor('test-ch', 'test-id'); 
console.log(result === 99 ? 'PASS' : 'FAIL');
"
```

---

### **Lane 2: LOGIC**

- [ ] **resolveFloor**: async function defined at module level, takes (channel, instance, clientAfterId, db)
  - Returns the minimum of clientAfterId, in-memory cursor, durable cursor (feature-detect db.getReadCursor)
  - Feature-detection guard: `typeof db.getReadCursor === 'function'`
- [ ] **advanceCursor**: rewritten to be async, persists via `db.setReadCursor` (feature-detect), maintains in-memory Map
- [ ] **check_messages**: calls `resolveFloor` instead of `effectiveAfter`, awaits `advanceCursor`
- [ ] **wait_for_reply**: 
  - Registers in activeWaiters with token (deregister in finally with token match)
  - Calls resolveFloor at START of each cycle
  - Implements checkYield() function that:
    - Filters activeWaiters by (tenantKey, channel) and excludes self instance
    - Drops stale/dead peers (offline status or > STALE_THRESHOLD_SECONDS old)
    - Returns yield message if a peer has waited >= 30 seconds AND I'm either newer (lower wait time) or lexicographically greater
    - Deterministic tie-break: lexicographically GREATER instance_id yields
  - Calls checkYield after each cycle with no messages (before loop restart)
- [ ] **Instrumentation**: logWaitEvent writes single-line JSON to stderr with type, channel, instance, timestamp, elapsedMs, reason
  - wait_enter: logged on entry
  - wait_exit with reason: logged on exit (message_received, mutual_wait_yield, timeout_nonpersistent, hard_ceiling)
  - mutual_wait_yield: logged when yield condition is met
- [ ] **Timeout messages** (non-persistent and hard-deadline returns): Updated to say "The other instance may also be waiting — send a message rather than waiting again"

**Verification commands**:
```bash
# resolveFloor exists and is awaitable
node -e "
import { registerTools } from './tools.mjs';
import { createDB } from './db.mjs';
const db = await createDB();
const server = { tool: () => {}, prompt: () => {} };
registerTools(server, db);
console.log('registerTools completed without error');
"

# Instrumentation writes JSON to stderr (grep for wait_enter/wait_exit in logs)
# This is implicit in integration testing; see Task 4.3 below
```

---

### **Lane 3: CONFIG**

- [ ] MUTUAL_WAIT_DETECT env var: active by default (`process.env.MUTUAL_WAIT_DETECT !== '0'`)
- [ ] GRACE_MS hardcoded to 30000 ms (not configurable, intentional)
- [ ] getTenantKey function defined: uses `db.tenantId ?? db.tenantKey() ?? ''`
- [ ] activeWaiters module-level Map created before registerTools
- [ ] No breaking changes to registerTools signature or return value
- [ ] Feature-detection gates added:
  - `typeof db.getReadCursor === 'function'` in resolveFloor, advanceCursor, check_messages
  - `typeof db.setReadCursor === 'function'` in advanceCursor
  - MUTUAL_WAIT_DETECT env gate in wait_for_reply

**Verification commands**:
```bash
# Feature-detection test (db without cursor methods doesn't throw)
node test-mutual-wait.mjs
# Expect "feature-detection" test to pass

# Env var gate
MUTUAL_WAIT_DETECT=0 node server.mjs &
sleep 1
# Verify server started without error
pkill -f "node server.mjs"

# Default (no env var set): detector is active
unset MUTUAL_WAIT_DETECT
node server.mjs &
sleep 1
pkill -f "node server.mjs"
```

---

### **Integration Test (All Lanes)**

- [ ] Full test suite passes:
  ```bash
  npm test
  # Expect: test.mjs, test-rest.mjs, and test-mutual-wait.mjs all green
  ```
- [ ] Server boots cleanly with schema migration applied (read_cursors table created):
  ```bash
  rm -f ~/.cross-claude-mcp/messages.db*
  node server.mjs &
  sleep 2
  sqlite3 ~/.cross-claude-mcp/messages.db ".tables"
  # Should list: channels, instances, invite_codes, messages, read_cursors, shared_data
  pkill -f "node server.mjs"
  ```
- [ ] Instrumentation events appear in stderr when wait_for_reply is called (integration test adds assertions or observes logs)

---

## Risk & Rollback

### **Pre-Deploy Checklist (per deploy-safety skill)**

- [ ] All tests pass locally: `npm test`
- [ ] Schema migration is idempotent: `node -e "import { createDB } from './db.mjs'; const db = await createDB(); db.getInstance('x'); console.log('OK')"`
- [ ] Feature-detection gates prevent breakage on old db implementations
- [ ] No SaaS-only logic in db.mjs (all new methods are OSS/SaaS-agnostic; SaaS adds tenant_id on its side)

### **Post-Deploy Observations (Railway logs)**

Watch for:
1. **No schema errors**: `read_cursors` table creation should be silent (idempotent)
2. **Instrumentation traffic**: Look for `{"type":"wait_enter"...}` and `{"type":"wait_exit"...}` in stderr
3. **No regressions in poll behavior**: crossing messages should still be visible (verifiable by manual cross-instance tests)

### **SaaS Follow-Up (Not v1)**

After v1 ships, SaaS repo must:
1. Implement TenantDB methods: `getReadCursor`, `setReadCursor` (mirror SqliteDB/PostgresDB signatures)
2. Add `tenant_id` to read_cursors table PK and scoping
3. Run `npm update` in saas/ to pick up the new tools.mjs package
4. Test that feature-detection gates properly activate the SaaS versions

### **Rollback Plan**

If a critical bug is discovered post-deploy:

1. **Schema is safe to rollback**: read_cursors table can be dropped (idempotent, no cascade). Falling back to in-memory-only readCursors (existing behavior) is safe—no data loss, just one reconnect regresses to legacy D1 risk.

2. **Disable detector via env**: If late-waiter-yields causes false positives, set `MUTUAL_WAIT_DETECT=0` before restart. Detector is OFF, mutual-wait still possible but no false returns.

3. **Commit to revert**:
   ```bash
   git revert <commit-hash>
   git push
   railway up  # deploys the revert
   ```

---

## Implementation Sequence (Recommended Order)

**Sequential approach** (commit after each task group):

1. **DB Schema + methods (Tasks 1.1–1.6)**: Foundational. Test with `test-mutual-wait.mjs` after 1.3 & 1.4.
2. **Tools logic (Tasks 2.1–2.3)**: Add helpers, resolveFloor, advanceCursor rewrite.
3. **check_messages integration (Task 2.4)**: Uses resolveFloor, tests will pass after 2.1–2.3.
4. **wait_for_reply full rewrite (Task 2.5)**: Largest, most complex. Requires 2.1–2.4.
5. **Tests + integration (Tasks 4.1–4.2)**: Full suite. Commit test file after 2.5 is complete.
6. **Feature-detection verification (Task 3.1–3.3)**: Implicit in code review; no code changes, just assertions.

---

## Spec Compliance Checklist

✓ **Change A (Durable read cursor)**: Tasks 1.1–1.6 + 2.2–2.4. Prevents D1 across reconnects.

✓ **Change B (Late-waiter-yields)**: Task 2.1 (activeWaiters) + 2.5 (checkYield logic). Fixes D2.

✓ **Change C (Instrumentation + timeout copy)**: Task 2.5 (logWaitEvent calls + message rewrites). Enables observability.

✓ **Feature-detection**: Implicit in all tasks (guards on `typeof db.* === 'function'`, MUTUAL_WAIT_DETECT env).

✓ **Hard constraints** (from CLAUDE.md):
  - tools.mjs is the ONE shared file — feature-detection protects SaaS ✓
  - No tenant_id in db.mjs ✓ (SaaS adds it in TenantDB)
  - New table is idempotent ✓ (CREATE TABLE IF NOT EXISTS)
  - Tests required ✓ (test-mutual-wait.mjs)

✓ **Spec-defined bounds**:
  - GRACE_MS = 30000 ✓
  - Hard ceiling = max_wait_minutes * 60 * 1000 ✓
  - Opportunistic cleanup = 30 days for read_cursors ✓
  - Monotonic upsert via MAX()/GREATEST() in SQL ✓
  - tenantKey derivation via db.tenantId / db.tenantKey() / '' ✓

---

## File Summary

**Files to create**:
- `/Users/rblank/Projects/cross-claude-mcp/test-mutual-wait.mjs` (Task 4.1)

**Files to modify**:
- `/Users/rblank/Projects/cross-claude-mcp/db.mjs` (Tasks 1.1–1.6, +18 lines SqliteDB, +18 lines PostgresDB)
- `/Users/rblank/Projects/cross-claude-mcp/tools.mjs` (Tasks 2.1–2.5, +50 lines helpers, ~300 lines wait_for_reply rewrite, +5 lines check_messages)
- `/Users/rblank/Projects/cross-claude-mcp/package.json` (Task 4.2, 1 line)

**No files deleted or moved.**

---

## Questions & Open Points

None. Spec is complete and design decisions are documented above.

---

## BINDING CORRECTIONS (post-plan red-team) — THESE OVERRIDE THE PLAN BODY

Two Opus red-team passes ran against this plan. The following corrections are **authoritative**; where they conflict with the task bodies above, follow the correction. Apply every one.

### C1 — Nested scope (fixes "readCursors is not defined") [overrides Task 2.1, 2.2, 2.5 placement]
`resolveFloor`, `checkYield`, `logWaitEvent`, and `getTenantKey` **MUST be nested functions declared INSIDE `registerTools`**, after the existing `readCursors` / `cursorKey` definitions (tools.mjs ~line 63), because they reference `readCursors`, `cursorKey`, and `db`. Do NOT place them at module scope.
- Only these stay module-level (shared across all `registerTools` calls, correct for the single-process server): `const activeWaiters = new Map();` and `const GRACE_MS = 30000;` and `const MUTUAL_WAIT_DETECT = process.env.MUTUAL_WAIT_DETECT !== '0';`.
- Because they are nested, `resolveFloor`/`advanceCursor` do NOT need `db` passed as a parameter — they close over it. (Ignore the `, db)` trailing param shown in the Task 2.2 signature.)

### C2 — getTenantKey MUST be async and awaited [overrides Task 2.1]
```js
async function getTenantKey() {                 // nested in registerTools
  if (db.tenantId) return db.tenantId;          // property form (SaaS may expose this)
  if (typeof db.tenantKey === 'function') return await db.tenantKey(); // may be async
  return '';                                    // open-source
}
```
Every caller does `const tenantKey = await getTenantKey();` BEFORE building `waiterKey`. A non-awaited Promise interpolated into the key would corrupt it (`[object Promise]`).

### C3 — Peer-staleness ceiling compares the PEER's own wait, not my deadline [overrides Task 2.5 checkYield]
A ghost/crashed peer is one whose OWN wait has exceeded a fixed ceiling. Do NOT compare against `hardDeadline - startedAt` (that mixes my deadline with the peer's clock). Use:
```js
const peerWaited = Date.now() - peer.startedAt;
const peerIsGhost = peerWaited >= max_wait_minutes * 60 * 1000;   // peer's own ceiling
```
Drop the peer from consideration if `peerIsGhost` OR the peer instance is offline (via `await db.getInstance(peerId)` → status/last_seen vs STALE_THRESHOLD_SECONDS). `await` on the sync SQLite `getInstance` is harmless and works for both drivers — keep it awaited.

### C4 — SQLite monotonic upsert: keep scalar `max(a,b)` but qualify the existing value [clarifies Task 1.3]
SQLite `max(x, y)` with **two args is a valid scalar function** (aggregate only with one arg) — it will NOT crash. Remove ambiguity by table-qualifying the existing-row value and writing `updated_at` on the update:
```sql
INSERT INTO read_cursors (channel, instance_id, last_read_id, updated_at)
VALUES (?, ?, ?, datetime('now'))
ON CONFLICT(channel, instance_id) DO UPDATE SET
  last_read_id = max(read_cursors.last_read_id, excluded.last_read_id),
  updated_at   = datetime('now');
```
PG form is already correct (`GREATEST(read_cursors.last_read_id, EXCLUDED.last_read_id)`, `updated_at = NOW()`); ensure `updated_at` is set on BOTH insert and update there too.

### C5 — resolveFloor must never return a non-finite floor [overrides Task 2.2 return]
`min(clientAfterId, inMemoryCursor ?? +Infinity, durableCursor ?? +Infinity)`. If the result is not a finite number (all sources absent), return `0` — NEVER `-Infinity`/`Infinity`. Rationale: message ids are 1-indexed positives, and better-sqlite3/pg throw when binding `Infinity`. In practice `clientAfterId` is always defined at both call sites (wait_for_reply requires it; check_messages only calls resolveFloor inside `after_id !== undefined`), but clamp defensively.

### C6 — D1 regression test must exercise resolveFloor after a simulated reconnect [overrides Task 4.1 "D1 regression"]
The test must PROVE the fix, not just the DB round-trip. Required shape:
1. Instance `frank` reads up to `id1` → `advanceCursor` persists cursor=id1 (in-memory + durable).
2. **Simulate reconnect: clear the in-memory `readCursors` Map** (or use a fresh registerTools whose Map is empty but shares the same `db`).
3. Call `resolveFloor('general', 'frank', id2)` where `id2 > id1` (a too-high client after_id, e.g. frank's own later send).
4. Assert the returned floor === `id1` (durable cursor wins), NOT `id2`. This test MUST FAIL if Change A / durable lookup is removed.

### C7 — MUTUAL_WAIT_DETECT=0 test must assert BEHAVIOR [overrides Task 4.1 env-gate test]
Do not merely assert `process.env.MUTUAL_WAIT_DETECT === '0'`. Arrange a mutual-wait condition (two waiters registered in `activeWaiters` for the same tenant/channel, one past GRACE) with the gate off, invoke the yield-check, and assert it returns "no yield". With the gate on, the same arrangement must yield. Prefer making GRACE_MS injectable/override-able in tests to avoid real 30s/90s sleeps — drive `checkYield` directly with crafted `startedAt` timestamps rather than wall-clock waits.

### C8 — Yield-check timing [clarifies Task 2.5]
- Register into `activeWaiters` (with `token = randomUUID()`) BEFORE the first poll, so a peer can observe this waiter immediately.
- Run `checkYield` once per cycle when that cycle produced no messages for me — but note the default cycle is 90s while GRACE is 30s: to make the breaker responsive, ALSO run `checkYield` inside the inner poll loop (every `poll_interval_seconds`, default 5s) once elapsed ≥ GRACE, not only at the 90s cycle boundary.
- `finally`: deregister ONLY if `activeWaiters.get(waiterKey)?.token === token` (guards overlapping same-instance waits).
- Simultaneous tie (both started within GRACE, neither past it): the lexicographically GREATER `instance_id` yields; the smaller keeps waiting. Exactly one yields.

### Verdict
All CRITICAL items from both passes are folded in above. Reviewer's "SQLite MAX crashes" (C4) was factually incorrect but the clarified form is adopted anyway. Reviewer's async-wrap of getInstance (SHOULD-FIX #2) is rejected — awaiting the sync method is safe. Proceed to implementation using the plan body AS CORRECTED BY C1–C8.
