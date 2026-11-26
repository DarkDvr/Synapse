// The Architect's Single-mode persona: a project's own name and voice.
//
// The role never changes. `architect` is still the id, the model picker and the
// permissions; only the card's label and the Single-mode brief change. Multi
// ignores this file entirely, which is why the editor here is only ever opened
// from Single.
import { state } from './state.js';
import { api } from './api.js';
import { esc } from './format.js';
import { currentProject } from './run-view.js';
import { openDialog } from './dialog.js';
import { toast } from './toast.js';
import { setIcon } from './icons.js';

// Mirrors src/project-persona.js. The page imports no server module: the limits
// are small enough to name here, and the server enforces them again on save.
const PERSONA_MAX_NAME = 40;
const PERSONA_MAX_TEXT = 2000;

let loading = null;
let loadingFor = '';

const pathFor = (id) => `/api/projects/${encodeURIComponent(id)}/persona`;

/** The name the Architect card carries in the current mode. */
export function architectLabel() {
  if (state.mode === 'single' && state.persona?.name) return `${state.persona.name} (Architect)`;
  return 'Architect';
}

/** Put the persona name, and its person mark, on the Architect card. */
export function renderPersonaCard() {
  if (typeof document === 'undefined') return;
  const card = document.querySelector('#topology .topo-architect .role-card');
  const h3 = card?.querySelector('.role-head h3');
  if (!h3) return;
  const label = architectLabel();
  const named = Boolean(state.mode === 'single' && state.persona?.name);
  const key = `${named ? 'persona' : 'role'}\u0000${label}`;
  if (h3._personaKey !== key) {
    h3._personaKey = key;
    h3.innerHTML = `${named ? setIcon('person') : ''}${esc(label)}`;
    h3.title = named ? `Single-mode persona for this project: ${state.persona.name}` : '';
  }
  const edit = card.querySelector('.ic-edit');
  if (edit) {
    const title = state.mode === 'single' ? 'Persona for this project' : 'Settings for this role';
    if (edit.title !== title) edit.title = title;
    if (edit.getAttribute('aria-label') !== title) edit.setAttribute('aria-label', title);
  }
}

/**
 * Read the open project's persona once. A stale name from the previous project
 * is cleared before the request, so a switch cannot paint it under the new chat.
 */
export async function loadPersona({ force = false } = {}) {
  const project = currentProject();
  if (!project?.id) {
    state.persona = null;
    state.personaFor = null;
    renderPersonaCard();
    return null;
  }
  const id = String(project.id);
  if (!force && loading && loadingFor === id) return loading;
  if (!force && state.personaFor === id) {
    renderPersonaCard();
    return state.persona;
  }
  state.persona = null;
  state.personaFor = id;
  renderPersonaCard();
  loadingFor = id;
  loading = (async () => {
    try {
      const out = await api('GET', pathFor(id));
      if (currentProject()?.id !== id) return null;
      state.persona = out?.persona || null;
    } catch {
      // No persona, a private view, or an older server: all mean "no persona".
      if (currentProject()?.id === id) state.persona = null;
    } finally {
      if (loadingFor === id) loading = null;
      if (currentProject()?.id === id) {
        state.personaFor = id;
        renderPersonaCard();
      }
    }
    return state.persona;
  })();
  return loading;
}

/** Drop the card's name when the chat or the project closes. */
export function clearPersonaState() {
  state.persona = null;
  state.personaFor = null;
  renderPersonaCard();
}

/**
 * The ✎ dialog in Single mode.
 *
 * It edits the project only. The global Architect instructions are in Multi's
 * dialog, and the message here says so; an empty save is a removal.
 */
export async function editPersona() {
  if (state.mode !== 'single') return;
  const project = currentProject();
  if (!project?.id) {
    toast('No Project Open', 'Open a project before giving it a persona.');
    return;
  }
  const entry = state.persona || {};
  const fields = [
    {
      name: 'name',
      type: 'text',
      label: 'Name',
      value: entry.name || '',
      placeholder: 'Vekra',
      hint: 'The name on the Architect card. One line, up to 40 characters.',
    },
    {
      name: 'instructions',
      type: 'textarea',
      label: 'Persona instructions',
      value: entry.instructions || '',
      placeholder: 'You are Vekra, the Architect for this project. Call me Andrew. Strict and professional about the work, dryly playful with me...',
      hint: 'Single mode only. This replaces the global Architect instructions for this project; Multi ignores it.',
    },
  ];
  if (entry.name || entry.instructions) {
    fields.push({
      name: 'remove',
      type: 'check',
      label: 'Remove this persona',
      value: false,
      hint: 'The card returns to “Architect” and Single uses the global instructions again.',
    });
  }

  let result;
  try {
    result = await openDialog({
      title: entry.name ? `Persona for ${entry.name}` : 'Persona for this project',
      message: entry.name || entry.instructions
        ? 'This is the voice the Architect uses in Single mode. Multi never sees it. Saving replaces the global Architect instructions for this project.'
        : 'This project currently uses the global Architect instructions. A persona gives it its own name and voice in Single mode, replacing that block here. Multi is unaffected.',
      fields,
      confirmLabel: entry.name || entry.instructions ? 'Save' : 'Create',
    });
  } catch (err) {
    toast('Could Not Open the Persona', err.message);
    return;
  }
  if (!result) return;

  if (result.remove) {
    await savePersona(project.id, null);
    return;
  }
  const name = String(result.name || '').replace(/\s+/g, ' ').trim();
  const instructions = String(result.instructions || '').trim();
  if (name.length > PERSONA_MAX_NAME) {
    toast('Name Too Long', `Keep the name to ${PERSONA_MAX_NAME} characters or fewer.`);
    return;
  }
  if (instructions.length > PERSONA_MAX_TEXT) {
    toast('Persona Too Long', `Keep the instructions to ${PERSONA_MAX_TEXT} characters or fewer.`);
    return;
  }
  if (!name && !instructions) {
    await savePersona(project.id, null);
    return;
  }
  await savePersona(project.id, { name, instructions });
}

async function savePersona(projectId, body) {
  try {
    const out = await api('PUT', pathFor(projectId), body || { name: '', instructions: '' });
    state.persona = out?.persona || null;
    state.personaFor = projectId;
    renderPersonaCard();
    toast(state.persona ? 'Persona Saved' : 'Persona Removed', state.persona
      ? 'Single mode will use this voice. Multi keeps the global Architect instructions.'
      : 'Single mode will use the global Architect instructions again.');
  } catch (err) {
    toast('Could Not Save the Persona', err.message);
  }
}
