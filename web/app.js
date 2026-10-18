// Synapse UI. Talks only to the Synapse API; knows nothing about the engine.
//
// LIVE: engine/stream status, projects and their sessions (create, rename,
// delete), the conversation with streamed tool calls, tool permissions,
// per-role model + thinking-effort choices, the Single↔Multi switch, and the
// settings form over config/synapse.config.json.
//
// The role cards are shown in Multi mode but their per-role activity is not
// wired yet — the orchestration layer will drive them (stage 3+).

import { renderMarkdown } from './md.js';

const $ = (id) => document.getElementById(id);

// Orchestration roles. These ids key the per-role model choices in the config
// file and label the cards. Every chat message goes to the Architect — the
// composer has no target picker; the philosophy is one interface, one lead.
const ROLES = [
  { id: 'architect', name: 'Architect' },
  { id: 'critic', name: 'Critic' },
  { id: 'designer', name: 'Designer' },
  { id: 'coder-1', name: 'Coder 1' },
  { id: 'coder-2', name: 'Coder 2' },
  { id: 'coder-3', name: 'Coder 3' },
  { id: 'auditor', name: 'Auditor' },
];

const TBD_TITLE = 'TBD';

const state = {
  status: null,
  config: null,
  models: [],
  workspace: '',
  projects: [],
  sessionId: null,
  messages: [],
  // The open session's project plan file: its parsed contents, any problems in
  // it, and when it last changed.
  planState: null,
  permissions: [],
  busy: false,
  busySessions: new Set(),
  busySince: new Map(),
  toolsInFlight: new Set(),
  forms: [],
  // 'single' (one Architect, all tools, no delegation) or 'multi' (delegation
  // allowed, role cards revealed). New sessions start single; the toggle
  // switches the open session live.
  mode: 'single',
  streaming: false,
  streamLive: false,
  collapsed: new Set(),
  // Keys of reasoning blocks and tool cards the operator has opened. The
  // transcript is rebuilt on every poll, so expansion state has to live outside
  // the DOM or it dies with the next render.
  open: new Set(),
  renderSig: '',
  renaming: null,
  view: 'none', // none | session
};

// ── helpers ─────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(json?.error || `${method} ${path} → ${res.status}`);
  return json;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const relTime = (ts) => {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
};

/** 24-hour HH:MM for message timestamps. */
const hhmm = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** A tool call's one-line description: what it is actually running. */
function toolTarget(part) {
  const i = part?.input;
  const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  if (i && typeof i === 'object') {
    const named = clean(i.command) || clean(i.path) || clean(i.filePath) || clean(i.pattern)
      || clean(i.query) || clean(i.url) || clean(i.name);
    if (named) return named;
    for (const v of Object.values(i)) {
      const s = clean(v);
      if (s) return s;
    }
  }
  return clean(part?.title);
}

// selects cannot render `text-overflow: ellipsis`, so truncate the label itself
const shortModel = (name) => {
  const s = String(name || '').replace(/\s*free\s*/i, ' ').trim();
  return s.length > 28 ? s.slice(0, 28).trimEnd() + '…' : s;
};

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

// ── toast ───────────────────────────────────────────────────────
function toast(title, body) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast-icon">◈</span><div><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}</div>`;
  $('toastRegion').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ── error popup ─────────────────────────────────────────────────
function openError(title, text) {
  $('errorHeading').textContent = title;
  $('errorText').textContent = text;
  $('errorModal').hidden = false;
  $('closeError').focus();
}
function closeError() { $('errorModal').hidden = true; }

// ── generic dialog (confirmations and small forms) ──────────────
let dialogResolve = null;
let dialogFields = [];

function openDialog({ title, message = '', fields = [], confirmLabel = 'OK', danger = false, afterRender }) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogFields = fields;
    $('dialogTitle').textContent = title;
    $('dialogMessage').textContent = message;
    $('dialogMessage').hidden = !message;
    $('dialogOk').textContent = confirmLabel;
    $('dialogOk').className = `btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`;
    $('dialogBody').innerHTML = fields
      .map((f) => {
        const control = f.type === 'select'
          ? `<select id="dlg-${esc(f.name)}">${f.options.map((o) => `<option value="${esc(o.v)}">${esc(o.l)}</option>`).join('')}</select>`
          : `<input id="dlg-${esc(f.name)}" type="text" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" />`;
        return `<label class="set-field wide"><span>${esc(f.label)}</span>${control}</label>`;
      })
      .join('');
    $('dialogModal').hidden = false;
    const first = $('dialogBody').querySelector('input, select');
    first?.focus();
    first?.select?.();
    afterRender?.();
  });
}

function readDialog() {
  if (!dialogFields.length) return true;
  const values = {};
  for (const f of dialogFields) {
    const el = $(`dlg-${f.name}`);
    if (el) values[f.name] = el.value.trim();
  }
  return values;
}

function closeDialog(result) {
  $('dialogModal').hidden = true;
  const resolve = dialogResolve;
  dialogResolve = null;
  resolve?.(result);
}

// ── status ──────────────────────────────────────────────────────
async function refreshStatus() {
  try {
    state.status = await api('GET', '/api/status');
    state.workspace = state.status?.engine?.workspace || '';
  } catch (err) {
    state.status = { engine: { ready: false, kind: 'engine' }, bootError: err.message };
  }
  renderStatus();
}

function renderStatus() {
  const engine = state.status?.engine || {};
  const ready = Boolean(engine.ready);
  const failed = Boolean(state.status?.bootError);

  $('engineDot').className = 'status-dot ' + (ready ? 'ok' : failed ? 'err' : 'warn');
  $('engineState').textContent = ready
    ? `${engine.kind} ${engine.version || ''}`.trim()
    : failed ? 'failed' : 'starting';

  $('streamDot').className = 'status-dot ' + (state.streamLive ? 'ok' : 'idle');
  $('streamState').textContent = state.streamLive ? 'connected' : 'offline';
}

function setEventChip(type) {
  const el = $('lastEvent');
  if (el) el.textContent = String(type || 'idle').replace(/^session\./, '');
  const dot = $('eventDot');
  if (!dot) return;
  dot.className = 'status-dot ok';
  clearTimeout(setEventChip.timer);
  setEventChip.timer = setTimeout(() => { dot.className = 'status-dot idle'; }, 1200);
}

// ── models / modes ──────────────────────────────────────────────
async function loadModels() {
  try { state.models = (await api('GET', '/api/models')).models; } catch { state.models = []; }
  fillRoleModels();
}

// Every role — the Architect included — stores its own selection as
// { ref, variant } under `roles[id]` in the config file. An empty variant means
// the engine's own default (recorded as "default"). Selecting a model does not
// imply an effort: the operator picks that with the chevron button.
const asSelection = (spec) => {
  if (!spec) return null;
  if (typeof spec === 'string') return { ref: spec, variant: '' };
  if (typeof spec === 'object' && typeof spec.ref === 'string') {
    return { ref: spec.ref, variant: String(spec.variant || '') };
  }
  return null;
};

const modelByRef = (ref) => state.models.find((m) => m.ref === ref) || null;
const variantsOf = (model) =>
  Array.isArray(model?.variants)
    ? model.variants
        .map((v) => (typeof v === 'string' ? { id: v, label: v } : { id: String(v?.id ?? ''), label: String(v?.label ?? v?.id ?? '') }))
        .filter((v) => v.id)
    : [];
// The chevron button exposes the three highest efforts a model allows, in
// ascending order: Cat Jam Free → high, xhigh, max; DeepSeek → low, high, max.
const topEfforts = (model) => variantsOf(model).slice(-3);

function selectionFor(roleId) {
  return asSelection(state.config?.roles?.[roleId]) || { ref: '', variant: '' };
}

/** The Architect is a role like any other — no "default model" exists. */
function architectSelection() {
  const sel = selectionFor('architect');
  if (!sel.ref) return null;
  // The chevron control only expresses the three highest efforts, so a stored
  // value it cannot show is dropped here too — the session must not run an
  // effort the button claims is not set.
  const model = modelByRef(sel.ref);
  const variant = topEfforts(model).some((v) => v.id === sel.variant) ? sel.variant : '';
  return { ref: sel.ref, variant };
}

const fmtTokens = (n) =>
  !n ? '' : n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

const modelTitle = (m) => {
  if (!m) return '';
  const bits = [m.name];
  if (m.context) bits.push(`${fmtTokens(m.context)} context`);
  if (m.output) bits.push(`${fmtTokens(m.output)} max output`);
  return bits.join(' · ');
};

const modelMeta = (m) => {
  const bits = [];
  if (m.context) bits.push(fmtTokens(m.context));
  if (Array.isArray(m.tools) && m.tools.length) bits.push(`${m.tools.length} tools`);
  return bits.join(' · ');
};

// Where a model comes from is part of its identity: `opencode/…-free` and
// `opencode-go/…` can be the same model with different backends, and local
// runtimes will be a third source later. The provider id is the source, so show
// it; unknown providers fall back to a readable form of the id.
const PROVIDER_LABELS = { opencode: 'OpenCode', 'opencode-go': 'OpenCode Go' };
const providerLabel = (p) => {
  const id = String(p || 'unknown');
  if (PROVIDER_LABELS[id]) return PROVIDER_LABELS[id];
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
};

// ── searchable model picker ─────────────────────────────────────
// The native <select> stays in the DOM as the source of truth — every existing
// handler (fillRoleModels, renderEffort, setRoleModel) keeps working — but it is
// hidden and driven by an input plus one shared menu. The menu is fixed-position
// so it can escape the role-card wrapper's overflow clipping. Typing only
// filters; a model can be set only by choosing an option.
const pickers = new Map();
let menuRole = null;
let menuIndex = -1;
let menuRefs = [];

function setupModelPickers() {
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
      const opt = e.target.closest('[data-ref]');
      if (!opt) return;
      e.preventDefault();
      chooseModel(menuRole, opt.dataset.ref);
    });
  }
}

function syncPickerInput(input) {
  const p = pickers.get(input.dataset.role);
  if (!p) return;
  const m = modelByRef(p.sel.value);
  input.value = m ? shortModel(m.name) : '';
  input.title = m ? `${modelTitle(m)} · type to search` : 'Type to search models';
}

