#!/usr/bin/env node

/**
 * Real consumer-path tests for mutual-wait deadlock fixes
 * - A: Durable read cursor via check_messages (D1 fix)
 * - B: Late-waiter-yields via decideYield + checkYield
 * - C: Instrumentation via wait_for_reply, timeout messages
 */

import { createDB } from './db.mjs';
import { registerTools, decideYield } from './tools.mjs';
import { randomUUID } from 'crypto';

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
  const hasMutualWaitCopy = text.includes('The other instance may also be waiting');
  assert(hasMutualWaitCopy, 'Hard-deadline timeout message mentions mutual-wait possibility');
});

// ============ CLEANUP ============

console.log(`\n${'='.repeat(50)}`);
console.log(`Tests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);
process.exit(testsFailed > 0 ? 1 : 0);
