// The line beside a question's title, and the clock Auto-Answer counts on.
//
// The line read "another chat is waiting on you · full auto answers on its next
// check" until 2 Nov: two clauses answering different questions, the first one
// false when the run answers itself. Then a longer sentence, which the operator
// cut back to one short countdown on 3 Nov. The wording and the page clock live in
// `web/ask-note.js` so they can be tested as sentences and numbers, not as a regex
// over app.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { askHeadNote, answerTimeline, permissionNote } from '../web/ask-note.js';
import { formPages } from '../src/auto-answer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('a question in the open chat says what it wants, plainly', () => {
  assert.equal(askHeadNote({ here: true }), 'waiting for your answer');
});

test('a question from another chat says where it is and what to do', () => {
  assert.equal(askHeadNote({ here: false }), 'asked in another chat — open that chat to answer');
});

test('under Auto-Answer the note is one short countdown', () => {
  assert.equal(askHeadNote({ here: true, autoAnswer: true, seconds: 10 }), 'Auto-Answering in 10 seconds…');
  assert.equal(askHeadNote({ here: true, autoAnswer: true, seconds: 1 }), 'Auto-Answering in 1 seconds…');
  assert.equal(askHeadNote({ here: true, autoAnswer: true, seconds: 0 }), 'Auto-Answering now…');
  // The location still matters when the question is elsewhere.
  assert.equal(
    askHeadNote({ here: false, autoAnswer: true, seconds: 7 }),
    'another chat — Auto-Answering in 7 seconds…',
  );
  // No quantity, no options, no explanation — the operator asked for exactly this.
  assert.doesNotMatch(askHeadNote({ here: true, autoAnswer: true, seconds: 5 }), /question|recommended/i);
});

test('every page gets its own wait, in order', () => {
  const firstAt = 1_700_000_000_000;
  const wait = 10;
  const at = (s) => ({ firstAt, wait, pages: 3, now: firstAt + s * 1000 });
  assert.deepEqual(answerTimeline(at(0)), { page: 0, seconds: 10 });
  assert.deepEqual(answerTimeline(at(4)), { page: 0, seconds: 6 });
  assert.deepEqual(answerTimeline(at(10)), { page: 1, seconds: 10 });
  assert.deepEqual(answerTimeline(at(14)), { page: 1, seconds: 6 });
  assert.deepEqual(answerTimeline(at(20)), { page: 2, seconds: 10 });
  // Past the last page the clock stays on it — the reply is the sweep's job.
  assert.deepEqual(answerTimeline(at(45)), { page: 2, seconds: 0 });
  // A page appears a moment before the server said it would: still page one.
  assert.deepEqual(answerTimeline(at(-2)), { page: 0, seconds: 12 });
});

test('a form with no fields still has one page, and hidden ones do not count', () => {
  assert.equal(formPages({}), 1);
  assert.equal(formPages({ fields: [{ key: 'a' }, { key: 'b' }] }), 2);
  assert.equal(formPages({ fields: [{ key: 'a' }, { key: 'b', hidden: true }, { key: 'c', type: 'external' }] }), 1);
});

test('the page turns itself while Auto-Answer counts, and is never forced back', () => {
  const js = read('web/app.js');
  assert.match(js, /import \{ askHeadNote, answerTimeline, permissionNote \} from '\.\/ask-note\.js';/);
  assert.match(js, /const timeline = answerTimeline\(\{ firstAt: n\.firstAt, wait: n\.wait, pages: n\.pages, now \}\)/);
  // Forward only: an operator who clicked ahead is not dragged back by the clock.
  assert.match(js, /const page = Math\.max\(state\.askPage, timeline\.page\);/);
  assert.match(js, /askTick = setInterval\(paintAskNote, 1000\)/);
  // Paging itself is untouched by the switch: one question at a time, always.
  const start = js.indexOf('function applyAskPage');
  const body = js.slice(start, js.indexOf('\nfunction ', start + 10));
  assert.doesNotMatch(body, /autoAnswer/, 'the switch has no say in paging');
  assert.match(body, /ask-page-off/);
});

test('the server sends one page per wait, and the reply after the last one', () => {
  const api = read('src/api.js');
  assert.match(api, /const pages = formPages\(f\);/);
  assert.match(api, /const firstAt = Number\(seen\) \|\| Date\.now\(\);/);
  assert.match(api, /autoAnswerFirstAt: autoAnswer \? firstAt : null/);
  assert.match(api, /autoAnswerPages: pages/);
  assert.match(api, /autoAnswerAt: autoAnswer \? firstAt \+ pages \* waitMs : null/);
  // The sweep must wait the same total, or it answers before the last page is read.
  assert.match(read('src/form-auto.js'), /const wait = waitMs\(\) \* formPages\(form\);/);
});

test('the note reads the asking chat’s Auto-Answer, not the one on screen', () => {
  assert.match(read('src/api.js'), /const autoAnswer = await formAuto\.enabledFor\(f\.sessionID\)/);
  assert.match(read('web/app.js'), /autoAnswer: \(form\.autoAnswer \?\? state\.automation\?\.autoAnswer\) === true/);
});

test('a permission card counts down to its automatic Allow Once', () => {
  const now = 1_700_000_000_000;
  assert.equal(permissionNote(now + 10_000, now), 'Auto-Permission: Allow Once will be picked in 10 seconds… ');
  assert.equal(permissionNote(now + 1_400, now), 'Auto-Permission: Allow Once will be picked in 2 seconds… ');
  assert.equal(permissionNote(now - 500, now), 'Auto-Permission: Allow Once will be picked now… ');
  const js = read('web/app.js');
  assert.match(js, /data-perm-due=/);
  assert.match(js, /permTick = setInterval\(paintPermissionNotes, 1000\)/);
  // The sentence is written once, in the module, like the question's.
  assert.match(read('src/api.js'), /autoPermissionsAt: permissionGate\?\.autoAllowAt/);
  assert.match(read('src/permission-gate.js'), /autoAllowAt: \(id\) => pendingAsks\.get\(id\)\?\.autoAt \?\? null/);
});

// 4 Nov: on a remote PC the countdown said "picked now" the moment it started.
// Both numbers compare a timestamp the server wrote with "now" on the page, so
// both clocks have to be reconciled — the HTTP Date header is the reconciler.
test('every countdown runs on the server’s clock, not the page’s', () => {
  const js = read('web/app.js');
  assert.match(js, /const serverNow = \(\) => Date\.now\(\) \+ \(Number\(state\.clockSkew\) \|\| 0\)/);
  assert.match(js, /state\.clockSkew = server - Date\.now\(\)/);
  assert.match(js, /res\.headers\.get\('date'\)/);
  assert.match(js, /permissionNote\(due, serverNow\(\)\)/);
  assert.match(js, /permissionNote\(el\.dataset\.permDue, serverNow\(\)\)/);
  assert.match(js, /const now = serverNow\(\);/);
  assert.match(
    js,
    /answerTimeline\(\{ firstAt: n\.firstAt, wait: n\.wait, pages: n\.pages, now: serverNow\(\) \}\)/,
  );
});

test('the note sits flush with the panel, and no nav reserve is left behind', () => {
  const css = read('web/synapse.css');
  assert.match(css, /\.ask-head \{[^}]*padding-right:\s*0/);
  assert.doesNotMatch(css, /\.ask-head \{[^}]*padding-right:\s*104px/, 'the old reserve is gone');
  assert.doesNotMatch(css, /body:has\(\.chat-nav/, 'and so is the rule that stepped aside for it');
});
