// The small doors into the conversation: double-click a project, drag a file onto
// the chat, and the two new right-click actions that go with them.
//
// The suite has no browser, so these guard the wiring and the one decision each
// feature makes: a project row's double-click is Browse, and a drop only lands while
// the composer can take the same file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('double-clicking a project row opens its folder, the same as Browse', () => {
  const app = read('web/app.js');
  assert.match(app, /'projectTree'\)\.addEventListener\('dblclick'/, 'no double-click on the rail');
  assert.match(app, /openProjectFolder\(row\.dataset\.projectRow, 'browse'\)/, 'double-click is not Browse');
  // The single click still opens the chat; the double-click is an addition, not a
  // replacement, so the rail does not become a folder-only list.
  assert.match(app, /if \(project\) \{ openProjectChat\(project\.dataset\.project\)/, 'single click lost its chat');
  // Two clicks arrive before the first open has finished: one project must not make
  // two sessions.
  assert.match(read('web/projects.js'), /const openingChats = new Set\(\)/, 'nothing guards a double-open');
});

test('the whole chat is a drop target for files, and only while the composer can take them', () => {
  const app = read('web/app.js');
  assert.match(app, /installChatDrop\(\)/, 'the drop target is never installed');
  const js = read('web/composer.js');
  assert.match(js, /export function installChatDrop\(\)/, 'the install function is gone');
  assert.match(js, /export function composerAcceptsFiles\(\)/, 'nothing decides whether the chat can take a file');
  assert.match(js, /!input\.disabled && !state\.compacting/, 'a blocked composer still accepts drops');
  assert.match(js, /addAttachmentFiles\(files\)/, 'a dropped file does not reach the attachment strip');
  assert.match(js, /dragHasFiles/, 'a drag without files is treated as an attachment');
  assert.match(js, /e\.preventDefault\(\)/, 'the WebView would navigate to the dropped file');
  const html = read('web/index.html');
  assert.match(html, /id="chatDrop"/, 'no drop hint node');
  assert.match(read('web/synapse.css'), /\.chat-drop\s*\{/, 'the drop hint has no style');
});

test('the drop hint is put away when a question or a permission closes the composer', () => {
  const js = read('web/composer.js');
  assert.match(js, /if \(!composerAcceptsFiles\(\)\) hideDropHint\(\);/, 'the target can stay lit over a blocked chat');
});
