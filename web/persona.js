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
import { setIcon } from './icons.js';

// Mirrors src/project-persona.js. The page imports no server module: the limits
// are small enough to name here, and the server enforces them again on save.
export const PERSONA_MAX_NAME = 40;
export const PERSONA_MAX_TEXT = 2000;

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
  const hasPersona = Boolean(
    state.mode === 'single' && (state.persona?.name || state.persona?.instructions),
  );
  const key = `${hasPersona ? 'persona' : 'role'}\u0000${label}`;
  if (h3._personaKey !== key) {
    h3._personaKey = key;
    h3.innerHTML = `${hasPersona ? setIcon('person') : ''}${esc(label)}`;
    h3.title = hasPersona
      ? `Single-mode persona for this project${state.persona?.name ? `: ${state.persona.name}` : ''}`
      : '';
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
 * Save the open project's persona. The dialog itself lives with the role
 * settings, because Single and Multi share one ✎; this is only the storage half.
 *
 * It updates the card immediately and returns the saved persona (or null). The
 * caller owns the toast, so a skills save and a persona save report once.
 */
export async function savePersona(projectId, body) {
  const out = await api('PUT', pathFor(projectId), body || { name: '', instructions: '' });
  state.persona = out?.persona || null;
  state.personaFor = projectId;
  renderPersonaCard();
  return state.persona;
}
