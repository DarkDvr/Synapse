// The follow rule, on its own: scrolling up during a turn must stay scrolled up.
//
// This is the third version of one rule, and the first that can be tested without a
// page, a run or a growing thinking pane. Each earlier version looked right and lost
// the same fight — the follow was released by an upward gesture and then re-armed by
// the geometry that the release itself caused. The operator put it plainly: "there's
// still a fight going on between scrolling chat up and keeping it pinned".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { followAfterScroll, CHAT_FOLLOW_SLACK } from '../web/chat-scroll.js';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('an upward gesture releases the follow and nothing about the geometry takes it back', () => {
  // The failing case, exactly: the reader is 30px from the end — inside the two-line
  // slack — having just scrolled up. Every animation frame of that wheel still
  // measures "near the end", and the old rule re-armed on it.
  const armed = followAfterScroll({ armed: false, byReader: true, movedUp: true, intent: -1, fromEnd: 30 });
  assert.equal(armed, false, 'a wheel up near the end re-armed the follow');
  // And it stays released while the gesture is still young and the box is still close.
  for (const fromEnd of [10, 25, 47, 48]) {
    assert.equal(
      followAfterScroll({ armed: false, byReader: true, movedUp: false, intent: -1, fromEnd }),
      false,
      `re-armed at ${fromEnd}px from the end`,
    );
  }
});

test('only a reader coming back can re-arm it', () => {
  assert.equal(followAfterScroll({ armed: false, byReader: true, intent: 1, fromEnd: 20 }), true, 'a wheel down at the end');
  assert.equal(followAfterScroll({ armed: false, byReader: true, intent: 0, fromEnd: 0 }), true, 'the scrollbar at the very end');
  assert.equal(followAfterScroll({ armed: false, byReader: true, intent: 0, fromEnd: 40 }), false, 'geometry alone is not a gesture');
  assert.equal(followAfterScroll({ armed: false, byReader: true, intent: -1, fromEnd: 0 }), false, 'an upward wheel never arms');
  assert.equal(CHAT_FOLLOW_SLACK, 48, 'two lines is the window');
});

test('our own writes never change the follow', () => {
  // The pin sets scrollTop to the end and fires a scroll event; that event reports
  // "at the end, no movement" and must not be read as the reader arriving.
  assert.equal(followAfterScroll({ armed: false, byReader: false, movedUp: false, intent: -1, fromEnd: 0 }), false);
  assert.equal(followAfterScroll({ armed: true, byReader: false, movedUp: true, intent: 0, fromEnd: 0 }), true);
});

test('the wheel listener is passive in the shell, and the frame loop asks the follow', () => {
  const zoom = read('web/chat-zoom.js');
  // A non-passive wheel listener on window makes every wheel wait for the main thread,
  // which during a turn is busy painting the pane. The shell disables WebView2's zoom,
  // so inside it no preventDefault is needed.
  assert.match(zoom, /const inShell = Boolean\(window\.chrome\?\.webview\)/);
  assert.match(zoom, /\{ passive: inShell \}/, 'the wheel listener is still blocking');
  const transcript = read('web/transcript.js');
  assert.match(transcript, /const stick = chatAtBottom\(\) && chatFollows\(\)/, 'the render pins on geometry');
  const app = read('web/app.js');
  assert.match(app, /atBottom: \(\) => chatAtBottom\(48\) && chatFollows\(\)/, 'the frame loop pins on geometry');
  // A wheel's deltaY is positive scrolling down; the app must pass the intent, not the event.
  assert.match(app, /noteUserScrollIntent\(e\.deltaY > 0 \? 1 : -1\)/);
});
