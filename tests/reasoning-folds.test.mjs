// What a fold says, and what a compaction says while it runs.
//
// Two reports from the operator (8 Nov): a compaction line that only said
// "Compacting ×3" and not how full the window was, and reasoning folds that were
// one per step and all called "Reasoning".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reasoningGist } from '../web/format.js';
import { renderTrace } from '../web/traces.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('a fold carries the first sentence, flattened and clipped', () => {
  assert.equal(
    reasoningGist('The menu is drawn by MainWindow. I should move it into its own file.'),
    'Reasoning · The menu is drawn by MainWindow.',
  );
  // Newlines and runs of spaces are one line, because the summary is one line.
  assert.equal(reasoningGist('First line\n\n  second   line'), 'Reasoning · First line second line');
  // A block with no sentence end is clipped with an ellipsis, on the same line.
  const long = reasoningGist('word '.repeat(60));
  assert.ok(long.length <= 122, `${long.length} characters`);
  assert.match(long, /…$/);
  assert.doesNotMatch(long, /\n/);
  // Nothing to say still names the thing.
  assert.equal(reasoningGist('   '), 'Reasoning');
  assert.equal(reasoningGist(''), 'Reasoning');
});

test('the fold summary is the gist, and the last ten blocks keep their own', () => {
  const source = read('web/transcript.js');
  assert.match(source, /const REASONING_KEEP = 10;/, 'ten recent blocks stay folds of their own');
  assert.match(source, /<summary>\$\{esc\(reasoningGist\(part\.text\)\)\}<\/summary>/, 'each fold names its own sentence');
  assert.match(source, /class="reasoning is-archive"/, 'the older ones still fold into one');
});

test('a compaction in flight says how full the window was', () => {
  const live = renderTrace({
    key: 'k',
    role: 'coder-1',
    task: 't4',
    title: 'Pin the widget',
    startedAt: 1,
    compactingSince: Date.now(),
    compactions: 2,
    compactFrom: 47000,
    compactLimit: 204800,
    notes: [],
  });
  assert.match(live, /Compacting ×3/);
  assert.match(live, /context at 47K\/205K/);
  // The worker's own words are not needed for the line to be a line.
  assert.match(live, /is-compact/);
});

test('a finished compaction keeps the size the engine actually sent', () => {
  const done = renderTrace({
    key: 'k',
    role: 'coder-1',
    task: 't4',
    title: 'Pin the widget',
    startedAt: 1,
    finishedAt: 2,
    compactions: 2,
    compactAt: 165000,
    compactLimit: 204800,
    notes: [],
  });
  assert.match(done, /Compacted ×2 · context at 165K\/205K/);
});

test('a compaction with no size says nothing it cannot support', () => {
  const bare = renderTrace({
    key: 'k',
    role: 'coder-1',
    task: 't4',
    startedAt: 1,
    compactingSince: Date.now(),
    compactions: 0,
    notes: [],
  });
  assert.match(bare, /Compacting ×1/);
  assert.doesNotMatch(bare, /context at/);
});

test('a finished worker step folds into one line in its trace', () => {
  const html = renderTrace({
    key: 'k',
    role: 'coder-1',
    task: 't6',
    title: 'Build the revised tooltip',
    startedAt: 1,
    reasons: [{ text: 'The bar is drawn by Taskbar.cs. I should change its fill to the value.', at: 5 }],
    notes: [],
  });
  assert.match(html, /class="reasoning is-trace"/);
  assert.match(html, /Reasoning · The bar is drawn by Taskbar\.cs\./);
  assert.match(html, /<pre>The bar is drawn by Taskbar\.cs\./);
  assert.match(html, /data-k="k:r5"/, 'the fold remembers whether it was opened');
});

test('a long run folds its early thinking into one line, like the chat', () => {
  const reasons = Array.from({ length: 13 }, (_, i) => ({ text: `Thought number ${i} about the bar.`, at: i + 1 }));
  const html = renderTrace({
    key: 'k',
    role: 'coder-1',
    task: 't6',
    startedAt: 1,
    reasons,
    notes: [],
  });
  assert.equal((html.match(/class="reasoning is-trace"/g) || []).length, 10, 'the newest ten are their own folds');
  assert.match(html, /3 earlier reasoning/, 'the rest is one line');
  assert.match(html, /<pre>Thought number 0 about the bar\.<\/pre>/, 'and it opens to the text');
  const archive = html.slice(html.indexOf('is-archive'), html.indexOf('</details>', html.indexOf('is-archive')));
  assert.equal((archive.match(/<pre>/g) || []).length, 3, 'the archive holds exactly the older three');
});

test('a steer and a compaction sit just above the live reasoning', () => {
  const html = renderTrace({
    key: 'k',
    role: 'coder-1',
    task: 't6',
    startedAt: 1,
    notes: [{ steer: true, text: 'PawnIO is running here' }, 'ran the probe'],
    reasons: [{ text: 'The PDH counter returns invalid data.', at: 9 }],
    compactingSince: Date.now(),
    compactions: 1,
    compactFrom: 47000,
    compactLimit: 204800,
    stream: { kind: 'think', text: 'currently thinking', ended: false },
  });
  const fold = html.indexOf('class="reasoning is-trace"');
  const compact = html.indexOf('Compacting');
  const steer = html.indexOf('STEER:');
  const panel = html.indexOf('trace-flow is-think');
  assert.ok(fold > 0 && panel > 0, 'both the fold and the live panel are rendered');
  assert.ok(compact > fold, 'the compaction is after the folds, not at the top');
  assert.ok(steer > compact, 'the steer is the line nearest the panel');
  assert.ok(steer < panel, 'and it is above the live reasoning');
  // With no panel, the same lines are the bottom of the trace.
  const quiet = renderTrace({
    key: 'k', role: 'coder-1', task: 't6', startedAt: 1,
    notes: [{ steer: true, text: 'still here' }],
    reasons: [{ text: 'a thought', at: 1 }],
    stream: null,
  });
  assert.ok(quiet.lastIndexOf('STEER:') > quiet.indexOf('class="reasoning is-trace"'));
});
