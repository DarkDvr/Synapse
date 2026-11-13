// The rail: the projects, their chats, and the dot that says which one is working.
//
// A project IS a directory, and a project has one chat — there is no "new session"
// in the product, so this module is the whole of the navigation: which projects
// exist, which chat is open, which one is working, stalled, or waiting on an answer,
// and what a row says when the answer is "nothing yet".
//
// Four things come from app.js and are wired at boot: create a chat, open one,
// the status chip and the empty view.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { projectOf, runIn, dirKey } from './run-view.js';

const missing = (name) => () => {
  throw new Error(`projects.js: ${name} was not wired at boot`);
};
const wired = {
  createChat: missing('createChat'),
  openSession: missing('openSession'),
  setEventChip: missing('setEventChip'),
  showNothing: missing('showNothing'),
};

/** Hand this module the four things that live in app.js. Called once, at boot. */
export function projectsWiring(fns) {
  Object.assign(wired, fns);
}

// ── projects + sessions ─────────────────────────────────────────
export async function loadProjects({ keepOpen = false } = {}) {
  try {
    state.projects = (await api('GET', '/api/projects')).projects;
  } catch (err) {
    state.projects = [];
    wired.setEventChip('projects unavailable');
    renderTree();
    return;
  }
  // The rail has no expand/collapse any more: a project is one row that opens
  // its conversation. The old per-load collapse state is not needed.
  renderTree();
  pruneFolderState();
  // The open session can be deleted from another tab, or by Synapse's own
  // scaffolding sweep. Left alone, the UI keeps a dead session open and every
  // control on it answers 404 — which is how a mode switch once reported
  // "Session not found". The list is only trusted while the engine is up: with
  // the engine down it is empty for a reason that has nothing to do with this
  // session, and closing the view would be wrong.
  //
  // `keepOpen` is for a load that is part of a replacement: a compact deletes
  // the old chat on purpose and opens a new one, so the moment the old id leaves
  // the list is not a moment to close the view. `state.compacting` is the same
  // rule one step earlier — the engine announces the old chat's deletion while the
  // compact is still running, and that announcement must not blank the page.
  if (
    !keepOpen &&
    !state.compacting &&
    state.sessionId &&
    state.status?.engine?.ready === true &&
    !findSession(state.sessionId)
  ) {
    toast('Chat Closed', 'It was replaced or removed, so it is no longer open.');
    wired.showNothing();
  }
}

export const findSession = (id) => {
  for (const p of state.projects) {
    const s = p.sessions.find((x) => x.id === id);
    if (s) return s;
  }
  return null;
};

/**
 * The same lookup, but only the operator's own conversation.
 *
 * A worker's session and the engine's subagent sessions are in the projects' session
 * lists (the server filters them, and a page loaded before that filter still holds
 * them), so "is this session still there" is not the same question as "may the page
 * open it as a chat". On 13 Nov the restored session was a subagent's and the page
 * showed its brief as the operator's own message.
 */
export const chatSession = (id) => {
  const s = findSession(id);
  return s && !s.internal && !s.raw?.parentID ? s : null;
};


export const isBusy = (sessionId) => state.busySessions.has(sessionId);
/**
 * Is anything being done on this session's behalf?
 *
 * The engine only knows about its own turns, and the Architect's turn ends the
 * moment it delegates: for the whole worker run that follows, the engine says
 * the session is idle. The rail then showed a yellow breathing dot while the
 * Architect was thinking and a dead one while a worker built the thing — the
 * exact opposite of when the work is happening. So a run the session started
 * counts as work too.
 */
export const sessionWorking = (sessionId) => {
  if (!sessionId) return false;
  if (isBusy(sessionId)) return true;
  // The engine's active list can be empty in the middle of a turn (measured);
  // the project lock is the second source, and it is the one the server refuses
  // on, so the rail must agree with it.
  if (sessionId === state.sessionId && state.busyInfo?.busy) return true;
  const project = projectOf(sessionId);
  const run = project ? runIn(project) : null;
  return Boolean(run && (!run.architect || run.architect === sessionId));
};
const lastProgress = (sessionId) => state.busySince.get(sessionId) || 0;
// A running session that has produced nothing for this long is not "working",
// it is waiting on an upstream request that is never coming back. A tool that
// is genuinely still executing emits nothing either (measured: a 100s shell
// command logs one progress event and then silence), so an in-flight tool
// always counts as progress. Measured first-token latency on the free models
// reached 69s on a cold start, so the window has to clear that comfortably.
export const STALL_MS = 180000;
export const isStalled = (sessionId) =>
  isBusy(sessionId) &&
  !state.toolsInFlight.has(sessionId) &&
  Date.now() - lastProgress(sessionId) > STALL_MS;

export function liveDot(sessionId, { clickable = true, on = sessionWorking(sessionId), ok = false, idle = false } = {}) {
  const stalled = isStalled(sessionId);
  if (stalled && clickable) {
    return `<button class="tree-live on stalled" data-interrupt="${esc(sessionId)}" title="No response for over ${Math.round(STALL_MS / 1000)}s — click to interrupt"></button>`;
  }
  if (stalled) return '<span class="tree-live on stalled" title="Stalled"></span>';
  const cls = `${on ? ' on' : ''}${ok ? ' ok' : ''}${idle ? ' idle' : ''}`;
  const title = on ? 'Working' : ok ? 'Idle — this project has a conversation' : idle ? 'Never used' : '';
  return `<span class="tree-live${cls}" title="${title}"></span>`;
}

