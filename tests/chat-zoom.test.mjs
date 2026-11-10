// The chat's text size as a gesture: Ctrl + wheel, Ctrl + plus/minus, Ctrl + 0.
//
// Two things are worth holding down. The rule — one notch is a whole point, never
// past the bounds, and the range still answers when it is already at an end. And the
// wiring, because a gesture that quietly does the browser's zoom instead is exactly
// the bug this replaced: the window grew, the setting did not, and nothing said so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { nextChatText, chatTextChip } from '../web/chat-zoom.js';
import { CHAT_TEXT_MIN, CHAT_TEXT_MAX, CHAT_TEXT_DEFAULT, CHAT_TEXT_STEP } from '../web/ui-prefs.js';
import { CHAT_TEXT_MAX as CONFIG_MAX, CHAT_TEXT_STEP as CONFIG_STEP } from '../src/config.js';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('one notch is one whole point, inside the same bounds as the slider', () => {
  assert.equal(CHAT_TEXT_STEP, 1, 'the step is a point, not the half point it was');
  assert.equal(CONFIG_STEP, 1, 'and the config says the same');
  assert.equal(CHAT_TEXT_MAX, CONFIG_MAX, 'the ceiling is one number, in one place');
  assert.equal(CHAT_TEXT_MAX, 20, 'the ceiling is 20: whole pixels, and room to read at the back of a desk');
  assert.equal(CHAT_TEXT_DEFAULT, 13, 'the designed size is a whole number now');
  assert.equal(nextChatText(CHAT_TEXT_DEFAULT, 1), 14);
  assert.equal(nextChatText(CHAT_TEXT_DEFAULT, -1), 12);
  assert.equal(nextChatText(14, 1), 15);
  assert.equal(nextChatText(14.5, 1), 16, 'an older half point steps to the nearest whole size');
  // A hand-edited config can hold a value off the whole-step grid; the notch moves it
  // to the next half point rather than refusing to move.
  assert.equal(nextChatText(13, 1), 14);
});

test('the ends of the range hold, and say so', () => {
  assert.equal(nextChatText(CHAT_TEXT_MAX, 1), CHAT_TEXT_MAX, 'the ceiling is a wall');
  assert.equal(nextChatText(CHAT_TEXT_MIN, -1), CHAT_TEXT_MIN, 'and so is the floor');
  assert.equal(nextChatText(CHAT_TEXT_MAX, 5), CHAT_TEXT_MAX, 'a fast wheel cannot jump the wall');
  assert.match(chatTextChip(CHAT_TEXT_MAX), /largest/);
  assert.match(chatTextChip(CHAT_TEXT_MIN), /smallest/);
  assert.doesNotMatch(chatTextChip(14), /largest|smallest/);
  assert.match(chatTextChip(14), /Chat text 14 px/);
  // Junk in the config reads as the designed size, not as NaN.
  assert.equal(nextChatText('nope', 1), CHAT_TEXT_DEFAULT + 1);
});

test('the gesture is installed, and the browser zoom is off under it', () => {
  assert.match(read('web/app.js'), /installChatZoom\(\)/, 'the page never installs it');
  const zoom = read('web/chat-zoom.js');
  assert.match(zoom, /addEventListener\(\s*'wheel'/, 'no wheel gesture');
  assert.match(zoom, /e\.preventDefault\(\)/, 'the browser would still zoom');
  assert.match(zoom, /'\+'/, 'Ctrl + plus does nothing');
  assert.match(zoom, /e\.ctrlKey/, 'a plain wheel must stay the chat scroll');
  // The shell has to switch WebView2's own zoom off, or the gesture moves two sizes.
  assert.match(read('shell/MainWindow.xaml.cs'), /IsZoomControlEnabled = false/);
});

test('the Settings control is a slider, and it moves the same numbers', () => {
  const form = read('web/settings-form.js');
  const pane = read('web/settings-panes.js');
  assert.match(form, /export function setSlider\(/, 'there is one slider primitive');
  assert.match(form, /type="range"/);
  assert.match(pane, /setSlider\(c, 'Chat Text Size', 'ui\.chatTextPx'/, 'the pane does not use it');
  assert.match(pane, /step: CHAT_TEXT_STEP/, 'the slider has its own step');
  assert.match(read('web/settings-window.js'), /el\.type === 'range'/, 'a slider collects as a string');
  // The value beside the track is the same number, written once.
  assert.match(form, /class="slider-value"/);
});
