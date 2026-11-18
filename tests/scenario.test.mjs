// The first scenario, and the promise it checks: nothing the operator opened closes.
//
// The player (./scenario-player.mjs) feeds a scenario to the page's own renderer with no
// server and no browser. The first case is the operator's 18 Nov complaint — a reasoning
// archive, an older step history, one reasoning fold and a finished trace, each opened,
// then the conversation updates. Every one must still be open in every later frame.
//
// The other two lock the two placement rules the chat already keeps, so the rebuild cannot
// quietly lose them: a download is drawn inside the post it happened in, and an alarm
// splits the turn it arrived in instead of sliding to the end of it.
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

test('a saved download is drawn inside the post it happened in', async () => {
  const { frames } = await play(read('download-placement.json'));
  const html = frames.at(-1).html;
  const card = html.indexOf('report.txt');
  const first = html.indexOf('The first report');
  const second = html.indexOf('operator reply in between');
  assert.ok(card > 0, 'the download card was not drawn at all');
  assert.ok(card > first, 'the card came before the post it belongs to');
  assert.ok(card < second, 'the card drifted past the next post');
});

test('an alarm splits the turn it arrived in, rather than sliding to its end', async () => {
  const { frames } = await play(read('alarm-split.json'));
  const html = frames.at(-1).html;
  const first = html.indexOf('first step of the turn');
  const alarm = html.indexOf('PROHIBITED');
  const second = html.indexOf('second step of the turn');
  assert.ok(first >= 0 && alarm > first, 'the alarm is missing or above the first step');
  assert.ok(second > alarm, 'the second step came before the alarm: the turn was not split');
});
