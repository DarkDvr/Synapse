// Which renderer draws the conversation: the one the app has always had, or the rebuild.
//
// The switch is a preview, not a setting — `?chat=v2` on the page's own address draws the
// same conversation with ./chat-view.js. Everything that feeds it stays exactly as it is:
// the stream, the poll, the cards, the composer and the panel's reply all run the paths they
// ran before, and the transcript is the same element in the same place. Only the function
// that draws it changes, which is why the two can be compared on a real turn instead of on a
// recording.
//
// It is one line on purpose. When the rebuild takes over, this file goes, the import in
// app.js points at ./chat-view.js, and the old renderer goes with its own modules.
import { state } from './state.js';
import { renderTranscript as renderV1 } from './transcript.js';
import { buildChat } from './chat-model.js';
import { createChatView } from './chat-view.js';
import { answerWaitSec } from './mode.js';

/** `v2` only when the address asks for it, and by its full name: no half-switched chat. */
export const chatRenderer = () => {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('chat') === 'v2' ? 'v2' : 'v1';
  } catch {
    // A page with no location is a page with no address to read: the old chat.
    return 'v1';
  }
};

export const chatIsV2 = () => chatRenderer() === 'v2';

let view = null;

/**
 * Mount the rebuild in `host` and hand it what its clicks mean in the app.
 *
 * `onToggle(key, open)` for a card, `onPaneToggle(key)` for the thinking pane's own switch,
 * `onSubmit(form, answer)` for a question. The view never keeps an answer to itself: the
 * page's state is the record, exactly as it is for the old renderer.
 */
export function mountChatView(host, wired = {}) {
  view = createChatView(host, wired);
  return view;
}

/**
 * Draw the chat.
 *
 * Every call site in the app already says `renderTranscript()`; what changes is who answers.
 * A `v2` page with no view mounted falls back to the old renderer rather than drawing
 * nothing — a chat that silently stops being drawn is the worst outcome of a switch.
 */
export function renderTranscript() {
  if (!view) return renderV1();
  // The model reads the panel's wait as a plain number, and the page's own settings are the
  // truth for it: read here rather than copied at boot, so a changed setting is never a
  // countdown measured against last week's answer.
  state.answerWaitSec = answerWaitSec();
  view.update(buildChat(state));
}
