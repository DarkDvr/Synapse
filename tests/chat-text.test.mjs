// The chat's text size: one number, and one place that draws from it.
//
// The operator asked for a size setting that touches the conversation and nothing
// else, with bounds "so the user doesn't go too crazy", and named the risks: the
// vertical rules and the scrolling. Both are geometry, and geometry breaks when a
// transcript rule keeps a fixed size while its neighbours scale — so the stylesheet
// half of this file refuses exactly that. The config half makes a hand-edited file
// as safe as the form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalize, DEFAULTS, CHAT_TEXT_MIN, CHAT_TEXT_MAX, CHAT_TEXT_STEP } from '../src/config.js';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('the chat text size is clamped to the range the form offers', () => {
  assert.equal(normalize({}).ui.chatTextPx, DEFAULTS.ui.chatTextPx, 'a config without it gets the designed size');
  assert.equal(normalize({ ui: { chatTextPx: 5 } }).ui.chatTextPx, CHAT_TEXT_MIN, 'too small is the floor, not a 5px chat');
  assert.equal(normalize({ ui: { chatTextPx: 40 } }).ui.chatTextPx, CHAT_TEXT_MAX, 'too large is the ceiling');
  assert.equal(normalize({ ui: { chatTextPx: 13.3 } }).ui.chatTextPx, 13, 'whole pixels only');
  assert.equal(normalize({ ui: { chatTextPx: 14.5 } }).ui.chatTextPx, 15, 'a saved half point moves to the nearest whole size');
  assert.equal(normalize({ ui: { chatTextPx: 'nope' } }).ui.chatTextPx, DEFAULTS.ui.chatTextPx, 'junk falls back');
  assert.equal(normalize({ ui: { chatTextPx: 14 } }).ui.chatTextPx, 14, 'a legal choice is kept as chosen');
  // The old `ui` block was dropped on sight (panel colours); it must not be dropped
  // now that it carries something — that would silently undo a setting on boot.
  assert.equal(normalize({ ui: { chatTextPx: 14 } }).ui.chatTextPx, 14);
});

// A rule inside the transcript that keeps a px size is a line that stops following
// the setting: the role label would drift off its clock, a code span would sink into
// the prose, a table would break its column. Every size in these families is a
// multiple of --chat-fs, and this is what keeps it that way.
const CHAT_SELECTOR =
  /(^|[\s,>~+])(\.msg|\.chat-post|\.trace|\.reasoning|\.tool-(card|head|chev|target|perm|body|detail|state)|\.perm-(card|head|who|lead|why|note|res|actions|reason)|\.state-pill|\.chat-alarm)/;

