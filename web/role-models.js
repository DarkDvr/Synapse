// The model each role runs, and how hard it thinks.
//
// The native <select> per role card is the truth; the picker in
// ./model-picker.js drives it, and this module is what happens when it changes: the
// choice is saved to the config at once (a role's model is not a draft), the effort
// chevrons follow the model that is now selected, and the Architect's own model is
// pushed to the session so the next turn uses it.
//
// Four things come from app.js and are wired at boot: the model labels, the dialog
// that asks before a role loses its settings, and the cards' activity.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { modelByRef, selectionFor, topEfforts, variantsOf, ROLES, architectSelection, currentProject } from './run-view.js';
import { hiddenProviderIds } from './provider-list.js';
import { renderTranscript } from './transcript.js';
import { pickers, syncPickerInput } from './model-picker.js';

const missing = (name) => () => {
  throw new Error(`role-models.js: ${name} was not wired at boot`);
};
const wired = {
  modelLabel: missing('modelLabel'),
  modelTitle: missing('modelTitle'),
  openDialog: missing('openDialog'),
  renderRoleActivity: missing('renderRoleActivity'),
};

/** Hand this module the four things that live in app.js. Called once, at boot. */
export function roleModelsWiring(fns) {
  Object.assign(wired, fns);
}

// One model picker and one thinking-effort button per role card. The model
// change is stored in the config file; the Architect's copy is also applied to
// the open session immediately, while worker selections wait for the
// orchestration layer to spawn their sessions.
// One SVG per effort level, drawn as evenly spaced stroked chevrons. Three
// separate SVGs with fractional negative margins rounded unevenly (the gaps
// looked different), so the whole glyph is one SVG with integer geometry.
export function effortChevrons(level) {
  const step = 4.4;
  const paths = Array.from({ length: level }, (_, i) => {
    const y = 5 + i * step;
    return `<path d="M1 ${y} L5 ${(y - 3.7).toFixed(1)} L9 ${y}"/>`;
  }).join('');
  const height = 5 + (level - 1) * step + 1.2;
  return (
    `<svg class="effort-chev" viewBox="0 0 10 ${height.toFixed(1)}" width="10" height="${height.toFixed(1)}" ` +
    'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
    `aria-hidden="true">${paths}</svg>`
  );
}

export function renderEffort(roleId) {
  const sel = document.querySelector(`.role-model[data-role="${roleId}"]`);
  const btn = document.querySelector(`.role-effort[data-role="${roleId}"]`);
  if (!btn) return;
  const model = modelByRef(sel?.value);
  const top = topEfforts(model);
  // A stored effort that is not one of the three the button offers shows as
  // default; the next click (or save) writes a value the control can express.
  const saved = selectionFor(roleId).variant;
  const idx = top.findIndex((v) => v.id === saved);
  const level = idx >= 0 ? idx + 1 : 0;
  // the provider's own label (reasoningEffort), not just our id
  const label = idx >= 0 ? top[idx].label : 'default';

  btn.disabled = top.length === 0;
  btn.dataset.level = String(level);
  btn.innerHTML = level
    ? `<span class="effort-glyph">${effortChevrons(level)}</span>`
    : '<span class="effort-glyph"><span class="effort-auto"></span></span>';
  const tools = Array.isArray(model?.tools) && model.tools.length ? ` · ${model.tools.length} tools` : '';
  btn.title = top.length
    ? `Current thinking effort: ${label}${tools}`
    : `No thinking-effort control for ${model?.name || 'this model'}${tools}`;
  btn.setAttribute('aria-label', btn.title);
}

export function fillRoleModels() {
  if (state.models.length === 0) return;
  document.querySelectorAll('.role-model').forEach((sel, i) => {
    const role = sel.dataset.role || String(i);
    sel.innerHTML = state.models
      .map((m) => `<option value="${esc(m.ref)}">${esc(wired.modelLabel(m.name))}</option>`)
      .join('');
    // The saved ref is the identity, and it is never replaced. A role whose model
    // is missing from the catalog *right now* — a provider had a bad minute, its
    // key was refused, the engine was restarting — keeps its own ref in an option
    // of its own, marked as missing. This used to fall back to another model by
    // position in the list, which is how the Architect's card came back showing a
    // DeepSeek from a different provider: same name, different source, and the
    // picker's value is what a later save would have written.
    const chosen = selectionFor(role).ref;
    const known = modelByRef(chosen);
    if (chosen && !known) {
      const id = String(chosen).split('/').pop();
      // Two reasons a saved model is not in the list, and they read differently: it
      // left the engine's catalog, or the operator removed its provider in Settings.
      // Either way the ref is kept — the choice is not replaced by a neighbour.
      const hidden = hiddenProviderIds().has(String(chosen).split('/')[0]);
      sel.insertAdjacentHTML(
        'beforeend',
        `<option value="${esc(chosen)}">${esc(id)} — ${hidden ? 'hidden in Settings' : 'not in the catalog'}</option>`,
      );
    }
    // Nothing saved at all is the only case where a model is offered: the first
    // free one, so a fresh install has something selectable rather than a blank.
    const fallback = state.models.find((m) => m.free) || state.models[0];
    sel.value = chosen || fallback.ref;
    sel.title = known
      ? wired.modelTitle(known)
      : chosen
        ? `${chosen} is ${hiddenProviderIds().has(String(chosen).split('/')[0]) ? 'from a provider hidden in Settings' : "not in the engine's catalog right now"} — the choice is kept, not replaced`
        : `Model for the ${role} role`;
    const p = pickers.get(role);
    if (p) syncPickerInput(p.input);
    renderEffort(role);
  });
}

