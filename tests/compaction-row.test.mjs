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

test('the compaction is the ordinary tool card, with Synapse-yellow text', () => {
  const live = compactRow({ id: 'c1', running: true, count: 2, size: 173000, limit: 205000 });
  assert.match(live, /class="tool-card is-compact-card"/);
  assert.match(live, /class="status-dot warn"/);
  assert.match(live, /Compacting ×2/);
  assert.match(live, /context at 173K\/205K/);
  assert.match(live, /class="tool-state state-pill warn">running/);
  assert.doesNotMatch(live, /⏳/, 'the old banner glyph is gone');
  const done = compactRow({ id: 'c2', running: false, count: 2, size: 165000, limit: 205000, status: 'completed' });
  assert.match(done, /Compacted ×2/);
  assert.match(done, /class="status-dot ok"/);
  assert.match(done, /completed/);
  assert.doesNotMatch(done, /is-live/);
});

test('the transcript draws a compaction as that tool card', () => {
  state.messages = [{ type: 'compaction', id: 'c1', created: 1, raw: { status: 'running' } }];
  const html = renderMessage(state.messages[0]);
  assert.match(html, /class="tool-card is-compact-card"/);
  assert.match(html, /data-line="msg:c1"/);
  assert.match(html, /Compacting ×1/);
});

test('a completed card reports its duration and the context after it', () => {
  const done = compactRow({
    id: 'c1',
    running: false,
    count: 1,
    size: 110000,
    limit: 205000,
    after: 12000,
    durationMs: 65000,
    status: 'completed',
  });
  assert.match(done, /110K\/205K → 12K\/205K/);
  assert.match(done, /1m 5s/);
  assert.match(done, /completed/);
});

test('a status arriving after the card was drawn changes it to Compacted', () => {
  state.messages = [{ type: 'compaction', id: 'c1', created: 1, raw: { status: 'running' } }];
  assert.match(renderMessage(state.messages[0]), /Compacting ×1/);
  state.messages[0].raw.status = 'completed';
  assert.match(renderMessage(state.messages[0]), /Compacted ×1/);
});

test('compaction messages after the pane are moved into the pane post', () => {
  const js = read('web/transcript.js');
  assert.match(js, /const movedCompactions = new Set\(\)/, 'no move is prepared');
  assert.match(js, /paneTail = lines\.join\(''\) \+ liveTail/, 'the line is not placed before the pane');
  assert.match(js, /i === paneAt \? paneTail : ''/, 'the pane post does not use the moved tail');
  assert.match(js, /movedCompactions\.has\(m\)/, 'a moved message would be drawn twice');
});

test('the card keeps the tool shape and the yellow tint', () => {
  const css = read('web/synapse.css');
  assert.match(css, /\.tool-card\.is-compact-card \.tool-name \{ color: var\(--yellow\); \}/);
  assert.match(css, /\.tool-card\.is-compact-card \.tool-target \{ color: rgba\(237, 194, 90, 0\.72\); \}/);
  assert.doesNotMatch(css, /\.trace-is-compact-post|\.trace\.is-compact-post/, 'no special vertical interruption');
});
