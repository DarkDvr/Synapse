// The context figure can never be larger than the window it is a fraction of: some
// providers report \`cache.read\` as a running total, and a 27B once showed five million
// against a 262K window (12 Nov). The display clamps; this is the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withinWindow, cacheShare } from '../web/rate-view.js';

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