function positionModelMenu(input, menu) {
  const r = input.getBoundingClientRect();
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.style.minWidth = `${Math.max(220, Math.round(r.width))}px`;
}

function paintModelMenu() {
  const menu = $('modelMenu');
  if (!menu) return;
  [...menu.querySelectorAll('.model-opt')].forEach((el, i) => el.classList.toggle('is-active', i === menuIndex));
}

function openModelMenu(role, fromTyping) {
  const p = pickers.get(role);
  const menu = $('modelMenu');
  if (!p || !menu) return;
  menuRole = role;
  if (!fromTyping) p.input.select();
  const q = fromTyping ? p.input.value.trim().toLowerCase() : '';
  const list = state.models
    .filter((m) => !q || m.name.toLowerCase().includes(q) || m.ref.toLowerCase().includes(q))
    .sort((a, b) => String(a.provider).localeCompare(String(b.provider)) || a.name.localeCompare(b.name));
  menuRefs = list.map((m) => m.ref);
  menu.innerHTML = list.length
    ? list
        .map(
          (m) => `<div class="model-opt${m.ref === p.sel.value ? ' is-current' : ''}" role="option" data-ref="${esc(m.ref)}">
            <span class="mo-src">${esc(providerLabel(m.provider))}</span>
            <span class="mo-name">${esc(shortModel(m.name))}</span>
            <span class="mo-meta">${esc(modelMeta(m))}</span>
          </div>`,
        )
        .join('')
    : '<div class="model-empty">No models match</div>';
  menu.hidden = false;
  p.input.setAttribute('aria-expanded', 'true');
  positionModelMenu(p.input, menu);
  menuIndex = menuRefs.length ? Math.max(0, menuRefs.indexOf(p.sel.value)) : -1;
  paintModelMenu();
}

