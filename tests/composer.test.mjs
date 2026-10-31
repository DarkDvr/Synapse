// The composer's height, and why it may not be measured by shrinking the box (31 Oct).
//
// The operator's report: "when I am typing a message in chat, my chat scrolls up and
// down by about half a line of text, seemingly randomly as I type." The auto-grow
// idiom — `height:auto`, read `scrollHeight`, write it back — leaves the composer one
// line tall for the instant the layout is read. The transcript above it is a line
// taller, the browser clamps the chat's scroll offset to the shorter distance that box
// can now scroll, and the clamp is *not* undone when the height is restored. Measured
// on a 42-message transcript: 3143 (exactly the end) → 3110, still 3110 after the box
// came back and still 3110 half a second later.
//
// The suite has no browser, so these guard the two things that make that impossible:
// the browser sizes the box itself, and the fallback for engines that cannot hold the
// chat's offset across its own measurement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const cssBlock = (css, selector) => {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `${selector} is gone from the stylesheet`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open, close);
};

test('the composer is sized from its text by the browser, not measured in JS', () => {
  const block = cssBlock(read('web/synapse.css'), '.composer textarea {');
  assert.match(block, /field-sizing:\s*content/, 'without it the box is measured by shrinking it');
  // The ceiling and the inner scrollbar have to stay with it: the box stops growing and
  // the rest of the text scrolls inside.
  assert.match(block, /max-height:\s*150px/);
  assert.match(block, /overflow-y:\s*auto/);
});

test('autoGrow leaves the height alone where the browser can size it', () => {
  const js = read('web/app.js');
  const at = js.indexOf('function autoGrow(');
  assert.notEqual(at, -1, 'autoGrow is gone');
  const body = js.slice(at, js.indexOf('\n}', at));
  assert.match(js, /const fieldSized = .*CSS\.supports\('field-sizing', 'content'\)/,
    'the old measurement must only run where the browser cannot size the box');
  assert.match(body, /if \(fieldSized\)/, 'and the supported path returns before measuring anything');
  assert.match(body, /if \(el\.style\.height\) el\.style\.height = ''/,
    'an inline height left by an older build wins over field-sizing');
});

test('the fallback measurement holds the chat’s offset across the transient', () => {
  const js = read('web/app.js');
  const at = js.indexOf('function autoGrow(');
  const body = js.slice(at, js.indexOf('\n}', at));
  assert.match(body, /const top = chat \? chat\.scrollTop : null/,
    'the offset is read before the box is collapsed');
  assert.match(body, /chat\.scrollTop = top/, 'and put back after it, or the browser’s clamp wins');
});
