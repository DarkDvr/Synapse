// What the page knows about the run on screen: the seven roles, which model each one
// has, which project and run are open, and the two shapes the transcript needs (the
// engine's one-message-per-step turns merged, and the form waiting on the operator).
//
// It is one file because the answers are one subject. The renderers, the role cards
// and the rate corner all ask the same questions — "whose run is this", "what model
// is behind this ref", "what is this role called" — and before this they asked
// app.js, which is why none of them could leave.
import { state } from './state.js';

// Orchestration roles. These ids key the per-role model choices in the config
// file and label the cards. Every chat message goes to the Architect — the
// composer has no target picker; the philosophy is one interface, one lead.
export const ROLES = [
  { id: 'architect', name: 'Architect' },
  { id: 'inventor', name: 'Inventor' },
  { id: 'designer', name: 'Designer' },
  { id: 'qc', name: 'QC' },
  { id: 'coder-1', name: 'Coder 1' },
  { id: 'coder-2', name: 'Coder 2' },
];

// Every role — the Architect included — stores its own selection as
// { ref, variant } under `roles[id]` in the config file. An empty variant means
// the engine's own default (recorded as "default"). Selecting a model does not
// imply an effort: the operator picks that with the chevron button.
export const asSelection = (spec) => {
  if (!spec) return null;
  if (typeof spec === 'string') return { ref: spec, variant: '' };
  if (typeof spec === 'object' && typeof spec.ref === 'string') {
    return { ref: spec.ref, variant: String(spec.variant || '') };
  }
  return null;
};

export const modelByRef = (ref) => state.models.find((m) => m.ref === ref) || null;
export const variantsOf = (model) =>
  Array.isArray(model?.variants)
    ? model.variants
        .map((v) => (typeof v === 'string' ? { id: v, label: v } : { id: String(v?.id ?? ''), label: String(v?.label ?? v?.id ?? '') }))
        .filter((v) => v.id)
    : [];
// The chevron button exposes the three highest efforts a model allows, in
// ascending order: Cat Jam Free → high, xhigh, max; DeepSeek → low, high, max.
export const topEfforts = (model) => variantsOf(model).slice(-3);

/**
 * The session on screen, from the project list the rail already has.
 *
 * `selectionFor` needs the open session's own model: a project keeps its Architect
 * there, and the config's `roles.architect` is only the fallback for a chat that
 * has no model yet. The lookup is local because projects.js imports this module.
 */
function sessionOnScreen() {
  const id = state.sessionId;
  if (!id) return null;
  for (const project of state.projects || []) {
    const session = (project.sessions || []).find((s) => s.id === id);
    if (session) return session;
  }
  return null;
}

/** The most recently used project chat, for when no chat is open. */
function latestSession() {
  let best = null;
  for (const project of state.projects || []) {
    for (const session of project.sessions || []) {
      if (!session?.model || session.internal) continue;
      if (!best || Number(session.updated || 0) > Number(best.updated || 0)) best = session;
    }
  }
  return best;
}

export function selectionFor(roleId) {
  // The Architect's model belongs to the project's one chat. Switching projects
  // must show that project's model, not whichever role was changed last in the
  // config (23 Nov). Worker roles remain config choices until they have a
  // project-scoped home of their own.
  if (roleId === 'architect') {
    const session = sessionOnScreen() || (!state.sessionId ? latestSession() : null);
    if (session?.model) {
      return {
        ref: session.model,
        variant: session.variant && session.variant !== 'default' ? session.variant : '',
      };
    }
  }
  return asSelection(state.config?.roles?.[roleId]) || { ref: '', variant: '' };
}

/** The Architect is a role like any other — no "default model" exists. */
export function architectSelection() {
  const sel = selectionFor('architect');
  if (!sel.ref) return null;
  // The chevron control only expresses the three highest efforts, so a stored
  // value it cannot show is dropped here too — the session must not run an
  // effort the button claims is not set.
  const model = modelByRef(sel.ref);
  const variant = topEfforts(model).some((v) => v.id === sel.variant) ? sel.variant : '';
  return { ref: sel.ref, variant };
}

export const fmtTokens = (n) =>
  !n ? '' : n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

export const projectOf = (sessionId) => state.projects.find((p) => p.sessions.some((s) => s.id === sessionId)) || null;

export function currentProject() {
  return projectOf(state.sessionId);
}

