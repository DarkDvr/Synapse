// The loop guard: one phrase unchanged for ten seconds, or one command run three
// times in five calls.
//
// The rule is deliberately loose. A worker that is thinking produces new text
// every second; a worker that is stuck writes the same line again and again, and
// the existing stall clock cannot see it because tokens keep arriving. These are
// the cheap halves — the pure detector and its defaults — so the shape is asserted
// without a model, a network or a ten-second wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { repeatedTailUnit, createLoopDetector } from '../src/runs.js';
import { DEFAULTS, normalize } from '../src/config.js';

const UNIT = 'Building the gauge layout... ';

test('a repeated phrase is recognised at the end of the thinking', () => {
  assert.equal(repeatedTailUnit(''), '');
  assert.equal(repeatedTailUnit('Short.'), '');
  assert.equal(
    repeatedTailUnit('I should check the colours, the spacing and the fonts before writing anything.'),
    '',
  );
  // The shape the operator saw: one line, over and over.
  assert.equal(repeatedTailUnit(`Planning the mock.\n${UNIT.repeat(20)}`), 'Building the gauge layout...');
});

test('new reasoning beside the phrase is not a loop', () => {
  const prose =
    'First I will lay out the four cards. Then I will pick the accent colour. ' +
    'The gauge needs a ring and a number. Each card gets the same padding. ' +
    'The background should stay dark so the cyan reads. The heading is one line. ' +
    'The footer says the time. Nothing repeats here, which is the whole point.';
  assert.equal(repeatedTailUnit(prose), '');
});

test('the detector only trips after the phrase has held for the whole window', () => {
  const detector = createLoopDetector({ afterMs: 1000 });
  const at = (n) => `Planning the mock.\n${UNIT.repeat(n)}`;
  assert.equal(detector.push(at(15), 0), null, 'first sighting only starts the clock');
  assert.equal(detector.push(at(16), 400), null, 'too soon');
  assert.equal(detector.push(at(17), 1200), 'Building the gauge layout...', 'held for a second');
});

test('a different phrase restarts the clock, and normal thinking cancels it', () => {
  const detector = createLoopDetector({ afterMs: 1000 });
  const other = 'Checking the contrast ratio... ';
  assert.equal(detector.push(`${UNIT.repeat(20)}`, 0), null);
  assert.equal(detector.push(`${other.repeat(20)}`, 1200), null, 'a different phrase is a new clock');
  assert.equal(detector.push(`${other.repeat(21)}`, 1500), null);
  assert.equal(detector.push(`${other.repeat(22)}`, 2400), 'Checking the contrast ratio...');
  // And a thought that moves on clears it completely.
  assert.equal(detector.push('Now I will write the file with the four cards.', 2500), null);
  assert.equal(detector.push(`${other.repeat(24)}`, 2600), null);
});

test('the guard is off by default, with three loops to a work order', () => {
  assert.equal(DEFAULTS.worker.loopGuard, false, 'off until it earns trust (13 Nov)');
  assert.equal(DEFAULTS.worker.loopLimit, 3);
});

test('the loop limit is clamped to 1–20', () => {
  assert.equal(normalize({ worker: { loopLimit: 99 } }).worker.loopLimit, 20);
  assert.equal(normalize({ worker: { loopLimit: 0 } }).worker.loopLimit, 1);
  assert.equal(normalize({ worker: { loopLimit: 'x' } }).worker.loopLimit, 3);
});

// 8 Nov: the operator saw no tool calls in a worker's chat at all. `onTool` — which
// feeds the trace's tool line — sat inside the `loopGuard` branch, so with the guard
// off (the operator's setting) the page was told about no call, ever. The call must
// happen before the guard decides whether to count it.
test('every tool call is reported, whether or not the loop guard is on', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'runs.js'), 'utf8');
  assert.doesNotMatch(src, /if \(loopGuard\) for \(const message of afterMark/, 'no longer gated');
  assert.match(
    src,
    /toolSeen\.add\(tool\.id\);\r?\n\s+onTool\?\.\(tool\);\r?\n\s+if \(!loopGuard \|\| !tool\.target\) continue;/,
    'onTool fires before the guard checks the target',
  );
});
