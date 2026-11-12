// What is waiting on the operator, and how often the page asks.
//
// Two things can hold a session open: a question and a permission card. Both are
// drawn from state the server owns, and both change while the page is looking — so
// this module is the one place that decides when to ask again, and the signature it
// compares so a poll that changed nothing does not redraw the chat.
//
// Two things come from app.js and are wired at boot: the chime's "is work still
// coming?" answer, and the status chip.
import { state } from './state.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { currentForm } from './run-view.js';
import { renderTranscript } from './transcript.js';
import { renderComposer } from './composer.js';
import { renderAskPanel, refreshAskPanel } from './ask-panel.js';
import { currentRun } from './run-view.js';
import { findSession, renderTree } from './projects.js';
import { renderMode } from './mode.js';
import { syncRuns } from './live-runs.js';
import { toast } from './toast.js';

const missing = (name) => () => {
  throw new Error(`pending.js: ${name} was not wired at boot`);
};
const wired = {
  noteWorking: missing('noteWorking'),
  settleEventChip: missing('settleEventChip'),
};

/** Hand this module the two things that live in app.js. Called once, at boot. */
export function pendingWiring(fns) {
  Object.assign(wired, fns);
}

// ── things that can block a session ─────────────────────────────
/**
 * Permissions, forms and the engine's own list of running sessions. A blocked
 * session emits nothing at all, so polling this is the only way to notice it —
 * and it is what restores the prompt after a reload.
 */
/**
 * The poll is authoritative, but an ask must not wait eight seconds. A request
 * the gate answers itself is gone by the time this fires, so it never draws a
 * card — that is why the refresh is delayed rather than painting the event
 * straight away.
 */
export let pendingTimer = null;
export function schedulePendingRefresh() {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    refreshPending();
  }, 200);
}

/** A decision changes a chip on a card that is already drawn. Coalesced, because
 *  a busy turn produces one decision per read and write. */
export let permissionRenderTimer = null;
export function schedulePermissionRender() {
  if (permissionRenderTimer) return;
  permissionRenderTimer = setTimeout(() => {
    permissionRenderTimer = null;
    renderTranscript();
  }, 120);
}

/**
 * What the session pane paints from state the pending poll can change.
 *
 * One string, compared before and after the poll, so an unchanged poll costs a
 * comparison and nothing else. The transcript's own guard is not enough: the dock
 * is re-measured before that guard is reached.
 */
export function paneSig() {
  const perms = (state.permissions || []).map((p) => `${p.requestId}:${p.scope}`).join(',');
  const forms = (state.forms || []).map((f) => `${f.id}:${f.sessionId}`).join(',');
  const info = state.busyInfo || {};
  return [
    perms,
    forms,
    state.busy ? 1 : 0,
    state.canStop ? 1 : 0,
    info.busy ? 1 : 0,
    info.state || '',
    info.project || '',
    info.driver?.name || '',
  ].join('|');
}