export const dirKey = (d) => String(d ?? '').replace(/[\\/]+$/, '').toLowerCase();
export const runIn = (project) => (project ? state.runs.get(dirKey(project.directory)) || null : null);
export const currentRun = () => runIn(currentProject());
export const roleLabel = (id) => ROLES.find((r) => r.id === id)?.name || String(id || '');

// ── what belongs to a chat ──────────────────────────────────────
// A chat is one project, and a project is one directory: that is the key. Every
// card, question, stop and "is it working" answer belongs to exactly one chat, and
// these are the one set of functions that decides which. They exist because a page
// with two chats open must never draw one's ask in the other (20 Nov) — and because
// a worker's ask was looked up by *session*, so a hidden worker's card never marked
// its project in the rail.
export const chatDir = () => dirKey(currentProject()?.directory || '');

/** The chat an ask belongs to: its own directory, else the session that asked. */
export function askDir(ask) {
  if (ask?.directory) return dirKey(ask.directory);
  const sessionId = ask?.sessionId;
  if (!sessionId) return '';
  const project = projectOf(sessionId);
  if (project) return dirKey(project.directory);
  // A worker's session is not in the project list (the server hides scaffolding).
  // Its run record carries the directory, which is the same fact.
  for (const run of state.runs?.values?.() || []) {
    if (run && (run.workerId === sessionId || run.architect === sessionId)) return dirKey(run.dir);
  }
  return '';
}

export const inChat = (ask, dir = chatDir()) => {
  if (!dir) return false;
  const at = askDir(ask);
  if (at) return at === dir;
  // An ask that cannot name a chat is drawn in the open one rather than lost: the
  // tool that asked is blocked until it is answered, and "no card anywhere" is worse
  // than "in the chat you are looking at". Only the browser can ask without a
  // project, and its server normally knows the folder it was started in.
  return ask?.scope === 'browser';
};

/** Is this directory the chat on screen? For events that carry only a folder. */
export const sameChat = (dir) => Boolean(dir) && chatDir() === dirKey(dir);

/** The cards and questions waiting in this chat, and nowhere else. */
export const permissionsHere = (dir = chatDir()) => (state.permissions || []).filter((p) => inChat(p, dir));
export const formsHere = (dir = chatDir()) => (state.forms || []).filter((f) => inChat(f, dir));

/**
 * What a directory's chat is waiting on: 'answer', 'decision', or null.
 *
 * The rail asks this by directory. By session it missed a hidden worker asking in
 * the same project, which is exactly the case the mark exists for.
 */
export function waitingIn(dir) {
  const key = dirKey(dir);
  if (!key) return null;
  if ((state.forms || []).some((f) => askDir(f) === key)) return 'answer';
  if ((state.permissions || []).some((p) => askDir(p) === key)) return 'decision';
  return null;
}

/**
 * The engine emits one assistant message per *step* — a reasoning turn, a tool
 * call, another reasoning turn — not one per conversational turn. Rendering
 * them raw gave a three-question chat fourteen "Architect" headers. Consecutive
 * assistant messages belong to the same turn, so merge them into one block: one
 * header, the steps in order, and the answer panels amongst them.
 *
 * `breakBefore` holds message ids a merged turn must not swallow: a transcript
 * alarm between two steps is anchored to the step where it happened, and a merge
 * across it would leave the line under the whole turn (15 Nov).
 */
export function groupTurns(messages, { breakBefore = new Set() } = {}) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.type === 'assistant' && prev?.type === 'assistant' && !breakBefore.has(m.id)) {
      prev.parts = [...(prev.parts || []), ...(m.parts || [])];
      prev.text = `${prev.text || ''}${m.text || ''}`;
      prev.error = prev.error || m.error;
      prev.completed = m.completed || prev.completed;
      continue;
    }
    out.push({ ...m, parts: m.parts ? [...m.parts] : m.parts });
  }
  return out;
}

/** The form waiting on the operator **in this chat**.
 *
 *  The open session's own form wins, but a form from a worker in the same project
 *  is shown too: a hidden worker runs in the same chat, and if it asks something
 *  the operator has to be able to answer it — otherwise the worker sits there until
 *  its timeout reports a failure nobody could see coming. Another chat's question
 *  is not this chat's, and is announced in the rail and a toast instead.
 */
export const currentForm = () => {
  const chat = formsHere();
  return chat.find((f) => f.sessionId === state.sessionId) || chat[0] || null;
};
