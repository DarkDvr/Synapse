// The item model, on the same scenarios the renderer is tested with.
//
// The model is the contract between the page's state and any renderer: which messages are
// one post, where a line belongs, which post a download happened in, and the key and open
// state of every fold. These tests assert that contract directly — no HTML — so the old and
// the new renderer can be checked against the same answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { play } from './scenario-player.mjs';
import { buildChat } from '../web/chat-model.js';

const read = (name) => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/scenarios', name), 'utf8'));

/** Every block in the list, wherever it sits. */
function allBlocks(items) {
  const out = [];
  const walk = (blocks) => {
    for (const b of blocks || []) {
      out.push(b);
      if (Array.isArray(b.body)) walk(b.body);
    }
  };
  for (const item of items) walk(item.blocks);
  return out;
}

test('the model keeps the folds the operator opened, and says so', async () => {
  const { state } = await play(read('S1-folds.json'));
  const { items } = buildChat(state);

  const posts = items.filter((i) => i.kind === 'post');
  const traces = items.filter((i) => i.kind === 'trace');
  assert.equal(posts.length, 1, `expected one Architect post, got ${posts.length}`);
  assert.equal(traces.length, 1, `expected one trace, got ${traces.length}`);

  const archive = allBlocks(items).find((b) => b.key === 'reasoning:m1');
  assert.ok(archive, 'the message archive is missing from the model');
  assert.equal(archive.kind, 'fold');
  assert.equal(archive.open, true, 'the archive the operator opened is closed in the model');

  const trace = traces[0];
  assert.equal(trace.state, 'folded', 'a finished trace is a folded one');
  assert.equal(trace.open, true, 'the trace the operator opened is closed in the model');
  for (const key of ['k1:older', 'k1:r120']) {
    const fold = allBlocks(items).find((b) => b.key === key);
    assert.ok(fold, `${key} is missing from the model`);
    assert.equal(fold.open, true, `${key} is closed in the model`);
  }
});

test('the model puts a download in the post whose window contains it', async () => {
  const { state } = await play(read('download-placement.json'));
  const { items } = buildChat(state);
  const posts = items.filter((i) => i.kind === 'post');
  assert.equal(posts.length, 3, `expected three posts, got ${posts.length}`);

  const card = allBlocks(items).find((b) => b.card === 'download');
  assert.ok(card, 'the download is missing from the model');
  assert.equal(card.props.name, 'report.txt');
  assert.ok(posts[0].blocks.includes(card), 'the download is not in the first post');
  assert.ok(!posts[1].blocks.includes(card) && !posts[2].blocks.includes(card), 'the download leaked into another post');
});

test('the model splits a turn where a prohibition landed', async () => {
  const { state } = await play(read('alarm-split.json'));
  const { items } = buildChat(state);
  const order = items.map((i) => i.kind);
  assert.deepEqual(order, ['post', 'line', 'post'], `got ${order.join(', ')}`);

  const line = items[1];
  assert.equal(line.line, 'refusal');
  assert.equal(line.props.action, 'shell');
  assert.ok(line.at > items[0].at && line.at < items[2].at, 'the line is not between the two steps');
});
