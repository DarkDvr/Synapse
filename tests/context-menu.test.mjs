// Text that behaves like text: what the right-click menu offers, and a selection that
// survives a live conversation.
//
// The incident (18 Nov): right-click had been switched off on 13 Nov because the only
// menu the page had opened the project list wherever you clicked. That took copy with it,
// and because a live turn rebuilds the transcript on every reasoning delta, a selection
// died within a second anyway. So the menu offers exactly what a text menu should, and
// the render pauses while a range is held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { menuItemsFor } from '../web/context-menu.js';
import { toolFile } from '../web/format.js';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const ids = (items) => items.map((i) => i.id).join(',');

test('a right-click in a field offers the field vocabulary', () => {
  const none = menuItemsFor({ editable: true, fieldSelection: false });
  assert.equal(ids(none), 'cut,copy,paste,select-all');
  assert.equal(none.find((i) => i.id === 'cut').enabled, false, 'Cut with nothing selected');
  assert.equal(none.find((i) => i.id === 'paste').enabled, true, 'Paste needs no selection');
  const some = menuItemsFor({ editable: true, fieldSelection: true });
  assert.equal(some.find((i) => i.id === 'copy').enabled, true);
});

test('a right-click on text offers Copy, and Select All with or without a range', () => {
  assert.equal(ids(menuItemsFor({ hasSelection: true })), 'copy,select-all');
  // Select All is the only thing a menu can honestly offer with nothing selected — and
  // it is how the operator gets a range to copy in the first place.
  assert.equal(ids(menuItemsFor({ hasSelection: false })), 'select-all');
  // Never the browser's vocabulary: no Print, Reload, Save As or Inspect.
  for (const items of [menuItemsFor({ hasSelection: true }), menuItemsFor({ editable: true })]) {
    for (const item of items) assert.match(item.label, /^(Cut|Copy|Paste|Select All)$/, `unexpected item ${item.label}`);
  }
});

test('a file card offers Open File and Open Folder before the text actions', () => {
  assert.equal(ids(menuItemsFor({ file: '.project/reports/qc.md' })), 'open-file,open-folder');
  assert.equal(
    ids(menuItemsFor({ file: 'src/app.js', hasSelection: true, canCopyIntoChat: true })),
    'open-file,open-folder,copy,copy-into-chat,select-all',
  );
});

test('Copy Into Chat only appears when the chat can take the text', () => {
  assert.equal(ids(menuItemsFor({ hasSelection: true, canCopyIntoChat: true })), 'copy,copy-into-chat,select-all');
  assert.equal(ids(menuItemsFor({ hasSelection: true, canCopyIntoChat: false })), 'copy,select-all');
  // A field's own menu never grows this item: Paste is already the right verb there.
  assert.equal(ids(menuItemsFor({ editable: true, fieldSelection: true, canCopyIntoChat: true })), 'cut,copy,paste,select-all');
});

test('a tool card names the file it is about, from the tool’s own argument', () => {
  assert.equal(toolFile({ name: 'read', input: { filePath: 'src/app.js' } }), 'src/app.js');
  assert.equal(toolFile({ name: 'write', input: '{"path":"report.md"}' }), 'report.md');
  assert.equal(toolFile({ name: 'read', input: 'filePath=docs%2Fnotes.md' }), 'docs/notes.md');
  // A command or a pattern is not a file to open.
  assert.equal(toolFile({ name: 'bash', input: { command: 'git status' } }), '');
  assert.equal(toolFile({ name: 'glob', input: { pattern: '**/*.js' } }), '');
  assert.equal(toolFile({ name: 'question', input: { questions: [] } }), '');
});

test('a local path in a card is drawn as data the menu can find', () => {
  const transcript = read('web/transcript.js');
  assert.match(transcript, /const file = toolFile\(part\)/);
  assert.match(transcript, /data-file="\$\{esc\(file\)\}"/);
  assert.match(read('web/context-menu.js'), /function fileTargetAt\(/);
  assert.match(read('web/context-menu.js'), /data-src/);
});

test('Copy Into Chat fills the question panel’s Something Else field', () => {
  const js = read('web/context-menu.js');
  assert.match(js, /function askCustomTarget\(/);
  assert.match(js, /querySelector\('\.ask-opt-other'\)/, 'it must pick the custom row');
  assert.match(js, /target\.pick\.checked = true/, 'Copy Into Chat must select Something Else');
  assert.match(js, /target\.text\.dispatchEvent\(new Event\('input'/, 'the panel has to see the text');
  assert.match(js, /function placeInComposer\(/, 'the ordinary chat is the other destination');
});

test('the menu is the page’s own, and the browser’s default stays off', () => {
  const app = read('web/app.js');
  assert.match(app, /installContextMenu\(\)/, 'the page never installs its menu');
  assert.doesNotMatch(app, /addEventListener\('contextmenu', \(e\) => e\.preventDefault\(\)\)/, 'the old blanket block is still there');
  const shell = read('shell/MainWindow.xaml.cs');
  assert.match(shell, /AreDefaultContextMenusEnabled = false/, 'the host menu must stay off: ours is the only one');
});

test('a held selection pauses the conversation, and releasing it catches up', () => {
  const js = read('web/transcript.js');
  assert.match(js, /export function selectionInChat\(\)/, 'nothing knows a selection is being made');
  assert.match(js, /if \(!renderOnce && selectionInChat\(\)\) \{[\s\S]*state\.renderPaused = true;[\s\S]*return;/, 'the render does not wait for it');
  assert.match(js, /export function forceNextRender\(\)/, 'a question cannot outrank a selection');
  assert.match(read('web/ask-panel.js'), /forceNextRender\(\)/, 'the question panel does not force its render');
  const app = read('web/app.js');
  // A Stop is not a pause (21 Nov): the chat is only ever held for a selection, so the
  // sign cannot outlive the reading it was drawn for.
  assert.match(app, /if \(!state\.renderPaused\) return;/, 'the pause is not released by moving the caret');
  assert.doesNotMatch(app, /state\.frozen/, 'a Stop still freezes the chat');
  assert.match(app, /if \(selectionInChat\(\)\) \{[\s\S]{0,400}?clearTimeout\(resumeTimer\)/, 'a new selection does not keep the pause');
  assert.match(app, /RESUME_GRACE_MS/, 'there is no grace before the pause drops');
  assert.match(app, /function continueChat\(\) \{[\s\S]*?state\.renderPaused = false;[\s\S]*?renderTranscript\(\);/, 'the chat does not catch up when the selection is released');
});
