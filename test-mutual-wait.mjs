#!/usr/bin/env node

/**
 * Real consumer-path tests for mutual-wait deadlock fixes
 * - A: Durable read cursor via check_messages (D1 fix)
 * - B: Late-waiter-yields via decideYield + checkYield
 * - C: Instrumentation via wait_for_reply, timeout messages
 */

import { createDB } from './db.mjs';
import { randomUUID } from 'crypto';

// Speed up the mutual-wait GRACE window for integration tests (production default is 30s).
// Must be set before tools.mjs is loaded (GRACE_MS is read at module init).
process.env.MUTUAL_WAIT_GRACE_MS ||= '150';
const { registerTools, decideYield } = await import('./tools.mjs');

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
    console.error(`  ERROR: ${err.message}\n${err.stack}`);
    testsFailed++;
  }
}

const db = await createDB();

// ============ CHANGE A: D1 REGRESSION TEST (CONSUMER PATH) ============

await test('CHANGE A: D1 Positive — durable cursor lets crossing message be seen after reconnect', async () => {
  const bob = `bob_${Math.random().toString(36).slice(2)}`;
  const alice = `alice_${Math.random().toString(36).slice(2)}`;
  await db.registerInstance(bob, null, randomUUID());
  await db.registerInstance(alice, null, randomUUID());

  // Baseline: bob has read up to the current max id in the channel.
  const baseline = await db.sendMessage('general', bob, 'baseline', 'message', null);
  db.setReadCursor('general', bob, baseline);          // durable cursor = baseline

  // Now the crossing: alice sends (idAlice), then bob sends (idBob > idAlice).
  const idAlice = await db.sendMessage('general', alice, 'alice_crossing', 'message', null);
  const idBob   = await db.sendMessage('general', bob,   'bob_send',       'message', null);

  // Reconnect: fresh registerTools => empty in-memory Map, same db (durable survives).
  const handlers = {};
  registerTools({ tool: (n,_d,_s,fn)=>{handlers[n]=fn;}, prompt: ()=>{} }, db);

  // Bob polls anchored on his OWN send (idBob, above alice's crossing id).
  const res = await handlers.check_messages({ channel:'general', after_id: idBob, instance_id: bob });
  const text = res.content[0].text;

  // With the durable cursor (=baseline < idAlice) as the floor, alice's crossing msg IS seen.
  // Without it, floor would be idBob and alice's lower-id msg would be missed.
  assert(text.includes(`#${idAlice}`) || text.includes('alice_crossing'),
    `Durable cursor lets bob see alice's crossing message #${idAlice} despite polling after_id=${idBob}`);
});

await test('CHANGE A: D1 Negative control — without durable cursor, crossing message is missed', async () => {
  // Use a different instance that never had a cursor set
  const uuid = randomUUID();
  await db.registerInstance('ghost', null, uuid);
  await db.registerInstance('alice2', null, randomUUID());

  // Alice sends
  const idAlice = await db.sendMessage('general', 'alice2', 'alice_msg', 'message', null);

  // Ghost sends (higher id)
  const idGhost = await db.sendMessage('general', 'ghost', 'ghost_msg', 'message', null);

  // Fresh registerTools for ghost
  const handlers = {};
  const mockServer = {
    tool: (name, _desc, _schema, fn) => { handlers[name] = fn; },
    prompt: () => {}
  };
  registerTools(mockServer, db);

  // Ghost polls with after_id=idGhost (client thinks it's at its own send)
  // NO durable cursor set, so in-memory only (empty after reconnect)
  // Should use clientAfterId=idGhost, missing alice's message
  const checkResult = await handlers.check_messages({
    channel: 'general',
    after_id: idGhost,
    instance_id: 'ghost'
  });

  const text = checkResult.content[0].text;
  // Should NOT include alice's message (no durable cursor to floor it)
  const missingAliceMessage = !text.includes(`#${idAlice}`) && !text.includes('alice_msg');
  assert(missingAliceMessage, `Without durable cursor, Alice's message (id ${idAlice}) is correctly filtered out`);
});