function closeModelMenu() {
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
function chooseModel(role, ref) {
  const p = pickers.get(role);
  if (!p || !ref || !modelByRef(ref)) return;
  if (p.sel.value !== ref) {
    p.sel.value = ref;
    p.sel.dispatchEvent(new Event('change'));
  }
  closeModelMenu();
}

function onModelKey(e, role) {
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

// Single mode keeps every tool but denies delegation, so the Architect answers
// everything itself in one chat. A dedicated agent for this is the obvious
// design and it fails: the free tier rejects every request from a custom agent
// with a provider auth error (measured). A permission ruleset on an ordinary
// session works, and — unlike denying everything — leaves the tools usable.
const SINGLE_PERMISSIONS = [{ action: 'subagent', resource: '*', effect: 'deny' }];
const sessionMode = (s) => (s?.single ? 'single' : 'multi');

/**
 * A new session is always born in Single mode: one Architect, every tool,
 * delegation denied. Multi is a live switch on the open session — a permission
 * PATCH — so nothing about the mode has to be decided at creation time.
 */
function sessionBody(projectId) {
  const body = { projectId, permissions: SINGLE_PERMISSIONS };
  const model = architectSelection();
  if (model) body.model = model;
  return body;
}

function renderMode() {
  const btn = $('modeToggle');
  const label = $('modeLabel');
  if (!btn || !label) return;
  const single = state.mode === 'single';
  label.textContent = single ? 'Single' : 'Multi';
  btn.classList.toggle('is-single', single);
  btn.setAttribute('aria-pressed', String(single));
  btn.title = single
    ? 'Single: one Architect, all the tools, no delegation — it answers everything itself. Click for Multi.'
    : 'Multi: the Architect can delegate to subagents and the role cards are shown. Click for Single.';
  const input = $('promptInput');
  if (input) input.placeholder = single ? 'Message' : 'Message the Architect…';
  document.body.dataset.mode = state.mode;
}

// ── role cards: the Architect is always there ───────────────────
// The cards sit in a wrapper whose max-height animates. The Architect card is
// visible in both modes — you need its model and thinking-effort controls even
// in Single — and Multi reveals the workers around it. Height is measured, not
// guessed, so the cards are never cut off mid-card.
let revealTimer = 0;
let workersPendingOff = false;

function topologyTarget() {
  const wrap = $('topologyWrap');
  const topo = $('topology');
  return wrap && topo ? { wrap, topo } : null;
}

/**
 * How much vertical room the role-card wrapper may take. In the wide layout the
 * stage has a definite height (viewport minus the frame); below the 1460px
 * breakpoint it is content-sized and the page scrolls. There, using the stage's
 * own height would collapse the reveal to the Architect alone, so the
 * breakpoint itself is the test — `getComputedStyle().height` reports the used
 * height, never `auto`. The chat visibly slides down as the workers reveal.
 */
function stageBudget(stage) {
  const composerH = $('composer')?.getBoundingClientRect().height || 58;
  const wide = window.matchMedia('(min-width: 1461px)').matches;
  const basis = wide && stage ? stage.getBoundingClientRect().height : window.innerHeight - 40;
  // composer row + its borders + the stage gap
  return Math.max(0, basis - composerH - 2 - 14);
}

function measureReveal(topo, stage) {
  // Use the real box height, rounded UP: scrollHeight rounds down, and a
  // 241.06px topology under a 241px cap clipped the last card's bottom border
  // and made `overflow: auto` grow a hairline scrollbar.
  const content = Math.ceil(topo.getBoundingClientRect().height);
  return Math.min(content, Math.round(stageBudget(stage)));
}

/**
 * Single: Architect only, wrapper at the Architect's height. Multi: the whole
 * topology, measured. The wrapper is always open in a session, so switching
 * modes is a height animation, not a show/hide.
 *
 * Single never trusts a measurement for its resting state: the wrapper ends at
 * `max-height: none`, i.e. exactly the Architect card, so a stale measure can
 * never clip the card or grow a scrollbar (and `overflow: clip` in CSS means
 * not even a transient one can scroll). The measured height is used only for
 * the 320ms Multi→Single collapse animation.
 */
function applyRoleCardsLayout({ animate = true } = {}) {
  const els = topologyTarget();
  if (!els || state.view !== 'session') return;
  const { wrap, topo } = els;
  clearTimeout(revealTimer);
  workersPendingOff = false;
  wrap.classList.add('is-open');

  if (state.mode === 'multi') {
    // `max-height: none` does not interpolate, so growing straight out of the
    // Single resting state would snap instead of sliding. Pin the current
    // height first, force a reflow, then grow to the measured target.
    const fromH = Math.ceil(wrap.getBoundingClientRect().height);
    document.body.classList.add('workers-on');
    wrap.style.setProperty('--reveal-h', `${fromH}px`);
    // the reflow is what makes the reveal animate instead of snapping
    void wrap.offsetHeight;
    wrap.style.setProperty('--reveal-h', `${measureReveal(topo, $('stage'))}px`);
    requestAnimationFrame(drawActivePath);
    return;
  }

  // Everything above the first worker, including the 12px top margin the
  // Architect row gets from `.topology > * + *` (the absolute path layer is a
  // preceding child, so the selector matches it). Only used to animate the
  // collapse; the resting state below does not depend on it.
  const topoRect = topo.getBoundingClientRect();
  const arch = topo.querySelector('.topo-architect');
  const archBottom = arch?.getBoundingClientRect().bottom ?? topoRect.top;
  const singleH = Math.ceil(archBottom - topoRect.top);
  const collapseH = Math.min(singleH, Math.round(stageBudget($('stage'))));

  if (!animate || !document.body.classList.contains('workers-on')) {
    // Fresh open or re-measure: settle exact immediately, no animation.
    document.body.classList.remove('workers-on');
    wrap.style.setProperty('--reveal-h', 'none');
    return;
  }
  // Collapsing from Multi: shrink through the measured height, then settle
  // exact and hide the workers only once the height has fallen.
  wrap.style.setProperty('--reveal-h', `${collapseH}px`);
  workersPendingOff = true;
  revealTimer = setTimeout(() => {
    if (workersPendingOff && state.mode === 'single') {
      document.body.classList.remove('workers-on');
      wrap.style.setProperty('--reveal-h', 'none');
    }
    workersPendingOff = false;
  }, 320);
}

async function switchMode() {
  if (state.view !== 'session' || !state.sessionId) {
    toast('No Session Open', 'Open or start a session to switch modes.');
    return;
  }
  const previous = state.mode;
  const next = previous === 'single' ? 'multi' : 'single';
  state.mode = next;
  renderMode();
  setView();
  try {
    // Single denies only the delegation tool; Multi clears the ruleset. The
    // engine applies this to later turns of the same session.
    await api('PATCH', `/api/sessions/${encodeURIComponent(state.sessionId)}`, {
      permissions: next === 'single' ? SINGLE_PERMISSIONS : [],
    });
    const s = findSession(state.sessionId);
    if (s) s.single = next === 'single';
  } catch (err) {
    state.mode = previous;
    renderMode();
    setView();
    toast('Could Not Switch Mode', err.message);
  }
}

// One model picker and one thinking-effort button per role card. The model
// change is stored in the config file; the Architect's copy is also applied to
// the open session immediately, while worker selections wait for the
// orchestration layer to spawn their sessions.
// One SVG per effort level, drawn as evenly spaced stroked chevrons. Three
// separate SVGs with fractional negative margins rounded unevenly (the gaps
// looked different), so the whole glyph is one SVG with integer geometry.
function effortChevrons(level) {
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

function renderEffort(roleId) {
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

function fillRoleModels() {
  if (state.models.length === 0) return;
  const free = state.models.filter((m) => m.free);
  const pool = free.length ? free : state.models;
  document.querySelectorAll('.role-model').forEach((sel, i) => {
    const role = sel.dataset.role || String(i);
    sel.innerHTML = state.models
      .map((m) => `<option value="${esc(m.ref)}">${esc(shortModel(m.name))}</option>`)
      .join('');
    let chosen = selectionFor(role).ref;
    if (!modelByRef(chosen)) chosen = (pool[i % pool.length] || state.models[0]).ref;
    sel.value = chosen;
    sel.title = modelTitle(modelByRef(chosen)) || `Model for the ${role} role`;
    const p = pickers.get(role);
    if (p) syncPickerInput(p.input);
    renderEffort(role);
  });
}

/** Every role, the Architect included, keeps its own persisted selection. */
async function saveRoleSelection(roleId, ref, variant) {
  const draft = JSON.parse(JSON.stringify(state.config || {}));
  const entry = { ref };
  if (variant) entry.variant = variant;
  draft.roles = { ...(draft.roles || {}), [roleId]: entry };
  state.config = await api('PUT', '/api/config', draft);
}

/** Push the Architect's current model + effort onto the open session. */
async function applyArchitectModel() {
  const model = architectSelection();
  if (!model || !state.sessionId) return;
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/model`, { model });
  } catch (err) {
    toast('Could Not Switch the Session Model', err.message);
  }
}

async function setRoleModel(roleId, ref) {
  const role = ROLES.find((r) => r.id === roleId);
  const current = selectionFor(roleId).variant;
  const variant = topEfforts(modelByRef(ref)).some((v) => v.id === current) ? current : '';
  try {
    await saveRoleSelection(roleId, ref, variant);
    renderEffort(roleId);
    // first time this model is chosen, learn its toolset in the background;
    // the server answers from cache and never probes the same model twice
    api('POST', '/api/models/inspect', { ref }).catch(() => {});
    if (roleId === 'architect') {
      await applyArchitectModel();
      toast('Model for Architect', state.sessionId ? 'Saved and applied to the open session.' : 'Saved for new sessions.');
    } else {
      toast(`Model for ${role?.name || roleId}`, 'Saved. The orchestration layer will use it when this role runs.');
    }
  } catch (err) {
    toast('Could not save the role model', err.message);
  }
}

// default → 1 chevron → 2 → 3 → back to default. Keeping the default reachable
// matters: it is the engine's own choice, not an absence of one.
async function cycleEffort(roleId) {
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

// ── projects + sessions ─────────────────────────────────────────
async function loadProjects() {
  try {
    state.projects = (await api('GET', '/api/projects')).projects;
  } catch (err) {
    state.projects = [];
    setEventChip('projects unavailable');
  }
  renderTree();
  updateSessionHeader();
}

const findSession = (id) => {
  for (const p of state.projects) {
    const s = p.sessions.find((x) => x.id === id);
    if (s) return s;
  }
  return null;
};

const projectOf = (sessionId) => state.projects.find((p) => p.sessions.some((s) => s.id === sessionId)) || null;

// Every project starts with the same slot; projects are all real now.
function newSessionRow(projectId) {
  return `<div class="tree-row new" data-new="${esc(projectId)}">
    <button class="tree-open"><span class="tree-name">New Session</span></button>
    <button class="tree-add-row" title="New Session" aria-label="New Session">＋</button>
  </div>`;
}

const isBusy = (sessionId) => state.busySessions.has(sessionId);
const lastProgress = (sessionId) => state.busySince.get(sessionId) || 0;
// A running session that has produced nothing for this long is not "working",
// it is waiting on an upstream request that is never coming back. A tool that
// is genuinely still executing emits nothing either (measured: a 100s shell
// command logs one progress event and then silence), so an in-flight tool
// always counts as progress. Measured first-token latency on the free models
// reached 69s on a cold start, so the window has to clear that comfortably.
const STALL_MS = 180000;
const isStalled = (sessionId) =>
  isBusy(sessionId) &&
  !state.toolsInFlight.has(sessionId) &&
  Date.now() - lastProgress(sessionId) > STALL_MS;

function liveDot(sessionId, { clickable = true } = {}) {
  const busy = isBusy(sessionId);
  const stalled = isStalled(sessionId);
  if (stalled && clickable) {
    return `<button class="tree-live on stalled" data-interrupt="${esc(sessionId)}" title="No response for over ${Math.round(STALL_MS / 1000)}s — click to interrupt"></button>`;
  }
  if (stalled) return '<span class="tree-live on stalled" title="Stalled"></span>';
  return `<span class="tree-live${busy ? ' on' : ''}" title="${busy ? 'Working' : ''}"></span>`;
}

function sessionRow(s) {
  if (state.renaming === s.id) {
    return `<div class="tree-row session" data-session="${esc(s.id)}">
      <input class="tree-rename" id="renameInput" value="${esc(s.title || TBD_TITLE)}" aria-label="Session Name" />
    </div>`;
  }
  const current = state.view === 'session' && s.id === state.sessionId;
  const title = s.title || TBD_TITLE;
  // Recency lives in the tooltip: the name needs the width more than "8m ago" does,
  // and the list is already newest-first.
  const when = relTime(s.updated || s.created);
  const busy = isBusy(s.id);
  return `<div class="tree-row session${current ? ' is-current' : ''}" data-session="${esc(s.id)}">
    <button class="tree-open" title="${esc(title)}${when ? ` · ${esc(when)}` : ''}${busy ? ' · working' : ''}">
      <span class="tree-name">${esc(title)}</span>
    </button>
    <span class="tree-actions">
      <button class="tree-edit ic-edit" data-rename="${esc(s.id)}" title="Rename Session" aria-label="Rename Session">✎</button>
      ${liveDot(s.id)}
      <button class="tree-x" data-del-session="${esc(s.id)}" title="Delete Session" aria-label="Delete Session">✕</button>
    </span>
  </div>`;
}

function renderTree() {
  const el = $('projectTree');
  if (!el) return;
  const html = [];

  for (const p of state.projects) {
    const open = !state.collapsed.has(p.id);
    const current = state.view === 'session' && p.sessions.some((s) => s.id === state.sessionId);
    html.push(`<div class="tree-project">
      <div class="tree-row project${current ? ' is-current' : ''}">
        <button class="tree-open" data-project="${esc(p.id)}" aria-expanded="${open}">
          <span class="tree-caret" aria-hidden="true"></span>
          <span class="tree-name">${esc(p.name)}</span>
        </button>
        ${p.exists === false ? '<span class="tree-missing" title="This folder no longer exists — sessions cannot run here">!</span>' : ''}
        <span class="tree-actions">
          ${p.general ? '' : `<button class="tree-edit ic-edit" data-rename-project="${esc(p.id)}" title="Rename Project" aria-label="Rename Project">✎</button>`}
          ${liveDot((p.sessions.find((s) => isBusy(s.id)) || {}).id || '__none__', { clickable: false })}
          ${p.general ? '' : `<button class="tree-x" data-del-project="${esc(p.id)}" title="Delete Project" aria-label="Delete Project">✕</button>`}
        </span>
      </div>`);
    if (open) {
      // New Session sits at the bottom: sessions read oldest-first, so the new
      // one belongs where it will actually land.
      html.push(`<div class="tree-sessions">${p.sessions.map(sessionRow).join('')}${newSessionRow(p.id)}</div>`);
    }
    html.push('</div>');
  }

  el.innerHTML = html.join('');

  if (state.renaming) {
    const input = $('renameInput');
    if (input) { input.focus(); input.select(); }
  }
}

function toggleProject(id) {
  if (state.collapsed.has(id)) state.collapsed.delete(id);
  else state.collapsed.add(id);
  renderTree();
}

async function createSession(projectId) {
  const project = state.projects.find((p) => p.id === projectId) || state.projects.find((p) => p.general);
  if (!project) return;
  if (project.exists === false) {
    toast('Folder missing', `${project.directory} does not exist, so no session can run there.`);
    return;
  }
  try {
    const { session } = await api('POST', '/api/sessions', sessionBody(project.id));
    await loadProjects();
    await openSession(session.id);
  } catch (err) {
    toast('Could not create a session', err.message);
  }
}

// One shape for every destructive confirmation.
function confirmDelete({ kind, name, consequence, extra }) {
  return openDialog({
    title: `Delete ${kind}`,
    message: `"${name}" ${consequence}${extra ? ` ${extra}` : ''}`,
    confirmLabel: 'Delete',
    danger: true,
  });
}

async function removeSession(id) {
  const s = findSession(id);
  const ok = await confirmDelete({
    kind: 'session',
    name: s?.title || TBD_TITLE,
    consequence: 'and its whole transcript are removed from the engine.',
    extra: 'This cannot be undone.',
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
    state.busySessions.delete(id);
    if (state.sessionId === id) showNothing();
    await loadProjects();
  } catch (err) {
    toast('Could not delete the session', err.message);
  }
}

async function removeProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  if (p.sessions.length) {
    await openDialog({
      title: 'Sessions Still Inside',
      message: `"${p.name}" holds ${p.sessions.length} session${p.sessions.length === 1 ? '' : 's'}. Delete or move ${p.sessions.length === 1 ? 'it' : 'them'} first — Synapse will not leave a session without a project.`,
      confirmLabel: 'OK',
    });
    return;
  }
  const ok = await confirmDelete({
    kind: 'project',
    name: p.name,
    consequence: 'is removed from Synapse.',
    extra: 'The folder and every file in it are left untouched.',
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/projects/${encodeURIComponent(id)}`);
    await loadProjects();
    toast('Project Removed', 'Nothing on disk was touched.');
  } catch (err) {
    toast('Could not remove the project', err.message);
  }
}

async function renameProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  const res = await openDialog({
    title: 'Rename project',
    message: `The label only — the folder stays ${p.directory}.`,
    fields: [{ name: 'name', label: 'Project name', value: p.name }],
    confirmLabel: 'Rename',
    afterRender: () => $('dlg-name')?.select(),
  });
  if (!res) return;
  const name = res.name?.trim();
  if (!name || name === p.name) return;
  try {
    await api('PATCH', `/api/projects/${encodeURIComponent(id)}`, { name });
    await loadProjects();
  } catch (err) {
    toast('Could not rename the project', err.message);
  }
}

async function addProject() {
  const base = state.workspace || '';
  const res = await openDialog({
    title: 'Add a project',
    message: 'A project is a folder. Sessions you start inside it run in that folder. Synapse creates the folder when it does not exist yet.',
    fields: [
      { name: 'name', label: 'Project name', placeholder: 'calendar' },
      { name: 'directory', label: 'Folder', placeholder: base ? `${base}\\calendar` : 'C:\\path\\to\\project' },
    ],
    confirmLabel: 'Add Project',
    afterRender: () => {
      const nameEl = $('dlg-name');
      const dirEl = $('dlg-directory');
      if (!nameEl || !dirEl) return;
      let touched = false;
      const suggest = () => (base ? `${base}\\${slug(nameEl.value)}` : '');
      dirEl.addEventListener('input', () => { touched = true; });
      nameEl.addEventListener('input', () => { if (!touched) dirEl.value = suggest(); });
    },
  });
  if (!res) return;

  const name = res.name?.trim();
  let directory = res.directory?.trim();
  if (!directory) directory = base ? `${base}\\${slug(name)}` : '';
  if (!directory) {
    toast('A folder is required', 'Give the project a folder to run in.');
    return;
  }
  try {
    await api('POST', '/api/projects', { name: name || undefined, directory });
    await loadProjects();
    toast('Project added', directory);
  } catch (err) {
    toast('Could not add the project', err.message);
  }
}

async function commitRename() {
  const id = state.renaming;
  if (!id) return;
  const input = $('renameInput');
  const title = input ? input.value.trim() : '';
  state.renaming = null;
  const current = findSession(id);
  if (!title || (current && current.title === title)) { renderTree(); return; }
  try {
    await api('PATCH', `/api/sessions/${encodeURIComponent(id)}`, { title });
    await loadProjects();
  } catch (err) {
    toast('Could not rename the session', err.message);
    renderTree();
  }
}

// ── view state ──────────────────────────────────────────────────

/**
 * The stage is exactly the window minus the frame, but a classic horizontal
 * scrollbar (narrow, unsupported windows) eats layout height that `100vh` does
 * not account for. Measure the difference and reserve it, so the vertical
 * scrollbar cannot come back.
 */
function fitStageHeight() {
  const doc = document.documentElement;
  const bar = Math.max(0, window.innerHeight - doc.clientHeight);
  doc.style.setProperty('--stage-h', `${Math.max(0, window.innerHeight - 26 - bar)}px`);
}

function setView() {
  document.body.dataset.view = state.view;
  document.body.dataset.mode = state.mode;
  // the mode toggle is a session control: there is nothing to switch without
  // an open session
  $('modeToggle').hidden = state.view !== 'session';
  applyRoleCardsLayout();
  renderComposer();
  updateSessionHeader();
  requestAnimationFrame(drawActivePath);
}

function currentProject() {
  return projectOf(state.sessionId);
}

function updateSessionHeader() {
  const p = currentProject();
  const nameEl = $('sessionProjectName');
  const pathEl = $('sessionProjectPath');
  if (nameEl) nameEl.textContent = p?.name || '—';
  if (pathEl) {
    pathEl.textContent = p?.directory || '';
    pathEl.title = p?.directory || '';
  }
}

async function openSession(id) {
  state.view = 'session';
  state.sessionId = id;
  state.permissions = [];
  // the mode is a property of the session, not of the app
  state.mode = sessionMode(findSession(id));
  renderMode();
  $('sidebar').classList.remove('open');
  setView();
  renderTree();
  await loadMessages();
  refreshPending();
  renderToolUsage();
  loadPlan();
}

function showNothing() {
  state.view = 'none';
  state.sessionId = null;
  state.messages = [];
  state.planState = null;
  state.mode = 'single';
  renderMode();
  setView();
  renderTree();
  renderTranscript();
  renderPlan();
}

// The live connection is drawn as one solid orange path from the requester
// down the spine and across into the worker, with faint ants travelling it.
function drawActivePath() {
  const layer = $('pathLayer');
  const topo = $('topology');
  if (!layer || !topo) return;
  layer.innerHTML = '';
  if (!topo.offsetParent || topo.clientWidth === 0) return; // hidden view

  const active = topo.querySelector('.link.active');
  const arch = topo.querySelector('.topo-architect .role-card');
  if (!active || !arch) return;

  const kids = [...topo.children];
  const idx = kids.indexOf(active);
  const rtl = active.classList.contains('rtl');
  const dest = rtl ? kids[idx - 1] : kids[idx + 1];
  if (!dest || !dest.classList.contains('role-card')) return;

  // Measure the spine and the dotted band from the connector cell itself, and
  // keep full precision (no rounding) — anything else leaves a sub-pixel step
  // between the orange path and the dots it is supposed to cover.
  const box = topo.getBoundingClientRect();
  const a = arch.getBoundingClientRect();
  const d = dest.getBoundingClientRect();
  const cell = active.getBoundingClientRect();
  const band = active.querySelector('.link-line').getBoundingClientRect();
  const n = (v) => Math.round(v * 100) / 100;

  const x0 = n(cell.left + cell.width / 2 - box.left);   // exactly the spine
  const y0 = n(a.bottom - box.top);                      // where the spine starts
  const y1 = n(band.top + band.height / 2 - box.top);    // exactly the dot centre
  const x1 = n((rtl ? d.right : d.left) - box.left);     // touches the worker
  const path = `M ${x0} ${y0} L ${x0} ${y1} L ${x1} ${y1}`;

  layer.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  layer.setAttribute('preserveAspectRatio', 'none');

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COUNT = 12;
  const DUR = 3.4;
  const ants = reduce
    ? ''
    : Array.from({ length: COUNT }, (_, i) =>
        `<circle r="3"><animateMotion dur="${DUR}s" begin="${(i * DUR / COUNT).toFixed(2)}s" repeatCount="indefinite" path="${path}"></animateMotion></circle>`,
      ).join('');

  layer.innerHTML =
    `<defs><marker id="synArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">` +
    `<path d="M0 0 L10 5 L0 10 Z"></path></marker></defs>` +
    `<path class="flow" d="${path}" marker-end="url(#synArrow)"></path>` +
    ants;
}

// ── messages ────────────────────────────────────────────────────
async function loadMessages() {
  if (!state.sessionId) return;
  try {
    state.messages = (await api('GET', `/api/sessions/${encodeURIComponent(state.sessionId)}/messages`)).messages;
    updateBusyFromMessages();
  } catch (err) {
    if (/not found|404/i.test(err.message)) {
      // The session is gone — deleted here, or by another client. Stop polling.
      state.busySessions.delete(state.sessionId);
      showNothing();
      await loadProjects();
      return;
    }
    setEventChip('message load failed');
  }
  renderTranscript();
  // The plan is a file the Architect writes during the turn, so a message
  // refresh is exactly when it is most likely to have changed.
  loadPlan();
}

function updateBusyFromMessages() {
  if (state.streaming) return;
  const convo = state.messages.filter((m) => m.type === 'user' || m.type === 'assistant');
  const last = convo[convo.length - 1];
  state.busy = Boolean(last && last.type === 'assistant' && !last.completed && !last.error);

  // Seed "a tool is running" from the transcript too, so a reload in the middle
  // of a long tool does not look like a stall.
  if (state.sessionId) {
    const running = (last?.parts || []).some(
      (p) => p.type === 'tool' && /run|stream|pend|progress/i.test(String(p.status || '')),
    );
    if (running) state.toolsInFlight.add(state.sessionId);
    else state.toolsInFlight.delete(state.sessionId);
  }
  renderComposer();
}

/**
 * The engine emits one assistant message per *step* — a reasoning turn, a tool
 * call, another reasoning turn — not one per conversational turn. Rendering
 * them raw gave a three-question chat fourteen "Architect" headers. Consecutive
 * assistant messages belong to the same turn, so merge them into one block: one
 * header, the steps in order, and the answer panels amongst them.
 */
function groupTurns(messages) {
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

// ── transcript ──────────────────────────────────────────────────
function renderTranscript() {
  const el = $('transcript');
  if (!el) return;
  toolSeq = 0;
  // Only the conversation itself is shown: user turns and assistant turns.
  // Anything else the engine reports (system prompts, scaffolding, context
  // dumps) is not chat and once leaked into the transcript above the user's
  // own message. Errors still show, whatever type carries them.
  //
  // Every part carries a stable key (its message id + index) so an expanded
  // Reasoning block or tool card can be restored after a rebuild — a poll
  // landing mid-read used to snap them shut.
  const tagged = state.messages
    .filter((m) => m.error || m.type === 'user' || m.type === 'assistant')
    .map((m) => (m.parts ? { ...m, parts: m.parts.map((p, i) => ({ ...p, _k: `${m.id}:${i}` })) } : m));
  const showable = groupTurns(tagged);
  const pending = renderPermissions() + renderForms();
  const hasHistory = showable.length > 0 || Boolean(pending);
  // The dock is a bare composer while empty and fills the stage once there is
  // anything to show; the CSS keys off this class, so set it on every render.
  $('chatDock')?.classList.toggle('has-history', hasHistory);

  // Nothing in the conversation changed since the last render: leave the DOM —
  // and whatever the operator has open — exactly as it is.
  const sig = hasHistory
    ? `${showable.map((m) => `${m.id}:${m.completed || 0}:${(m.parts || []).length}`).join(',')}|${pending.length}|${state.streaming}`
    : '';
  if (sig && sig === state.renderSig) {
    renderChatNav();
    return;
  }
  state.renderSig = sig;

  if (!hasHistory) {
    // nothing to show: collapse the transcript entirely, so the dock is just
    // the composer and the empty space above it belongs to the cards/napkin
    el.innerHTML = '';
    el.classList.add('is-empty');
    renderChatNav();
    return;
  }
  el.classList.remove('is-empty');
  // Stick to the bottom while new output arrives, but never yank the view away
  // from someone who has scrolled up to read.
  const stick = chatAtBottom();
  el.innerHTML = showable.map(renderMessage).join('') + pending;
  if (stick) scrollChatToBottom();
  renderChatNav();
}

// The role label shares the first line with the text; the time rides the right.
function renderMessage(m) {
  const t = hhmm(m.created);
  const stamp = t ? `<span class="msg-time">${t}</span>` : '';

  if (m.type === 'user') {
    return `<div class="msg user" data-msg="user"><div class="msg-body">
      ${stamp}<span class="msg-role">You</span><span class="msg-text">${esc(m.text)}</span>
    </div></div>`;
  }
  if (m.type === 'assistant') {
    const body = [`${stamp}<span class="msg-role">Architect</span>`];
    for (const part of m.parts || []) {
      // The model's actual answer goes in its own panel, rendered as markdown,
      // so it is visually separate from reasoning and tool noise.
      if (part.type === 'text') body.push(`<div class="msg-answer">${renderMarkdown(part.text)}</div>`);
      else if (part.type === 'reasoning')
        body.push(
          `<details class="reasoning" data-k="${esc(part._k)}"${state.open.has(part._k) ? ' open' : ''}>` +
            `<summary>Reasoning</summary><pre>${esc(part.text)}</pre></details>`,
        );
      else if (part.type === 'tool') body.push(renderTool(part));
    }
    if ((m.parts || []).length === 0 && !m.error) body.push('<span class="msg-text">…</span>');
    if (m.error) body.push(`<div class="msg-error">${esc(m.error)}</div>`);
    return `<div class="msg assistant" data-msg="assistant"><div class="msg-body">${body.join('')}</div></div>`;
  }
  const body = m.error
    ? `<div class="msg-error">${esc(m.error)}</div>`
    : `<span class="msg-text">${esc(m.text)}</span>`;
  return `<div class="msg"><div class="msg-body">${stamp}<span class="msg-role">${esc(m.type)}</span>${body}</div></div>`;
}

let toolSeq = 0;

// A tool call is one line until you ask for the detail — you rarely need the
// full payload, and a busy turn produces dozens of them.
function renderTool(part) {
  const status = String(part.status || 'unknown').toLowerCase();
  const failed = Boolean(part.failed) || /error|fail/.test(status);
  const running = /run|stream|pend|progress/.test(status);
  const cls = running ? 'warn' : failed ? 'err' : 'ok';

  // A stable key so an open card survives a re-render; toolSeq is only the
  // fallback for a part with no message identity.
  const id = part._k || `tool-${toolSeq++}`;
  const open = state.open.has(id);
  const target = toolTarget(part);
  const input = part.input !== null && part.input !== undefined ? JSON.stringify(part.input, null, 1) : '';
  const output = part.output !== null && part.output !== undefined
    ? (typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 1))
    : '';
  const hasExit = typeof part.exitCode === 'number';
  // One status label, not two. The Error button that used to sit here said the
  // same thing as this pill, and the detail is one click away in the card body.
  const label = failed ? (hasExit ? `Exit ${part.exitCode}` : 'Failed') : status;
  const detail = part.error || output || '(no output)';

  return `<div class="tool-card${open ? ' open' : ''}" data-tool-card="${esc(id)}">
    <div class="tool-head" role="button" tabindex="0" data-tool-toggle="${esc(id)}" aria-expanded="${open}" aria-controls="${esc(id)}-detail">
      <span class="status-dot ${cls}" role="img" aria-label="${esc(label)}"></span>
      <span class="tool-name">${esc(part.name)}</span>
      <span class="tool-target" title="${esc(target)}">${esc(target)}</span>
      <span class="tool-state state-pill ${cls}">${esc(label)}</span>
      <span class="tool-chev" aria-hidden="true">›</span>
    </div>
    <div class="tool-detail" id="${esc(id)}-detail"${open ? '' : ' hidden'}>
      ${input ? `<div class="tool-body"><pre>${esc(input)}</pre></div>` : ''}
      ${output ? `<div class="tool-body"><pre${failed ? ' class="is-error"' : ''}>${esc(output)}</pre></div>` : ''}
      ${part.error ? `<div class="tool-body"><pre class="is-error">${esc(part.error)}</pre></div>` : ''}
    </div>
  </div>`;
}

function toggleTool(id) {
  const card = document.querySelector(`[data-tool-card="${CSS.escape(id)}"]`);
  if (!card) return;
  const head = card.querySelector('.tool-head');
  const detail = card.querySelector('.tool-detail');
  const open = detail.hidden;
  detail.hidden = !open;
  card.classList.toggle('open', open);
  head.setAttribute('aria-expanded', String(open));
  if (open) state.open.add(id); else state.open.delete(id);
}

// ── scrolling: the transcript when it scrolls, the page when it does not ──
// In the wide layout the stage has a definite height and the transcript scrolls
// inside itself; in the stacked layout the page scrolls instead. Every scroll
// helper goes through here so both behave the same.
function chatScroller() {
  const el = $('transcript');
  return el && el.scrollHeight > el.clientHeight + 2 ? el : null;
}

function chatScrollTop() {
  const el = chatScroller();
  return el ? el.scrollTop : window.scrollY;
}

function chatAtBottom(slack = 60) {
  const el = chatScroller();
  if (el) return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - slack;
}

function scrollChatToBottom(behavior = 'auto') {
  const el = chatScroller();
  if (el) { el.scrollTo({ top: el.scrollHeight, behavior }); return; }
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
}

const myMessages = () =>
  [...document.querySelectorAll('#transcript .msg[data-msg="user"]')];

function myMessageTops() {
  const el = chatScroller();
  if (el) {
    const sRect = el.getBoundingClientRect();
    return myMessages().map((n) => n.getBoundingClientRect().top - sRect.top + el.scrollTop);
  }
  return myMessages().map((n) => n.getBoundingClientRect().top + window.scrollY);
}

/**
 * Which of my messages currently owns the top of the viewport. `cur` is the
 * last message whose top is at or above the fold; -1 means the view sits above
 * every message. Comparing raw scroll offsets is not enough: the first message
 * often sits ~10px below the content top, so a "first one below the fold" test
 * kept re-selecting it and the DOWN button never advanced past message one.
 */
function navAnchors() {
  const tops = myMessageTops();
  const at = chatScrollTop();
  let cur = -1;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= at + 12) cur = i;
  return { tops, at, cur };
}

