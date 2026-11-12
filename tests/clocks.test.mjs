// The Architect's stopwatch follows its session, not the cards on screen: opening another
// project used to stop it and lose the time spent looking elsewhere (12 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceClock } from '../web/clocks.js';

const rec = () => ({ ms: 0, since: null, last: 0, sessionId: null });

test('a clock runs from the moment the session became busy', () => {
  const r = rec();
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 1000, now: 5000 });
  assert.equal(r.since, 1000, 'the start is the session turn, not the page noticing');
  assert.equal(r.sessionId, 'a');
});

test('looking at another project does not stop the clock', () => {
  const r = rec();
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 1000, now: 5000 });
  // The operator opens project b, which is idle.
  advanceClock(r, { sessionId: 'b', busy: false, busySince: null, now: 20000 });
  assert.equal(r.since, 1000, 'the running chat keeps its start');
  assert.equal(r.ms, 0, 'and nothing is banked yet');
  // Back to a, still working: the time away counts.
  const elapsed = 31000 - r.since;
  assert.equal(elapsed, 30000);
});

test('the clock banks its time when its own chat stops', () => {
  const r = rec();
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 1000, now: 5000 });
  advanceClock(r, { sessionId: 'a', busy: false, now: 6000 });
  assert.equal(r.since, null);
  assert.equal(r.ms, 5000);
  assert.equal(r.last, 5000);
});

test('a new turn on the same chat starts a new stopwatch', () => {
  const r = rec();
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 1000, now: 5000 });
  advanceClock(r, { sessionId: 'a', busy: false, now: 6000 });
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 7000, now: 8000 });
  assert.equal(r.since, 7000);
  assert.equal(r.ms, 5000, 'the finished turn is kept');
});
