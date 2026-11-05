// One answer, one request.
//
// Measured 6 Nov: the operator answered a question and got two toasts — "Could Not
// Send The Answer / 409 Form already settled" above "Answer Sent". One click, two
// POSTs. The ask panel is moved *into* the transcript while a question is up (so it
// is the first thing read), so the click bubbled through the panel's handler and the
// transcript's, and both submitted. The first answered; the second lost the race.
//
// The UI is a browser module with no DOM in this suite, so this pins the shape of
// the fix where a regression would remove it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');

test('the answer submit is guarded against a second call', () => {
  assert.match(app, /const replyingForms = new Set\(\)/, 'one set of forms being answered');
  assert.match(app, /if \(replyingForms\.has\(formId\)\) return;/, 'a second submit returns at once');
  assert.match(app, /replyingForms\.add\(formId\);/, 'the form is claimed before the request');
  assert.match(app, /finally \{\s*replyingForms\.delete\(formId\);/, 'and released however it ends');
});

test('the transcript handler does not answer a click the ask panel already handled', () => {
  assert.match(
    app,
    /if \(e\.target\.closest\('\.ask-panel'\)\) return;/,
    'the panel is inside the transcript while a question is up',
  );
});

test('a form settled elsewhere closes the panel instead of raising an error', () => {
  assert.match(app, /already settled/i);
  assert.match(app, /That Question Was Already Answered/);
  // And it is not the generic failure: the operator did nothing wrong.
  const catchBlock = app.slice(app.indexOf('async function replyForm'), app.indexOf('async function replyForm') + 4000);
  assert.match(catchBlock, /state\.forms = state\.forms\.filter\(\(f\) => f\.id !== formId\)/);
});
