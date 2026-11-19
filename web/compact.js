// Discard this conversation and leave a handover.
//
// The only reset there is: the engine writes a summary of the whole conversation, the
// server puts it in the project document and starts a fresh chat, and the new chat
// shows one post where the old one was. The chip is hidden unless a compact can
// actually run — a project is open, nothing is working, and there is something to
// discard — so it never sits there greyed out.
//
// One thing comes from app.js: opening the new chat. Wired at boot.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { renderTranscript } from './transcript.js';
import { findSession, loadProjects } from './projects.js';
import { renderComposer } from './composer.js';

const missing = (name) => () => {
  throw new Error(`compact.js: ${name} was not wired at boot`);
};
const wired = { openSession: missing('openSession') };

/** Hand this module the one thing that lives in app.js. Called once, at boot. */
export function compactWiring(fns) {
  Object.assign(wired, fns);
}

// ── compact: discard this conversation, leave a handover ─────────
//
// The only reset. The engine writes the handover from the whole conversation,
// the server puts it in the project document and starts a fresh chat, and the
// new chat shows one post where the old conversation was. The chip is hidden
// unless a compact can actually run — a project is open, nothing is working, and
// there is something to discard — so it never sits there greyed out.
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
    btn.title = 'The engine is writing the handover. The chat is replaced when it is done.';
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
    const open = (state.planState?.plan?.tasks || []).filter((t) => t.status !== 'done').length;
    const total = chatMessageCount();
    const tasks = open ? ` · ${open} task${open === 1 ? '' : 's'} unfinished` : '';
    btn.textContent = `Discard ${total} message${total === 1 ? '' : 's'}? The files stay${tasks}`;
    btn.title = 'Click again to discard this conversation. The plan, the project document and every file stay.';
  } else {
    btn.textContent = 'Compact';
    btn.title = 'Discard this conversation and start fresh. The plan, the project document and every file stay.';
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
    const out = await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/compact`);
    state.compacting = false;
    state.messages = [];
    // The old chat has just left the list on purpose; do not read that as "the
    // open chat was removed" and close the view before opening its replacement.
    await loadProjects({ keepOpen: true });
    if (out?.sessionId && state.sessionId !== out.sessionId) await wired.openSession(out.sessionId);
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
