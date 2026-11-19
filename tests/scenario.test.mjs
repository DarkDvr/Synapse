// The first scenario, and the promise it checks: nothing the operator opened closes.
//
// The player (./scenario-player.mjs) feeds a scenario to the page's own renderer with no
// server and no browser. This case is the operator's 18 Nov complaint — a reasoning
// archive, an older step history, one reasoning fold and a finished trace, each opened,
// then the conversation updates. Every one must still be open in every later frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { play, foldOpen } from './scenario-player.mjs';

const read = (name) => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/scenarios', name), 'utf8'));

const scenario = read('S1-folds.json');

/** Every frame drawn after the step that opened `key` keeps it open. */
function staysOpen(frames, steps, key) {
  const at = steps.findIndex((s) => s.do === 'open' && s.key === key);
  assert.ok(at >= 0, `the scenario never opens ${key}`);
  const after = frames.filter((f) => f.step > at);
  assert.ok(after.length >= 2, `only ${after.length} frame(s) after opening ${key}`);
  for (const frame of after) {
    assert.equal(foldOpen(frame.html, key), true, `${key} closed itself at step ${frame.step}`);
  }
}

test('nothing the operator opened closes when the conversation updates', async () => {
  const { frames } = await play(scenario);
  assert.ok(frames.length >= 6, `only ${frames.length} frames were drawn`);
  // The four shapes: a message's reasoning archive, a trace's older-entries fold, one
  // reasoning fold inside the trace, and the finished trace itself.
  staysOpen(frames, scenario.steps, 'reasoning:m1');
  staysOpen(frames, scenario.steps, 'k1:older');
  staysOpen(frames, scenario.steps, 'k1:r120');
  staysOpen(frames, scenario.steps, 'k1:fold');
});

test('the folds were closed before the operator opened them', async () => {
  const { frames } = await play(scenario);
  for (const key of ['reasoning:m1', 'k1:older', 'k1:r120']) {
    const at = scenario.steps.findIndex((s) => s.do === 'open' && s.key === key);
    for (const frame of frames.filter((f) => f.step < at && f.html.includes(`data-k="${key}"`))) {
      assert.equal(foldOpen(frame.html, key), false, `${key} was already open before it was clicked`);
    }
  }
});

// The archive is one closed fold. Rolling an open block into it is the chat shutting what the
// operator was reading, and it happened whenever a turn ran past ten reasoning blocks.
test('a reasoning fold the operator has open is never archived', async () => {
  const archiveScenario = read('S2-archive.json');
  const { frames } = await play(archiveScenario);
  assert.ok(frames.length >= 4, `only ${frames.length} frames were drawn`);
  const opened = archiveScenario.steps.findIndex((s) => s.do === 'open' && s.key === 'm1:0');
  const after = frames.filter((f) => f.step > opened);
  assert.ok(after.length >= 3, 'the scenario never grew the turn after the fold was opened');
  for (const frame of after) {
    assert.match(frame.html, /data-k="m1:0"/, `the open fold was archived at step ${frame.step}`);
    assert.equal(foldOpen(frame.html, 'm1:0'), true, `the open fold closed at step ${frame.step}`);
  }
  // The archive still forms, from the older blocks that were not open: thirteen blocks,
  // ten kept, three candidates of which one is open, so two are archived.
  assert.match(frames.at(-1).html, /2 earlier reasoning/, 'the archive holds the wrong number of blocks');
});
