// The context figure can never be larger than the window it is a fraction of: some
// providers report \`cache.read\` as a running total, and a 27B once showed five million
// against a 262K window (12 Nov). The display clamps; this is the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withinWindow } from '../web/rate-view.js';

test('a context figure is never larger than its window', () => {
  assert.equal(withinWindow(222325, 262144), 222325);
  assert.equal(withinWindow(5_000_000, 262144), 262144, 'a cumulative provider figure is capped at the window');
  assert.equal(withinWindow(1200, 0), 1200, 'no window known: the number is left alone');
  assert.equal(withinWindow(0, 262144), 0);
  assert.equal(withinWindow(NaN, 262144), 0);
});
