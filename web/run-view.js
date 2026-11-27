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

/** The project whose chat is on screen. */
function projectOnScreen() {
  const id = state.sessionId;
  if (!id) return null;
  return (state.projects || []).find((p) => (p.sessions || []).some((s) => s.id === id)) || null;
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

/** The project that chat belongs to, for inheritance while no chat is open. */
function latestProject() {
  const session = latestSession();
  if (!session) return null;
  return (state.projects || []).find((p) => (p.sessions || []).some((s) => s.id === session.id)) || null;
}

export function selectionFor(roleId) {
  // Every role's model belongs to the project. The project's `roles.json` is the
  // source; the config's role is only the template for a project that has never
  // written that role. With no chat open, the newest project supplies the set a
  // new project will inherit.
  const project = projectOnScreen() || (!state.sessionId ? latestProject() : null);
  const saved = project?.roles?.[roleId];
  if (saved?.ref) {
    return {
      ref: saved.ref,
      variant: saved.variant && saved.variant !== 'default' ? saved.variant : '',
    };
  }
  // Projects written before roles.json keep their Architect session model.
  if (roleId === 'architect') {
    const session = project
      ? (project.sessions || []).find((s) => s.id === state.sessionId) || latestSession()
      : latestSession();
    if (session?.model) {
      return {
        ref: session.model,
        variant: session.variant && session.variant !== 'default' ? session.variant : '',
      };
    }
  }
  return asSelection(state.config?.roles?.[roleId]) || { ref: '', variant: '' };
}

/**
 * What a newly created chat should put in a role before it exists.
 *
 * The project's own choice wins while its model is still offered. If it is not —
 * the usual case after a provider is removed — the newest project that used a
 * model this catalog still offers supplies it, role by role, rather than copying
 * a dead ref into a new project and making every card say "No model".
 */
export function seedSelection(roleId) {
  const models = Array.isArray(state.models) ? state.models : [];
  const offered = new Set(models.map((m) => String(m?.ref || '')).filter(Boolean));
  const usable = (entry) => {
    const sel = asSelection(entry);
    return sel?.ref && offered.has(sel.ref) ? sel : null;
  };
  const current = usable(selectionFor(roleId));
  if (current) return current;
  if (!offered.size) return asSelection(selectionFor(roleId));
  const recency = (project) =>
    Math.max(0, ...(project?.sessions || []).map((s) => Number(s?.updated) || 0));
  const projects = [...(state.projects || [])].sort((a, b) => recency(b) - recency(a));
  for (const project of projects) {
    const found = usable(project?.roles?.[roleId]);
    if (found) return found;
  }
  const configured = usable(state.config?.roles?.[roleId]);
  if (configured) return configured;
  const fallback = models.find((m) => m.free) || models[0];
  return fallback?.ref ? { ref: fallback.ref, variant: '' } : null;
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