function renderChatNav() {
  const nav = $('chatNav');
  const dock = $('chatDock');
  if (!nav || !dock) return;
  const count = myMessages().length;
  const show = count >= 3;
  nav.hidden = !show;
  if (!show) return;

  // No JS anchoring: the nav is absolutely positioned inside the dock, so it is
  // clipped to the chat pane and stays put when the window resizes.

  const { tops, cur } = navAnchors();
  // Never offer a jump that cannot happen: with nothing to scroll, both rest.
  const canScroll =
    chatScroller() !== null || document.documentElement.scrollHeight > window.innerHeight + 2;
  $('navPrev').disabled = !canScroll || cur <= 0;
  $('navNext').disabled = !canScroll || cur >= tops.length - 1;
}

/**
 * The jump buttons animate the transcript themselves. `behavior: 'smooth'`
 * hands the duration to the browser, where it cannot be tuned; 280ms here is
 * roughly 30% quicker than the browser's own smooth scroll over these
 * distances, with an ease-out so the arrival still reads as a landing.
 */
function animateScroll(el, to, ms = 280) {
  const from = el ? el.scrollTop : window.scrollY;
  const delta = to - from;
  if (Math.abs(delta) < 1) return;
  const t0 = performance.now();
  const ease = (t) => 1 - (1 - t) ** 3;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const y = from + delta * ease(p);
    if (el) el.scrollTop = y;
    else window.scrollTo(0, y);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function jumpMessage(dir) {
  const { tops, cur } = navAnchors();
  // Move exactly one message from the one currently at the fold, in the asked
  // direction. Deriving the target from the scroll offset alone got stuck on
  // the first message (its top is not at 0), which is why DOWN did nothing.
  const next = dir < 0 ? cur - 1 : cur + 1;
  if (next < 0 || next >= tops.length) return;
  const top = Math.max(0, tops[next] - 10);
  animateScroll(chatScroller(), top);
}

// The engine blocks the session until every permission request is answered.
function renderPermissions() {
  return state.permissions
    .filter((p) => p.sessionId === state.sessionId)
    .map(
      (p) => `<div class="perm-card">
        <div class="perm-head"><span class="status-dot warn" role="img" aria-label="waiting"></span>Permission needed</div>
        <p class="perm-action">${esc(p.action)}</p>
        ${p.resources?.length ? `<pre class="perm-res">${esc(p.resources.join('\n'))}</pre>` : ''}
        <div class="perm-actions">
          <button class="btn btn-primary btn-sm" data-perm="once" data-perm-id="${esc(p.requestId)}">Allow Once</button>
          <button class="btn btn-secondary btn-sm" data-perm="always" data-perm-id="${esc(p.requestId)}">Always Allow</button>
          <button class="btn btn-ghost btn-sm" data-perm="reject" data-perm-id="${esc(p.requestId)}">Reject</button>
        </div>
      </div>`,
    )
    .join('');
}

// An agent can also ask for structured input; the session blocks until it is
// answered, exactly like a permission.
function renderForms() {
  return (state.forms || [])
    .filter((f) => f.sessionId === state.sessionId)
    .map(
      (f) => `<div class="form-card" data-form-card="${esc(f.id)}">
        <div class="form-head"><span class="status-dot warn" role="img" aria-label="waiting"></span>Input Needed</div>
        <p class="form-title">${esc(f.title)}</p>
        ${(f.fields || []).map(formField).join('')}
        <div class="perm-actions">
          <button class="btn btn-primary btn-sm" data-form-reply="${esc(f.id)}">Send Answer</button>
        </div>
      </div>`,
    )
    .join('');
}

function formField(field) {
  const key = esc(field.key);
  const label = esc(field.title || field.key);
  const hint = field.description ? ` title="${esc(field.description)}"` : '';
  const req = field.required ? ' *' : '';
  const options = Array.isArray(field.options) ? field.options : [];

  if (field.type === 'boolean') {
    return `<label class="form-check"><input type="checkbox" data-form-key="${key}" ${field.default ? 'checked' : ''} />${label}${req}</label>`;
  }
  if (field.type === 'multiselect') {
    return `<label class="form-field"><span>${label}${req}</span>
      <select data-form-key="${key}" multiple size="${Math.min(5, options.length || 3)}">
        ${options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}
      </select></label>`;
  }
  if (options.length) {
    return `<label class="form-field"><span>${label}${req}</span>
      <select data-form-key="${key}">
        ${options.map((o) => `<option value="${esc(o.value)}"${o.value === field.default ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select></label>`;
  }
  const type = field.type === 'number' || field.type === 'integer' ? 'number' : 'text';
  return `<label class="form-field"><span>${label}${req}</span>
    <input type="${type}" data-form-key="${key}" value="${esc(field.default ?? '')}" placeholder="${esc(field.placeholder || '')}" /></label>`;
}

function collectFormAnswer(formId) {
  const card = document.querySelector(`[data-form-card="${CSS.escape(formId)}"]`);
  const answer = {};
  for (const el of card?.querySelectorAll('[data-form-key]') || []) {
    const key = el.dataset.formKey;
    if (el.tagName === 'SELECT' && el.multiple) answer[key] = [...el.selectedOptions].map((o) => o.value);
    else if (el.type === 'checkbox') answer[key] = el.checked;
    else if (el.type === 'number') answer[key] = el.value === '' ? null : Number(el.value);
    else answer[key] = el.value;
  }
  return answer;
}

async function replyForm(formId) {
  const sessionId = state.sessionId;
  const answer = collectFormAnswer(formId);
  state.forms = state.forms.filter((f) => f.id !== formId);
  renderTranscript();
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/forms/${encodeURIComponent(formId)}/reply`, { answer });
    toast('Answer Sent');
  } catch (err) {
    toast('Could not send the answer', err.message);
    refreshPending();
  }
}

// ── things that can block a session ─────────────────────────────
/**
 * Permissions, forms and the engine's own list of running sessions. A blocked
 * session emits nothing at all, so polling this is the only way to notice it —
 * and it is what restores the prompt after a reload.
 */
async function refreshPending() {
  let p;
  try {
    p = await api('GET', '/api/pending');
  } catch {
    return;
  }

  // The engine is the authority on what is running; SSE keeps us snappy
  // between polls and this corrects any drift.
  const active = new Set(p.active || []);
  for (const id of active) if (!state.busySince.has(id)) state.busySince.set(id, Date.now());
  for (const id of [...state.busySince.keys()]) if (!active.has(id)) state.busySince.delete(id);
  state.busySessions = active;

  state.permissions = (p.permissions || []).map((x) => ({
    sessionId: x.sessionId,
    requestId: x.requestId,
    action: x.action,
    resources: x.resources,
  }));
  state.forms = p.forms || [];

  renderTree();
  if (state.view === 'session') renderTranscript();
}

// ── the project plan ────────────────────────────────────────────
// `.synapse\plan.json` in the session's project folder, written by the Architect
// and read here. The file is the source of truth: this pane only renders it, and
// says so plainly when the file is malformed rather than hiding the problem.
const PLAN_STATUS = { todo: 'Todo', doing: 'Doing', done: 'Done', blocked: 'Blocked', failed: 'Failed' };

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function loadPlan() {
  if (!state.sessionId) {
    state.planState = null;
    renderPlan();
    return;
  }
  try {
    state.planState = await api('GET', `/api/sessions/${encodeURIComponent(state.sessionId)}/plan`);
  } catch {
    state.planState = null;
  }
  renderPlan();
}

function renderPlan() {
  const body = $('planBody');
  if (!body) return;
  const st = state.planState;
  const rel = st?.relative || '.synapse\\plan.json';

  // A file we cannot read is the Architect's to fix, so say exactly what is
  // wrong and where, rather than showing an empty pane.
  if (st?.error) {
    body.innerHTML =
      `<p class="plan-error">${esc(st.error)}</p>` +
      `<p class="rail-note plan-meta">${esc(rel)}</p>`;
    return;
  }

  const tasks = st?.plan?.tasks || [];
  if (!tasks.length) {
    body.innerHTML = `<p class="rail-note">No plan yet. Ask the Architect to plan this job — it owns ${esc(rel)}.</p>`;
    return;
  }

  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const meta = [`${counts.done || 0}/${tasks.length} done`];
  if (counts.doing) meta.push(`${counts.doing} in flight`);
  if (counts.blocked) meta.push(`${counts.blocked} blocked`);
  if (counts.failed) meta.push(`${counts.failed} failed`);
  if (st.mtime) meta.push(ago(st.mtime));

  body.innerHTML =
    (st.plan.goal ? `<p class="plan-goal">${esc(st.plan.goal)}</p>` : '') +
    `<ol class="plan-list">${tasks
      .map((t) => {
        const status = PLAN_STATUS[t.status] ? t.status : 'todo';
        return `<li class="plan-task" data-status="${status}">
          <span class="plan-dot" role="img" aria-label="${esc(PLAN_STATUS[status])}"></span>
          <span class="plan-main">
            <span class="plan-title">${esc(t.title)}</span>
            ${t.result ? `<span class="plan-result">${esc(t.result)}</span>` : ''}
            ${t.note ? `<span class="plan-note">${esc(t.note)}</span>` : ''}
          </span>
          <span class="plan-role">${esc(t.role)}</span>
        </li>`;
      })
      .join('')}</ol>` +
    (st.problems?.length
      ? `<p class="plan-problems">${st.problems.map((p) => esc(p)).join('<br>')}</p>`
      : '') +
    `<p class="rail-note plan-meta">${esc(meta.join(' · '))}</p>`;
}

async function renderToolUsage() {
  const note = $('toolUsageNote');
  const table = $('toolUsage');
  const meta = $('toolUsageMeta');
  if (!note || !table) return;
  let stats = null;
  try {
    stats = await api('GET', '/api/tools/stats');
  } catch { /* engine down */ }

  if (!stats || !stats.total) {
    note.hidden = false;
    note.textContent = 'No tool calls recorded yet. The census fills in as sessions run.';
    table.hidden = true;
    if (meta) meta.textContent = '';
    return;
  }
  note.hidden = true;
  table.hidden = false;
  table.querySelector('tbody').innerHTML = stats.tools
    .slice(0, 8)
    .map(
      (t) => `<tr>
        <td class="tool-name" title="${esc(t.key)}">${esc(t.key)}</td>
        <td class="tool-time">${t.calls}</td>
        <td class="tool-time${t.failed ? ' slow' : ''}">${t.failed || ''}</td>
        <td class="tool-time${t.avgMs > 1000 ? ' slow' : ''}">${t.avgMs ? fmtMs(t.avgMs) : ''}</td>
      </tr>`,
    )
    .join('');
  if (meta) {
    meta.textContent = `${stats.total} calls · ${stats.failed} failed (${Math.round(stats.failRate * 100)}%)`;
  }
}

function fmtMs(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The probe's per-case results. A case is "clean" when the turn closed, the
 * tool we asked for actually ran, and none of its calls failed — anything else
 * is worth looking at, so it gets a coloured dot and, when there is a message,
 * the standard red Error button.
 */
async function renderProbe() {
  const note = $('probeNote');
  const table = $('probeTable');
  const meta = $('probeMeta');
  const btn = $('runProbe');
  if (!note || !table) return;

  let st = null;
  try {
    st = await api('GET', '/api/tools/probe');
  } catch {
    return;
  }

  if (btn) {
    btn.disabled = Boolean(st.running);
    btn.textContent = st.running ? 'Probe Running…' : 'Run Tool Probe';
  }

  const results = st.results || [];
  const modelEl = $('probeModel');
  if (modelEl) {
    // The full provider/id, ellipsised by CSS when it does not fit; the ref is
    // in the tooltip so the truncated part is still available.
    modelEl.textContent = st.model || '';
    modelEl.title = st.model || '';
    modelEl.hidden = !modelEl.textContent;
  }
  if (!results.length) {
    note.hidden = false;
    note.textContent = st.running
      ? st.current === 'toolset'
        ? 'Asking the model which tools it has…'
        : `Running case "${st.current || '…'}"…`
      : 'Runs every tool once and records what happened, and how long it took.';
    table.hidden = true;
    if (meta) meta.textContent = '';
    return;
  }

  note.hidden = true;
  table.hidden = false;
  table.querySelector('tbody').innerHTML = results
    .map((r) => {
      const label = r.ok
        ? 'clean'
        : r.offered === false
          ? 'not offered by this model'
          : r.timedOut
            ? 'timeout'
            : r.missing
              ? 'not called'
              : 'failed';
      const cls = r.ok ? 'ok' : r.offered === false || r.timedOut ? 'warn' : 'err';
      const detail = r.errors?.length
        ? r.errors.map((e) => `${e.tool}${e.exitCode != null ? ` (exit ${e.exitCode})` : ''}: ${e.detail}`).join('\n\n')
        : r.error || '';
      const errBtn = detail
        ? `<button class="err-btn" data-error-title="${esc(r.id)}" data-error="${esc(detail)}">Error</button>`
        : '';
      // The time shown is the tool's own execution. The turn took far longer,
      // but almost all of that is the model thinking — showing the turn time
      // here would make every tool look slow.
      const turn = r.ms ? `turn ${fmtMs(r.ms)}` : '';
      const tool = (r.used || []).join(', ') || r.expect || '—';
      // A failed case shows the Error button alone; a red dot next to it said
      // exactly the same thing and cost a column of width.
      const status = errBtn
        ? errBtn
        : `<span class="status-dot ${r.ok ? 'ok' : 'warn'}" role="img" aria-label="${esc(label)}"></span>`;
      return `<tr>
        <td class="tool-name" title="${esc(r.id)} · ran ${esc(tool)} · ${esc(label)}${turn ? ` · ${esc(turn)}` : ''}">${esc(r.id)}</td>
        <td class="tool-time${r.toolMs > 1000 ? ' slow' : ''}" title="tool ${fmtMs(r.toolMs)}${turn ? ` · ${turn}` : ''}">${r.toolMs ? fmtMs(r.toolMs) : ''}</td>
        <td class="tool-result">${status}</td>
      </tr>`;
    })
    .join('');

  if (meta) {
    const passed = results.filter((r) => r.ok).length;
    meta.textContent = st.running
      ? `${results.length}/${st.cases?.length || results.length} done · running "${st.current || '…'}"`
      : `${passed}/${results.length} clean · tool times, not model times · ${relTime(st.finishedAt)}`;
  }
}

function permissionFromEvent(ev) {
  const d = ev.raw?.data || ev.raw?.properties || ev.raw || {};
  const req = d.request || d;
  return {
    requestId: d.requestID || d.id || req.id,
    action: req.action || req.title || req.metadata?.title || 'tool call',
    resources: Array.isArray(req.resources) ? req.resources : [],
  };
}

async function replyPermission(requestId, decision) {
  const sessionId = state.sessionId;
  state.permissions = state.permissions.filter((p) => p.requestId !== requestId);
  renderTranscript();
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/permission`, { requestId, decision });
  } catch (err) {
    toast('Could not answer the request', err.message);
  }
}

// ── composer ────────────────────────────────────────────────────
function renderComposer() {
  const hasSession = Boolean(state.sessionId);
  $('sendBtn').disabled = state.busy && !hasSession;
  $('stopBtn').disabled = !state.busy || !hasSession;
}

async function send() {
  const input = $('promptInput');
  const text = input.value.trim();
  if (!text) return;

  if (!state.sessionId) {
    toast('No session open', 'Pick a session on the left, or start a new one.');
    return;
  }

  input.value = '';
  autoGrow(input);
  try {
    await ensureSession();
    state.streaming = true;
    state.busy = true;
    renderComposer();
    state.messages.push({ id: 'local-' + Date.now(), type: 'user', text, created: Date.now() });
    renderTranscript();
    await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/messages`, { text });
    await loadMessages();
  } catch (err) {
    toast('Send failed', err.message);
  } finally {
    state.streaming = false;
    renderComposer();
  }
}

