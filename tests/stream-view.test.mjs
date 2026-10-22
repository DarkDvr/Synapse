// The streamed worker text leaves the top of its line a step at a time.
//
// This is the regression the operator saw: the window was written as
// `text.slice(-600)`, so everything that had arrived since the last frame came off
// the top at once. At speed the text looked like it vanished word by word.
// `streamView` is the shipped function from `web/stream-view.js`, so these are the
// real numbers the UI uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { streamView, newStream, pushStream, STREAM_VIEW, STREAM_BUFFER } from '../web/stream-view.js';

/** Run frames until the front stops moving, or the cap is reached. */
function frames(s, cap = 400) {
  const shown = [];
  for (let i = 0; i < cap; i += 1) {
    const v = streamView(s);
    shown.push(v.text.length);
    if (!v.moving) break;
  }
  return shown;
}

test('a short block is shown whole, with no ellipsis', () => {
  const s = newStream('word');
  pushStream(s, 'hello');
  const v = streamView(s);
  assert.equal(v.text, 'hello');
  assert.equal(v.moving, false);
});

test('the window settles on the last STREAM_VIEW characters', () => {
  const s = newStream('word');
  pushStream(s, 'abcdefghij'.repeat(STREAM_VIEW));
  frames(s);
  const v = streamView(s);
  assert.equal(v.text.length, STREAM_VIEW + 1, 'ellipsis plus the window');
  assert.ok(v.text.startsWith('…'));
  assert.equal(v.text.slice(-1), s.text.at(-1));
  assert.equal(v.moving, false);
});

test('a burst leaves the top a step at a time, never in one jump', () => {
  const s = newStream('word');
  pushStream(s, 'x'.repeat(STREAM_VIEW)); // a full window already on screen
  assert.equal(streamView(s).text.length, STREAM_VIEW); // settled, nothing to cut
  pushStream(s, 'y'.repeat(30)); // one delta of thirty characters
  const shown = frames(s);
  assert.ok(shown.length > 4, `expected several frames, got ${shown.length}`);
  // Every step shrinks the visible line, and no step takes more than a fifth of
  // the backlog: the first cut is the largest and it is still small.
  assert.equal(shown[0], 624, '30 characters are on screen before any of it leaves');
  for (let i = 1; i < shown.length; i += 1) {
    assert.ok(shown[i] <= shown[i - 1], 'the window never grows while easing');
    assert.ok(shown[i - 1] - shown[i] <= 8, `step of ${shown[i - 1] - shown[i]} characters is a jump`);
  }
  assert.equal(shown.at(-1), STREAM_VIEW + 1);
});

test('a slow stream keeps the line still: one character in, one character out', () => {
  const s = newStream('think');
  pushStream(s, 'z'.repeat(STREAM_VIEW));
  streamView(s);
  const lengths = [];
  for (let i = 0; i < 40; i += 1) {
    if (i % 4 === 0) pushStream(s, 'q'); // about 15 characters a second at 60fps
    lengths.push(streamView(s).text.length);
  }
  assert.equal(new Set(lengths).size, 1, `the window should hold its size, saw ${[...new Set(lengths)]}`);
  assert.equal(lengths[0], STREAM_VIEW + 1);
});

test('the window keeps easing between bursts, so a pause cannot leave it wide', () => {
  const s = newStream('word');
  pushStream(s, 'x'.repeat(STREAM_VIEW));
  streamView(s);
  pushStream(s, 'y'.repeat(40));
  // No further deltas: frames alone must finish the slide.
  const shown = frames(s);
  assert.equal(shown.at(-1), STREAM_VIEW + 1);
});

test('the buffer is trimmed but the window position survives it', () => {
  const s = newStream('word');
  for (let i = 0; i < 40; i += 1) pushStream(s, 'abcdefghij'); // 400 characters
  frames(s);
  for (let i = 0; i < 1200; i += 1) pushStream(s, 'abcd');
  assert.equal(s.text.length, STREAM_BUFFER, 'the buffer is capped');
  assert.equal(s.total, 400 + 4800, 'but every character is still counted');
  frames(s);
  const v = streamView(s);
  assert.equal(v.text.length, STREAM_VIEW + 1);
  assert.equal(v.text.slice(-1), 'd', 'the window is at the end of what was written');
  assert.equal(v.text.slice(1), s.text.slice(-STREAM_VIEW), 'and the window is the very end of the buffer');
});

test('a block restarted for a rebuild shows its tail without sliding', () => {
  // renderTrace calls streamView on a block that was never on screen: it should
  // paint the tail at once rather than easing from the first character.
  const s = { kind: 'word', text: 'x'.repeat(1200), total: 1200 };
  const v = streamView(s);
  assert.equal(v.text.length, STREAM_VIEW + 1);
  assert.equal(v.moving, false);
});