// ============ CHANGE B: LATE-WAITER-YIELDS TESTS ============

await test('CHANGE B: decideYield — late waiter yields to early peer', async () => {
  const result = decideYield({
    myId: 'instance1',
    myWaitMs: 5000,  // Late (before GRACE)
    peers: [{ peerId: 'instance2', peerWaitMs: 40000 }],  // Early (past GRACE=30s)
    graceMs: 30000
  });
  assert(result === 'instance2', 'Late waiter yields to peer that has waited >= GRACE');
});

await test('CHANGE B: decideYield — tie-break: lexicographically greater yields', async () => {
  const result = decideYield({
    myId: 'z-instance',  // Greater
    myWaitMs: 40000,      // Both past GRACE
    peers: [{ peerId: 'a-instance', peerWaitMs: 40000 }],
    graceMs: 30000
  });
  assert(result === 'a-instance', 'z-instance (greater) yields to a-instance (lesser)');
});

await test('CHANGE B: decideYield — lexicographically smaller keeps waiting', async () => {
  const result = decideYield({
    myId: 'a-instance',  // Smaller
    myWaitMs: 40000,      // Both past GRACE
    peers: [{ peerId: 'z-instance', peerWaitMs: 40000 }],
    graceMs: 30000
  });
  assert(result === null, 'a-instance (smaller) does not yield to z-instance (greater)');
});

await test('CHANGE B: decideYield — no yield if peer below GRACE', async () => {
  const result = decideYield({
    myId: 'instance1',
    myWaitMs: 5000,
    peers: [{ peerId: 'instance2', peerWaitMs: 20000 }],  // Below GRACE=30s
    graceMs: 30000
  });
  assert(result === null, 'No yield if peer has not waited >= GRACE');
});

await test('CHANGE B: decideYield — no yield with no peers', async () => {
  const result = decideYield({
    myId: 'instance1',
    myWaitMs: 40000,
    peers: [],
    graceMs: 30000
  });
  assert(result === null, 'No yield with empty peer list');
});

// ============ CHANGE C: INSTRUMENTATION & TIMEOUT MESSAGES ============

await test('CHANGE C: Instrumentation — wait_for_reply emits wait_enter JSON to stderr', async () => {
  const originalError = console.error;
  let stderr = [];
  console.error = (msg) => stderr.push(msg);

  const handlers = {};
  const mockServer = {
    tool: (name, _desc, _schema, fn) => { handlers[name] = fn; },
    prompt: () => {}
  };
  registerTools(mockServer, db);

  // Trigger wait_for_reply with tiny timeout
  await handlers.wait_for_reply({
    channel: 'general',
    after_id: 999999,  // Far future, no messages
    instance_id: 'test_instance',
    timeout_seconds: 0.05,  // Very short
    poll_interval_seconds: 0.01,
    persistent: false
  });

  console.error = originalError;

  // Check stderr contains wait_enter JSON
  const hasWaitEnter = stderr.some(line => {
    try {
      const obj = JSON.parse(line);
      return obj.type === 'wait_enter' && obj.channel === 'general' && obj.instance === 'test_instance';
    } catch { return false; }
  });
  assert(hasWaitEnter, 'wait_for_reply emits wait_enter as JSON to stderr');
});

await test('CHANGE C: Timeout messages mention mutual-wait possibility', async () => {
  const handlers = {};
  const mockServer = {
    tool: (name, _desc, _schema, fn) => { handlers[name] = fn; },
    prompt: () => {}
  };
  registerTools(mockServer, db);

  // Trigger wait_for_reply (persistent, short max_wait_minutes)
  const result = await handlers.wait_for_reply({
    channel: 'general',
    after_id: 999999,
    instance_id: 'timeout_test',
    timeout_seconds: 0.05,
    poll_interval_seconds: 0.01,
    persistent: true,
    max_wait_minutes: 0.001  // ~60ms hard ceiling
  });

  const text = result.content[0].text;
  const hasMutualWaitCopy = text.includes('peer might also be waiting');
  assert(hasMutualWaitCopy, 'Hard-deadline timeout message mentions mutual-wait possibility');
});

