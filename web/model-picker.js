// The model menu: a hidden <select> for the truth, and a searchable menu on top.
//
// The select stays in the DOM because every handler that already exists reads it —
// fillRoleModels, renderEffort, setRoleModel. The menu is fixed-position so it can
// escape the role-card wrapper's overflow clipping; typing only filters, and a model
// can be set only by choosing an option.
//
// Five things come from app.js and are wired at boot: the model labels and the
// issues title, and the fill that keeps the select in step.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { modelByRef } from './run-view.js';
import { providerLabel, providerOrderOf, hiddenProviderIds } from './provider-list.js';

const missing = (name) => () => {
  throw new Error(`modelPicker.js: ${name} was not wired at boot`);
};
const wired = {
  fillRoleModels: missing('fillRoleModels'),
  modelLabel: missing('modelLabel'),
  modelMeta: missing('modelMeta'),
  modelTitle: missing('modelTitle'),
  issuesTitle: missing('issuesTitle'),
};

/** Hand this module the 5 things that live in app.js. Called once, at boot. */
export function modelPickerWiring(fns) {
  Object.assign(wired, fns);
}

// ── searchable model picker ─────────────────────────────────────
// The native <select> stays in the DOM as the source of truth — every existing
// handler (fillRoleModels, renderEffort, setRoleModel) keeps working — but it is
// hidden and driven by an input plus one shared menu. The menu is fixed-position
// so it can escape the role-card wrapper's overflow clipping. Typing only
// filters; a model can be set only by choosing an option.
export const pickers = new Map();
export let menuRole = null;
export let menuIndex = -1;
export let menuRefs = [];

export function setupModelPickers() {
  document.querySelectorAll('.role-model').forEach((sel) => {
    const role = sel.dataset.role;
    if (!role) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'model-search';
    input.dataset.role = role;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Search models…';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-label', `Search models for ${role}`);
    sel.after(input);
    pickers.set(role, { sel, input });

    input.addEventListener('focus', () => openModelMenu(role, false));
    input.addEventListener('click', () => openModelMenu(role, false));
    input.addEventListener('input', () => openModelMenu(role, true));
    input.addEventListener('keydown', (e) => onModelKey(e, role));
    // the delay lets a click on an option land before the menu closes
    input.addEventListener('blur', () => setTimeout(() => { if (menuRole === role) closeModelMenu(); }, 130));
  });

  const menu = $('modelMenu');
  if (menu) {
    menu.addEventListener('mousedown', (e) => {
      // The badge is the operator's own control, so it is handled before the row
      // is: clicking it clears the mark, it does not choose the model.
      const badge = e.target.closest('[data-clear-issues]');
      if (badge) {
        e.preventDefault();
        e.stopPropagation();
        clearModelIssues(badge.dataset.clearIssues);
        return;
      }
      const opt = e.target.closest('[data-ref]');
      if (!opt) return;
      e.preventDefault();
      chooseModel(menuRole, opt.dataset.ref);
    });
  }

  // The menu is fixed to the viewport, so anything that moves what it points at
  // has to move it too — the page under it, an inner scroller, the window itself.
  const reposition = () => {
    if (!menuRole) return;
    const p = pickers.get(menuRole);
    if (p) positionModelMenu(p.input, $('modelMenu'));
  };
  window.addEventListener('scroll', reposition, { capture: true, passive: true });
  window.addEventListener('resize', () => requestAnimationFrame(reposition));
}

/**
 * Take the mark off a model. UI-only and instant: no turn, no question, nothing
 * said to anybody — the operator checked it and it works again.
 */
export async function clearModelIssues(ref) {
  const role = menuRole;
  try {
    await api('POST', '/api/models/issues/clear', { ref });
  } catch (err) {
    toast('Could Not Clear Issues', err.message);
    return;
  }
  const m = modelByRef(ref);
  if (m) m.issues = null;
  toast('Issues Cleared', `${m ? wired.modelLabel(m.name) : ref} is unmarked.`);
  // Re-open unfiltered: the input holds the model's *name*, so passing it through
  // as a search would leave the operator looking at a one-row menu.
  if (role) openModelMenu(role, false);
}

