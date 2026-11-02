// The line beside a question's title.
//
// It read "another chat is waiting on you · full auto answers on its next check",
// reported on 2 Nov while running Multi in Full auto. Two things were wrong: under
// Full auto nobody is waiting on the operator — the run answers itself — and
// "check" names a poll the operator never sees. The wording lives in
// `web/ask-note.js` so it can be tested as sentences, not as a regex over app.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { askHeadNote } from '../web/ask-note.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('a question in the open chat says what it wants, plainly', () => {
  assert.equal(askHeadNote({ here: true }), 'waiting for your answer');
});

test('a question from another chat says where it is and what to do', () => {
  assert.equal(askHeadNote({ here: false }), 'asked in another chat — open that chat to answer');
});

test('under Full auto the note says the run answers, not that the operator is waited on', () => {
  const here = askHeadNote({ here: true, fullAuto: true, wait: 20 });
  const elsewhere = askHeadNote({ here: false, fullAuto: true, wait: 20 });
  assert.equal(here, 'Full auto answers in 20s unless you answer first');
  assert.equal(elsewhere, 'asked in another chat — Full auto answers in 20s');
  for (const text of [here, elsewhere]) {
    assert.doesNotMatch(text, /waiting on you/, 'nobody is waiting on the operator under Full auto');
    assert.doesNotMatch(text, /next check/, 'no engine vocabulary');
  }
});

test('a zero wait is answered at once, and says so', () => {
  assert.equal(askHeadNote({ here: true, fullAuto: true, wait: 0 }), 'Full auto answers at once');
  assert.equal(
    askHeadNote({ here: false, fullAuto: true, wait: 0 }),
    'asked in another chat — Full auto answers at once',
  );
});

test('the wait is the number actually set, never a stale 20', () => {
  assert.match(askHeadNote({ here: true, fullAuto: true, wait: 90 }), /in 90s/);
  // A negative or unreadable wait is "at once", not a countdown to the past.
  assert.equal(askHeadNote({ here: true, fullAuto: true, wait: -5 }), 'Full auto answers at once');
  assert.equal(askHeadNote({ here: true, fullAuto: true, wait: 'nonsense' }), 'Full auto answers at once');
});

test('the page renders that note and nothing of its own', () => {
  const js = read('web/app.js');
  assert.match(js, /import \{ askHeadNote \} from '\.\/ask-note\.js';/);
  assert.match(js, /askHeadNote\(\{/);
  assert.doesNotMatch(js, /another chat is waiting on you/, 'the old two-clause label is gone');
  assert.doesNotMatch(js, /on its next check|on the next check/, 'and so is the engine vocabulary');
});

test('the note reads the asking chat’s Full auto, not the one on screen', () => {
  // A worker asks from another chat: its chat answers, and the label has to say
  // that chat's truth. The server decides per session, so the snapshot carries it.
  assert.match(read('src/api.js'), /fullAuto: await formAuto\.enabledFor\(f\.sessionID\)/);
  assert.match(read('web/app.js'), /fullAuto: \(form\.fullAuto \?\? state\.fullAuto\) === true/);
});