// A session always starts in Single mode; Multi is switched live.
async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const general = state.projects.find((p) => p.general);
  if (!general) throw new Error('no General project');
  const { session } = await api('POST', '/api/sessions', sessionBody(general.id));
  state.sessionId = session.id;
  state.view = 'session';
  state.mode = sessionMode(session);
  renderMode();
  setView();
  await loadProjects();
  return state.sessionId;
}

async function interrupt() {
  if (!state.sessionId) return;
  try { await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/interrupt`); }
  catch (err) { toast('Stop failed', err.message); }
}

/** Interrupt any session, from the rail — the way out of a stalled run. */
async function interruptSession(sessionId) {
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`);
    state.busySessions.delete(sessionId);
    state.busySince.delete(sessionId);
    renderTree();
    toast('Interrupted', 'The stuck request was cancelled.');
    refreshPending();
  } catch (err) {
    toast('Could not interrupt', err.message);
  }
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}

// ── live event stream ───────────────────────────────────────────
const reloadMessages = debounce(() => loadMessages(), 250);
const reloadProjects = debounce(() => loadProjects(), 600);

function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { state.streamLive = true; renderStatus(); };
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.kind === 'hello') { state.streamLive = true; renderStatus(); return; }

    // Synapse's own notification: the session was just auto-named.
    if (ev.kind === 'sessions') {
      reloadProjects();
      if (ev.sessionId === state.sessionId) updateSessionHeader();
      return;
    }

    // The tool probe reports its own progress; it is not a session event.
    if (ev.kind === 'probe') {
      renderProbe();
      if (ev.type === 'probe.finished') {
        const results = ev.results || [];
        const passed = results.filter((r) => r.ok).length;
        toast('Tool Probe Finished', `${passed}/${results.length} cases clean — see Tools In Use.`);
      }
      return;
    }

    // A background model check finished: fold the toolset into the model list
    // and refresh the pickers' meta (the menu shows a tool count when known).
    if (ev.kind === 'model') {
      const m = state.models.find((x) => x.ref === ev.ref);
      if (m && Array.isArray(ev.tools) && ev.tools.length) {
        m.tools = ev.tools;
        pickers.forEach((p) => {
          if (p.sel.value === ev.ref) {
            syncPickerInput(p.input);
            renderEffort(p.sel.dataset.role);
          }
        });
      }
      return;
    }

    setEventChip(ev.type);
    const mine = !ev.sessionId || ev.sessionId === state.sessionId;
    // any traffic from a session counts as progress against the stall timer
    if (ev.sessionId) state.busySince.set(ev.sessionId, Date.now());

    // A tool that is still executing is progress, even though it emits nothing.
    if (ev.sessionId) {
      if (ev.type === 'session.tool.called' || ev.type === 'session.tool.input.ended') {
        state.toolsInFlight.add(ev.sessionId);
      } else if (
        ev.type === 'session.tool.success' ||
        ev.type === 'session.tool.failed' ||
        ev.type === 'shell.exited' ||
        /^session\.execution\.(succeeded|failed|interrupted)$/.test(ev.type)
      ) {
        state.toolsInFlight.delete(ev.sessionId);
      }
    }

    if (ev.kind === 'status') {
      // Track every session, not just the open one, so the rail can show which
      // project or session is actually working right now.
      let changed = false;
      if (ev.sessionId) {
        const busy = state.busySessions.has(ev.sessionId);
        if (ev.type === 'session.execution.started' && !busy) { state.busySessions.add(ev.sessionId); changed = true; }
        else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(ev.type) && busy) {
          state.busySessions.delete(ev.sessionId);
          changed = true;
        }
      }
      if (mine) {
        if (ev.type === 'session.execution.started') state.busy = true;
        else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(ev.type) || ev.type === 'session.idle') state.busy = false;
        renderComposer();
      }
      if (changed) renderTree();
      reloadProjects();
      if (mine) reloadMessages();
      return;
    }

    if (ev.kind === 'permission') {
      if (ev.type === 'permission.asked' && mine) {
        const p = permissionFromEvent(ev);
        if (p.requestId && !state.permissions.some((x) => x.requestId === p.requestId)) {
          state.permissions.push({ sessionId: ev.sessionId, ...p });
          renderTranscript();
        }
      }
      return;
    }

    if (ev.kind === 'tool' || ev.kind === 'message') {
      reloadProjects();
      if (mine) reloadMessages();
    }
  };
  es.onerror = () => { state.streamLive = false; renderStatus(); };
}