/** Re-read the catalog, so a badge earned server-side appears without a reload. */
export async function refreshModels() {
  try {
    state.models = (await api('GET', '/api/models')).models;
    wired.fillRoleModels();
  } catch { /* the catalog is not worth a toast */ }
}

export function syncPickerInput(input) {
  const p = pickers.get(input.dataset.role);
  if (!p) return;
  let ref = p.sel.value;
  let m = modelByRef(ref);
  // A chat can hold a provider id that has since been renamed: this project's
  // session still says `opencode-go/deepseek-v4.1-flash` where the catalog offers
  // `oc-go/deepseek-v4.1-flash`. One model, one match — repair the ref rather than
  // telling the operator that a model they can see in the menu is missing. The
  // repair is in the select, so the next send switches the session to it.
  if (!m && ref) {
    const id = String(ref).split('/').pop();
    const same = state.models.filter((x) => x.id === id);
    if (same.length === 1) {
      p.sel.value = same[0].ref;
      ref = same[0].ref;
      m = same[0];
    }
  }
  // The name of the model the operator chose, or the ref itself when the catalog
  // is not offering it at the moment. Never another model's name: two providers
  // can serve the same name, and that is exactly how a card lies.
  input.value = m ? wired.modelLabel(m.name) : ref ? String(ref).split('/').pop() : '';
  const issues = m?.issues?.length ? ` · ISSUES: ${m.issues[0].message}` : '';
  input.title = m
    ? `${wired.modelTitle(m)}${issues} · type to search`
    : ref
      ? `${ref} is ${hiddenProviderIds().has(String(ref).split('/')[0]) ? 'from a provider hidden in Settings' : "not in the engine's catalog right now"} · type to search`
      : 'Type to search models';
  input.classList.toggle('has-issues', Boolean(m?.issues?.length));
  input.classList.toggle('is-missing', Boolean(ref && !m));
}

/**
 * Place the menu inside the window, always.
 *
 * It is fixed-positioned so it can escape the role cards' clipped wrapper, which
 * also means nothing clamps it: in the right-hand card column it ran off the
 * window, and on a second monitor it ran off the screen. Width first, then a
 * horizontal clamp, then down when there is room and up when there is not — and
 * never taller than the space it has, scrolling inside that.
 */
export function positionModelMenu(input, menu) {
  if (!input || !menu) return;
  const pad = 8;
  const gap = 4;
  const r = input.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Measure from the left edge: a stale `left` near the right edge would make
  // shrink-to-fit report a narrower menu than it can be.
  menu.style.left = `${pad}px`;
  menu.style.top = '-9999px';
  const maxW = Math.max(200, Math.min(560, vw - pad * 2));
  menu.style.minWidth = `${Math.min(Math.max(320, Math.round(r.width)), maxW)}px`;
  menu.style.maxWidth = `${maxW}px`;
  const w = menu.getBoundingClientRect().width;

  const left = Math.max(pad, Math.min(r.left, vw - pad - w));
  menu.style.left = `${Math.round(left)}px`;

  const below = vh - r.bottom - gap - pad;
  const above = r.top - gap - pad;
  const openUp = below < 180 && above > below;
  const maxH = Math.max(80, Math.min(300, openUp ? above : below));
  menu.style.maxHeight = `${Math.round(maxH)}px`;

  const h = Math.min(menu.getBoundingClientRect().height, maxH);
  const top = openUp ? Math.max(pad, r.top - gap - h) : r.bottom + gap;
  menu.style.top = `${Math.round(top)}px`;
}

export function paintModelMenu() {
  const menu = $('modelMenu');
  if (!menu) return;
  [...menu.querySelectorAll('.model-opt')].forEach((el, i) => el.classList.toggle('is-active', i === menuIndex));
}

