// The record behind the permission chip.
//
// Run: node tests\permission-log.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPermissionLog } from '../src/permission-log.js';

const base = {
  sessionId: 'ses_1',
  toolCallId: 'call_1',
  action: 'edit',
  resources: ['D:/x.txt'],
  outside: true,
  reason: 'outside your workspace',
};

test('an auto decision is listed for its session', () => {
  const log = createPermissionLog();
  log.record({ ...base, requestId: 'req_1', effect: 'allow', asked: false, decided: true, decidedBy: 'harness' });
  const list = log.list('ses_1');
  assert.equal(list.length, 1);
  assert.equal(list[0].effect, 'allow');
  assert.equal(list[0].decidedBy, 'harness');
});

test('a pending ask is not a chip until the operator answers', () => {
  const log = createPermissionLog();
  log.record({ ...base, requestId: 'req_1', effect: 'ask', asked: true, decided: false, decidedBy: null });
  assert.deepEqual(log.list('ses_1'), []);

  const answered = log.answer('req_1', 'once');
  assert.equal(answered.effect, 'allow');
  assert.equal(answered.decidedBy, 'operator');
  assert.equal(log.list('ses_1').length, 1);
});

test('a rejection is recorded as a denial by the operator', () => {
  const log = createPermissionLog();
  log.record({ ...base, requestId: 'req_1', effect: 'ask', asked: true, decided: false });
  const answered = log.answer('req_1', 'reject');
  assert.equal(answered.effect, 'deny');
  assert.equal(answered.decidedBy, 'operator');
});

test('an unknown request is ignored', () => {
  const log = createPermissionLog();
  assert.equal(log.answer('nope', 'once'), null);
});

test('only the requested session, and only decided calls with a tool id', () => {
  const log = createPermissionLog();
  log.record({ ...base, requestId: 'req_1', effect: 'allow', decided: true });
  log.record({ ...base, sessionId: 'ses_2', requestId: 'req_2', effect: 'allow', decided: true });
  log.record({ ...base, requestId: 'req_3', toolCallId: null, effect: 'allow', decided: true });
  assert.deepEqual(log.list('ses_1').map((e) => e.requestId), ['req_1']);
  assert.deepEqual(log.list('ses_2').map((e) => e.requestId), ['req_2']);
});

test('the log is capped, oldest first out', () => {
  const log = createPermissionLog({ limit: 2 });
  for (const n of [1, 2, 3]) {
    log.record({ ...base, requestId: `req_${n}`, effect: 'allow', decided: true });
  }
  assert.deepEqual(log.list('ses_1').map((e) => e.requestId), ['req_2', 'req_3']);
});