// ── settings (live) ─────────────────────────────────────────────
function readPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) ?? '';
}
function writePath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = o[keys[i]] || {}; o = o[keys[i]]; }
  o[keys[keys.length - 1]] = value;
}

function renderSettings() {
  const c = state.config;
  if (!c) { $('settingsBody').innerHTML = '<p class="rail-note">Config unavailable.</p>'; return; }

  const f = (label, path, opts = {}) => `
    <label class="set-field${opts.wide ? ' wide' : ''}">
      <span>${esc(label)}</span>
      <input data-path="${path}" type="${opts.type || 'text'}" value="${esc(opts.value !== undefined ? opts.value : readPath(c, path))}" ${opts.attr || ''} />
    </label>`;
  const sel = (label, path, options, opts = {}) => `
    <label class="set-field${opts.wide ? ' wide' : ''}">
      <span>${esc(label)}</span>
      <select data-path="${path}">
        ${options.map((o) => `<option value="${esc(o.v)}"${o.v === readPath(c, path) ? ' selected' : ''}>${esc(o.l)}</option>`).join('')}
      </select>
    </label>`;
  const check = (label, path) => `
    <label class="set-check">
      <input data-path="${path}" type="checkbox" ${readPath(c, path) ? 'checked' : ''} />
      <span>${esc(label)}</span>
    </label>`;
  const group = (title, body, cols) => `<section class="set-group"><h4>${title}</h4><div class="set-grid${cols === 3 ? ' cols-3' : ''}">${body}</div></section>`;

  // Show what the engine actually resolved when the config is blank: these two
  // fields mean "auto" when empty, and an empty box hides the path in use.
  const detected = state.status?.engine || {};
  const binaryValue = readPath(c, 'engine.opencode.binary') || detected.binary || '';
  const homeValue = readPath(c, 'engine.opencode.home') || detected.home || '';

  // No model or agent fields here: there is no "default" — every role owns its
  // model and effort, chosen on its card and persisted in the config file.
  $('settingsBody').innerHTML = [
    group('Server',
      f('Host', 'server.host') +
      f('Port', 'server.port', { type: 'number' }) +
      check('Open browser on start', 'server.openBrowser')),
    group('Engine',
      f('Engine type', 'engine.type') +
      f('Engine port', 'engine.opencode.port', { type: 'number' }) +
      f('opencode.exe path (blank = auto-detect)', 'engine.opencode.binary', { wide: true, value: binaryValue }) +
      f('Password (blank = keep existing)', 'engine.opencode.password', { type: 'password', attr: 'placeholder="unchanged"' }) +
      f('Start timeout (ms)', 'engine.opencode.startTimeoutMs', { type: 'number' }) +
      f('Engine home (blank = data\\engine\\opencode)', 'engine.opencode.home', { wide: true, value: homeValue })),
    group('Working directory',
      f('Where new sessions run (blank = workspace)', 'defaults.directory', { wide: true })),
    group('Model checks',
      f('Max asks per model (1–20)', 'modelChecks.maxAsks', { type: 'number' }) +
      `<div class="set-field"><span>Ask counters</span>
        <button type="button" class="btn btn-warn btn-sm" data-reset-asks>Reset Ask Counters</button>
      </div>`),
    group('Tools',
      check('Clear the tool census on every start', 'tools.resetOnBoot') +
      `<div class="set-field"><span>Tool census</span>
        <button type="button" class="btn btn-warn btn-sm" data-clear-tools>Clear Tool Census</button>
      </div>`),
    group('Chat',
      `<label class="set-field"><span>Answer panel colour</span>
        <span class="color-row">
          <input type="color" data-path="ui.answerBg" value="${esc(readPath(c, 'ui.answerBg') || '#382f19')}" aria-label="Answer panel background colour" />
          <input type="text" class="color-hex" data-color-hex="ui.answerBg" value="${esc(readPath(c, 'ui.answerBg') || '#382f19')}" spellcheck="false" aria-label="Answer panel background hex" />
        </span>
      </label>`),
    group('Logging',
      sel('Level', 'logging.level', [
        { v: 'debug', l: 'Debug' },
        { v: 'info', l: 'Info' },
        { v: 'warn', l: 'Warn' },
        { v: 'error', l: 'Error' },
      ]) +
      f('Retention (days)', 'logging.retentionDays', { type: 'number' }) +
      f('Max file size (MB)', 'logging.maxFileMb', { type: 'number' }), 3),
  ].join('');
}

