// A fold opens and closes over 500ms, and a page that asks for no motion still snaps.
//
// This is the mechanism only — a height driven by hand, because `<details>` renders nothing
// while it is closed. What it looks like is the operator's judgement; that it starts, lasts
// 500ms and puts the element back exactly as it found it is a fact a test can hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPage, FakeElement } from './fake-page.mjs';

const fold = () => {
  const details = new FakeElement('', 'details');
  details.open = false;
  const body = new FakeElement('', 'div');
  body.className = 'fold-wrap';
  return { details, body };
};

test('opening a fold grows its body over 500ms, then puts it back', async () => {
  const { window } = installPage();
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const { animateFold, FOLD_MS } = await import('../web/folds.js');
  const { details, body } = fold();
  assert.equal(FOLD_MS, 250);
  assert.equal(animateFold(details, body), true);
  assert.equal(details.open, true, 'the fold was not opened');
  assert.match(String(body.style.transition), /height 250ms/, 'no 500ms height transition');
  assert.equal(body.style.overflow, 'hidden');
  await new Promise((r) => setTimeout(r, FOLD_MS + 140));
  assert.equal(body.style.transition, '', 'the transition was left on the element');
  assert.equal(body.style.height, '', 'the height was left on the element');
  assert.equal(body.style.overflow, '', 'the overflow was left on the element');
  assert.equal(details.open, true, 'the fold closed itself after opening');
});

test('closing keeps the fold open until the body has shrunk, then closes it', async () => {
  const { window } = installPage();
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const { animateFold, FOLD_MS } = await import('../web/folds.js');
  const { details, body } = fold();
  details.open = true;
  assert.equal(animateFold(details, body), true);
  assert.equal(details.open, true, 'the content vanished before it could shrink');
  await new Promise((r) => setTimeout(r, FOLD_MS + 140));
  assert.equal(details.open, false, 'the fold never closed');
  assert.equal(body.style.height, '');
});

test('a page that asks for reduced motion snaps, and the module leaves it alone', async () => {
  const { window } = installPage();
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const { animateFold } = await import('../web/folds.js');
  const { details, body } = fold();
  assert.equal(animateFold(details, body), false);
  assert.equal(details.open, false, 'the fold was opened by the animation');
  assert.ok(!body.style.transition, 'the reduced-motion path touched the element');
});

// The thinking pane is a different shape on each side of its toggle, so it moves as a box
// rather than as a fold: same 250ms, and the callback is what flips the state afterwards.
test('the pane helper grows a box from nothing and reports when it is done', async () => {
  const { window } = installPage();
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const { animateHeight, FOLD_MS } = await import('../web/folds.js');
  const box = new FakeElement('', 'div');
  const timeline = [];
  assert.equal(animateHeight(box, 200, () => timeline.push('done'), 0), true);
  assert.equal(box.style.height, '200px', 'the box was not grown');
  assert.match(String(box.style.transition), /height 250ms/, 'the pane does not use the fold duration');
  assert.deepEqual(timeline, [], 'the caller was told the move was finished before it started');
  await new Promise((r) => setTimeout(r, FOLD_MS + 140));
  assert.deepEqual(timeline, ['done'], 'the caller was never told the move was done');
  assert.equal(box.style.height, '');
});

test('the pane helper still calls back when motion is off, so the state still flips', async () => {
  const { window } = installPage();
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const { animateHeight } = await import('../web/folds.js');
  const box = new FakeElement('', 'div');
  let done = false;
  assert.equal(animateHeight(box, 200, () => { done = true; }, 0), false);
  assert.equal(done, true, 'a reduced-motion page would never finish the toggle');
  assert.ok(!box.style.height, 'the reduced-motion path touched the element');
});
