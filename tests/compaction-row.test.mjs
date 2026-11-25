// A compaction is a moment in the conversation, not a banner under it.
//
// The row borrows the tool head's shape — dot, name, target — because that is what
// the operator already reads as "something happened here", and it belongs above the
// live thinking pane rather than below it. The transcript moves the compaction
// messages that follow the pane's post into that post's tail, before the pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compactRow } from '../web/compact-row.js';
import { renderMessage } from '../web/transcript.js';
import { state } from '../web/state.js';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('the compaction row is a tool-shaped yellow row, not a banner', () => {
  const live = compactRow({ running: true, count: 2, size: 173000, limit: 205000 });
  assert.match(live, /class="trace-line is-compact"/);
  assert.match(live, /class="compact-dot is-live"/);
  assert.match(live, /Compacting ×2/);
  assert.match(live, /context at 173K\/205K/);
  assert.doesNotMatch(live, /⏳/, 'the old banner glyph is gone');
  const done = compactRow({ running: false, count: 2, size: 165000, limit: 205000 });
  assert.match(done, /Compacted ×2/);
  assert.doesNotMatch(done, /is-live/);
});

test('the transcript draws a compaction through the same row', () => {
  state.messages = [{ type: 'compaction', id: 'c1', created: 1, raw: { status: 'running' } }];
  const html = renderMessage(state.messages[0]);
  assert.match(html, /class="trace is-compact-post"/);
  assert.match(html, /Compacting ×1/);
});

test('compaction messages after the pane are moved into the pane post', () => {
  const js = read('web/transcript.js');
  assert.match(js, /const movedCompactions = new Set\(\)/, 'no move is prepared');
  assert.match(js, /paneTail = lines\.join\(''\) \+ liveTail/, 'the line is not placed before the pane');
  assert.match(js, /i === paneAt \? paneTail : ''/, 'the pane post does not use the moved tail');
  assert.match(js, /movedCompactions\.has\(m\)/, 'a moved message would be drawn twice');
});

test('the row is small, with no banner margins', () => {
  const css = read('web/synapse.css');
  assert.match(css, /\.trace-line\.is-compact \{[\s\S]*?font-size: calc\(var\(--chat-fs\) \* 0\.8\)/);
  assert.match(css, /\.trace\.is-compact-post \{ margin: 0 0 5px; \}/);
  assert.match(css, /\.compact-target \{/);
});