test('every size in the transcript is a multiple of the chat text size', () => {
  const css = read('web/synapse.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /--chat-fs:\s*13px/, 'the transcript has one base size to multiply');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const fixed = [];
  for (const [, selector, body] of rules) {
    if (!CHAT_SELECTOR.test(selector)) continue;
    const px = /font-size:\s*([0-9.]+)px/.exec(body);
    if (px) fixed.push(`${selector.trim().replace(/\s+/g, ' ')} -> font-size ${px[1]}px`);
    // One line of chat text is 1.5 × its size, and the role/clock boxes are that
    // tall: a literal 18.75px box would leave them off the message's centre at any
    // size but the default.
    if (/\b18\.75px/.test(body)) fixed.push(`${selector.trim().replace(/\s+/g, ' ')} -> an 18.75px box`);
  }
  assert.deepEqual(fixed, [], 'a transcript rule with a fixed size ignores the setting');
});

test('the transcript is drawn from var(--chat-fs), not from a copy of 12.5px', () => {
  const css = read('web/synapse.css');
  const uses = [...css.matchAll(/var\(--chat-fs\)/g)].length;
  // Prose, headings, code, tables, the clock, the role label, the trace, the tool
  // cards and the permission cards: the count only ever goes up, and a rule that
  // stopped using it would show up above.
  assert.ok(uses >= 40, `only ${uses} declarations follow --chat-fs`);
});

// The baseline sets `th { font-size: 9px }` and `td { font-size: 10px }`, and a direct
// element rule beats the size a table inherits — so a table in the chat kept its cells
// at 9 and 10px while the prose around them followed the setting. The operator asked
// whether tables scaled; they did not (10 Nov).
test('a table in the conversation takes the size of the conversation', () => {
  const css = read('web/synapse.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /#transcript th,\s*#transcript td\s*\{\s*font-size:\s*inherit;?\s*\}/, 'the chat cells do not inherit');
  // And the size they inherit is the chat's own, not a literal.
  assert.match(
    css,
    /\.msg-answer table\.md-table\s*\{[^}]*font-size:\s*calc\(var\(--chat-fs\)/,
    'the table itself is not on the chat grid',
  );
});

// A fold is a line of the conversation, not a label in a different typeface. The
// compacted post was monospace, letter-spaced and 0.8 of the chat, with a chevron at
// 0.8 that read as a speck; the operator asked for the type and the marker the
// reasoning fold uses (10 Nov).
test('the compacted line wears the chat type, and the reasoning fold marker', () => {
  const css = read('web/synapse.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.chat-post > summary \{[^}]*font-size:\s*calc\(var\(--chat-fs\) \* 0\.96\)/, 'the summary is not on the chat scale');
  assert.match(css, /\.chat-post-mark \{[^}]*font-family:\s*inherit/, 'the label is still a code font');
  assert.match(css, /\.chat-post-mark \{[^}]*letter-spacing:\s*normal/, 'the label is still letter-spaced');
  // The marker: the reasoning fold's 1.3em, and the same two glyphs rather than a
  // rotated speck.
  const marker = /\.chat-post > summary::after \{[^}]*\}/.exec(css);
  assert.ok(marker, 'the chevron rule is gone');
  assert.match(marker[0], /font-size:\s*1\.3em/, 'the chevron is not the reasoning size');
  assert.match(marker[0], /content:\s*'▸'/, 'the chevron is not the reasoning glyph');
  assert.match(css, /\.chat-post\[open\] > summary::after \{ content: '▾'; \}/, 'it has no open state');
});

// The prohibited alarm opens with a chevron too, and it had a 0.8em speck at the
// start of the line: the operator could not see it was a control (13 Nov). It is
// the fold marker now — the same 1.3em glyph in the same 16px slot.
test('a prohibited line opens with the fold marker, not a speck', () => {
  const css = read('web/synapse.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.chat-alarm\.is-prohibited > summary::before \{[^}]*\}/.exec(css);
  assert.ok(rule, 'the alarm marker rule is gone');
  assert.match(rule[0], /font-size:\s*1\.3em/, 'the chevron is not the reasoning size');
  assert.match(rule[0], /content:\s*'▸'/, 'the chevron is not the reasoning glyph');
  assert.match(css, /\.chat-alarm\.is-prohibited > summary \{[^}]*padding-left:\s*16px/, "it keeps the fold's 16px slot");
});

test('General is the first Settings tab and the Windows tab is gone', () => {
  const src = read('web/settings-panes.js');
  const block = /export const SETTINGS_TABS = \[([\s\S]*?)\n\];/.exec(src);
  assert.ok(block, 'the tab list is where it has always been');
  const ids = [...block[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(ids[0], 'general', 'General is the tab the window opens on');
  assert.ok(!ids.includes('windows'), 'the Windows toolchain pane is retired');
  // A tab with no pane silently falls back to the first one, which reads as a tab
  // that does nothing: every id must have a pane. Nine are in the panes module and
  // Providers is added by app.js, because it is the one editor with its own state.
  const panes = /export const PANES = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(panes, 'the pane map exists');
  assert.match(read('web/settings-window.js'), /const SETTINGS_PANES = \{ \.\.\.PANES, providers: settingsProviders \};/);
  for (const id of ids) {
    if (id === 'providers') continue;
    assert.match(panes[1], new RegExp(`\\b${id}:`), `Settings → ${id} has no pane`);
  }
});

test('the General pane edits the setting the page applies', () => {
  const src = read('web/settings-panes.js') + read('web/ui-prefs.js');
  // A slider with its value beside it, since 10 Nov: a number box with two arrows
  // and a half-point step was a change the eye could not see.
  assert.match(src, /setSlider\(c, 'Chat Text Size', 'ui\.chatTextPx'/);
  assert.match(src, /data-path="ui\.chatTextPx"|setSlider\(c, 'Chat Text Size', 'ui\.chatTextPx'/);
  assert.match(src, /function applyChatText\(/, 'there is one function that applies it');
  assert.match(src, /--chat-fs/, 'and it applies it through the transcript property');
  // The form must offer the same bounds the config enforces, or one of them lies.
  const min = new RegExp(`CHAT_TEXT_MIN = ${String(CHAT_TEXT_MIN).replace('.', '\\.')}`);
  const max = new RegExp(`CHAT_TEXT_MAX = ${String(CHAT_TEXT_MAX).replace('.', '\\.')}`);
  assert.match(src, min);
  assert.match(src, max);
  // One notch is a whole point, and both the slider and the gesture step use it.
  assert.equal(CHAT_TEXT_STEP, 1, 'a step smaller than a point is a change nobody can see');
  assert.match(src, /CHAT_TEXT_STEP = 1/);
  assert.match(read('web/settings-panes.js'), /step: CHAT_TEXT_STEP/);
});