/** Every role, the Architect included, keeps its own persisted selection. */
export async function saveRoleSelection(roleId, ref, variant) {
  const draft = JSON.parse(JSON.stringify(state.config || {}));
  // Keep whatever else the entry holds (its skill list, its timeout): changing
  // the model must never quietly wipe the rest of the role's settings.
  const entry = { ...(draft.roles?.[roleId] || {}), ref };
  if (variant) entry.variant = variant;
  else delete entry.variant;
  draft.roles = { ...(draft.roles || {}), [roleId]: entry };
  state.config = await api('PUT', '/api/config', draft);
}

/**
 * The ✎ button: which skills this role may load.
 *
 * The list is enforced at the engine, not merely written down — a role with a
 * list gets every skill denied and its own ones allowed, so an unticked skill is
 * genuinely refused (measured on 2.0.30). Ticking nothing is saved as an empty
 * list, which means "no skills at all", and the dialog says so.
 */
export async function editRoleSettings(roleId) {
  const role = ROLES.find((r) => r.id === roleId);
  const entry = state.config?.roles?.[roleId] || {};
  let installed = [];
  try {
    installed = (await api('GET', '/api/skills')).skills || [];
  } catch (err) {
    toast('Could Not Read the Skills', err.message);
    return;
  }
  const allowed = Array.isArray(entry.skills) ? entry.skills : installed.map((s) => s.name);
  if (!installed.length) {
    toast('No Skills Available', 'Synapse found no skills in its own folder or yours — see Settings → Skills.');
    return;
  }
  // A name the role expects but this machine cannot load is shown rather than
  // dropped in silence: keeping it is a valid choice (it works again once the
  // skill is installed), and unticking it is the clean way to drop the reference.
  const missingHere = (state.skillsInfo?.missing || []).filter((m) => m.roles.includes(roleId));
  const fields = [];
  // QC's dial is the one role-specific setting: the same role, at two very
  // different volumes. `app` is the default because an ordinary person meeting
  // the build is what finds the wording defects and the clipped layouts.
  if (roleId === 'qc') {
    fields.push({
      name: 'focus',
      type: 'select',
      label: 'How hard should it push?',
      value: entry.focus === 'security' ? 'security' : 'app',
      options: [
        { v: 'app', l: 'Real use — confusing wording, clipping, bad input, states that lie' },
        { v: 'security', l: 'Security — hunt for a way in, hostile input, break out' },
      ],
    });
  }
  fields.push({
    name: 'skills',
    type: 'skills',
    label: 'Skills — tick to allow, “Required” to make the brief demand it',
    options: installed
      .map((s) => ({ v: s.name, l: s.name, hint: s.description }))
      .concat(
        missingHere.map((m) => ({
          v: m.name,
          l: m.name,
          hint: 'Not installed on this machine — the reference is kept, but nothing loads.',
        })),
      )
      .map((o) => ({
        ...o,
        allowed: allowed.includes(o.v),
        must: (entry.mustLoad || []).includes(o.v),
      })),
  });
  fields.push({
    name: 'instructions',
    type: 'textarea',
    label: 'Instructions for this role',
    value: entry.instructions || '',
    placeholder: 'Anything it should remember every turn. Optional.',
  });

  const result = await wired.openDialog({
    title: `Settings for ${role?.name || roleId}`,
    message:
      roleId === 'qc'
        ? 'Tick a skill to let this role load it; “Required” makes the brief demand it, and the Architect is told if it was skipped. Real use is the default focus: the wording, the clipping and the bad input an ordinary person meets.'
        : 'Tick a skill to let this role load it; “Required” makes the brief demand it, and the Architect is told if it was skipped. Instructions are added to what the role is told on every turn.',
    fields,
    confirmLabel: 'Save',
    afterRender: () => {
      // The required box follows the allowed one: unticking a skill clears and
      // disables it, so a required skill can never be one the engine refuses.
      const body = $('dialogBody');
      body.addEventListener('change', (e) => {
        const allow = e.target.closest?.('input[data-skill-allow]');
        if (!allow) return;
        const must = body.querySelector(`input[data-skill-must="${CSS.escape(allow.dataset.skillAllow)}"]`);
        if (!must) return;
        must.disabled = !allow.checked;
        if (!allow.checked) must.checked = false;
      });
    },
  });
  if (!result || !Array.isArray(result.skills)) return;

  const draft = JSON.parse(JSON.stringify(state.config || {}));
  draft.roles = { ...(draft.roles || {}) };
  const next = { ...(draft.roles[roleId] || {}) };
  // Ticking everything means "no restriction", which is exactly what an absent
  // list says — and it lets a skill added next month reach this role without the
  // operator coming back to tick it.
  if (result.skills.length === installed.length) delete next.skills;
  else next.skills = result.skills;
  // Required is a subset of allowed, always.
  const mustLoad = (result.mustLoad || []).filter((s) => result.skills.includes(s));
  if (mustLoad.length) next.mustLoad = mustLoad;
  else delete next.mustLoad;
  if (roleId === 'qc') next.focus = result.focus === 'security' ? 'security' : 'app';
  const text = String(result.instructions || '').trim();
  if (text) next.instructions = text;
  else delete next.instructions;
  draft.roles[roleId] = next;

  try {
    state.config = await api('PUT', '/api/config', draft);
    toast(
      'Role Saved',
      `${role?.name || roleId}${roleId === 'qc' ? ` · ${next.focus === 'security' ? 'security' : 'real use'}` : ''}.`,
    );
    // The ruleset follows the mode at the next send, so a changed skill list
    // reaches the chat then — no separate PATCH, and nothing to go stale.
  } catch (err) {
    toast('Could Not Save the Role', err.message);
  }
}

