// The UI has no session concept (27 Oct).
//
// The engine still has sessions — that is its word for the thing Synapse shows
// as a project's chat — but the product does not. This is a guard against the
// old vocabulary creeping back into a label, a dialog or a control: the operator
// asked for it to be cleansed, and a rule that is only in a document is a rule
// that comes back. Internal identifiers (`state.sessionId`, `view: 'session'`)
// are deliberately not matched: they are the engine's id and a comment is not UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('index.html says nothing about sessions or General', () => {
  const html = read('web/index.html');
  assert.doesNotMatch(html, /session/i, 'the page shell must not name sessions');
  assert.doesNotMatch(html, /\bGeneral\b/, 'General is gone');
});

test('the old session controls and wording are gone from app.js', () => {
  const js = read('web/app.js');
  for (const needle of [
    'New Session',
    'Sessions Still Inside',
    'TBD_TITLE',
    'Could not create a session',
    'Where new sessions run',
    'delete the session',
    'settingsGeneral',
    "'general', label: 'General'",
  ]) {
    assert.equal(js.includes(needle), false, `app.js still contains: ${needle}`);
  }
});

test('the dead session-row styles are gone from the stylesheet', () => {
  const css = read('web/synapse.css');
  for (const needle of ['.tree-row.session', '.tree-caret', '.tree-project-body', '.tree-sessions', '.tree-add-row', '.tree-rename']) {
    assert.equal(css.includes(needle), false, `synapse.css still contains: ${needle}`);
  }
});
