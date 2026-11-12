// The context figure can never be larger than the window it is a fraction of: some
// providers report \`cache.read\` as a running total, and a 27B once showed five million
// against a 262K window (12 Nov). The display clamps; this is the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withinWindow, cacheShare, lastPromptOf, noteArchitectCompaction } from '../web/rate-view.js';
import { state } from '../web/state.js';
import { promptParts } from '../src/runs.js';

test('a context figure is never larger than its window', () => {
  assert.equal(withinWindow(222325, 262144), 222325);
  assert.equal(withinWindow(5_000_000, 262144), 262144, 'a cumulative provider figure is capped at the window');
  assert.equal(withinWindow(1200, 0), 1200, 'no window known: the number is left alone');
  assert.equal(withinWindow(0, 262144), 0);
  assert.equal(withinWindow(NaN, 262144), 0);
});

test('the cache share is read from the two halves the provider reports', () => {
  // The operator's example: 120k of a 262k window, 92% of it cached.
  const share = cacheShare(9600, 110400, 262144);
  assert.equal(share.total, 120000);
  assert.equal(share.pct, 92);
  assert.equal(share.ok, true);

  // The real figures from test_27b: 699 fresh, 208,809 cached.
  assert.equal(cacheShare(699, 208809, 262144).pct, 99.7);

  // A provider that reports no cache figures has no share to show.
  assert.equal(cacheShare(4200, 0, 262144).ok, false);

  // A cumulative cache counter is not a prompt: refuse rather than invent.
  assert.equal(cacheShare(15_000, 5_000_000, 262144).ok, false);

  // No window known: the share is still computable, it is the cap that is missing.
  assert.equal(cacheShare(100, 900, 0).pct, 90);
});

// After a compaction there is no honest number until the next step reports its size.
// The compaction's own usage is the prompt it summarised: measured 13 Nov, 167,193 for a
// context that came out at 10,121 — printing it would be the same lie in a new place.
test('a compaction newer than the last step says so, and prints no size', () => {
  state.sessionId = 'sess_x';
  const step = { id: 'm1', type: 'assistant', created: 1000, raw: { tokens: { input: 160000, cache: { read: 7193 } } } };
  const pack = { id: 'c1', type: 'compaction', created: 2000, raw: { status: 'completed', tokens: { input: 167193, output: 2338 } } };
  const done = lastPromptOf([step, pack]);
  assert.equal(done.used, 0, 'no size is claimed');
  assert.equal(done.pending, 'compacted');

  const running = lastPromptOf([step, { ...pack, raw: { ...pack.raw, status: 'running' } }]);
  assert.equal(running.pending, 'compacting');

  // A step after it is the real context again: 10,121 tokens.
  const after = { id: 'm2', type: 'assistant', created: 3000, raw: { tokens: { input: 9000, cache: { read: 1121 } } } };
  assert.equal(lastPromptOf([step, pack, after]).used, 10121);
});

test('the card carries the compacting state until a usage event clears it', () => {
  state.sessionId = 'sess_x';
  state.archCtx = { sessionId: 'sess_x', used: 167193, fresh: 167193, cached: 0, at: Date.now() };
  noteArchitectCompaction('sess_x', 'start');
  assert.equal(state.archCtx.pending, 'compacting');
  assert.equal(state.archCtx.used, 0);
  noteArchitectCompaction('sess_x', 'end');
  assert.equal(state.archCtx.pending, 'compacted');
  // another chat's compaction must not touch this card
  noteArchitectCompaction('sess_other', 'start');
  assert.equal(state.archCtx.pending, 'compacted');
});

// The worker's card is fed by promptParts on the server: the same rule, one mode over.
test('a worker\'s compaction hides its size too', () => {
  const step = { type: 'assistant', created: 1000, raw: { tokens: { input: 150000, cache: { read: 17193 } } } };
  const pack = { type: 'compaction', created: 2000, raw: { status: 'completed', tokens: { input: 167193 } } };
  assert.equal(promptParts([step, pack]).pending, 'compacted');
  assert.equal(promptParts([step, pack]).used, 0);
  assert.equal(promptParts([step, { ...pack, raw: { status: 'running' } }]).pending, 'compacting');
  const after = { type: 'assistant', created: 3000, raw: { tokens: { input: 9000, cache: { read: 1121 } } } };
  assert.equal(promptParts([step, pack, after]).used, 10121);
});
