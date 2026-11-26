// A steer shows in the chat the moment it is sent, not when a worker reads it.
//
// The operator pressed Steer during a worker's turn and watched an unchanged chat for a
// minute: the only line was the runner's, which arrives when the worker takes the words
// at its next step. The page has to answer "it went" itself — a pending line where they
// sent it — and then let the runner confirm it rather than add a second copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderTrace, steerLine } from '../web/traces.js';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('a pending steer is drawn, and says it is not taken yet', () => {
  const html = renderTrace({
    key: 'k',
    role: 'coder-1',
    task: 't6',
    startedAt: 1,
    notes: [{ at: 5, steer: true, text: 'While you are doing QC, check the labels', pending: true }],
  });
  assert.match(html, /is-steer is-pending/, 'the line is not marked pending');
  assert.match(html, /While you are doing QC, check the labels/, 'the sentence is missing');
  assert.match(html, /the worker reads it at its next step/, 'no tooltip saying when it is read');
  // Taken: the same line, no pending mark.
  const taken = renderTrace({
    key: 'k',
    role: 'coder-1',
    task: 't6',
    startedAt: 1,
    notes: [{ at: 5, steer: true, text: 'While you are doing QC, check the labels' }],
  });
  assert.doesNotMatch(taken, /is-pending/, 'a taken steer still looks pending');
});

test('the page and the runner agree on the line, so one steer is one line', () => {
  assert.equal(steerLine('  two   spaces\nand a newline '), 'two spaces and a newline');
  const long = 'x'.repeat(400);
  assert.equal(steerLine(long).length, 300, 'the cap is 299 characters plus the ellipsis');
  // The composer paints it before asking the server, and takes it back if the server
  // refuses; the runner adopts that line instead of pushing a second one.
  const composer = read('web/composer.js');
  assert.match(composer, /if \(target\?\.kind === 'worker'\)/, 'the worker branch does not paint');
  // The order is the whole point: paint, then ask. Both searched inside sendSteer, or
  // the regular Send's `api('POST'` earlier in the file would answer for it.
  const fn = /async function sendSteer[\s\S]*?\n\}/.exec(composer);
  assert.ok(fn, 'sendSteer is gone');
  const body = fn[0];
  const painted = body.indexOf('trace.notes.push(painted)');
  const sent = body.indexOf("await api('POST'");
  assert.ok(painted > -1, 'nothing is painted into the trace');
  assert.ok(sent > -1, 'the request is gone');
  assert.ok(painted < sent, 'the line is painted after the round trip, not before it');
  // The first event only says the server took it. The breath ends on the second,
  // when the worker reaches the boundary where it reads the steer.
  assert.match(body, /const sent = await api/, 'the steer is still sent');
  assert.match(body, /wired\.ensureLivePost\(true\)/, 'the read does not move the steer above the next post');
  const runs = read('web/live-runs.js');
  assert.match(runs, /const existing = trace\.notes\.find\(\(n\) => n\?\.steer && n\.text === line\)/, 'the runner pushes a duplicate');
  assert.match(runs, /if \(ev\.delivered\) delete existing\.pending/, 'the runner never confirms the painted line');
  assert.match(runs, /\.\.\.\(ev\.delivered \? \{\} : \{ pending: true \}\)/, 'a steer from another view starts pending');
  assert.match(runs, /A steer the worker never reached/, 'a finished run stops the breath');
  assert.match(runs, /steerLine\(ev\.text\)/, 'the runner builds its own line instead of the shared one');
});

test('the pending steer wears a breathing dot, not just a faint tag', () => {
  const html = renderTrace({
    key: 'k',
    role: 'coder-1',
    task: 't6',
    startedAt: 1,
    notes: [{ at: 5, steer: true, text: 'look at this', pending: true }],
  });
  assert.match(html, /class="steer-dot"/, 'the pending line has no dot');
  const transcript = read('web/transcript.js');
  assert.match(transcript, /class="steer-dot"/, 'the pending post has no dot');
  const css = read('web/synapse.css');
  assert.match(css, /@keyframes steer-dot-breathe/);
  assert.match(css, /\.is-steer\.is-pending \.steer-dot/, 'the dot does not breathe');
});

test('the pending line is visibly different, and only for the steer', () => {
  const css = read('web/synapse.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.trace-line\.is-steer\.is-pending \{[^}]*border-left-color/, 'no pending border');
  assert.match(css, /\.trace-line\.is-steer\.is-pending \.trace-steer-text \{[^}]*color/, 'no pending text colour');
});
