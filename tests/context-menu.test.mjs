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
  assert.match(app, /if \(!state\.renderPaused \|\| selectionInChat\(\)\) return;/, 'nothing releases the hold');
  assert.match(app, /state\.renderPaused = false;\s*renderTranscript\(\);/, 'the chat does not catch up when the selection is released');
});
