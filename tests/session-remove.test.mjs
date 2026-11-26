// The one deletion is a suffix: the last operator prompt and everything after it.
//
// The engine has no message delete; it has a revert boundary. This helper is what
// the API uses to find the boundary, and what keeps a steer, a harness report or a
// half-written answer from being offered as a removable exchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lastExchange } from '../src/session-remove.js';

const user = (id, text = 'Do the thing') => ({ id, type: 'user', text });
const assistant = (id, completed = 10) => ({ id, type: 'assistant', completed });
const idle = (id) => ({ id, type: 'idle' });

test('the last prompt is the boundary and every later message goes with it', () => {
  const out = lastExchange([user('u1'), assistant('a1'), idle('i1')]);
  assert.deepEqual(out, { ok: true, messageID: 'u1', count: 3 });
});

test('a failed turn with no answer is still a removable prompt', () => {
  assert.deepEqual(lastExchange([user('u1')]), { ok: true, messageID: 'u1', count: 1 });
});

test('only the last exchange is offered, not an earlier one', () => {
  const out = lastExchange([
    user('u1'),
    assistant('a1'),
    idle('i1'),
    user('u2'),
    assistant('a2'),
    idle('i2'),
  ]);
  assert.deepEqual(out, { ok: true, messageID: 'u2', count: 3 });
});

test('a steer after the prompt is not an exchange boundary', () => {
  const out = lastExchange([user('u1'), assistant('a1'), user('s1', '[steer] try again')]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /steer/);
});

test('a harness report in the turn is not silently deleted', () => {
  const out = lastExchange([
    user('u1'),
    assistant('a1'),
    { id: 'h1', type: 'synthetic', text: 'worker report', description: 'report' },
    idle('i1'),
  ]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /harness/);
});

test('a compaction in the turn is not silently deleted', () => {
  const out = lastExchange([
    user('u1'),
    assistant('a1'),
    { id: 'c1', type: 'compaction', raw: { status: 'completed' } },
  ]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /harness/);
});

test('a turn that is still being written cannot be removed', () => {
  const out = lastExchange([user('u1'), assistant('a1', null)]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /still being written/);
});

test('a local echo is not a boundary', () => {
  const out = lastExchange([
    user('u1'),
    { id: 'local-live-1', type: 'assistant', completed: 10 },
  ]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /has not reached the engine/);
});

test('there is nothing to remove without an operator prompt', () => {
  assert.equal(lastExchange([assistant('a1'), idle('i1')]).ok, false);
  assert.equal(lastExchange([]).ok, false);
});
