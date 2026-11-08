// The pane's pure parts: the ease that makes the slide a slide, and the tail that
// keeps it a tail. Everything else in thinking-pane.js is DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paneEase, paneTrim, PANE_MAX, PANE_KEEP } from '../web/thinking-pane.js';

test('the pane eases toward the end and arrives exactly', () => {
  const step = paneEase(0, 100, 1 / 60);
  assert.ok(step > 0 && step < 100, 'one frame moves part of the way');
  const next = paneEase(step, 100, 1 / 60);
  assert.ok(next > step, 'and the next moves further');
  assert.ok(next < 100, 'without arriving instantly');
  // Half a second is about four eases: close, not there.
  let at = 0;
  for (let i = 0; i < 30; i += 1) at = paneEase(at, 100, 1 / 60);
  assert.ok(at > 95 && at <= 100, `half a second lands near the end (${at.toFixed(1)})`);
  assert.equal(paneEase(100, 100, 1 / 60), 100, 'no drift at rest');
  assert.equal(paneEase(0, 100, 10), 100, 'a huge step arrives');
});

test('the pane keeps a tail, cut on a line boundary', () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const cut = paneTrim(text);
  assert.ok(cut.length <= PANE_MAX, 'never longer than the cap');
  assert.ok(cut.length > PANE_KEEP - 200, 'keeps roughly the tail, not less');
  assert.ok(cut.startsWith('line '), 'starts on a whole line');
  assert.ok(text.endsWith(cut), 'and ends at the newest text');
  assert.equal(paneTrim('short'), 'short');
  assert.equal(paneTrim(''), '');
});
