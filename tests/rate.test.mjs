// The tokens-per-second tally, without a browser.
//
// The rule the card depends on: only a step the model actually streamed is a
// sample, and a run's rate is the sum of its samples — not the newest step (a
// tool-call step is mostly overhead) and not the engine's turn window (which
// starts before the request is assembled, and so shrinks as the transcript grows).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addSample, rateOf } from '../web/rate.js';

test('a run averages its measured steps', () => {
  // Two steps, 500 tokens in 6.5 s and 1,500 in 19.5 s: 2,000 / 26 s = 77 tok/s.
  let tally = addSample(null, { written: 500, ms: 6_500 });
  tally = addSample(tally, { written: 1_500, ms: 19_500 });
  assert.equal(rateOf(tally), 77);
});

test('one huge step does not define the whole run', () => {
  // The first step is a burst (2,000 in 10 s), the next two are ordinary; the
  // answer must move toward the rest, not stay on the burst.
  let tally = addSample(null, { written: 2_000, ms: 10_000 });
  assert.equal(rateOf(tally), 200);
  tally = addSample(tally, { written: 700, ms: 10_000 });
  tally = addSample(tally, { written: 700, ms: 10_000 });
  assert.equal(rateOf(tally), 113);
});

test('a step with no streaming window is not a sample', () => {
  // No window at all, or a window too short to be writing: the step's tokens must
  // not be divided by a fixed round-trip cost.
  assert.equal(addSample(null, { written: 120, ms: 0 }), null);
  assert.equal(addSample(null, { written: 120, ms: 200 }), null);
  assert.equal(addSample(null, { written: 120, ms: Number.NaN }), null);
});

test('a step that wrote nothing is not a sample', () => {
  assert.equal(addSample(null, { written: 0, ms: 5_000 }), null);
  assert.equal(addSample(null, { written: -20, ms: 5_000 }), null);
});

test('a tally too small to mean anything reads as no number', () => {
  assert.equal(rateOf(null), 0);
  // A single 40-token step in 0.6 s would read 66 tok/s, which is noise: it needs
  // a second of streaming behind it.
  const flash = addSample(null, { written: 40, ms: 600 });
  assert.equal(rateOf(flash), 0);
  // And it needs enough tokens that one odd step cannot set the number.
  const tiny = addSample(null, { written: 20, ms: 2_000 });
  assert.equal(rateOf(tiny), 0);
});
