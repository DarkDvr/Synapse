// Where a question lands in the chat.
//
// The failing case, reported 18 Nov: the Architect writes a report and then asks a
// question about it. The page scrolled the question's *top* to the top of the chat, so
// the report — the whole reason for the question — was above the fold, and the operator
// answered it blind. When the answer was sent the panel went away and the report's last
// screen landed where the question had been, so it looked as if the report arrived
// *after* the answer.
//
// The rule, apart from the DOM so it can be tested without a page: the question sits at
// the end of the chat, with the report above it; a panel taller than the chat keeps its
// own head on screen instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { askScrollTop, ASK_GAP } from '../web/chat-scroll.js';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('the question sits at the end, so the report above it is read first', () => {
  const placed = askScrollTop({ top: 10000, height: 300, viewport: 700 });
  // Its bottom is the gap above the bottom of the box…
  assert.equal(placed + 700, 10000 + 300 + ASK_GAP, 'the question did not land at the end');
  // …which is exactly the room the report above it gets.
  assert.equal(10000 - placed, 700 - 300 - ASK_GAP, 'the report above the question got no room');
  assert.ok(placed < 10000, 'the question was placed at the top of the chat again');
});

test('a panel taller than the chat keeps its own head on screen', () => {
  // There is no room for both, and the first line of a question outranks its options:
  // an answers list with the question above the fold is the bug, not the fix.
  assert.equal(askScrollTop({ top: 5000, height: 900, viewport: 700 }), 5000, 'a tall panel was bottom-aligned');
  // Exactly filling the box is still "taller" once the gap is counted: the head wins.
  assert.equal(askScrollTop({ top: 5000, height: 700, viewport: 700 }), 5000);
});

test('a short chat is not scrolled above its start', () => {
  // The question is already visible under a report that fits: nothing to scroll, and
  // certainly not a negative offset.
  assert.equal(askScrollTop({ top: 120, height: 300, viewport: 700 }), 0);
  assert.equal(askScrollTop(), 0, 'a missing measurement places nothing');
});

test('the gap stays a gap', () => {
  assert.equal(ASK_GAP, 8);
});

// What makes the rule true in the page, not just in the arithmetic: the panel is placed
// by that one function, and nothing cuts the follow when a question arrives — the chat
// may grow above it (a report the poll had not fetched yet) and must stay at the end.
test('the panel is placed by the rule, and the follow is not cut', () => {
  const js = read('web/ask-panel.js');
  assert.match(js, /placeAskHost\(askHost\(\)\)/, 'the panel is not placed by the rule');
  assert.doesNotMatch(js, /el\.scrollTop \+= top - 6/, 'the question is still scrolled to the top of the chat');
  assert.doesNotMatch(js, /stopFollowingChat/, 'the follow is still cut when a question arrives');
  assert.doesNotMatch(read('web/app.js'), /stopFollowingChat/, 'a dead import is left behind in app.js');
  assert.match(read('web/chat-scroll.js'), /export function placeAskHost\(host\)/, 'the rule lives with the scrolling');
});
