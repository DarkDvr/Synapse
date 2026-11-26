// The model each role runs, and how hard it thinks.
//
// The native <select> per role card is the truth; the picker in
// ./model-picker.js drives it, and this module is what happens when it changes: the
// choice is written to the open project's `.project\roles.json` at once (a role's
// model is not a draft), and the effort chevrons follow the model now selected. The
// server moves the Architect's chat and wakes a worker that was waiting on the old
// model. With no project open, the same choice becomes the config template for the
// next project.
//
// Four things come from app.js and are wired at boot: the model labels, the dialog
// that asks before a role loses its settings, and the cards' activity.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { modelByRef, selectionFor, topEfforts, variantsOf, ROLES, currentProject, dirKey } from './run-view.js';
import { renderTranscript } from './transcript.js';
import { pickers, syncPickerInput } from './model-picker.js';
import { clearRoleRate } from './role-rate-store.js';
import { loadPersona, savePersona, PERSONA_MAX_NAME, PERSONA_MAX_TEXT } from './persona.js';
import { visibleSkills } from './skill-list.js';

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

/** The open session, from the project list the rail already has. */
function sessionNow() {
  const id = state.sessionId;
  if (!id) return null;
  for (const project of state.projects || []) {
    const session = (project.sessions || []).find((s) => s.id === id);
    if (session) return session;
  }
  return null;
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

// A role with no model is said out loud once, not on every redraw: the red border is
// the standing state, and a toast that repeats on every render is noise.
const notedMissing = new Set();
function noteMissingModel(role, ref) {
  const key = `${role}|${ref}`;
  if (notedMissing.has(key)) return;
  notedMissing.add(key);
  const name = ROLES.find((r) => r.id === role)?.name || role;
  toast('No Model for This Role', `${name}: ${ref} is no longer offered. Choose a model before sending.`);
}

export function fillRoleModels() {
  if (state.models.length === 0) return;
  document.querySelectorAll('.role-model').forEach((sel, i) => {
    const role = sel.dataset.role || String(i);
    sel.innerHTML = state.models
      .map((m) => `<option value="${esc(m.ref)}">${esc(wired.modelLabel(m.name))}</option>`)
      .join('');
    // The saved ref is the identity, and it is never replaced silently. But a role
    // whose model its provider no longer lists *cannot run*: the card shows nothing
    // selected and a red border, so the difference between "not right now" and
    // "choose another" is visible without opening the menu. The ref stays in the
    // config until the operator picks a model — the choice is theirs, not ours.
    const chosen = selectionFor(role).ref;
    const known = modelByRef(chosen);
    const gone = Boolean(chosen && !known);
    if (gone) {
      sel.insertAdjacentHTML('afterbegin', '<option value="">No model — choose one</option>');
      sel.classList.add('is-missing');
      sel.value = '';
      sel.title = `${chosen} is no longer offered by its provider. Choose a model for this role.`;
      noteMissingModel(role, chosen);
    } else {
      sel.classList.remove('is-missing');
      // Nothing saved at all is the only case where a model is offered: the first
      // free one, so a fresh install has something selectable rather than a blank.
      const fallback = state.models.find((m) => m.free) || state.models[0];
      sel.value = chosen || fallback.ref;
      sel.title = known ? wired.modelTitle(known) : `Model for the ${role} role`;
    }
    const p = pickers.get(role);
    if (p) {
      syncPickerInput(p.input);
      // syncPickerInput reads the select: with nothing selected it shows the
      // placeholder. The red mark is this module's, because it knows *why*.
      p.input.classList.toggle('is-missing', gone);
      p.input.placeholder = gone ? 'No model — choose one' : 'Search models…';
    }
    renderEffort(role);
  });
}

/** Every role, the Architect included, keeps its model in the project's role set. */
export async function saveRoleSelection(roleId, ref, variant) {
  const project = currentProject();
  if (project?.id) {
    const out = await api('POST', `/api/projects/${encodeURIComponent(project.id)}/roles`, {
      role: roleId,
      ref,
      variant,
    });
    if (out?.roles) project.roles = out.roles;
    if (roleId === 'architect') {
      const session = sessionNow();
      if (session) {
        session.model = ref;
        session.variant = variant || 'default';
      }
    }
    fillRoleModels();
    return true;
  }
  // With no project open the config is the template the next project inherits.
  const draft = JSON.parse(JSON.stringify(state.config || {}));
  // Keep whatever else the entry holds (its skill list, its timeout): changing
  // the model must never quietly wipe the rest of the role's settings.
  const entry = { ...(draft.roles?.[roleId] || {}), ref };
  if (variant) entry.variant = variant;
  else delete entry.variant;
  draft.roles = { ...(draft.roles || {}), [roleId]: entry };
  state.config = await api('PUT', '/api/config', draft);
  return true;
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
  const isPersona = roleId === 'architect' && state.mode === 'single';
  const project = currentProject();
  if (isPersona) {
    if (!project?.id) {
      toast('No Project Open', 'Open a project before giving it a persona.');
      return;
    }
    if (state.personaFor !== project.id) await loadPersona();
  }
  const base = state.config?.roles?.[roleId] || {};
  const persona = isPersona ? state.persona : null;
  const hadPersona = Boolean(persona?.name || persona?.instructions);
  // Single uses the same card dialog as Multi; only the instruction box changes
  // its meaning. Skills stay the role's skills in both modes.
  const entry = isPersona ? { ...base, instructions: persona?.instructions || '' } : base;
  let available = [];
  try {
    available = visibleSkills((await api('GET', '/api/skills')).skills || []);
  } catch (err) {
    toast('Could Not Read the Skills', err.message);
    return;
  }
  const allowed = Array.isArray(entry.skills) ? entry.skills : available.map((s) => s.name);
  if (!available.length) {
    toast('No Skills Available', 'Synapse found no skills in its own folder or yours — see Settings → Tools.');
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
    options: available
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
  if (isPersona) {
    fields.push({
      name: 'personaName',
      type: 'text',
      label: 'Persona name (Single mode only)',
      value: persona?.name || '',
      placeholder: 'Persona Name',
      tip: 'The name on the Architect card in Single mode. Optional; without one the card stays “Architect”.',
    });
  }
  fields.push({
    name: 'instructions',
    type: 'textarea',
    label: isPersona
      ? 'Instructions / Persona for this role (Single mode only)'
      : 'Instructions for this role',
    value: entry.instructions || '',
    placeholder: isPersona ? '' : 'Anything it should remember every turn. Optional.',
    tip: isPersona
      ? 'This replaces the global Architect instructions for this project in Single mode. Multi keeps the global block.'
      : '',
  });
  if (isPersona && persona && (persona.name || persona.instructions)) {
    fields.push({
      name: 'removePersona',
      type: 'check',
      label: 'Remove this persona',
      value: false,
      hint: 'The card returns to “Architect” and Single uses the global Architect instructions again.',
    });
  }

  const result = await wired.openDialog({
    title: `Settings for ${role?.name || roleId}`,
    message:
      roleId === 'qc'
        ? 'Tick a skill to let this role load it; “Required” makes the brief demand it, and the Architect is told if it was skipped. Real use is the default focus: the wording, the clipping and the bad input an ordinary person meets.'
        : isPersona
          ? 'Skills apply in both modes. The instruction box is this project\'s Single-mode persona; Multi keeps the global Architect instructions. With no persona, Single uses the global block.'
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

  const text = String(result.instructions || '').trim();
  const personaName = isPersona
    ? String(result.personaName || '').replace(/\s+/g, ' ').trim()
    : '';
  if (isPersona && personaName.length > PERSONA_MAX_NAME) {
    toast('Name Too Long', `Keep the persona name to ${PERSONA_MAX_NAME} characters or fewer.`);
    return;
  }
  if (isPersona && text.length > PERSONA_MAX_TEXT) {
    toast('Persona Too Long', `Keep the persona instructions to ${PERSONA_MAX_TEXT} characters or fewer.`);
    return;
  }
  const removePersona = isPersona && hadPersona && (result.removePersona === true || (!personaName && !text));

  const draft = JSON.parse(JSON.stringify(state.config || {}));
  draft.roles = { ...(draft.roles || {}) };
  const next = { ...(draft.roles[roleId] || {}) };
  // Store the visible list even when every box is ticked. An absent list means "no
  // restriction", which would also let the engine's hidden desktop skills through —
  // the ones this dialog no longer offers because their tools do not exist here.
  next.skills = result.skills;
  // Required is a subset of allowed, always.
  const mustLoad = (result.mustLoad || []).filter((s) => result.skills.includes(s));
  if (mustLoad.length) next.mustLoad = mustLoad;
  else delete next.mustLoad;
  if (roleId === 'qc') next.focus = result.focus === 'security' ? 'security' : 'app';
  // In Single the instruction box is the project's persona, not the global
  // Architect text. Leave the global entry untouched for Multi.
  if (!isPersona) {
    if (text) next.instructions = text;
    else delete next.instructions;
  }
  draft.roles[roleId] = next;

  try {
    state.config = await api('PUT', '/api/config', draft);
    if (isPersona) {
      if (hadPersona || removePersona || personaName || text) {
        try {
          await savePersona(project.id, removePersona ? null : { name: personaName, instructions: text });
        } catch (err) {
          toast('Could Not Save the Persona', err.message);
          return;
        }
      }
      toast(
        removePersona ? 'Persona Removed' : personaName || text ? 'Persona Saved' : 'Role Saved',
        removePersona
          ? 'Single mode uses the global Architect instructions again. Skills stay saved for both modes.'
          : personaName || text
            ? 'Skills apply in both modes; the persona is Single mode only.'
            : `${role?.name || roleId} settings saved for both modes.`,
      );
    } else {
      toast(
        'Role Saved',
        `${role?.name || roleId}${roleId === 'qc' ? ` · ${next.focus === 'security' ? 'security' : 'real use'}` : ''}.`,
      );
    }
    // The ruleset follows the mode at the next send, so a changed skill list
    // reaches the chat then — no separate PATCH, and nothing to go stale.
  } catch (err) {
    toast('Could Not Save the Role', err.message);
  }
}

export async function setRoleModel(roleId, ref) {
  const role = ROLES.find((r) => r.id === roleId);
  const current = selectionFor(roleId).variant;
  const variant = topEfforts(modelByRef(ref)).some((v) => v.id === current) ? current : '';
  const select = document.querySelector(`#topology .role-model[data-role="${CSS.escape(roleId)}"]`);
  const picker = pickers.get(roleId);
  const input = picker?.input;
  // A choice that has not reached the project file does not look applied yet. The
  // breathing stops the moment the save returns, whether it succeeded or failed.
  input?.classList.add('is-saving');
  select?.classList.add('is-saving');
  try {
    await saveRoleSelection(roleId, ref, variant);
    // A speed belongs to the model it was measured on. The old model's figure must
    // not reappear here or on another project's card (16 Nov).
    clearRoleRate(roleId);
    // Keep the card's own select in step: renderRoleActivity reads the refused
    // mark from it, and a stale value would keep the old model's red line.
    if (select) select.value = ref;
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
      toast('Model for Architect', currentProject() ? 'Saved for this project.' : 'Saved for new chats.');
    } else {
      // Honest about the one case where changing the model is not a fix: the new
      // model carries a provider or tools mark of its own.
      const marked = (modelByRef(ref)?.issues || []).some((i) => i.kind === 'provider' || i.kind === 'tools');
      const scope = currentProject() ? 'Saved for this project.' : 'Saved for new projects.';
      toast(
        `Model for ${role?.name || roleId}`,
        marked
          ? `${scope} This model still carries an issue mark — the picker shows why.`
          : `${scope} It can take tasks again.`,
      );
    }
  } catch (err) {
    toast('Could not save the role model', err.message);
  } finally {
    input?.classList.remove('is-saving');
    select?.classList.remove('is-saving');
  }
}

// default → 1 chevron → 2 → 3 → back to default. Keeping the default reachable
// matters: it is the engine's own choice, not an absence of one.
export async function cycleEffort(roleId) {
  const sel = document.querySelector(`.role-model[data-role="${roleId}"]`);
  const btn = document.querySelector(`.role-effort[data-role="${roleId}"]`);
  if (!btn || btn.disabled || !sel?.value) return;
  const ids = topEfforts(modelByRef(sel.value)).map((v) => v.id);
  if (ids.length === 0) return;
  const idx = ids.indexOf(selectionFor(roleId).variant);
  const next = idx === -1 ? ids[0] : idx < ids.length - 1 ? ids[idx + 1] : '';
  const picker = pickers.get(roleId);
  const input = picker?.input;
  input?.classList.add('is-saving');
  sel.classList.add('is-saving');
  try {
    await saveRoleSelection(roleId, sel.value, next);
    renderEffort(roleId);
  } catch (err) {
    toast('Could not save the thinking effort', err.message);
  } finally {
    input?.classList.remove('is-saving');
    sel.classList.remove('is-saving');
  }
}
