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

const scenario = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/scenarios/S1-folds.json'), 'utf8'));

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
