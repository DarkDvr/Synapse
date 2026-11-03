// The loop guard: one phrase, unchanged, for ten seconds.
//
// The rule is deliberately loose. A worker that is thinking produces new text
// every second; a worker that is stuck writes the same line again and again, and
// the existing stall clock cannot see it because tokens keep arriving. These are
// the cheap halves — the pure detector and the effort step-down — so the shape is
// asserted without a model, a network or a ten-second wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  repeatedTailUnit,
  createLoopDetector,
  nextLowerVariant,
} from '../src/runs.js';
import { DEFAULTS } from '../src/config.js';

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

test('the effort steps down one advertised variant at a time', () => {
  const variants = [{ id: 'low' }, { id: 'medium' }, { id: 'high' }];
  assert.equal(nextLowerVariant(variants, 'high'), 'medium');
  assert.equal(nextLowerVariant(variants, 'medium'), 'low');
  assert.equal(nextLowerVariant(variants, 'low'), '', 'nothing below the bottom');
  assert.equal(nextLowerVariant(variants, ''), '', 'an unset effort is not guessed at');
  assert.equal(nextLowerVariant([], 'high'), '');
});

test('the guard is on by default', () => {
  assert.equal(DEFAULTS.worker.loopGuard, true);
});