/**
 * What a session is stopped on, if anything.
 *
 * A session waiting on an answer emits nothing, exactly like an idle one, and
 * the question panel only exists inside an open session — so after a reload a
 * blocked session used to look like any other and the operator had no way to
 * know a question was sitting there. The rail says it instead.
 */
export function waitingFor(sessionId) {
  if (!sessionId) return null;
  if ((state.forms || []).some((f) => f.sessionId === sessionId)) return 'answer';
  if ((state.permissions || []).some((p) => p.sessionId === sessionId)) return 'decision';
  return null;
}

// Every project is one conversation: there is no session list and no "New
// Session" row. Clicking a project opens its chat, and the chat is the newest
// session in that folder (a compact replaces it).
export function newestSession(project) {
  // Only the operator's own sessions count. A worker's session is marked internal;
  // a session the engine spawned for a model's `subagent` call carries a parent and
  // no mark of ours — on 13 Nov one was newer than the chat, so clicking the project
  // opened the subagent's transcript (its brief as "You", its interrupted step as the
  // Architect's). The server filters both out of `sessions`; this is the belt.
  const chat = [...(project?.sessions || [])].filter((s) => !s.internal && !s.raw?.parentID);
  // By creation, not by update: the engine touches `updated` for reasons that
  // have nothing to do with the conversation (a policy write at boot), and the
  // chat is the one made last — a compact makes a newer one.
  return (
    chat.sort(
      (a, b) => (b.created || b.updated || 0) - (a.created || a.updated || 0),
    )[0] || null
  );
}

/**
 * Drop the page state that belongs to folders that are no longer projects.
 *
 * A run's trace, its rate and its project-level alarms are keyed by folder, not by
 * session, so deleting a project and making the same folder a project again brought
 * the old runs back — a deleted project's "DESIGNER-1 · t1 · 3s" fold sat above a
 * brand-new conversation (13 Nov, fable_calc). The run log on disk is the history;
 * the rail is not a place to keep a dead folder's evidence.
 */
export function pruneFolderState() {
  const folders = new Set(state.projects.map((p) => dirKey(p.directory)));
  for (const [key, trace] of [...state.traces]) {
    if (trace.dir && !folders.has(dirKey(trace.dir))) state.traces.delete(key);
  }
  for (const key of [...state.rates.keys()]) if (!folders.has(key)) state.rates.delete(key);
  state.alarms = state.alarms.filter((a) => !a.dir || folders.has(dirKey(a.dir)));
}

/** Has this project's conversation been used at all (as opposed to just opened)? */
export function projectUsed(project) {
  const chat = newestSession(project);
  if (!chat) return false;
  const t = chat.raw?.tokens;
  const tokens = (Number(t?.input) || 0) + (Number(t?.output) || 0) + (Number(t?.reasoning) || 0);
  return tokens > 0 || Number(chat.updated || 0) > Number(chat.created || 0) + 1000;
}

export function renderTree() {
  const el = $('projectTree');
  if (!el) return;
  el.innerHTML = state.projects
    .map((p) => {
      const chat = newestSession(p);
      const current = Boolean(chat) && state.view === 'session' && chat.id === state.sessionId;
      const working = Boolean(chat) && sessionWorking(chat.id);
      const waiting = chat ? waitingFor(chat.id) : null;
      const used = projectUsed(p);
      const waitNote =
        waiting === 'answer' ? ' · waiting on your answer' : waiting === 'decision' ? ' · waiting for your decision' : '';
      const title = `${p.name}${working ? ' · working' : ''}${waitNote}${p.exists === false ? ' · folder missing' : ''}`;
      return `<div class="tree-project">
        <div class="tree-row project${current ? ' is-current' : ''}${working ? ' has-work' : ''}${waiting ? ' has-question' : ''}" data-project-row="${esc(p.id)}">
          <button class="tree-open" data-project="${esc(p.id)}" title="${esc(title)}">
            <span class="tree-name">${esc(p.name)}</span>
          </button>
          <span class="tree-actions">
            ${waiting ? `<span class="tree-wait" title="${waiting === 'answer' ? 'Waiting on your answer' : 'Waiting for your decision'}" aria-label="${waiting === 'answer' ? 'Waiting on your answer' : 'Waiting for your decision'}">?</span>` : ''}
            ${liveDot('', { clickable: false, on: working, ok: used && !working, idle: !used && !working })}
            <button class="tree-menu" data-menu-project="${esc(p.id)}" title="Project menu" aria-label="Project menu" aria-haspopup="menu">⋯</button>
          </span>
        </div>
      </div>`;
    })
    .join('');
  renderEmpty();
}

/** The landing panel: it says what to do depending on whether any project exists. */
export function renderEmpty() {
  const note = $('emptyNote');
  if (!note) return;
  note.textContent = state.projects.length
    ? 'Pick a project in the left rail to open its conversation.'
    : 'A project is a folder. Make one and its conversation opens here.';
}

/** A project's one conversation. With no chat yet, the first open makes one. */
export async function openProjectChat(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  if (p.exists === false) {
    toast('Folder Missing', `${p.directory} does not exist, so no conversation can run there.`);
    return;
  }
  const chat = newestSession(p);
  if (chat) {
    await wired.openSession(chat.id);
    return;
  }
  await wired.createChat(p.id);
}

/**
 * Open a project's folder in Explorer, or a command prompt at it. The backend
 * spawns a detached GUI process; nothing here tracks it, and a failure is
 * reported rather than swallowed.
 */
export async function openProjectFolder(id, what) {
  try {
    await api('POST', `/api/projects/${encodeURIComponent(id)}/open`, { what });
  } catch (err) {
    toast(what === 'cmd' ? 'Could Not Open a Command Prompt' : 'Could Not Open the Folder', err.message);
  }
}
