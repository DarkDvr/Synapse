// The tool half of the loop rule, and the watcher the Architect's own turn never had.
//
// The switch was on and the guard caught nothing because nothing was watching the operator's
// own turn: a run is waited on by the runner, a chat the operator drives is not (13 Nov).
// The phrase half lives in loop-guard.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolSignature, loopStrike, LOOP_WINDOW, LOOP_NUDGE } from '../src/loop-detect.js';
import { createTurnGuard } from '../src/turn-guard.js';

const call = (name, target, output = '') => toolSignature({ name, target, output });
const long = (n) => `${'x'.repeat(n)}`;

test('the same call four times is a strike, and three is not', () => {
  const three = [call('read', 'a.md'), call('read', 'a.md'), call('read', 'a.md')];
  assert.equal(loopStrike(three), null, 'three is work, not a loop');
  const four = [...three, call('read', 'a.md')];
  assert.equal(loopStrike(four)?.kind, 'target');
  assert.equal(loopStrike(four)?.times, 4);
});

test('paging a long file is not a loop', () => {
  const paged = ['#0:2000', '#2000:2000', '#4000:2000', '#6000:2000', '#8000:2000'].map((slice) =>
    call('read', `big.md${slice}`),
  );
  assert.equal(loopStrike(paged), null, 'different targets, real progress');
});

test('the same answer three times is a strike even when the question moved', () => {
  // The 27B's shape: offset 34/limit 11, then 35/10 — the same paragraphs back.
  const same = long(600);
  const reads = [
    call('read', 'README.md#34:11', same),
    call('read', 'README.md#35:10', same),
    call('read', 'README.md#34:10', same),
  ];
  const strike = loopStrike(reads);
  assert.equal(strike?.kind, 'output');
  assert.equal(strike?.times, 3);
});

test('a short answer is never evidence', () => {
  assert.equal(toolSignature({ name: 'glob', target: 'x', output: 'No files found' }).digest, '');
});

test('a write is never judged by its answer', () => {
  assert.equal(toolSignature({ name: 'edit', target: 'a.py', output: long(600) }).digest, '');
});

test('the window is wide enough for a loop every other call', () => {
  assert.equal(LOOP_WINDOW, 12);
  const alternating = [];
  for (let i = 0; i < 4; i += 1) {
    alternating.push(call('read', 'same.md'));
    alternating.push(call('grep', `pattern-${i}`));
  }
  assert.equal(loopStrike(alternating)?.times, 4, 'still four in the window');
});

// ── the watcher ────────────────────────────────────────────────────
const fakeEngine = ({ active = [], messages = [] } = {}) => {
  const prompts = [];
  const sessions = [...active];
  return {
    prompts,
    engine: {
      listActiveSessions: async () => [...sessions],
      getMessages: async () => messages,
      prompt: async (id, text, opts) => {
        prompts.push({ id, text, opts });
      },
    },
  };
};
const msgPart = (n) => ({ type: 'tool', name: 'read', id: `call-${n}`, input: { path: 'README.md' }, output: long(600) });

test('the watcher nudges a loop once, by steer', async () => {
  const parts = [1, 2, 3, 4].map((n) => msgPart(n));
  const { engine, prompts } = fakeEngine({ active: ['sess_1'], messages: [{ parts }] });
  const notes = [];
  const guard = createTurnGuard({
    engine,
    sessionId: 'sess_1',
    log: { warn() {} },
    notify: (n) => notes.push(n),
    now: () => 1_000_000,
  });
  await guard.poll();
  assert.equal(prompts.length, 1, 'one nudge');
  assert.equal(prompts[0].opts?.delivery, 'steer', 'into the live turn, never after it');
  assert.ok(prompts[0].text.includes(LOOP_NUDGE.slice(0, 20)));
  assert.equal(notes.length, 0, 'one strike is not news yet');
});

test('a healthy turn is left alone', async () => {
  const parts = [
    { type: 'tool', name: 'read', id: 'a', input: { path: 'a.md' }, output: long(600) },
    { type: 'tool', name: 'read', id: 'b', input: { path: 'b.md' }, output: long(601) },
    { type: 'tool', name: 'edit', id: 'c', input: { path: 'a.md' }, output: 'done' },
    { type: 'tool', name: 'read', id: 'd', input: { path: 'a.md' }, output: long(602) },
  ];
  const { engine, prompts } = fakeEngine({ active: ['sess_1'], messages: [{ parts }] });
  const guard = createTurnGuard({ engine, sessionId: 'sess_1', log: { warn() {} } });
  await guard.poll();
  assert.equal(prompts.length, 0);
});

test('no nudge after the turn ends, and none for another session', async () => {
  const parts = [1, 2, 3, 4].map((n) => msgPart(n));
  const idle = fakeEngine({ active: [], messages: [{ parts }] });
  const guard = createTurnGuard({ engine: idle.engine, sessionId: 'sess_1', log: { warn() {} } });
  await guard.poll();
  assert.equal(idle.prompts.length, 0, 'an idle session is nobody to nudge');
  assert.equal(guard.state().stopped, true, 'and the watcher stops');

  const other = fakeEngine({ active: ['sess_1'], messages: [{ parts }] });
  const guard2 = createTurnGuard({ engine: other.engine, sessionId: 'sess_2', log: { warn() {} } });
  await guard2.poll();
  assert.equal(other.prompts.length, 0, 'only its own session');
});
