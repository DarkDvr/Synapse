// Which delegated runs a restart left open. The measured failure: t3 had a
// `delegate` record and no `result`, the plan said todo, and the Architect waited
// for a worker that no longer existed.
//
// Run: node tests\open-delegations.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDelegations } from '../src/plans.js';

const delegate = (callId, extra = {}) => ({
  kind: 'delegate',
  callId,
  task: 't1',
  role: 'coder-1',
  at: 1000,
  ...extra,
});
const result = (callId) => ({ kind: 'result', callId, outcome: 'completed', at: 2000 });

test('a delegate with no result is open', () => {
  assert.deepEqual(openDelegations([delegate('a')]).map((r) => r.callId), ['a']);
});

test('a delegate with a result is closed', () => {
  assert.deepEqual(openDelegations([delegate('a'), result('a')]), []);
});

test('a delegate that carries its own outcome is already settled', () => {
  // A delegation refused in Single mode is recorded with an outcome and no result.
  assert.deepEqual(openDelegations([delegate('a', { outcome: 'single-mode' })]), []);
});

test('a deferred delegation is settled, so a boot cannot replay it', () => {
  // Measured 27 Oct: t5/t6/t9 were deferred because a worker was running, nothing
  // was journalled, and the next boot started t5 again from a round the operator
  // had stopped.
  assert.deepEqual(openDelegations([delegate('a', { outcome: 'deferred' })]), []);
});

test('a result without a delegate is not an open run', () => {
  assert.deepEqual(openDelegations([result('a')]), []);
});

test('a record without a call id cannot be closed by id, so it is ignored', () => {
  assert.deepEqual(openDelegations([{ kind: 'delegate', task: 't1' }]), []);
});

test('only the unfinished one is returned from a mixed log', () => {
  const runs = [delegate('a'), result('a'), delegate('b', { outcome: 'unknown-task' }), delegate('c')];
  assert.deepEqual(openDelegations(runs).map((r) => r.callId), ['c']);
});