async function saveSettings() {
  const draft = JSON.parse(JSON.stringify(state.config));
  for (const el of $('settingsBody').querySelectorAll('[data-path]')) {
    const path = el.dataset.path;
    let value = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') value = Number(value);
    if (el.type === 'number' && !Number.isFinite(value)) continue;
    writePath(draft, path, value);
  }
  // A model change can strand a thinking effort the new model does not offer
  // (or that the chevron control cannot express). Clear it rather than let the
  // config and the button disagree.
  const effortIds = (ref) => topEfforts(modelByRef(ref)).map((v) => v.id);
  for (const entry of Object.values(draft.roles || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (!effortIds(entry.ref).includes(entry.variant)) delete entry.variant;
  }
  try {
    state.config = await api('PUT', '/api/config', draft);
    applyUiTheme();
    toast('Settings saved', 'Restart Synapse to apply engine or server changes.');
    await loadModels();
  } catch (err) {
    toast('Could not save settings', err.message);
  }
}

async function resetModelAsks() {
  try {
    const r = await api('POST', '/api/models/reset-asks');
    toast('Ask Counters Reset', `${r.models} model(s) may be asked again.`);
  } catch (err) {
    toast('Could Not Reset Ask Counters', err.message);
  }
}

async function clearToolCensus() {
  try {
    await api('POST', '/api/tools/reset');
    await renderToolUsage();
    toast('Tool Census Cleared', 'The Tools in use panel starts from zero.');
  } catch (err) {
    toast('Could Not Clear the Tool Census', err.message);
  }
}

function openSettings() { renderSettings(); bindColorInputs($('settingsBody')); $('settingsModal').hidden = false; }
function closeSettings() { $('settingsModal').hidden = true; }

/**
 * The answer panel's fill is the operator's choice (Settings → Chat). It is a
 * CSS variable on the root so the transcript repaints instantly while they try
 * colours in the picker, and it is read from config on boot and after a save.
 */
function applyUiTheme() {
  const bg = state.config?.ui?.answerBg || '#382f19';
  document.documentElement.style.setProperty('--answer-bg', bg);
}

/** Live preview: colour input and hex field mirror each other as you type. */
function bindColorInputs(scope) {
  const color = scope.querySelector('input[type="color"][data-path]');
  const hex = scope.querySelector('input[data-color-hex]');
  if (!color || !hex) return;
  const paint = (value) => {
    document.documentElement.style.setProperty('--answer-bg', value);
  };
  color.addEventListener('input', () => { hex.value = color.value; paint(color.value); });
  hex.addEventListener('input', () => {
    const v = hex.value.trim();
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) { color.value = v; paint(v); }
  });
}

