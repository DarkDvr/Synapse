// The tool half of the loop rule, and the watcher the Architect's own turn never had.
//
// The switch was on and the guard caught nothing because nothing was watching the operator's
// own turn: a run is waited on by the runner, a chat the operator drives is not (13 Nov).
// The phrase half lives in loop-guard.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolSignature, loopStrike, LOOP_WINDOW, LOOP_NUDGE } from '../src/loop-detect.js';
import { createTurnGuard } from '../src/turn-guard.js';
import { toolTarget } from '../src/runs.js';

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

// The loop the operator could see on screen was `browser_read {maxChars:2000}` and
// `browser_scroll {dy:-3000}` alternating: neither has a path, so the guard had no
// signature for either and skipped every call (13 Nov).
test('a browser call has a signature, and an empty call has none', () => {
  assert.equal(toolTarget({ maxChars: 2000 }), 'maxChars=2000');
  assert.equal(toolTarget({ dy: -3000 }), 'dy=-3000');
  assert.equal(toolTarget({ limit: 5, maxChars: 2000 }), 'limit=5&maxChars=2000', 'key order is stable');
  assert.equal(toolTarget({}), '', 'no arguments is no signature');
  const loop = [1, 2, 3, 4].map(() => toolSignature({ name: 'synapse-browser_read', target: toolTarget({ maxChars: 2000 }) }));
  assert.equal(loopStrike(loop)?.times, 4, 'four identical browser calls strike');
});

// The two strikes of 13 Nov, replayed. Both were ours.
test('five reads of different slices of one file are paging, not a loop', () => {
  const paged = [216, 454, 668, 905, 1100].map((offset) =>
    toolSignature({ name: 'read', target: toolTarget({ path: 'archive.txt', offset, limit: 200 }) }),
  );
  assert.equal(loopStrike(paged), null, 'the target carries the slice');
});

test('five writes of one file are iteration, not a loop', () => {
  const writes = [1, 2, 3, 4, 5].map(() => toolSignature({ name: 'write', target: toolTarget({ path: 'ANSWER.md' }) }));
  assert.equal(writes.filter((w) => w.mutating).length, 5);
  assert.equal(loopStrike(writes), null, 'write, test, fix, write again is the work');
});

test('the same shell command with the same answer is still a loop', () => {
  const same = long(600);
  const runs = [1, 2, 3].map(() => toolSignature({ name: 'shell', target: toolTarget({ command: 'npm test' }), output: same }));
  assert.equal(loopStrike(runs)?.kind, 'output');
  assert.equal(loopStrike(runs)?.times, 3);
});

test('a shell command with different answers is polling, not a loop', () => {
  const runs = [1, 2, 3].map((n) => toolSignature({ name: 'shell', target: toolTarget({ command: 'npm test' }), output: long(600 + n) }));
  assert.equal(loopStrike(runs), null);
});

// A scroll is a movement, not a question: the same delta from a new position is new
// reading. On 14 Nov a model walking a long thread scrolled `dy: 400` five times between
// screenshots, and the fourth struck the guard as "the same target" (ornith-test-web-reddit).
test('a scroll that moves is reading, and one that cannot move is still a loop', () => {
  const moving = [400, 800, 1200, 1600].map((top) =>
    toolSignature({ name: 'synapse-browser_scroll', target: toolTarget({ dy: 400 }), output: `Scrolled to ${top} of 20000 (not at the end)\n\nsome page text` }),
  );
  assert.equal(loopStrike(moving), null, 'each scroll landed somewhere new');
  const stuck = [0, 1, 2, 3].map(() =>
    toolSignature({ name: 'synapse-browser_scroll', target: toolTarget({ dy: 400 }), output: 'Scrolled to 20000 of 20000 (at the end)\n\nsome page text' }),
  );
  assert.equal(loopStrike(stuck)?.kind, 'target', 'a page that cannot move is a loop');
});
