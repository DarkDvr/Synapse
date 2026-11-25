// A compact replaces the chat; it does not replace the operator's unsent words.
//
// OpenSession clears the draft and attachments on a normal chat switch, because a
// draft belongs to the chat it was typed in (21 Nov). A compact's replacement is
// the same conversation, so clearing them there made the operator retype the
// message and re-attach the files after every handover (25 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('a compact opens the replacement with the draft and attachments kept', () => {
  const compact = read('web/compact.js');
  assert.match(compact, /openSession\(out\.sessionId, \{ keepDraft: true \}\)/, 'the compact opens its replacement as an ordinary switch');
});

test('an ordinary chat switch still starts with an empty box', () => {
  const app = read('web/app.js');
  assert.match(app, /async function openSession\(id, \{ keepDraft = false \} = \{\}\)/, 'no explicit opt-in');
  const block = app.slice(app.indexOf('async function openSession'), app.indexOf('state.busyInfo = null'));
  assert.match(block, /if \(!keepDraft\) \{/, 'the clear is not guarded');
  assert.match(block, /\$\('promptInput'\)\.value = ''/, 'the draft is not cleared');
  assert.match(block, /state\.attachments = \[\];/, 'the attachments are not cleared');
});

test('the compact itself does not empty the composer on the way through', () => {
  const compact = read('web/compact.js');
  assert.doesNotMatch(compact, /promptInput.*value\s*=\s*''/, 'compact clears the draft');
  assert.doesNotMatch(compact, /state\.attachments\s*=\s*\[\]/, 'compact clears the attachments');
});
