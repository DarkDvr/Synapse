// The line beside a question's title.
//
// It read "another chat is waiting on you · full auto answers on its next check",
// reported on 2 Nov while running Multi in Full auto. Two things were wrong: under
// the switch nobody is waiting on the operator — the run answers itself — and
// "check" names a poll the operator never sees. It now names the switch and counts
// down to the moment it acts, because "in 30s" that never moves is a claim nobody
// can check. The wording lives in `web/ask-note.js` so it can be tested as
// sentences, not as a regex over app.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { askHeadNote, askHeadSeconds } from '../web/ask-note.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('a question in the open chat says what it wants, plainly', () => {
  assert.equal(askHeadNote({ here: true }), 'waiting for your answer');
});

test('a question from another chat says where it is and what to do', () => {
  assert.equal(askHeadNote({ here: false }), 'asked in another chat — open that chat to answer');
});

test('under Auto-Answer the note names the switch and the options it will take', () => {
  const here = askHeadNote({ here: true, autoAnswer: true, wait: 30 });
  const elsewhere = askHeadNote({ here: false, autoAnswer: true, wait: 30 });
  assert.equal(here, 'Auto-Answering enabled, answering with recommended options in 30s…');
  assert.equal(elsewhere, 'another chat — Auto-Answering enabled, answering with recommended options in 30s…');
  for (const text of [here, elsewhere]) {
    assert.doesNotMatch(text, /waiting on you/, 'nobody is waiting on the operator when it answers itself');
    assert.doesNotMatch(text, /next check/, 'no engine vocabulary');
  }
});

test('the number counts down from the server’s due time, not from a fixed wait', () => {
  const now = 1_700_000_000_000;
  assert.equal(
    askHeadNote({ here: true, autoAnswer: true, dueAt: now + 30_000, now }),
    'Auto-Answering enabled, answering with recommended options in 30s…',
  );
  assert.equal(
    askHeadNote({ here: true, autoAnswer: true, dueAt: now + 9_400, now }),
    'Auto-Answering enabled, answering with recommended options in 10s…',
    'part of a second rounds up, so it does not say 9s while 9.4 are left',
  );
  // The moment has passed (the sweep runs every few seconds, so this is visible).
  assert.equal(
    askHeadNote({ here: true, autoAnswer: true, dueAt: now - 1_000, now }),
    'Auto-Answering enabled, answering with recommended options now…',
  );
  assert.equal(askHeadSeconds({ dueAt: now + 9_400, now }), 10);
});

test('a zero wait is answered at once, and says so', () => {
  assert.equal(
    askHeadNote({ here: true, autoAnswer: true, wait: 0 }),
    'Auto-Answering enabled, answering with recommended options now…',
  );
});

test('the wait is the number actually set, never a stale 20', () => {
  assert.match(askHeadNote({ here: true, autoAnswer: true, wait: 90 }), /in 90s/);
  // A negative or unreadable wait is "at once", not a countdown to the past.
  assert.match(askHeadNote({ here: true, autoAnswer: true, wait: -5 }), /now…$/);
  assert.match(askHeadNote({ here: true, autoAnswer: true, wait: 'nonsense' }), /now…$/);
});

test('the page renders that note, counts it down, and keeps the panel', () => {
  const js = read('web/app.js');
  assert.match(js, /import \{ askHeadNote \} from '\.\/ask-note\.js';/);
  assert.match(js, /askHeadNote\(state\.askNote\)/);
  // One interval, writing only the line: rebuilding the panel per second would
  // clear answers the operator had already given.
  assert.match(js, /askTick = setInterval\(paintAskNote, 1000\)/);
  assert.match(js, /note\.textContent = askHeadNote\(state\.askNote\)/);
  assert.doesNotMatch(js, /another chat is waiting on you/, 'the old two-clause label is gone');
  assert.doesNotMatch(js, /on its next check|on the next check/, 'and so is the engine vocabulary');
});

test('the note reads the asking chat’s Auto-Answer, not the one on screen', () => {
  // A worker asks from another chat: its chat answers, and the label has to say
  // that chat's truth. The server decides per session, so the snapshot carries it.
  assert.match(read('src/api.js'), /const autoAnswer = await formAuto\.enabledFor\(f\.sessionID\)/);
  assert.match(read('src/api.js'), /autoAnswerAt: autoAnswer \?/);
  assert.match(read('web/app.js'), /autoAnswer: \(form\.autoAnswer \?\? state\.automation\?\.autoAnswer\) === true/);
});

test('with several questions in one form, the countdown says how many', () => {
  // Test2, 3 Nov: one form asked two questions, the panel paged them, and
  // Auto-Answer answered both in one reply — so the second was never on screen.
  assert.equal(
    askHeadNote({ here: true, autoAnswer: true, wait: 10, questions: 2 }),
    'Auto-Answering enabled, answering 2 questions with recommended options in 10s…',
  );
  assert.equal(
    askHeadNote({ here: true, autoAnswer: true, wait: 10, questions: 1 }),
    'Auto-Answering enabled, answering with recommended options in 10s…',
  );
});

test('the panel shows every question while Auto-Answer is on, so all are seen', () => {
  const js = read('web/app.js');
  assert.match(js, /const answeringAll = state\.askNote\?\.autoAnswer === true;/, 'the panel knows');
  assert.match(
    js,
    /for \(const holder of panel\.querySelectorAll\('\.ask-field'\)\) holder\.classList\.remove\('ask-page-off'\)/,
    'every field is on the one page',
  );
});

test('the note sits flush with the panel, and no nav reserve is left behind', () => {
  const css = read('web/synapse.css');
  assert.match(css, /\.ask-head \{[^}]*padding-right:\s*0/);
  assert.doesNotMatch(css, /\.ask-head \{[^}]*padding-right:\s*104px/, 'the old reserve is gone');
  assert.doesNotMatch(css, /body:has\(\.chat-nav/, 'and so is the rule that stepped aside for it');
});
