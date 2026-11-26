// Remove the last exchange: the operator's last prompt and the answer to it.
//
// There is exactly one deletion, and it is a suffix: the engine's revert boundary
// takes the last operator message and everything after it. The chip is quiet and
// appears only when the server says the last exchange is a clean one; hovering it
// tints the posts that would go, and a second click within three seconds commits.
// The files, the plan and every worker session stay.
import { state } from './state.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { chatAtBottom, scrollChatToBottom } from './chat-scroll.js';

/** How long a first click stays a confirmation, the same three seconds Compact uses. */
export const REMOVE_CONFIRM_MS = 3000;
/** The height slide after the server has committed; long enough to read, short enough not to wait. */
export const REMOVE_ANIMATION_MS = 500;

let confirmUntil = 0;
let confirmTimer = 0;
let busy = false;

const missing = (name) => () => {
  throw new Error(`remove-exchange.js: ${name} was not wired at boot`);
};
const wired = { loadMessages: missing('loadMessages') };

export function removeExchangeWiring(fns) {
  Object.assign(wired, fns);
}

function transcript() {
  return $('transcript');
}

/** Can this chat offer the one deletion right now? */
function ready() {
  if (busy || !state.removeInfo?.available) return false;
  if (!state.sessionId || state.mode !== 'single') return false;
  if (!state.removeInfo.messageID) return false;
  const messages = state.messages || [];
  if (!messages.length || !messages.some((m) => m.id === state.removeInfo.messageID)) return false;
  if (state.busy || state.busyInfo?.busy || state.streaming || state.compacting || state.stopping) return false;
  if (state.busySessions?.has(state.sessionId) || state.canStop) return false;
  if (state.forms?.length || state.permissions?.length || state.lease) return false;
  if (state.runs?.size) return false;
  if ((state.messages || []).some((m) => String(m?.id || '').startsWith('local-'))) return false;
  return true;
}

function setHighlight(which) {
  const box = transcript();
  if (!box) return;
  box.classList.toggle('is-remove-preview', which === 'preview');
  box.classList.toggle('is-remove-confirm', which === 'confirm');
}

/** Draw the chip from the page's own state. Called by the transcript and the composer. */
export function renderRemoveChip() {
  const btn = $('removeChip');
  if (!btn) return;
  if (busy) {
    btn.hidden = false;
    btn.disabled = true;
    btn.classList.add('is-confirm');
    btn.textContent = 'Removing…';
    btn.title = 'The exchange is being removed. The files and the plan stay.';
    btn.setAttribute('aria-label', 'Removing the last exchange');
    return;
  }
  if (!ready()) {
    btn.hidden = true;
    btn.disabled = false;
    btn.classList.remove('is-confirm');
    btn.textContent = '';
    btn.title = '';
    confirmUntil = 0;
    clearTimeout(confirmTimer);
    setHighlight(null);
    return;
  }
  const confirming = Date.now() < confirmUntil;
  btn.hidden = false;
  btn.disabled = false;
  btn.classList.toggle('is-confirm', confirming);
  btn.textContent = confirming ? 'Remove Exchange?' : 'Remove Exchange';
  btn.title = confirming
    ? 'Click again to remove your last message and its response. The files, the plan and any worker work stay.'
    : 'Remove your last message and its response from this chat. The files, the plan and any worker work stay.';
  btn.setAttribute('aria-label', confirming ? 'Confirm removing the last exchange' : 'Remove the last exchange');
}

/** The first look: show exactly what the delete would take. */
export function previewRemoveExchange() {
  if (busy || Date.now() < confirmUntil || !ready()) return;
  setHighlight('preview');
}

/** Leaving the button takes the preview with it, unless a confirmation is waiting. */
export function endRemovePreview() {
  if (busy || Date.now() < confirmUntil) return;
  setHighlight(null);
}

/** The chip's click: first is a question, second within three seconds is the answer. */
export function removeExchangeClick() {
  if (busy || !ready()) return;
  if (Date.now() < confirmUntil) {
    void runRemoveExchange();
    return;
  }
  confirmUntil = Date.now() + REMOVE_CONFIRM_MS;
  setHighlight('confirm');
  renderRemoveChip();
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => {
    confirmUntil = 0;
    if (!busy) {
      setHighlight(null);
      renderRemoveChip();
    }
  }, REMOVE_CONFIRM_MS + 50);
}

/** Put the chip and the highlight back to idle when the chat changes. */
export function resetRemoveExchange() {
  busy = false;
  confirmUntil = 0;
  clearTimeout(confirmTimer);
  setHighlight(null);
  renderRemoveChip();
}

/**
 * Animate the posts out, then let the transcript reload from the engine.
 *
 * The height is measured first and written as a keyframe: CSS cannot animate to
 * `height: auto`, and a class that merely hid the posts would make the conversation
 * jump. The reduction of the scroll box is what makes what remains above slide down
 * to the composer. A reader with reduced motion gets the same removal without the
 * slide.
 */
function collapseExchange(nodes) {
  return new Promise((resolve) => {
    if (!nodes.length) return resolve();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof nodes[0]?.animate !== 'function') return resolve();
    let left = nodes.length;
    const done = () => {
      left -= 1;
      if (left === 0) resolve();
    };
    for (const node of nodes) {
      const style = getComputedStyle(node);
      const height = node.getBoundingClientRect().height;
      // A measured height includes padding; make the box agree with it, or the first
      // frame grows taller before it starts to collapse.
      node.style.boxSizing = 'border-box';
      node.style.overflow = 'hidden';
      node.style.pointerEvents = 'none';
      const anim = node.animate(
        [
          {
            height: `${height}px`,
            opacity: 1,
            marginBottom: style.marginBottom,
            paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom,
            borderTopWidth: style.borderTopWidth,
          },
          {
            height: '0px',
            opacity: 0,
            marginBottom: '0px',
            paddingTop: '0px',
            paddingBottom: '0px',
            borderTopWidth: '0px',
          },
        ],
        { duration: REMOVE_ANIMATION_MS, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'forwards' },
      );
      anim.finished.then(done, done);
    }
  });
}

async function runRemoveExchange() {
  const sessionId = state.sessionId;
  if (!sessionId || busy) return;
  busy = true;
  confirmUntil = 0;
  clearTimeout(confirmTimer);
  setHighlight('confirm');
  renderRemoveChip();
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/remove-last`);
    if (state.sessionId !== sessionId) {
      // The operator moved on while the request was in flight; the new chat owns
      // the screen and its own reset already put this chip away.
      busy = false;
      return;
    }
    const wasAtBottom = chatAtBottom();
    const nodes = [...document.querySelectorAll('#transcript [data-remove-target]')];
    await collapseExchange(nodes);
    busy = false;
    state.removeInfo = { available: false };
    setHighlight(null);
    renderRemoveChip();
    await wired.loadMessages();
    if (wasAtBottom) scrollChatToBottom();
  } catch (err) {
    busy = false;
    confirmUntil = 0;
    setHighlight(null);
    renderRemoveChip();
    const why = String(err?.message || 'The exchange was left as it was.');
    toast('Could Not Remove', why);
  }
}