// ============ WS1: PARKED ROLE + SINGLE-WAIT + CURSOR-SWALLOW + GHOST-BY-HEARTBEAT ============

function makeHandlers(database = db) {
  const handlers = {};
  registerTools({ tool: (n, _d, _s, fn) => { handlers[n] = fn; }, prompt: () => {} }, database);
  return handlers;
}
const rnd = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// NOTE: these tests call the tool handlers DIRECTLY (bypassing MCP/zod), so zod schema defaults
// are NOT applied — every wait_for_reply call must pass a complete param set (esp. max_wait_minutes,
// or hardDeadline becomes NaN and the poll loop is skipped).

await test('WS1-D1: parked peers do NOT pull an active conductor out of its wait', async () => {
  const ch = `topo-parked-${rnd()}`;
  const conductor = `zzz-conductor-${rnd()}`;
  const w1 = `aaa-worker-${rnd()}`;
  const w2 = `aaa-worker-${rnd()}`;
  for (const id of [conductor, w1, w2]) await db.registerInstance(id, null, randomUUID());

  const hW1 = makeHandlers(), hW2 = makeHandlers(), hC = makeHandlers();
  // Two workers park first and stay registered through the conductor's decision window.
  const pW1 = hW1.wait_for_reply({ channel: ch, after_id: 1e9, instance_id: w1, timeout_seconds: 1.5, poll_interval_seconds: 0.05, persistent: false, max_wait_minutes: 0.1, role: 'parked' });
  const pW2 = hW2.wait_for_reply({ channel: ch, after_id: 1e9, instance_id: w2, timeout_seconds: 1.5, poll_interval_seconds: 0.05, persistent: false, max_wait_minutes: 0.1, role: 'parked' });
  await sleep(220); // workers pass the (test-shortened) 150ms GRACE
  const rC = await hC.wait_for_reply({ channel: ch, after_id: 1e9, instance_id: conductor, timeout_seconds: 0.4, poll_interval_seconds: 0.05, persistent: false, max_wait_minutes: 0.1, role: 'active' });
  await Promise.all([pW1, pW2]);
  assert(!rC.content[0].text.includes('MUTUAL WAIT'), 'Active conductor does NOT yield to two parked peers (parked = not a mutual-wait party)');
});

await test('WS1-D2: forgotten role flag (peers default active) → conductor yields exactly as today', async () => {
  const ch = `topo-active-${rnd()}`;
  const conductor = `zzz-conductor-${rnd()}`;
  const w1 = `aaa-worker-${rnd()}`;
  for (const id of [conductor, w1]) await db.registerInstance(id, null, randomUUID());
  const hW1 = makeHandlers(), hC = makeHandlers();
  // role omitted → 'active' (the safe default when the flag is forgotten)
  const pW1 = hW1.wait_for_reply({ channel: ch, after_id: 1e9, instance_id: w1, timeout_seconds: 1.5, poll_interval_seconds: 0.05, persistent: false, max_wait_minutes: 0.1, role: 'active' });
  await sleep(220);
  const rC = await hC.wait_for_reply({ channel: ch, after_id: 1e9, instance_id: conductor, timeout_seconds: 0.4, poll_interval_seconds: 0.05, persistent: false, max_wait_minutes: 0.1, role: 'active' });
  await pW1;
  assert(rC.content[0].text.includes('MUTUAL WAIT'), 'With an active peer past GRACE, the greater-id conductor yields — unchanged from today (safe default)');
});