/** Push the Architect's current model + effort onto the open session. */
export async function applyArchitectModel() {
  const model = architectSelection();
  if (!model || !state.sessionId) return;
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/model`, { model });
  } catch (err) {
    toast('Could Not Switch the Chat Model', err.message);
  }
}

export async function setRoleModel(roleId, ref) {
  const role = ROLES.find((r) => r.id === roleId);
  const current = selectionFor(roleId).variant;
  const variant = topEfforts(modelByRef(ref)).some((v) => v.id === current) ? current : '';
  try {
    await saveRoleSelection(roleId, ref, variant);
    // Keep the card's own select in step: renderRoleActivity reads the refused
    // mark from it, and a stale value would keep the old model's red line.
    const select = document.querySelector(`#topology .role-model[data-role="${CSS.escape(roleId)}"]`);
    if (select) select.value = ref;
    const picker = pickers.get(roleId);
    if (picker) syncPickerInput(picker.input);
    renderEffort(roleId);
    // A model change is the operator saying "this role is fixed". Three things
    // that were about the old model go with it: the red provider line on the
    // card, and the project hold that refuses every delegation after a Stop. The
    // hold is per project, so only the project on screen is lifted.
    const dir = currentProject()?.directory || '';
    if (dir) {
      state.roleErrors.delete(`${dirKey(dir)}|${roleId}`);
      api('POST', '/api/runs/resume', { dir }).catch(() => {});
      wired.renderRoleActivity();
    }
    // first time this model is chosen, learn its toolset in the background;
    // the server answers from cache and never probes the same model twice
    api('POST', '/api/models/inspect', { ref }).catch(() => {});
    if (roleId === 'architect') {
      await applyArchitectModel();
      toast('Model for Architect', state.sessionId ? 'Saved and applied to this chat.' : 'Saved for new chats.');
    } else {
      // Honest about the one case where changing the model is not a fix: the new
      // model carries a provider or tools mark of its own.
      const marked = (modelByRef(ref)?.issues || []).some((i) => i.kind === 'provider' || i.kind === 'tools');
      toast(
        `Model for ${role?.name || roleId}`,
        marked
          ? 'Saved. This model still carries an issue mark — the picker shows why.'
          : 'Saved. It can take tasks again.',
      );
    }
  } catch (err) {
    toast('Could not save the role model', err.message);
  }
}

// default → 1 chevron → 2 → 3 → back to default. Keeping the default reachable
// matters: it is the engine's own choice, not an absence of one.
export async function cycleEffort(roleId) {
  const sel = document.querySelector(`.role-model[data-role="${roleId}"]`);
  const btn = document.querySelector(`.role-effort[data-role="${roleId}"]`);
  if (!btn || btn.disabled) return;
  const ids = topEfforts(modelByRef(sel?.value)).map((v) => v.id);
  if (ids.length === 0) return;
  const idx = ids.indexOf(selectionFor(roleId).variant);
  const next = idx === -1 ? ids[0] : idx < ids.length - 1 ? ids[idx + 1] : '';
  try {
    await saveRoleSelection(roleId, sel.value, next);
    renderEffort(roleId);
    if (roleId === 'architect') await applyArchitectModel();
  } catch (err) {
    toast('Could not save the thinking effort', err.message);
  }
}