export async function refreshPending() {
  let p;
  try {
    p = await api('GET', `/api/pending${state.sessionId ? `?session=${encodeURIComponent(state.sessionId)}` : ''}`);
  } catch {
    return;
  }
  // What the session pane looks like before this poll's answers land. Compared at
  // the end: the poll runs every eight seconds whether or not anything happened.
  const before = paneSig();

  // The engine is the authority on what is running; SSE keeps us snappy
  // between polls and this corrects any drift.
  const active = new Set(p.active || []);
  for (const id of active) if (!state.busySince.has(id)) state.busySince.set(id, Date.now());
  for (const id of [...state.busySince.keys()]) if (!active.has(id)) state.busySince.delete(id);
  state.busySessions = active;
  // The project lock. The server decides; this is the face of it: Send and the
  // mode switch both read it, and both stay open for the cards and Stop.
  if (state.sessionId) {
    state.busyInfo = await api('GET', `/api/busy?session=${encodeURIComponent(state.sessionId)}`).catch(() => null);
  } else {
    state.busyInfo = null;
  }
  renderMode();
  renderComposer();
  state.canStop = Boolean(p.canStop);
  state.activeHere = Number(p.activeHere) || 0;
  // A stop outlives a reload: the server keeps the intent, so the notice and the
  // red button come back with the page instead of vanishing on refresh while the
  // engine is still retrying.
  state.stopping = Boolean(p.stopping);
  state.stoppingPhase = p.stopping?.phase || null;
  state.stoppingReason = p.stopping?.reason || null;
  // A page opened, or reloaded, in the middle of a turn never saw the
  // `session.execution.started` that began it — so the composer showed no Stop and
  // the card looked idle while the engine was working. The engine's own list of
  // active sessions is the authority, and it is already in hand here. It only ever
  // turns this *on*: clearing it is the transcript's job (`updateBusyFromMessages`)
  // and the turn's own end event, so a poll that races the engine cannot take the
  // Stop button away from a session that is working.
  if (state.sessionId && active.has(state.sessionId) && !state.busy) {
    state.busy = true;
    renderComposer();
  }
  // The project lock is part of "is this chat working?", and a poll is the only
  // thing that sees it let go: without this, a turn that ends while the lock is
  // still held would go quiet with no chime, and nothing later would notice.
  wired.noteWorking();

  const previousPermissions = new Set((state.permissions || []).map((p) => p.requestId));
  state.permissions = (p.permissions || []).map((x) => ({
    sessionId: x.sessionId,
    requestId: x.requestId,
    action: x.action,
    resources: x.resources,
    resolved: x.resolved || [],
    reason: x.reason || '',
    scope: x.scope || '',
    // When Auto-Permissions will allow this card (epoch ms), or null when the
    // switch is off for the asking project. The card counts down to it.
    autoPermissionsAt: x.autoPermissionsAt || null,
    role: x.role || null,
    task: x.task || null,
    title: x.title || null,
    directory: x.directory || null,
    files: x.files || [],
    // A sign-in ask is the harness's own card; these two fields let it say which site.
    browserHost: x.browserHost || '',
    browserUrl: x.browserUrl || '',
  }));
  state.forms = p.forms || [];

  // A worker's request is a card in a transcript nobody has open, so it is
  // announced once here — otherwise the worker blocks until its timeout and the
  // only evidence is a log line. The open session's own asks are not announced:
  // the card is already on screen.
  for (const perm of state.permissions) {
    if (previousPermissions.has(perm.requestId) || state.announcedPermissions.has(perm.requestId)) continue;
    state.announcedPermissions.add(perm.requestId);
    // A card that waits for a person is news in the taskbar too — but only when the
    // thing waiting has no automatic answer and only when the window is not in
    // front (the shell decides that part). A browser sign-in never answers itself,
    // and neither does a screen lease; a permission card does only when
    // Auto-Permissions is on for its project, which is what autoPermissionsAt says
    // (12 Nov).
    const wantsPerson = perm.scope === 'browser' || perm.scope === 'desk' || !perm.autoPermissionsAt;
    // A sign-in card is the one that asks to open a window: it has its own sound, the two
    // hollow knocks, and it is always on screen — the operator is the one who must act.
    if (perm.scope === 'browser') {
      if (wantsPerson) wired.blinkTaskbar?.('a sign-in is waiting');
      wired.playSound?.('hollow');
      continue;
    }
    if (wantsPerson) wired.blinkTaskbar?.(perm.scope === 'desk' ? 'the screen is asked for' : 'a permission is waiting');
    if (state.view === 'session' && perm.sessionId === state.sessionId) continue;
    const who = [perm.role, perm.task].filter(Boolean).join(' · ') || perm.title || 'A chat';
    toast('Permission Needed', `${who} is waiting on ${perm.action}. Open it in the rail to answer.`);
  }

  // A question must not be able to hide. The panel lives inside the session
  // view and a reload opens no session, so a waiting question says so once —
  // and the rail carries a mark on the session that asked it, so a page left
  // open on the project list still shows where the run is stuck.
  for (const form of state.forms) {
    if (state.announcedForms.has(form.id)) continue;
    state.announcedForms.add(form.id);
    // A question with no automatic answer waits for a person: the same blink.
    if (!form.autoAnswerAt) wired.blinkTaskbar?.('a question is waiting');
    if (state.view === 'session') continue; // the panel is on screen already
    const who = findSession(form.sessionId)?.title || 'this conversation';
    toast('Answer Needed', `${who} is waiting on a question. Open it in the rail to answer.`);
  }

  // The same poll is the only place that knows, for certain, that nothing is
  // running anywhere — so it is where the sidebar clock is allowed to stop.
  wired.settleEventChip(state.busySessions);

  renderTree();
  // What the server says is running, not only what the stream said. A missed
  // `run.finished` used to leave a run on screen for ever — Stop live over an
  // Architect that had already said it was waiting (see syncRuns).
  await syncRuns();
  // The same authority for the turn itself. A restart, or a stream that died just
  // before the end event, leaves `state.busy` true for ever — and the composer then
  // says "Working — Stop to take over" over a chat that is waiting for the operator.
  // The server's own answer is the only thing that can settle it. If this races a
  // turn that is just starting, the next event sets it back and the server refuses
  // the Send itself, which is the same answer a stale button would have given.
  if (state.sessionId && state.busy && state.busyInfo && !state.busyInfo.busy && !currentRun()) {
    state.busy = false;
    renderComposer();
  }
  if (state.view === 'session') {
    // Only what this poll can actually have changed is repainted. The transcript
    // used to be rebuilt every eight seconds whatever had happened, and the
    // operator watched the chat move up and down by about a line on a laptop while
    // typing: a rebuild re-measures the dock and settles the scroll offset even
    // when not one message changed. Its own signature guard did not help, because
    // `fitChatHeight` runs before it.
    if (paneSig() !== before) {
      renderAskPanel();
      renderComposer();
      renderTranscript();
    }
  }
}
