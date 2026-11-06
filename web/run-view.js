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
  { id: 'coder-1', name: 'Coder 1' },
  { id: 'coder-2', name: 'Coder 2' },
  { id: 'coder-3', name: 'Coder 3' },
  { id: 'qc', name: 'QC' },
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

export function selectionFor(roleId) {
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

/**
 * The engine emits one assistant message per *step* — a reasoning turn, a tool
 * call, another reasoning turn — not one per conversational turn. Rendering
 * them raw gave a three-question chat fourteen "Architect" headers. Consecutive
 * assistant messages belong to the same turn, so merge them into one block: one
 * header, the steps in order, and the answer panels amongst them.
 */
export function groupTurns(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.type === 'assistant' && prev?.type === 'assistant') {
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

/** The form waiting on the operator.
 *
 *  The open session's own form wins, but any pending form is shown: a hidden
 *  worker session has the same toolset, and if one of those asks something the
 *  operator has to be able to answer it — otherwise the worker sits there until
 *  its timeout reports a failure nobody could see coming. The head says which.
 */
export const currentForm = () => {
  const forms = state.forms || [];
  return forms.find((f) => f.sessionId === state.sessionId) || forms[0] || null;
};
