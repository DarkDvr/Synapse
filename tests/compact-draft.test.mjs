// A compact condenses the context; it does not replace the chat or the operator's
// unsent words. The transcript is reloaded in place, so the draft and attachments
// never leave the composer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('a compact keeps the same chat and reloads its transcript', () => {
  const compact = read('web/compact.js');
  assert.match(compact, /wired\.loadMessages\(\)/, 'the compact reloads the same chat');
  assert.doesNotMatch(compact, /state\.messages\s*=\s*\[\]/, 'the compact clears the transcript');
  assert.doesNotMatch(compact, /openSession\(/, 'the compact opens a replacement chat');
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
