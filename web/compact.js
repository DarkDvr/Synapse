// Compact the model's context and leave a handover.
//
// The chat stays exactly where it is. The engine writes a summary, the server puts
// it in the project document, and the transcript gains one more compaction card.
// This is the manual form of the engine's own automatic compaction. The chip is
// hidden unless a compact can actually run — a project is open, nothing is working,
// and there is something to compact — so it never sits there greyed out.
//
// One thing comes from app.js: reloading the transcript after the engine writes its
// card. Wired at boot.
import { state } from './state.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { findSession } from './projects.js';
import { renderComposer } from './composer.js';

const missing = (name) => () => {
  throw new Error(`compact.js: ${name} was not wired at boot`);
};
const wired = { loadMessages: missing('loadMessages') };

/** Hand this module the one thing that lives in app.js. Called once, at boot. */
export function compactWiring(fns) {
  Object.assign(wired, fns);
}

// ── compact: condense the context, keep the chat ────────────────
//
// The engine writes the handover from the whole conversation, the server puts it
// in the project document, and the existing transcript gets a compaction card. No
// new session, no cleared messages, no lost draft.
export const COMPACT_CONFIRM_MS = 3000;
export let compactTimer = 0;

/** The post the chat was started with, from the new session's own metadata. */
export function compactPostOf() {
  const meta = findSession(state.sessionId)?.metadata?.synapse?.compacted;
  if (!meta?.summary) return null;
  return {
    at: Number(meta.at) || 0,
    summary: String(meta.summary),
    messages: Number(meta.messages) || 0,
  };
}


/**
 * How many messages the chat is actually showing. The engine's list also holds
 * idle markers and system notes, so counting it said "Discard 7 messages?" over
 * a four-message conversation — a number the operator could not find anywhere.
 */
export function chatMessageCount() {
  return (state.messages || []).filter(
    (m) => m.error || m.type === 'user' || m.type === 'assistant' || m.type === 'synthetic',
  ).length;
}

export function renderCompactChip() {
  const btn = $('compactChip');
  if (!btn) return;
  if (state.compacting) {
    btn.hidden = false;
    btn.disabled = true;
    btn.classList.remove('is-confirm');
    btn.textContent = 'Compacting…';
    btn.title = 'The engine is writing the handover. The chat stays; a compaction card appears when it is done.';
    return;
  }
  const ready =
    state.view === 'session' &&
    Boolean(state.sessionId) &&
    !state.busyInfo?.busy &&
    chatMessageCount() > 0;
  if (!ready) {
    btn.hidden = true;
    btn.classList.remove('is-confirm');
    return;
  }
  const confirming = Date.now() < state.compactUntil;
  btn.hidden = false;
  btn.disabled = false;
  btn.classList.toggle('is-confirm', confirming);
  if (confirming) {
    btn.textContent = 'Compact the context?';
    btn.title = 'Click again to compact the context. The chat, the plan, the project document and every file stay.';
  } else {
    btn.textContent = 'Compact';
    btn.title = 'Compact the model context and leave a handover. The chat, the plan, the project document and every file stay.';
  }
}

export function compactClick() {
  if (state.compacting || !state.sessionId) return;
  if (Date.now() < state.compactUntil) {
    runCompact();
    return;
  }
  state.compactUntil = Date.now() + COMPACT_CONFIRM_MS;
  renderCompactChip();
  clearTimeout(compactTimer);
  compactTimer = setTimeout(() => {
    state.compactUntil = 0;
    renderCompactChip();
  }, COMPACT_CONFIRM_MS + 50);
}

export async function runCompact() {
  const sessionId = state.sessionId;
  if (!sessionId) return;
  state.compactUntil = 0;
  clearTimeout(compactTimer);
  state.compacting = true;
  renderCompactChip();
  renderComposer();
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/compact`);
    state.compacting = false;
    // Same session, same draft, same scroll: fetch the transcript so the new
    // compaction card appears where the engine wrote it.
    await wired.loadMessages();
  } catch (err) {
    state.compacting = false;
    renderCompactChip();
    renderComposer();
    const cancelled = err.status === 409 && /cancel/i.test(String(err.message || ''));
    toast(
      cancelled ? 'Compaction Cancelled' : 'Could Not Compact',
      cancelled ? 'The conversation was left exactly as it was.' : err.message,
    );
    return;
  }
  renderCompactChip();
}
