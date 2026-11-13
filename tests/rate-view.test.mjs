// The context figure can never be larger than the window it is a fraction of: some
// providers report \`cache.read\` as a running total, and a 27B once showed five million
// against a 262K window (12 Nov). The display clamps; this is the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withinWindow, cacheShare, lastPromptOf, noteArchitectCompaction, noteArchitectUsage, rateViewWiring, noteDelta, noteWorkerUsage, resetRate, forgetUsageSamples } from '../web/rate-view.js';
import { state } from '../web/state.js';
import { promptParts } from '../src/runs.js';

const read = (rel) => fs.readFileSync(new URL(`../web/${rel}`, import.meta.url), 'utf8');

test('a context figure is never larger than its window', () => {
  assert.equal(withinWindow(222325, 262144), 222325);
  assert.equal(withinWindow(5_000_000, 262144), 262144, 'a cumulative provider figure is capped at the window');
  assert.equal(withinWindow(1200, 0), 1200, 'no window known: the number is left alone');
  assert.equal(withinWindow(0, 262144), 0);
  assert.equal(withinWindow(NaN, 262144), 0);
});

test('the cache share is read from the two halves the provider reports', () => {
  // The operator's example: 120k of a 262k window, 92% of it cached.
  const share = cacheShare(9600, 110400, 262144);
  assert.equal(share.total, 120000);
  assert.equal(share.pct, 92);
  assert.equal(share.ok, true);

  // The real figures from test_27b: 699 fresh, 208,809 cached.
  assert.equal(cacheShare(699, 208809, 262144).pct, 99.7);

  // A provider that reports no cache figures has no share to show.
  assert.equal(cacheShare(4200, 0, 262144).ok, false);

  // A cumulative cache counter is not a prompt: refuse rather than invent.
  assert.equal(cacheShare(15_000, 5_000_000, 262144).ok, false);

  // No window known: the share is still computable, it is the cap that is missing.
  assert.equal(cacheShare(100, 900, 0).pct, 90);
});

// After a compaction there is no honest number until the next step reports its size.
// The compaction's own usage is the prompt it summarised: measured 13 Nov, 167,193 for a
// context that came out at 10,121 — printing it would be the same lie in a new place.
test('a compaction newer than the last step says so, and prints no size', () => {
  state.sessionId = 'sess_x';
  const step = { id: 'm1', type: 'assistant', created: 1000, raw: { tokens: { input: 160000, cache: { read: 7193 } } } };
  const pack = { id: 'c1', type: 'compaction', created: 2000, raw: { status: 'completed', tokens: { input: 167193, output: 2338 } } };
  const done = lastPromptOf([step, pack]);
  assert.equal(done.used, 0, 'no size is claimed');
  assert.equal(done.pending, 'compacted');

  const running = lastPromptOf([step, { ...pack, raw: { ...pack.raw, status: 'running' } }]);
  assert.equal(running.pending, 'compacting');

  // A step after it is the real context again: 10,121 tokens.
  const after = { id: 'm2', type: 'assistant', created: 3000, raw: { tokens: { input: 9000, cache: { read: 1121 } } } };
  assert.equal(lastPromptOf([step, pack, after]).used, 10121);
});

test('the card carries the compacting state until a usage event clears it', () => {
  state.sessionId = 'sess_x';
  state.archCtx = { sessionId: 'sess_x', used: 167193, fresh: 167193, cached: 0, at: Date.now() };
  noteArchitectCompaction('sess_x', 'start');
  assert.equal(state.archCtx.pending, 'compacting');
  assert.equal(state.archCtx.used, 0);
  noteArchitectCompaction('sess_x', 'end');
  assert.equal(state.archCtx.pending, 'compacted');
  // another chat's compaction must not touch this card
  noteArchitectCompaction('sess_other', 'start');
  assert.equal(state.archCtx.pending, 'compacted');
});

// The worker's card is fed by promptParts on the server: the same rule, one mode over.
test('a worker\'s compaction hides its size too', () => {
  const step = { type: 'assistant', created: 1000, raw: { tokens: { input: 150000, cache: { read: 17193 } } } };
  const pack = { type: 'compaction', created: 2000, raw: { status: 'completed', tokens: { input: 167193 } } };
  assert.equal(promptParts([step, pack]).pending, 'compacted');
  assert.equal(promptParts([step, pack]).used, 0);
  assert.equal(promptParts([step, { ...pack, raw: { status: 'running' } }]).pending, 'compacting');
  const after = { type: 'assistant', created: 3000, raw: { tokens: { input: 9000, cache: { read: 1121 } } } };
  assert.equal(promptParts([step, pack, after]).used, 10121);
});

