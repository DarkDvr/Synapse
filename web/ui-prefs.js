// The two interface preferences that are applied to the page rather than to the
// engine: the chat's text size and the interface language. They live here because
// both the Settings pane (which draws the fields) and app.js (which applies a saved
// change at boot, after Save and on every keystroke) need them.
import { state } from './state.js';

// The chat's text size, in whole pixels. The same bounds live in src/config.js and
// both are enforced: the form is a convenience, the config file is the truth.
export const CHAT_TEXT_DEFAULT = 13;
export const CHAT_TEXT_MIN = 10;
export const CHAT_TEXT_MAX = 20;
// One notch of the slider, the keyboard and the wheel. It was half a point, which
// is a change nobody can see; a whole point is one the operator can judge (10 Nov).
export const CHAT_TEXT_STEP = 1;

// The languages the interface has strings for. English only for now: an entry with
// no strings behind it would be a switch that does nothing.
export const LANGUAGES = [{ v: 'en', l: 'English' }];

/** The size, clamped, on the whole-pixel grid the setting is defined on. */
export function chatTextPx(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return CHAT_TEXT_DEFAULT;
  return Math.min(CHAT_TEXT_MAX, Math.max(CHAT_TEXT_MIN, Math.round(n)));
}

// ── the look: one picture, one panel, two numbers ───────────────────────
//
// The working area carries a picture; the chat, the role cards and the plan are one
// translucent surface over it. Two numbers decide the result — how opaque that surface
// is, and how strong the picture is on the stage — and one choice says which picture,
// or none at all (the dark blue-grey it was before). They live here for the same reason
// the text size does: the Settings pane draws them and the page applies them, at boot,
// on every change in the field, and after Save.

export const GROUNDS = [
  { v: 'nebula', l: 'Nebula' },
  { v: 'neural', l: 'Neural' },
  { v: 'none', l: 'None (dark blue-grey)' },
];

export const PANEL_OPACITY_DEFAULT = 94;
export const PANEL_OPACITY_MIN = 70;
export const PANEL_OPACITY_MAX = 98;
export const GROUND_STRENGTH_DEFAULT = 66;
export const GROUND_STRENGTH_MIN = 20;
export const GROUND_STRENGTH_MAX = 100;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** A number, or NaN for "not set" — the settings form hands a missing path back as an
 *  empty string, and `Number('')` is 0, which would read as "the minimum". */
const toNumber = (value) => (value === '' || value === null || value === undefined ? NaN : Number(value));

/** How opaque the panels are over the picture, in percent. */
export function panelOpacity(value) {
  const n = toNumber(value);
  return Number.isFinite(n) ? clamp(n, PANEL_OPACITY_MIN, PANEL_OPACITY_MAX) : PANEL_OPACITY_DEFAULT;
}

/** How strong the picture is on the stage, in percent. */
export function groundStrength(value) {
  const n = toNumber(value);
  return Number.isFinite(n) ? clamp(n, GROUND_STRENGTH_MIN, GROUND_STRENGTH_MAX) : GROUND_STRENGTH_DEFAULT;
}

/**
 * Apply the look.
 *
 * One attribute and two custom properties: the stylesheet owns what they mean, this
 * only hands it the chosen numbers. Called at boot, on every change in the Looks pane
 * (so the operator judges it while choosing) and after a save.
 */
export function applyLooks(config = state.config) {
  const ui = config?.ui || {};
  const ground = GROUNDS.some((g) => g.v === ui.background) ? ui.background : GROUNDS[0].v;
  document.body.dataset.ground = ground;
  const root = document.documentElement.style;
  root.setProperty('--panel-alpha', (panelOpacity(ui.panelOpacity) / 100).toFixed(2));
  root.setProperty('--ground-strength', (groundStrength(ui.backgroundStrength) / 100).toFixed(2));
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
