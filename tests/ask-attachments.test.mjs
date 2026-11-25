// The question panel's attachments: the same strip, limits and gestures as the chat.
//
// The engine's form reply takes an answer and nothing else, so the files follow the
// answer as a short steer. These checks guard the wiring: the panel has the strip and
// the three doors (button, paste, drop), and replyForm sends the files after the
// answer settles rather than pretending the reply carried them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('the question panel has an attachment strip, an Attach button and a drop target', () => {
  const ask = read('web/ask-panel.js');
  assert.match(ask, /id="askAttachStrip"/, 'no strip in the panel');
  assert.match(ask, /id="askAttachBtn"/, 'no Attach button');
  assert.match(ask, /id="askAttachInput"/, 'no file picker');
  assert.match(ask, /id="askDrop"/, 'no drop target');
  assert.match(read('web/synapse.css'), /\.ask-drop\s*\{/, 'the drop target has no style');
  assert.match(read('web/synapse.css'), /\.ask-attach-strip\s*\{/, 'the strip has no style');
});

test('the panel reuses the composer’s file rules rather than inventing a second set', () => {
  const composer = read('web/composer.js');
  assert.match(composer, /export async function addFilesToList\(/, 'the shared add function is gone');
  assert.match(composer, /export function filesFromClipboard\(/, 'the shared clipboard reader is gone');
  assert.match(composer, /export function hasDragFiles\(/, 'the shared drag test is gone');
  const ask = read('web/ask-attachments.js');
  assert.match(ask, /addFilesToList/, 'the panel does not add through the shared rules');
  assert.match(ask, /filesFromClipboard/, 'paste does not read the clipboard');
  assert.match(ask, /hasDragFiles/, 'drag does not check for files');
  assert.match(ask, /data-ask-detach/, 'a waiting file cannot be removed');
});

test('a new form starts empty, and the same form keeps what was already attached', () => {
  const ask = read('web/ask-attachments.js');
  assert.match(ask, /export function resetAskAttachments\(formId\)/, 'no reset');
  assert.match(ask, /if \(id === owner\) return false/, 'a poll of the same form would clear the strip');
  assert.match(read('web/ask-panel.js'), /resetAskAttachments\(form\.id\)/, 'the panel never resets for a new form');
});

test('the files follow the answer, because the engine’s reply has no files', () => {
  const ask = read('web/ask-panel.js');
  assert.match(ask, /async function deliverAskFiles\(files, form, sessionId\)/, 'no delivery step');
  assert.match(ask, /const delivery = files\.length \? await deliverAskFiles\(files, form, sessionId\)/, 'the reply ignores its files');
  assert.match(ask, /\/steer`/, 'the files do not go as a steer');
  assert.match(ask, /form\?\.sessionId === state\.sessionId/, 'a worker could be briefed as the Architect');
  assert.match(ask, /\/messages`/, 'an ended Architect turn has no fallback');
  assert.match(ask, /clearAskAttachments\(\)/, 'the strip is not cleared after the answer');
});
