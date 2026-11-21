// The pane's pure parts: the ease that makes the slide a slide, the tail that keeps it a
// tail, the end it shows, and what a wheel over it asks for. Everything else in
// thinking-pane.js is DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paneEase, paneTrim, paneShown, wheelIntent, PANE_MAX, PANE_KEEP } from '../web/thinking-pane.js';

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

// The model writes the paragraph break before the paragraph, so the newest text ends in
// "\n\n" until the next line arrives. Measured in the running page: each trailing newline
// was 20px of the body, so the follow pinned the pane to blank space below its own words
// and reading to the end showed the same gap (21 Nov).
test('the pane ends at its last line of words, not after the blank ones', () => {
  assert.equal(paneShown('a\nb'), 'a\nb', 'an ordinary tail is untouched');
  assert.equal(paneShown('a\nb\n\n'), 'a\nb', 'a paragraph break waiting for its paragraph is not the end');
  assert.equal(paneShown('a\n\n\n\n'), 'a');
  assert.equal(paneShown('a   '), 'a', 'trailing spaces are not something to scroll to either');
  assert.equal(paneShown('   \n'), '');
  assert.equal(paneShown(''), '');
  assert.equal(paneShown(null), '');
  // Once the paragraph starts, the break is in the middle and it is drawn: the trim only
  // ever touches the very end of the text, never the words before it.
  assert.equal(paneShown('a\n\n' + 'b'), 'a\n\nb');
});

// The reported bug: while the text populates, the slide is behind the end, so there is a
// scroll position below the follow. A wheel down took the pane there and stopped the
// follow — the operator scrolled down to see what was being written (21 Nov).
test('a wheel while the pane follows either reads back or stays, never takes a downward one', () => {
  const atEnd = 400;
  assert.deepEqual(wheelIntent(false, 120, atEnd, atEnd), { action: 'stay' }, 'down at the end stays at the end');
  assert.deepEqual(wheelIntent(false, 120, 300, atEnd), { action: 'stay' }, 'down while the slide lags still stays');
  assert.deepEqual(wheelIntent(false, -120, atEnd, atEnd), { action: 'read', to: 280 }, 'up takes the pane');
  assert.deepEqual(wheelIntent(true, 120, 100, atEnd), { action: 'read', to: 220 }, 'reading moves under the wheel');
  // Down at the end of a pane the operator took: hand it back to the follow. Parking it at
  // the last scroll position left the text short of the box's bottom edge, with a band of
  // empty space under it, until something else moved the pane (21 Nov).
  assert.deepEqual(wheelIntent(true, 120, atEnd, atEnd), { action: 'follow' }, 'down at the end does not resume the follow');
  assert.deepEqual(wheelIntent(true, 120, atEnd - 1, atEnd), { action: 'follow' }, 'a wheel that cannot move is a request for the end');
  assert.deepEqual(wheelIntent(true, -120, 0, atEnd), { action: 'chat' }, 'up at the top is the conversation');
  assert.deepEqual(wheelIntent(false, -120, 0, 0), { action: 'chat' }, 'a pane with nothing to read back is the chat');
});