// The card flickered between 262K/262K and 198K/262K: a provider reporting cumulative cache
// tokens produced a sum over the window, and the cap printed it while the transcript printed
// the truth (13 Nov).
test('an implausible usage event is ignored, not capped', () => {
  state.sessionId = 'sess_x';
  state.archCtx = { sessionId: 'sess_x', used: 198000, fresh: 1000, cached: 197000, at: 1 };
  // the model's window is unknown here, so the guard cannot judge: it takes the number
  noteArchitectUsage({ sessionId: 'sess_x', raw: { data: { tokens: { input: 1000, cache: { read: 197000 } } } } });
  assert.equal(state.archCtx.used, 198000);
  // with a window known and the sum over it, nothing is written
  rateViewWiring({ modelByRef: () => ({ context: 262144 }), selectionFor: () => ({ ref: 'arch' }) });
  state.archCtx = { sessionId: 'sess_x', used: 198000, fresh: 1000, cached: 197000, at: 1 };
  const before = state.archCtx;
  noteArchitectUsage({ sessionId: 'sess_x', raw: { data: { tokens: { input: 70000, cache: { read: 202000 } } } } });
  assert.equal(state.archCtx, before, 'a 262K prompt on a 262K model is not a prompt');
});

// The card's second row is 13px and the clock owns its right half. Measured on the
// narrowest card (288px): the rate line had 154px and wanted 207 with the cache share
// on it, so the ellipsis ate "(100% ca…" and the clock read "00:05:47 / 00:57:04" with
// two spaces the line could not afford (13 Nov). The share moved to the hover, the
// slash lost its air, and the line is 132px — a 4-digit rate and an "M" window still fit.
test('the card line fits the narrowest card, and the cache share is in the hover', () => {
  const code = read('rate-view.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /share\.pct\}% cache/, 'the share is no longer printed on the line');
  assert.match(code, /% from the provider's cache/, 'it is in the tooltip, with the figures');
  assert.ok(code.includes('${share.fresh} fresh, ${share.read} read'), 'the halves are named');
  const clocks = read('clocks.js');
  assert.ok(clocks.includes('${hhmmss(running || last || 0)}/${hhmmss(total)}'), 'the clock has no air around its slash');
});

// The card's speed divides the step's tokens by the time the model was writing — and a
// tool call's arguments are writing too. They are counted in `tokens.output` but arrive
// as tool-input events, not deltas; without marking the window with them, a step that
// wrote a file divided the file's tokens by the seconds spent thinking around it. The
// operator's Designer card read 279 tok/s while the provider's own log said 60–174, and
// a step that was one big write read 1000+ (13 Nov).
const wire = () => rateViewWiring({
  currentRun: () => ({ dir: 'F:/p', workerId: 'w', role: 'designer' }),
  dirKey: (d) => String(d || '').toLowerCase(),
  fmtTokens: (n) => String(n),
});

test('the speed window ends with the tool call the step wrote', () => {
  const app = read('app.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(
    app,
    /EV\.toolInputStarted \|\| ev\.type === EV\.toolInputEnded\) noteDelta\(ev\)/,
    'the tool-input events are part of the writing window',
  );
});

test('a reconnect re-baselines the speed instead of adding two steps', () => {
  wire();
  resetRate({ dir: 'F:/p' });
  noteWorkerUsage({ sessionId: 'w', raw: { data: { tokens: { output: 100 } } } });
  noteDelta({ sessionId: 'w' });
  forgetUsageSamples();
  noteWorkerUsage({ sessionId: 'w', raw: { data: { tokens: { output: 300 } } } });
  assert.equal(state.rates.get('f:/p'), undefined, 'no sample is invented across the gap');
});

test('a step with a window becomes one sample of written tokens over its own time', async () => {
  wire();
  resetRate({ dir: 'F:/p' });
  noteWorkerUsage({ sessionId: 'w', raw: { data: { tokens: { output: 100 } } } });
  noteDelta({ sessionId: 'w' });
  await new Promise((r) => setTimeout(r, 450));
  noteDelta({ sessionId: 'w' });
  noteWorkerUsage({ sessionId: 'w', raw: { data: { tokens: { output: 200 } } } });
  const rec = state.rates.get('f:/p');
  assert.ok(rec, 'the step is a sample');
  assert.equal(rec.tokens, 100, 'the step wrote a hundred tokens');
  assert.ok(rec.ms >= 400, `the window is the step's own (${rec.ms}ms)`);
});
