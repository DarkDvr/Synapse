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

test('the transcript is refreshed before the question is placed', () => {
  // The pending poll and the message poll are two timers: the form can arrive a beat
  // before the report it is about. Placing the panel against the older chat is how the
  // "no report above the question" report came back a second time (18 Nov).
  const js = read('web/ask-panel.js');
  const at = js.indexOf('placeAskHost(askHost())');
  assert.ok(at > 0, 'the panel is not placed at all');
  assert.match(js.slice(Math.max(0, at - 600), at), /await wired\.loadMessages\(\)/, 'the panel can be placed before the report has loaded');
  assert.match(js, /loadMessages: missing\('loadMessages'\)/, 'a forgotten wire would be a silent no-op');
  assert.match(read('web/app.js'), /askPanelWiring\(\{[^}]*loadMessages/, 'loadMessages is not handed to the panel');
});

test('a late transcript answer cannot put back a chat without the report', () => {
  // Two fetches are in flight all turn long. The slower one carries the older snapshot,
  // and with the turn blocked on a question there is no later event to fetch again —
  // the report stayed missing until the answer (18 Nov).
  const js = read('web/app.js');
  const start = js.indexOf('async function loadMessages');
  assert.ok(start > 0, 'the transcript loader is not where it was');
  const body = js.slice(start, js.indexOf('\n}', start));
  assert.match(body, /const asked = \+\+messagesAsked;/, 'the fetch has no sequence number');
  assert.match(body, /asked === messagesAsked/, 'the newest answer is not the only one allowed to write');
  assert.match(body, /if \(!current\(\)\) return;[\s\S]*state\.messages =/, 'the write is not guarded');
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
