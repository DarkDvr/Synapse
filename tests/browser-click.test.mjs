// Where a click lands, and what the model is told about it.
//
// Measured on 16 Nov in a scratch project (not the operator's live one): a 1280x800
// window gives a 1280x800 viewport screenshot at device scale 1, and a click asked for
// 324,444 arrives at exactly 324,444. The arithmetic was never the problem — a model
// reading a picture is, by a few pixels or by a scale factor — so the click now clamps
// to the viewport, snaps to the nearest control within 28 px, and says which it did.
//
// The snapping itself runs in the page and needs a browser; these are the parts that do
// not, so the sentence a model reads cannot silently change.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clickSummary } from '../src/browser/browser.js';

test('a click that landed where it was asked says only where', () => {
  assert.equal(clickSummary({ url: '', at: [324, 444], requested: [324, 444], snapped: null }), ' at 324,444');
});

test('a snapped click says what it snapped to, and how far it moved', () => {
  const summary = clickSummary({
    url: '',
    at: [324, 444],
    requested: [324, 400],
    snapped: { from: [324, 400], to: [324, 444], px: 44, label: 'Six' },
  });
  assert.match(summary, /at 324,444/);
  assert.match(summary, /landed 44 px/);
  assert.match(summary, /"Six"/);
  assert.match(summary, /324,400 asked for/, 'the answer does not say where the click was asked to go');
});

test('a click moved far onto a neighbouring element is not reported as a hit', () => {
  // Measured on the Nexus files page, 22 Nov: the point was inside the download row's box,
  // so the old "distance to the box" said 0 px while the click moved 83 px to the middle of
  // the row and landed on the wrong control. A model read that as a successful click.
  const summary = clickSummary({
    url: '',
    at: [1161, 432],
    requested: [1078, 432],
    snapped: { from: [1078, 432], to: [1161, 432], px: 83, label: 'Version history' },
  });
  assert.match(summary, /landed 83 px/);
  assert.match(summary, /1078,432 asked for/);
  assert.match(summary, /Version history/);
});

test('a clamped click says so, because a full-page image invited it', () => {
  const summary = clickSummary({ url: '', at: [324, 798], requested: [324, 920], snapped: null, clamped: true });
  assert.match(summary, /outside the viewport/);
});

test('a string answer (an older caller) formats to nothing rather than throwing', () => {
  assert.equal(clickSummary('https://example.com'), '');
  assert.equal(clickSummary(null), '');
  assert.equal(clickSummary(undefined), '');
});
