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
import { state } from '../web/state.js';
import { normalize } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('a fold carries the first sentence, flattened and clipped', () => {
  assert.equal(
    reasoningGist('The menu is drawn by MainWindow. I should move it into its own file.'),
    'Reasoning • The menu is drawn by MainWindow.',
  );
  // Newlines and runs of spaces are one line, because the summary is one line.
  assert.equal(reasoningGist('First line\n\n  second   line'), 'Reasoning • First line second line');
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
  assert.match(html, /Reasoning • The bar is drawn by Taskbar\.cs\./);
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
    notes: [{ at: 20, steer: true, text: 'PawnIO is running here' }, { at: 5, text: 'ran the probe' }],
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
  assert.ok(steer > fold, 'the steer is after the thought it answered');
  assert.ok(steer < panel, 'and stays in its place above the live reasoning');
  assert.ok(compact > steer && compact < panel, 'the compaction is the pinned line above the panel');
  // With no panel, the same lines are the bottom of the trace.
  const quiet = renderTrace({
    key: 'k', role: 'coder-1', task: 't6', startedAt: 1,
    notes: [{ at: 20, steer: true, text: 'still here' }],
    reasons: [{ text: 'a thought', at: 1 }],
    stream: null,
  });
  assert.ok(quiet.lastIndexOf('STEER:') > quiet.indexOf('class="reasoning is-trace"'));
});

// The worker's tool calls are drawn as the Architect's one-line cards, and one
// switch puts the old plain line back. Rendered from the same notes either way.
test('a worker tool note is a card, and the switch brings the old line back', () => {
  const trace = {
    key: 'k',
    role: 'coder-1',
    task: 't11',
    startedAt: 1,
    notes: [{ text: 'shell cd .\\sysmoninor; .\\probe.exe', tool: { name: 'shell', target: 'cd .\\sysmoninor; .\\probe.exe' } }],
  };
  state.config = { ui: { workerCards: true } };
  const on = renderTrace(trace);
  assert.match(on, /class="tool-card trace-card"/);
  assert.match(on, /<span class="tool-name">shell<\/span>/);
  assert.match(on, /class="trace-role">Coder 1</, 'the role is the bright word in the head');

  state.config = { ui: { workerCards: false } };
  const off = renderTrace(trace);
  assert.doesNotMatch(off, /class="tool-card trace-card"/);
  assert.match(off, /class="trace-line">shell cd/);
  state.config = null;
});

test('the worker-card switch is on unless it was turned off', () => {
  assert.equal(normalize({}).ui.workerCards, true);
  assert.equal(normalize({ ui: { workerCards: false } }).ui.workerCards, false);
  assert.equal(normalize({ ui: { workerCards: 'off' } }).ui.workerCards, true);
  assert.match(read('web/settings-panes.js'), /'ui\.workerCards'/, 'the switch is in Settings');
});

test("a worker's words are a paragraph, with the chat's markdown", () => {
  const trace = {
    key: 'k', role: 'coder-1', task: 't11', startedAt: 1,
    notes: [{ text: 'The **PDH** counter returns invalid data.\n\nSecond thought.', prose: true }],
  };
  state.config = { ui: { workerCards: true } };
  const on = renderTrace(trace);
  assert.match(on, /class="trace-prose msg-answer"/);
  assert.match(on, /<strong>PDH<\/strong>/, 'markdown, not escaped text');
  assert.match(on, /<p>/, 'a paragraph');
  state.config = { ui: { workerCards: false } };
  assert.doesNotMatch(renderTrace(trace), /trace-prose/, 'the switch hides it too');
  state.config = null;
  // The stream becomes a paragraph when its step ends, not a frozen panel.
  assert.match(read('web/chat-scroll.js'), /prose: true/);
  assert.match(read('web/chat-scroll.js'), /stream\.kind === 'word'/);
});

// 8 Nov: the tool said "Queued: t12… you will be told the outcome", the runner
// refused the delegation silently (Keep Building off), and the Architect answered
// the operator's "continue" with "t12 is already running". The receipt now says
// what it can keep.
test('the delegate receipt does not promise a run it cannot guarantee', () => {
  const src = read('src/mcp/delegate-server.js');
  assert.doesNotMatch(src, /Queued: /, 'no word that reads as already running');
  assert.doesNotMatch(src, /You will be told the outcome when it finishes/, 'no promise of a report');
  assert.match(src, /was never started/, 'the plan is named as the record of what is running');
  assert.match(src, /Keep Building off/, 'and the condition is named up front');
  assert.match(read('src/plans.js'), /if the plan still says the task is todo, it never/, 'the brief says the same');
});

test('a tool call sits between the thoughts that surround it', () => {
  const html = renderTrace({
    key: 'k', role: 'coder-1', task: 't12', startedAt: 1,
    notes: [
      { at: 10, text: 'read MainWindow.xaml.cs', tool: { name: 'read', target: 'MainWindow.xaml.cs' } },
      { at: 30, text: 'read Autostart.cs', tool: { name: 'read', target: 'Autostart.cs' } },
    ],
    reasons: [
      { text: 'First I need the window code.', at: 5 },
      { text: 'Now the older half of the file.', at: 20 },
      { text: 'The startup shortcut lives here.', at: 40 },
    ],
    stream: null,
  });
  const at = (s) => html.indexOf(s);
  assert.ok(at('First I need the window code.') < at('MainWindow.xaml.cs'), 'thought before its call');
  assert.ok(at('MainWindow.xaml.cs') < at('Now the older half of the file.'), 'call before the next thought');
  assert.ok(at('Now the older half of the file.') < at('Autostart.cs'), 'and the second call after it');
  assert.ok(at('Autostart.cs') < at('The startup shortcut lives here.'), 'closing thought last');
});

// An empty reasoning part is a step that has not thought yet: the engine opens the
// part before the first token, and it showed in the chat as a fold labelled
// "Reasoning" with nothing in it while the tools ran (8 Nov).
test('an empty reasoning part is not a fold', () => {
  const src = read('web/transcript.js');
  assert.match(src, /p\.type === 'reasoning' && String\(p\.text \|\| ''\)\.trim\(\)/);
});