// ── wiring ──────────────────────────────────────────────────────
function wire() {
  setupModelPickers();
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('stopBtn').addEventListener('click', interrupt);
  $('modeToggle').addEventListener('click', switchMode);
  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('emptyNewSession').addEventListener('click', () => createSession(state.projects.find((p) => p.general)?.id));
  $('addProjectBtn').addEventListener('click', addProject);

  // conversation navigation + collapsible tool calls
  $('navPrev').addEventListener('click', () => jumpMessage(-1));
  $('navNext').addEventListener('click', () => jumpMessage(1));
  let navRaf = 0;
  $('transcript').addEventListener('scroll', () => {
    if (navRaf) return;
    navRaf = requestAnimationFrame(() => { navRaf = 0; renderChatNav(); });
  });
  $('transcript').addEventListener('click', (e) => {
    const formBtn = e.target.closest('[data-form-reply]');
    if (formBtn) { replyForm(formBtn.dataset.formReply); return; }
    if (e.target.closest('[data-error]')) return; // the error button is not a toggle
    const head = e.target.closest('[data-tool-toggle]');
    if (head) toggleTool(head.dataset.toolToggle);
  });
  $('transcript').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = e.target.closest('[data-tool-toggle]');
    if (head) { e.preventDefault(); toggleTool(head.dataset.toolToggle); }
  });
  // <details> fires `toggle` (no bubbling), so capture it to remember which
  // Reasoning blocks the operator opened.
  $('transcript').addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || d.tagName !== 'DETAILS' || !d.classList.contains('reasoning')) return;
    const k = d.dataset.k;
    if (!k) return;
    if (d.open) state.open.add(k); else state.open.delete(k);
  }, true);
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('cancelSettings').addEventListener('click', closeSettings);
  $('saveSettings').addEventListener('click', saveSettings);

  // The probe takes minutes, so it is started and then reported over the stream.
  $('runProbe').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/tools/probe/run');
      if (!r.started) {
        toast('Probe Not Started', r.reason || 'Something is already running.');
        return;
      }
      toast('Tool Probe Started', 'Every tool runs once — results appear as they land.');
      renderProbe();
    } catch (err) {
      toast('Could Not Start The Probe', err.message);
    }
  });

  const input = $('promptInput');
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  $('projectTree').addEventListener('click', (e) => {
    if (e.target.closest('[data-soon]')) return;
    const stop = e.target.closest('[data-interrupt]');
    if (stop) { interruptSession(stop.dataset.interrupt); return; }
    const renameProjectBtn = e.target.closest('[data-rename-project]');
    if (renameProjectBtn) { renameProject(renameProjectBtn.dataset.renameProject); return; }
    const delProject = e.target.closest('[data-del-project]');
    if (delProject) { removeProject(delProject.dataset.delProject); return; }
    const delSession = e.target.closest('[data-del-session]');
    if (delSession) { removeSession(delSession.dataset.delSession); return; }
    const rename = e.target.closest('[data-rename]');
    if (rename) { state.renaming = rename.dataset.rename; renderTree(); return; }
    const fresh = e.target.closest('[data-new]');
    if (fresh) { createSession(fresh.dataset.new); return; }
    const project = e.target.closest('[data-project]');
    if (project) { toggleProject(project.dataset.project); return; }
    const row = e.target.closest('[data-session]');
    if (row && !e.target.closest('.tree-edit, .tree-x')) openSession(row.dataset.session);
  });

  $('projectTree').addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('tree-rename')) return;
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    if (e.key === 'Escape') { e.preventDefault(); state.renaming = null; renderTree(); }
  });
  $('projectTree').addEventListener('focusout', (e) => {
    if (e.target.classList.contains('tree-rename') && state.renaming) commitRename();
  });

  document.querySelectorAll('.role-model').forEach((sel) =>
    sel.addEventListener('change', () => setRoleModel(sel.dataset.role, sel.value)),
  );
  document.querySelectorAll('.role-effort').forEach((btn) =>
    btn.addEventListener('click', () => cycleEffort(btn.dataset.role)),
  );

  // mockup affordances: clearly announce what is not wired yet
  document.addEventListener('click', (e) => {
    // a click anywhere outside the open model menu closes it
    if (menuRole && !e.target.closest('.model-search') && !e.target.closest('#modelMenu')) closeModelMenu();

    const resetAsks = e.target.closest('[data-reset-asks]');
    if (resetAsks) { e.preventDefault(); resetModelAsks(); return; }

    const clearTools = e.target.closest('[data-clear-tools]');
    if (clearTools) { e.preventDefault(); clearToolCensus(); return; }

    const perm = e.target.closest('[data-perm]');
    if (perm) { e.preventDefault(); replyPermission(perm.dataset.permId, perm.dataset.perm); return; }

    const soon = e.target.closest('[data-soon]');
    if (soon) { e.preventDefault(); e.stopPropagation(); toast('Not wired yet', soon.dataset.soon); return; }

    const err = e.target.closest('[data-error]');
    if (err) { e.preventDefault(); openError(err.dataset.errorTitle || 'Error', err.dataset.error || ''); }
  });

  $('dialogOk').addEventListener('click', () => closeDialog(readDialog()));
  $('dialogCancel').addEventListener('click', () => closeDialog(null));
  $('dialogClose').addEventListener('click', () => closeDialog(null));
  $('dialogModal').addEventListener('click', (e) => { if (e.target === $('dialogModal')) closeDialog(null); });
  $('dialogModal').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); $('dialogOk').click(); } });

  $('closeError').addEventListener('click', closeError);
  $('closeErrorTop').addEventListener('click', closeError);
  $('errorModal').addEventListener('click', (e) => { if (e.target === $('errorModal')) closeError(); });
  $('copyError').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('errorText').textContent);
      toast('Copied', 'Error text is on the clipboard.');
    } catch {
      toast('Copy failed', 'Clipboard access was blocked.');
    }
  });
  $('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('dialogModal').hidden) closeDialog(null);
    else if (!$('errorModal').hidden) closeError();
    else if (!$('settingsModal').hidden) closeSettings();
  });

  window.addEventListener('resize', () => requestAnimationFrame(() => {
    fitStageHeight();
    if (state.view === 'session') applyRoleCardsLayout({ animate: false });
    drawActivePath();
    renderChatNav();
  }));

  // The card heights change after the fonts load (and with any content change),
  // which used to leave the wrapper's max-height stale by a pixel or two — the
  // Architect card was cut and the wrapper grew a scrollbar. Re-measure whenever
  // the topology's box changes.
  if (window.ResizeObserver) {
    let topoRaf = 0;
    new ResizeObserver(() => {
      if (topoRaf) return;
      topoRaf = requestAnimationFrame(() => {
        topoRaf = 0;
        if (state.view === 'session') applyRoleCardsLayout({ animate: false });
        drawActivePath();
      });
    }).observe($('topology'));
  }
  // Fonts settle a tick after first paint; measure once more when they do.
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (state.view === 'session') applyRoleCardsLayout({ animate: false });
    }).catch(() => {});
  }

  setInterval(refreshStatus, 10000);

  // Blocked or stalled sessions emit nothing, so they have to be polled for.
  setInterval(refreshPending, 8000);
  // Re-render the rail as sessions cross into "stalled".
  let lastStalled = 0;
  setInterval(() => {
    if (state.busySessions.size === 0) return;
    const stalled = [...state.busySessions].filter(isStalled).length;
    if (stalled !== lastStalled) { lastStalled = stalled; renderTree(); }
  }, 5000);
  setInterval(() => { if (state.view !== 'none') renderToolUsage(); }, 30000);
  // Belt and braces for the plan pane: the SSE event is the fast path, this
  // catches a tab that missed it.
  setInterval(() => { if (state.view !== 'none') loadPlan(); }, 30000);
}

async function boot() {
  wire();
  fitStageHeight();
  state.config = await api('GET', '/api/config').catch(() => null);
  applyUiTheme();
  // every new session starts Single; an opened session sets its own mode
  state.mode = 'single';
  renderMode();
  setView();
  await refreshStatus();
  await loadModels();
  await loadProjects();
  renderTranscript();
  connectStream();
  refreshPending();
  renderProbe();
  // nothing is auto-opened: the operator picks what to work on
}

boot();

