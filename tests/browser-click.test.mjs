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

test('a snapped click says what it snapped to, and how far', () => {
  const summary = clickSummary({
    url: '',
    at: [324, 444],
    requested: [324, 380],
    snapped: { from: [324, 380], to: [324, 444], px: 4, label: 'Six' },
  });
  assert.match(summary, /at 324,444/);
  assert.match(summary, /missed a control/);
  assert.match(summary, /"Six" 4 px away/);
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
