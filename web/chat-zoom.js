// Ctrl + wheel, Ctrl + plus and Ctrl + minus are the chat's text size.
//
// The page runs inside a WebView2 window, so these were the browser's own zoom: the
// whole interface grew — rail, cards, composer, dialogs — while the chat's size
// setting stayed where it was, and the operator had two sizes fighting each other.
// The chat is the thing worth enlarging and the setting already exists, so the
// gesture moves the setting instead, inside the same bounds, saved the way the
// slider saves it, and said on screen for a moment: a size with no feedback is a
// guess, and the two ends of the range need a name (10 Nov).
import { state } from './state.js';
import { api } from './api.js';
import { applyChatText, chatTextPx, CHAT_TEXT_DEFAULT, CHAT_TEXT_MAX, CHAT_TEXT_MIN, CHAT_TEXT_STEP } from './ui-prefs.js';
import { $ } from './dom.js';

const CHIP_MS = 1500;
const SAVE_MS = 600;

let chipTimer = 0;
let saveTimer = 0;
let saving = false;

/** Where one notch lands, never past the bounds. Pure, so the rule is testable. */
export function nextChatText(current, delta) {
  const from = chatTextPx(current);
  const raw = from + Number(delta || 0) * CHAT_TEXT_STEP;
  // Whole pixels, like the slider: a config that still holds 14.5 from an older build
  // steps to the nearest whole size rather than through half points.
  const to = Math.min(CHAT_TEXT_MAX, Math.max(CHAT_TEXT_MIN, Math.round(raw)));
  return to;
}

/** "Chat text 15 px", and at an end of the range, which end it is. */
export function chatTextChip(px) {
  const at = chatTextPx(px);
  const edge = at >= CHAT_TEXT_MAX ? ' · largest' : at <= CHAT_TEXT_MIN ? ' · smallest' : '';
  return `Chat text ${at} px${edge}`;
}

function showChip(px) {
  let chip = $('chatZoomChip');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'chatZoomChip';
    chip.className = 'chat-zoom-chip';
    chip.setAttribute('role', 'status');
    chip.setAttribute('aria-live', 'polite');
    document.body.append(chip);
  }
  chip.textContent = chatTextChip(px);
  chip.classList.add('is-on');
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => chip.classList.remove('is-on'), CHIP_MS);
}

/** The Settings slider and its readout, if the window is open, follow the gesture. */
function syncSettingsField(px) {
  const input = $('settingsBody')?.querySelector('[data-path="ui.chatTextPx"]');
  if (input) {
    input.value = String(px);
    input.setAttribute('aria-valuetext', `${px} px`);
    const min = Number(input.min);
    const max = Number(input.max);
    input.style.setProperty('--fill', `${((Number(px) - min) / (max - min || 1)) * 100}%`);
    const says = $('settingsBody')?.querySelector('[data-says="ui.chatTextPx"]');
    if (says) says.textContent = `${px} px`;
  }
  // The draft is what Save would write. Without this, zooming while Settings is open
  // and then pressing Save puts the old number back — the setting would undo itself.
  if (state.setDraft?.ui) state.setDraft.ui.chatTextPx = px;
}

/**
 * Persist the size. Debounced, because a wheel produces a dozen notches a second and
 * each save writes the config file; the page is already showing the new size, so the
 * only thing waiting for this is the file.
 */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (saving) return scheduleSave();
    const px = chatTextPx(state.config?.ui?.chatTextPx);
    saving = true;
    try {
      state.config = await api('PUT', '/api/config', { ...state.config, ui: { ...state.config?.ui, chatTextPx: px } });
      applyChatText(state.config?.ui?.chatTextPx);
    } catch {
      // A config that cannot be written is still applied for this page: the size the
      // operator chose is the size on screen, and the next save will try again.
    } finally {
      saving = false;
    }
  }, SAVE_MS);
}

/**
 * Move the chat's text size by `delta` notches, in the bounds, and say so.
 *
 * The chip shows even when the range refuses the notch — pressing again at the
 * ceiling has to answer "this is the largest", not nothing.
 */
export function chatTextBy(delta, { save = true } = {}) {
  const before = chatTextPx(state.config?.ui?.chatTextPx);
  const after = nextChatText(before, delta);
  if (after !== before) {
    if (!state.config) state.config = {};
    if (!state.config.ui) state.config.ui = {};
    state.config.ui.chatTextPx = after;
    applyChatText(after);
    syncSettingsField(after);
    if (save) scheduleSave();
  }
  showChip(after);
  return after;
}

/** Ctrl + 0: the size the interface was designed around. */
export function resetChatText(opts = {}) {
  return chatTextBy(CHAT_TEXT_DEFAULT - chatTextPx(state.config?.ui?.chatTextPx), opts);
}

/**
 * Install the three gestures.
 *
 * The keys are `preventDefault`ed anywhere: a page that relies on the shell to stop a
 * keystroke is a page that zooms when someone runs it in a browser.
 *
 * The wheel is a different matter, and it is the one the operator's report changed:
 * a **non-passive** wheel listener on `window` makes every wheel in the page wait for
 * the main thread, which during a turn is busy painting a growing thinking pane. The
 * shell already turns WebView2's own zoom off (`IsZoomControlEnabled = false`), so
 * inside the shell this listener needs no `preventDefault` at all — it is registered
 * passive, and the scroll stays on the compositor. In a browser (remote access) it
 * stays non-passive, because there the `preventDefault` is what stops the page zooming
 * instead of the chat resizing (10 Nov).
 */
export function installChatZoom() {
  const inShell = Boolean(window.chrome?.webview);
  window.addEventListener(
    'wheel',
    (e) => {
      // Ctrl is the whole signal. A plain wheel belongs to the chat's scrolling, and
      // the browser's pinch-zoom sends ctrlKey with a fractional deltaY.
      if (!e.ctrlKey || !e.deltaY) return;
      if (!inShell) e.preventDefault();
      chatTextBy(e.deltaY < 0 ? 1 : -1);
    },
    { passive: inShell },
  );
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const key = e.key;
    if (key === '+' || key === '=') {
      e.preventDefault();
      chatTextBy(1);
    } else if (key === '-' || key === '_') {
      e.preventDefault();
      chatTextBy(-1);
    } else if (key === '0') {
      e.preventDefault();
      resetChatText();
    }
  });
}