export function openModelMenu(role, fromTyping) {
  const p = pickers.get(role);
  const menu = $('modelMenu');
  if (!p || !menu) return;
  menuRole = role;
  if (!fromTyping) p.input.select();
  const q = fromTyping ? p.input.value.trim().toLowerCase() : '';
  // The operator's own order, from Settings > Providers. Two servers with the
  // same badge ("Local") are two different providers here, and the label no
  // longer decides where a group sits (4 Nov).
  const order = providerOrderOf(state.config);
  const rankOf = (id) => {
    const at = order.indexOf(String(id));
    return at === -1 ? order.length : at;
  };
  const list = state.models
    .filter((m) => !q || m.name.toLowerCase().includes(q) || m.ref.toLowerCase().includes(q))
    .sort((a, b) => rankOf(a.provider) - rankOf(b.provider) || a.name.localeCompare(b.name));
  menuRefs = list.map((m) => m.ref);
  // A rule between provider groups. Eleven rows of eight different sources read
  // as one list until the source changes are visible: the chip alone was too
  // quiet, and the selection highlight made it worse when it landed across two.
  const rows = [];
  let previousGroup = null;
  for (const m of list) {
    const group = providerLabel(m.provider);
    if (previousGroup !== null && group !== previousGroup) {
      rows.push('<div class="model-sep" role="separator"></div>');
    }
    previousGroup = group;
    rows.push(`<div class="model-opt${m.ref === p.sel.value ? ' is-current' : ''}" role="option" data-ref="${esc(m.ref)}">
            <span class="mo-src">${esc(providerLabel(m.provider))}</span>
            <span class="mo-name">${esc(wired.modelLabel(m.name))}</span>
            ${m.issues?.length ? `<span class="mo-issues" data-clear-issues="${esc(m.ref)}" title="${esc(wired.issuesTitle(m))}">Issues</span>` : ''}
            <span class="mo-meta">${esc(wired.modelMeta(m))}</span>
          </div>`);
  }
  menu.innerHTML = rows.length ? rows.join('') : '<div class="model-empty">No models match</div>';
  menu.hidden = false;
  p.input.setAttribute('aria-expanded', 'true');
  positionModelMenu(p.input, menu);
  menuIndex = menuRefs.length ? Math.max(0, menuRefs.indexOf(p.sel.value)) : -1;
  paintModelMenu();
}

export function closeModelMenu() {
  const menu = $('modelMenu');
  if (menu) menu.hidden = true;
  if (menuRole) {
    const p = pickers.get(menuRole);
    if (p) {
      p.input.setAttribute('aria-expanded', 'false');
      syncPickerInput(p.input);
    }
  }
  menuRole = null;
  menuIndex = -1;
  menuRefs = [];
}

/** Only a real model can be set; the typed text never becomes the value. */
export function chooseModel(role, ref) {
  const p = pickers.get(role);
  if (!p || !ref || !modelByRef(ref)) return;
  if (p.sel.value !== ref) {
    p.sel.value = ref;
    p.sel.dispatchEvent(new Event('change'));
  }
  closeModelMenu();
}

export function onModelKey(e, role) {
  const p = pickers.get(role);
  const menu = $('modelMenu');
  if (!p || !menu) return;
  const open = menuRole === role && !menu.hidden;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) { openModelMenu(role, true); return; }
    if (!menuRefs.length) return;
    menuIndex = (menuIndex + (e.key === 'ArrowDown' ? 1 : -1) + menuRefs.length) % menuRefs.length;
    paintModelMenu();
    menu.querySelector('.model-opt.is-active')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Enter') {
    if (open && menuIndex >= 0) {
      e.preventDefault();
      chooseModel(role, menuRefs[menuIndex]);
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModelMenu();
    return;
  }
  if (e.key === 'Tab') closeModelMenu();
}
