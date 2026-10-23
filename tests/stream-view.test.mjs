// The worker's streamed text slides up through a panel, and it slides like a
// spring rather than a command: it is dragged along by the writing, lags a little
// and eases to a stop when the model pauses.
//
// These are the numbers the UI actually runs — `nextOffset` etc. are imported from
// `web/stream-view.js`, not copied — because smoothing is the kind of thing that
// reads fine and looks wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newStream,
  pushStream,
  slideTarget,
  nextOffset,
  takePending,
  freezeStream,
  STREAM_BUFFER,
  STREAM_KEEP,
} from '../web/stream-view.js';

/** Drive the spring for `seconds` at a given refresh rate and return the trace. */
function run(s, target, seconds, hz = 60) {
  const frames = Math.max(1, Math.round(seconds * hz));
  const dt = 1 / hz;
  const offsets = [];
  for (let i = 0; i < frames; i += 1) {
    nextOffset(s, target, dt);
    offsets.push(s.offset);
  }
  return offsets;
}

test('a block that fits needs no travel', () => {
  assert.equal(slideTarget(120, 183), 0);
  assert.equal(slideTarget(0, 183), 0);
  assert.equal(slideTarget(undefined, 183), 0);
  assert.equal(slideTarget(400, 183), 217);
});

test('a new block starts at rest', () => {
  const s = newStream('word');
  assert.deepEqual({ text: s.text, total: s.total, offset: s.offset, settled: s.settled }, {
    text: '',
    total: 0,
    offset: 0,
    settled: true,
  });
});

test('the text arrives at the target and stops exactly there', () => {
  const s = newStream('word');
  run(s, 300, 1.5);
  assert.equal(s.offset, 300, 'lands on the target, not near it');
  assert.equal(s.velocity, 0);
  assert.equal(s.settled, true);
});

test('it gets there lazily, in about half a second, not in one frame', () => {
  const s = newStream('word');
  const offsets = run(s, 300, 1);
  assert.ok(offsets[0] < 30, `the first frame should not jump the whole way: ${offsets[0]}`);
  // Half a second in, most of the distance is covered and it is still moving.
  const half = offsets[Math.round(offsets.length / 2) - 1];
  assert.ok(half > 200 && half < 300, `half a second in: ${half}`);
  assert.ok(offsets.at(-1) === 300, 'and it does finish inside a second');
});

test('there is no overshoot to see', () => {
  const s = newStream('word');
  const offsets = run(s, 400, 1.5);
  assert.ok(Math.max(...offsets) <= 401, `peak ${Math.max(...offsets)}`);
  assert.ok(offsets.every((v, i) => i === 0 || v >= offsets[i - 1]), 'never goes backwards');
});

test('a 144Hz screen and a 60Hz one arrive at the same moment', () => {
  const a = newStream('word');
  const b = newStream('word');
  run(a, 300, 0.2, 60);
  run(b, 300, 0.2, 144);
  assert.ok(Math.abs(a.offset - b.offset) < 1.5, `60Hz ${a.offset} vs 144Hz ${b.offset}`);
});

test('a tab that was hidden does not teleport the text', () => {
  const s = newStream('word');
  nextOffset(s, 600, 12); // twelve seconds of debt
  assert.ok(s.offset > 0 && s.offset < 600, `moved ${s.offset} of 600, not all of it`);
  run(s, 600, 1.5);
  assert.equal(s.offset, 600);
});

test('reduced motion puts it where it belongs at once', () => {
  const s = newStream('word');
  nextOffset(s, 250, 1 / 60, { reduced: true });
  assert.equal(s.offset, 250);
  assert.equal(s.settled, true);
});

test('it lags the writing while the writing continues, by a bounded amount', () => {
  // A target that grows a line every 150ms, as a fast model does.
  const s = newStream('word');
  const dt = 1 / 60;
  const line = 17; // px
  let target = 0;
  const lag = [];
  for (let i = 0; i < 180; i += 1) {
    if (i % 9 === 0) target += line;
    nextOffset(s, target, dt);
    lag.push(target - s.offset);
  }
  const tail = lag.slice(-90);
  assert.ok(Math.min(...tail) > 0, 'it is always a little behind: the text is still below the edge');
  assert.ok(Math.max(...tail) < 6 * line, `lag stays under six lines, saw ${Math.max(...tail)}`);
});

test('a pause lets it settle without any new text', () => {
  const s = newStream('word');
  run(s, 340, 0.1); // interrupted mid-slide
  assert.equal(s.settled, false);
  run(s, 340, 1.5); // no further deltas, only frames
  assert.equal(s.offset, 340);
  assert.equal(s.settled, true);
});

test('the buffer is a guard, not a window: every character is counted', () => {
  const s = newStream('word');
  pushStream(s, 'a'.repeat(100));
  assert.equal(s.text.length, 100);
  assert.equal(s.total, 100);
  assert.equal(s.dirty, true);
  pushStream(s, 'b'.repeat(STREAM_BUFFER));
  assert.equal(s.text.length, STREAM_KEEP, 'the buffer is trimmed to the keep size');
  assert.equal(s.total, 100 + STREAM_BUFFER, 'but the count is the whole block');
  assert.equal(s.text.at(-1), 'b');
  // The trim happens once, not on every character after it: pushing the character
  // that follows must not trim again, or the panel would rewrite its whole text
  // every frame for the rest of the block.
  pushStream(s, 'c');
  assert.equal(s.text.length, STREAM_KEEP + 1);
  assert.equal(s.text.endsWith('bc'), true);
  pushStream(s, ''); // an empty delta changes nothing
  assert.equal(s.total, 100 + STREAM_BUFFER + 1, 'the empty delta added nothing');
});

// The panel is given the text in pieces, never rewritten, because rewriting a
// twenty-thousand-character block re-breaks every line of it once per frame.
test('the panel is handed only the new tail', () => {
  const s = newStream('word');
  pushStream(s, 'hello ');
  assert.deepEqual(takePending(s), { text: 'hello ', reset: false });
  pushStream(s, 'world');
  assert.deepEqual(takePending(s), { text: 'world', reset: false });
  assert.deepEqual(takePending(s), { text: '', reset: false }, 'nothing new, nothing written');
});

test('a trim moves the start of the text, so the panel is rewritten once', () => {
  const s = newStream('word');
  pushStream(s, 'a'.repeat(STREAM_BUFFER + 50));
  assert.equal(takePending(s).reset, true, 'the front is gone: the whole block is written again');
  pushStream(s, 'b');
  assert.deepEqual(takePending(s), { text: 'b', reset: false }, 'and then it appends again');
});

// A finished block keeps its last window: its height is what the chat hangs on,
// and removing it at every step boundary made the chat jump.
test('a frozen block adds nothing and asks for no frames', () => {
  const s = newStream('think');
  pushStream(s, 'reasoning');
  takePending(s);
  freezeStream(s);
  assert.equal(s.ended, true);
  assert.equal(s.dirty, false);
  assert.deepEqual(takePending(s), { text: '', reset: false });
  assert.equal(pushStream(s, 'more') && s.text.endsWith('more'), true, 'the text is still there to be replaced');
});

