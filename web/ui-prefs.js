// The two interface preferences that are applied to the page rather than to the
// engine: the chat's text size and the interface language. They live here because
// both the Settings pane (which draws the fields) and app.js (which applies a saved
// change at boot, after Save and on every keystroke) need them.
import { state } from './state.js';

// The chat's text size, in pixels. The same bounds live in src/config.js and both
// are enforced: the form is a convenience, the config file is the truth.
export const CHAT_TEXT_DEFAULT = 12.5;
export const CHAT_TEXT_MIN = 10.5;
export const CHAT_TEXT_MAX = 16.5;

// The languages the interface has strings for. English only for now: an entry with
// no strings behind it would be a switch that does nothing.
export const LANGUAGES = [{ v: 'en', l: 'English' }];

export function chatTextPx(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return CHAT_TEXT_DEFAULT;
  return Math.min(CHAT_TEXT_MAX, Math.max(CHAT_TEXT_MIN, Math.round(n * 2) / 2));
}

/**
 * Apply the chat's text size, and nothing else's.
 *
 * The transcript is drawn from one custom property (`--chat-fs`), so this moves the
 * conversation — prose, headings, code, tables, the clock, the role label — and
 * leaves the rail, the cards, the composer and the dialogs alone. Called at boot,
 * after Save, and on every keystroke in the field, so the size can be judged before
 * it is saved.
 */
export function applyChatText(value = state.config?.ui?.chatTextPx) {
  const scroller = document.getElementById('transcript');
  // The browser keeps the scroll *offset* when text grows, not the place in the
  // conversation: measured at 1280px on a 32-message transcript, changing 16.5px to
  // 10.5px and back left the view 6,895px above the newest line. Pin it to the
  // bottom again if that is where it was — and leave it alone if the operator had
  // scrolled up to read something, because moving their page is the same bug.
  const pinned = scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 4 : false;
  document.documentElement.style.setProperty('--chat-fs', `${chatTextPx(value)}px`);
  if (pinned && scroller) {
    // After layout: the scroll height is only final once the new size has been laid
    // out, so setting it now would pin to the old height.
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }
}

/**
 * The interface language. English is the only one with strings behind it today, so
 * this records the choice on the page (`lang`, which a screen reader also reads)
 * and nothing else. When a translation lands, this is where it would take effect.
 */
export function applyLanguage(value = state.config?.ui?.language) {
  const lang = LANGUAGES.some((l) => l.v === value) ? value : 'en';
  document.documentElement.lang = lang;
}