await test('WS1-E: single-wait — a newer wait supersedes the older one on the same channel', async () => {
  const ch = `supersede-${rnd()}`;
  const dup = `dup-${rnd()}`;
  await db.registerInstance(dup, null, randomUUID());
  const h = makeHandlers(); // same session/closure = same instance starting a second wait
  const pA = h.wait_for_reply({ channel: ch, after_id: 1e9, instance_id: dup, timeout_seconds: 5, poll_interval_seconds: 0.05, persistent: true, max_wait_minutes: 0.1, role: 'active' });
  await sleep(140);
  // pB must STAY registered long enough for pA to observe the token change (persistent + real ceiling).
  const pB = h.wait_for_reply({ channel: ch, after_id: 1e9, instance_id: dup, timeout_seconds: 5, poll_interval_seconds: 0.05, persistent: true, max_wait_minutes: 0.03, role: 'active' });
  const rA = await pA;
  await pB;
  assert(rA.content[0].text.toLowerCase().includes('superseded'), 'Older wait returns a clear "superseded" result once a newer wait starts on the same channel');
});

await test('WS1-F: cursor-swallow — advancing the read cursor mid-wait does NOT skip a later message', async () => {
  const ch = `swallow-${rnd()}`;
  const cs = `cs-${rnd()}`;
  const peer = `peer-${rnd()}`;
  await db.registerInstance(cs, null, randomUUID());
  await db.registerInstance(peer, null, randomUUID());
  await db.createChannel(ch, null); // messages.channel FK → channels.name
  const h = makeHandlers();
  // Baseline sets the durable cursor BELOW the client's high after_id, so the snapshot floor = baseline.
  const b0 = await db.sendMessage(ch, peer, 'baseline', 'message', null);
  await db.setReadCursor(ch, cs, b0);
  const pW = h.wait_for_reply({ channel: ch, after_id: 1e9, instance_id: cs, timeout_seconds: 0.3, poll_interval_seconds: 0.08, persistent: true, max_wait_minutes: 0.1, role: 'active' });
  await sleep(180);
  // Sibling turn consumes everything, advancing the durable cursor far past the wait's floor.
  // Under the OLD re-resolve-each-cycle code this would raise the floor to 1e9 and swallow the next msg.
  await db.setReadCursor(ch, cs, 1e9);
  const mx = await db.sendMessage(ch, peer, 'crossing-after-advance', 'message', null);
  const rW = await pW;
  assert(rW.content[0].text.includes('crossing-after-advance'),
    `Wait still fires on message #${mx} despite the cursor advancing to 1e9 (floor snapshotted at ${b0}, never re-resolved)`);
});

await test('WS1-G: ghost-by-heartbeat — a stale-heartbeat peer is evicted regardless of the 24h ceiling', async () => {
  const ch = `ghost-${rnd()}`;
  const conductor = `zzz-cond-${rnd()}`;
  const ghost = `aaa-ghost-${rnd()}`;
  await db.registerInstance(conductor, null, randomUUID());
  await db.registerInstance(ghost, null, randomUUID());
  // Ghost holds a young wait with the full 24h ceiling — wait-age says "alive", heartbeat says "dead".
  const hGhost = makeHandlers();
  const pGhost = hGhost.wait_for_reply({ channel: ch, after_id: 1e9, instance_id: ghost, timeout_seconds: 1.5, poll_interval_seconds: 0.05, persistent: false, max_wait_minutes: 1440, role: 'active' });
  await sleep(220);
  // Conductor sees the world through a db whose heartbeat view reports the ghost as long-offline.
  const staleDb = Object.create(db);
  staleDb.getInstance = async (id) =>
    id === ghost
      ? { instance_id: ghost, status: 'offline', last_seen: new Date(Date.now() - 10 * 60 * 1000).toISOString() }
      : db.getInstance(id);
  const hC = makeHandlers(staleDb);
  const rC = await hC.wait_for_reply({ channel: ch, after_id: 1e9, instance_id: conductor, timeout_seconds: 0.4, poll_interval_seconds: 0.05, persistent: false, max_wait_minutes: 0.1, role: 'active' });
  await pGhost;
  assert(!rC.content[0].text.includes('MUTUAL WAIT'),
    'Peer with a stale heartbeat is evicted from the waiter pool (eviction keyed on heartbeat, not the 24h wait-age ceiling), so the conductor does not yield');
});

// ============ CLEANUP ============

console.log(`\n${'='.repeat(50)}`);
console.log(`Tests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);
process.exit(testsFailed > 0 ? 1 : 0);
