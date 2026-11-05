// The page must not believe a run is live just because it once heard it start.
//
// Measured 5 Nov: the Stop button was live and the chat said "Working — Stop to
// take over" over an Architect that had already said it was waiting. Nothing was
// running. The stream is the fast path, and it was the only thing that ever
// *removed* a run, so a `run.finished` lost to a dropped connection, a restart or a
// sleeping tab left the run painted for ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileRuns } from '../web/runs-sync.js';

const NOW = 1_800_000_000_000;
const run = (key, startedAt) => ({ key, startedAt, dir: `F:\\p\\${key}` });

test('a run the server no longer lists is dropped', () => {
  const current = new Map([['a', run('a', NOW - 60_000)]]);
  assert.deepEqual(reconcileRuns(current, [], NOW), { drop: ['a'], add: [] });
});

test('a run that started after the request left is kept', () => {
  // The answer cannot include a run that began while it was in flight; dropping it
  // would blink the card off in the middle of a start.
  const current = new Map([['a', run('a', NOW - 500)]]);
  assert.deepEqual(reconcileRuns(current, [], NOW), { drop: [], add: [] });
});

test('a run the server still lists is left alone', () => {
  const current = new Map([['a', run('a', NOW - 60_000)]]);
  assert.deepEqual(reconcileRuns(current, [run('a', NOW - 60_000)], NOW), { drop: [], add: [] });
});

test('a run the page never heard about is added', () => {
  const current = new Map();
  const live = [run('b', NOW - 1000)];
  assert.deepEqual(reconcileRuns(current, live, NOW), { drop: [], add: live });
});

test('one project ending does not disturb another that is still running', () => {
  const current = new Map([
    ['a', run('a', NOW - 60_000)],
    ['b', run('b', NOW - 60_000)],
  ]);
  const live = [run('b', NOW - 60_000)];
  assert.deepEqual(reconcileRuns(current, live, NOW), { drop: ['a'], add: [] });
});
