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
  // "Keep building": the open session's switch for running the plan to the end.
  auto: false,
  permissions: [],
  busy: false,
  busySessions: new Set(),
  busySince: new Map(),
  toolsInFlight: new Set(),
  // Delegated work in flight, keyed by directory: one worker per project, so a
  // project has at most one entry. The cards and the live path are drawn from
  // this, and `GET /api/runs` is what a page opened mid-run starts from.
  runs: new Map(),
  // Signature of what the role cards are showing, so a poll that learned nothing
  // does not re-measure the wrapper and jiggle the chat.
  roleSig: '',
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
  // Signature of what the question panel is showing, so a poll does not rebuild
  // it and discard answers the operator has already given.
  askSig: '',
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
let dialogDismissable = true;
let dialogOkResult;

function openDialog({
  title,
  message = '',
  fields = [],
  confirmLabel = 'OK',
  danger = false,
  extra = null,
  okResult = undefined,
  dismissable = true,
  tone = null,
  afterRender,
}) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogFields = fields;
    dialogDismissable = dismissable;
    dialogOkResult = okResult;
    $('dialogTitle').textContent = title;
    $('dialogMessage').textContent = message;
    $('dialogMessage').hidden = !message;
    $('dialogOk').textContent = confirmLabel;
    $('dialogOk').className = `btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`;
    // A third choice, for the one dialog that needs three (a folder that already
    // exists: cancel, wipe it, or carry on with it).
    const extraBtn = $('dialogExtra');
    extraBtn.hidden = !extra;
    if (extra) {
      extraBtn.textContent = extra.label;
      extraBtn.dataset.result = extra.result || 'extra';
    }
    // "Non-bypassable" means exactly this: no close button, no backdrop dismiss, no
    // Escape. The operator must pick one of the answers.
    $('dialogClose').hidden = !dismissable;
    document.querySelector('#dialogModal .modal')?.classList.toggle('is-clash', tone === 'clash');
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

/** The badge of shame: what a provider said about this model, when it said it,
 *  and how to take the mark off. It is the operator's own note — nothing is said
 *  to any model about another model's reputation. */
const issuesTitle = (m) =>
  [...(m.issues || []).map((i) => `${new Date(i.at).toLocaleString()} - ${i.message}`), 'Click to clear.'].join('\n');

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
}

/**
 * Take the mark off a model. UI-only and instant: no turn, no question, nothing
 * said to anybody — the operator checked it and it works again.
 */
async function clearModelIssues(ref) {
  const role = menuRole;
  try {
    await api('POST', '/api/models/issues/clear', { ref });
  } catch (err) {
    toast('Could Not Clear Issues', err.message);
    return;
  }
  const m = modelByRef(ref);
  if (m) m.issues = null;
  toast('Issues Cleared', `${m ? shortModel(m.name) : ref} is unmarked.`);
  // Re-open unfiltered: the input holds the model's *name*, so passing it through
  // as a search would leave the operator looking at a one-row menu.
  if (role) openModelMenu(role, false);
}

/** Re-read the catalog, so a badge earned server-side appears without a reload. */
async function refreshModels() {
  try {
    state.models = (await api('GET', '/api/models')).models;
    fillRoleModels();
  } catch { /* the catalog is not worth a toast */ }
}

function syncPickerInput(input) {
  const p = pickers.get(input.dataset.role);
  if (!p) return;
  const m = modelByRef(p.sel.value);
  input.value = m ? shortModel(m.name) : '';
  const issues = m?.issues?.length ? ` · ISSUES: ${m.issues[0].message}` : '';
  input.title = m ? `${modelTitle(m)}${issues} · type to search` : 'Type to search models';
  input.classList.toggle('has-issues', Boolean(m?.issues?.length));
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
            ${m.issues?.length ? `<span class="mo-issues" data-clear-issues="${esc(m.ref)}" title="${esc(issuesTitle(m))}">Issues</span>` : ''}
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
 * The "keep building" switch, shown between Stop and Send.
 *
 * It is only meaningful where delegation is possible, so it is hidden with no
 * session open and hidden entirely in Single mode — the runner refuses
 * delegation there, and a switch that does nothing is worse than no switch.
 */
function renderKeep() {
  const btn = $('keepBtn');
  if (!btn) return;
  const usable = state.view === 'session' && state.mode === 'multi' && Boolean(state.sessionId);
  btn.hidden = !usable;
  btn.classList.toggle('is-on', state.auto);
  btn.setAttribute('aria-pressed', String(state.auto));
  btn.title = state.auto
    ? 'Keep building: on. The Architect works through the plan, one task at a time, until it is ' +
      'done or a hard blocker stops it. Click to make it stop after each task.'
    : "Ask the Architect to keep building until it's done, unless a hard blocker stops it";
}

async function toggleKeep() {
  if (!state.sessionId) return;
  const next = !state.auto;
  try {
    const r = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/auto`, { auto: next });
    state.auto = r.auto === true;
    renderKeep();
    toast(
      state.auto ? 'Keep Building On' : 'Keep Building Off',
      state.auto
        ? 'The Architect will run the plan through to the end, unless a task is blocked.'
        : 'The Architect does one task, then stops for you.',
    );
  } catch (err) {
    toast('Could Not Change Keep Building', err.message);
  }
}

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
  renderKeep();
}

// ── role cards: the Architect is always there ───────────────────
// The cards sit in a wrapper whose max-height animates. The Architect card is
// visible in both modes — you need its model and thinking-effort controls even
// in Single — and Multi reveals the workers around it. Height is measured, not
// guessed, so the cards are never cut off mid-card.
let revealTimer = 0;
let workersPendingOff = false;
// While a card transition is in flight, re-measures wait (see applyRoleCardsLayout).
let revealUntil = 0;
// The chat's height is settled after the cards have moved: one correction at the
// end, not a per-frame chase (that overshoots the window by a frame).
let chatFitTimer = 0;

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
function applyRoleCardsLayout({ animate = true, from = null, remeasure = false } = {}) {
  const els = topologyTarget();
  if (!els || state.view !== 'session') return;
  // A re-measure landing mid-slide restarts the wrapper's transition while the
  // chat's own curve keeps going, and the two fall out of step — that is the
  // ~29px bounce the composer did while the cards were revealing. The observer
  // fires exactly then (adding `workers-on` resizes the topology), so it waits
  // for the slide to finish; a mode switch is never a re-measure and always runs.
  if (remeasure && performance.now() < revealUntil) {
    requestAnimationFrame(drawActivePath);
    return;
  }
  const { wrap, topo } = els;
  clearTimeout(revealTimer);
  clearTimeout(chatFitTimer);
  workersPendingOff = false;
  wrap.classList.add('is-open');
  // The chat's cap is set from the reveal's *target* (so the two transitions can
  // run together), and re-fitted once more when everything has settled. The
  // question panel needs none of this: as the dock's child it moves with it.
  chatFitTimer = setTimeout(fitChatHeight, 340);

  if (state.mode === 'multi') {
    // `max-height: none` does not interpolate, so growing straight out of the
    // Single resting state would snap instead of sliding. Pin the current
    // height first, force a reflow, then grow to the measured target.
    //
    // `from` is the height to animate from when the caller already changed the
    // content: a card that just gained a subtitle is taller by the time this
    // runs, and pinning *that* would snap instead of sliding. The chat's top
    // edge is what moves; its bottom is pinned by the stage's definite height.
    const fromH = from ?? Math.ceil(wrap.getBoundingClientRect().height);
    document.body.classList.add('workers-on');
    wrap.style.setProperty('--reveal-h', `${fromH}px`);
    // the reflow is what makes the reveal animate instead of snapping
    void wrap.offsetHeight;
    wrap.style.setProperty('--reveal-h', `${measureReveal(topo, $('stage'))}px`);
    revealUntil = performance.now() + 300;
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
  revealUntil = performance.now() + 300;
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
    // The session may simply not exist any more (deleted in another tab, or by
    // a scaffolding sweep). Re-reading the projects closes the dead view instead
    // of complaining about a session that is gone.
    if (/not found|404/i.test(String(err.message || ''))) {
      await loadProjects();
      return;
    }
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
    renderTree();
    return;
  }
  renderTree();
  // The open session can be deleted from another tab, or by Synapse's own
  // scaffolding sweep. Left alone, the UI keeps a dead session open and every
  // control on it answers 404 — which is how a mode switch once reported
  // "Session not found". The list is only trusted while the engine is up: with
  // the engine down it is empty for a reason that has nothing to do with this
  // session, and closing the view would be wrong.
  if (state.sessionId && state.status?.engine?.ready === true && !findSession(state.sessionId)) {
    toast('Session Closed', 'It was deleted, so it is no longer open.');
    showNothing();
  }
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
      </div>
      <div class="tree-project-body">
        <div class="tree-project-actions">
          <button class="btn-thin" data-browse-project="${esc(p.id)}" title="Open this project's folder in Explorer">Browse</button>
          <button class="btn-thin" data-cmd-project="${esc(p.id)}" title="Open a command prompt in this project's folder">Cmd</button>
        </div>
        ${
          open
            ? `<div class="tree-sessions-label">Sessions:</div>` +
              // New Session sits at the bottom: sessions read oldest-first, so
              // the new one belongs where it will actually land.
              `<div class="tree-sessions">${p.sessions.map(sessionRow).join('')}${newSessionRow(p.id)}</div>`
            : ''
        }
      </div>`);
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

/**
 * Open a project's folder in Explorer, or a command prompt at it. The backend
 * spawns a detached GUI process; nothing here tracks it, and a failure is
 * reported rather than swallowed.
 */
async function openProjectFolder(id, what) {
  try {
    await api('POST', `/api/projects/${encodeURIComponent(id)}/open`, { what });
  } catch (err) {
    toast(what === 'cmd' ? 'Could Not Open a Command Prompt' : 'Could Not Open the Folder', err.message);
  }
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

/**
 * The folder-history dialog's body: the path, the numbers as chips, and the old
 * goal as a quotation.
 *
 * The goal is shown in full and clamped by CSS to three lines *with an ellipsis*,
 * its text in the tooltip. It used to be sliced to 160 characters by the server,
 * which cut it mid-sentence with no ellipsis — the operator's word for it was "text
 * cuts off", and it read as a rendering fault rather than a summary.
 */
function clashBody(info) {
  const mins = info.plan.mtime ? Math.max(1, Math.round((Date.now() - info.plan.mtime) / 60000)) : null;
  const ago = mins === null
    ? null
    : mins < 90 ? `${mins} min ago` : mins < 60 * 36 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  const chips = [
    `${info.plan.tasks} task${info.plan.tasks === 1 ? '' : 's'}`,
    `${info.plan.done} done`,
    info.files ? `${info.files} file${info.files === 1 ? '' : 's'}` : null,
    ago ? `last touched ${ago}` : null,
  ].filter(Boolean);
  return (
    `<p class="clash-path" title="${esc(info.directory)}">${esc(info.directory)}</p>` +
    `<div class="clash-chips">${chips.map((c) => `<span class="clash-chip">${esc(c)}</span>`).join('')}</div>` +
    (info.plan.goal
      ? `<p class="clash-label">Its goal was</p>` +
        `<blockquote class="clash-goal" title="${esc(info.plan.goal)}">${esc(info.plan.goal)}</blockquote>`
      : '') +
    `<p class="clash-note">Re-using continues that plan where it left off. ` +
    `Deleting removes the folder and everything inside it — that cannot be undone.</p>`
  );
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
    // Look before creating. A folder that was a project once still holds everything
    // — and a reused name ("Test Project 1") resolves to the very same path — so
    // the operator is asked, not told, and nothing is created or deleted until
    // they answer.
    const info = await api('POST', '/api/projects/inspect', { directory });
    if (info.plan) {
      const choice = await openDialog({
        title: 'This folder was a project before',
        message: '',
        confirmLabel: 'Delete Folder And Start Fresh',
        danger: true,
        extra: { label: 'Re-Use It', result: 'reuse' },
        okResult: 'wipe',
        dismissable: false,
        tone: 'clash',
        afterRender: () => { $('dialogBody').innerHTML = clashBody(info); },
      });
      if (!choice) return; // cancelled: nothing created, nothing deleted
      if (choice === 'wipe') {
        await api('POST', '/api/projects/wipe', { directory });
        toast('Folder Wiped', `"${directory}" is empty — starting fresh.`);
      }
    }
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
  renderKeep();
  applyRoleCardsLayout();
  fitChatHeight();
  renderComposer();
  renderAskPanel();
  renderRoleActivity();
  requestAnimationFrame(drawActivePath);
}

function currentProject() {
  return projectOf(state.sessionId);
}

async function openSession(id) {
  state.view = 'session';
  state.sessionId = id;
  state.permissions = [];
  // the mode is a property of the session, not of the app
  state.mode = sessionMode(findSession(id));
  state.auto = findSession(id)?.auto === true;
  renderMode();
  renderKeep();
  $('sidebar').classList.remove('open');
  setView();
  renderTree();
  await loadMessages();
  // A session is opened to read where it got to, not where it started: put the
  // transcript at its end once, without touching the page (the role cards above it
  // are where the operator's eye goes next anyway).
  const el = chatScroller();
  if (el) el.scrollTop = el.scrollHeight;
  refreshPending();
  renderToolUsage();
  loadPlan();
}

function showNothing() {
  state.view = 'none';
  state.sessionId = null;
  state.messages = [];
  state.planState = null;
  state.auto = false;
  state.mode = 'single';
  renderMode();
  setView();
  renderTree();
  renderTranscript();
  renderPlan();
}

// ── live delegated work ─────────────────────────────────────────
// The runner broadcasts a run's whole life (`run.started` → `run.progress` →
// `run.finished`) and serves the same shape at `GET /api/runs`, so a page opened
// mid-run starts from the truth rather than from an idle screen. One worker per
// project at a time, so a project has at most one live run.
const dirKey = (d) => String(d ?? '').replace(/[\\/]+$/, '').toLowerCase();
const runIn = (project) => (project ? state.runs.get(dirKey(project.directory)) || null : null);
const currentRun = () => runIn(currentProject());
const roleLabel = (id) => ROLES.find((r) => r.id === id)?.name || String(id || '');

/** A tool call as the card's phrase: "writing calendar.py". */
function runPhrase(tool) {
  const name = String(tool?.name || '');
  const target = String(tool?.target || '');
  const file = target.split(/[\\/]/).filter(Boolean).pop() || '';
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  switch (name) {
    case 'write': return file ? `writing ${file}` : 'writing a file';
    case 'edit': return file ? `editing ${file}` : 'editing a file';
    case 'read': return file ? `reading ${file}` : 'reading';
    case 'shell': return target ? `running ${target}` : 'running a command';
    case 'grep':
    case 'glob': return file ? `searching ${file}` : 'searching';
    case 'webfetch': return 'fetching a page';
    case 'skill': return file ? `using ${file}` : 'loading a skill';
    case 'subagent': return 'delegating';
    case 'question': return 'asking the operator';
    default: return name || 'working';
  }
}

/** The newest tool call in the open transcript — the Architect's own activity
 *  while its turn is running (a worker's comes from the runner instead). */
function latestToolIn(messages) {
  let found = null;
  for (const m of messages || []) {
    for (const p of m?.parts || []) {
      if (p?.type === 'tool' && p.name) found = { name: String(p.name), target: toolTarget(p) };
    }
  }
  return found;
}

/** The card a role owns. The role id lives on its model select, which the picker
 *  code already treats as the source of truth for which card is whose. */
const cardFor = (role) => {
  const sel = document.querySelector(`#topology .role-model[data-role="${CSS.escape(String(role || ''))}"]`);
  return sel ? sel.closest('.role-card') : null;
};

/**
 * Give every card a role id and a subtitle slot.
 *
 * The ids are read off the cards' own model selects rather than written into the
 * markup a second time: one source of truth per role, and a card added to
 * index.html gets its slot without anyone remembering to add one.
 */
function initRoleCards() {
  for (const card of document.querySelectorAll('#topology .role-card')) {
    const sel = card.querySelector('.role-model[data-role]');
    if (sel) card.dataset.role = sel.dataset.role;
    if (!card.querySelector('.role-task')) {
      const slot = document.createElement('p');
      slot.className = 'role-task';
      card.append(slot);
    }
  }
}

/**
 * What every card is doing right now, and what state its role is in.
 *
 * One derivation, three things read off it: the **dot** (taking part / blocked /
 * idle but has taken part / never taken part), the card's **opacity** (a role
 * that has never been in this plan is dimmed to 80%), and the **subtitle** (who
 * the Architect is waiting on, what a worker is doing to its task, or that the
 * operator is the one being waited on).
 *
 * All of it is derived from state we already hold — the plan file, the runs the
 * runner serves, the open session's turn, the pending form — so nothing is
 * stored, a reload and a restart show the same picture, and a new plan (whose
 * tasks are all `todo` again) puts every card back to 80% by itself.
 *
 * Precedence per role: running → blocked → done → idle.
 */
function renderRoleActivity() {
  const run = currentRun();
  const archBusy = isBusy(state.sessionId);
  const archTool = archBusy ? latestToolIn(state.messages) : null;
  const form = (state.forms || [])[0] || null;
  const tasks = state.planState?.plan?.tasks || [];
  // The plan is finished when there is one and nothing in it is outstanding.
  const planFinished = tasks.length > 0 && tasks.every((t) => t.status === 'done');
  const unfinished = tasks.some((t) => t.status !== 'done');
  const rows = [];
  let sig = '';

  for (const card of document.querySelectorAll('#topology .role-card')) {
    const role = card.dataset.role;
    const mine = tasks.filter((t) => t.role === role);
    // "Has been used this session" — the server answers it from the run log, scoped
    // to the open session, so it survives a plan rewrite and a page reload and
    // starts over in a new session. Per the operator: a role card is about whether
    // this role was used for anything in this session, ever.
    const participated = (state.planState?.used || []).includes(role);
    const blocked = mine.some((t) => t.status === 'blocked' || t.status === 'failed');
    // A role whose *current* model the provider has already refused keeps its mark
    // after the run: the run is over, the dead model is still selected. It clears
    // the moment the role points at another model, or the operator clears the badge.
    const pickerValue = card.querySelector('.role-model')?.value || selectionFor(role).ref;
    const refused = pickerValue
      ? (modelByRef(pickerValue)?.issues || []).find((i) => i.kind === 'provider')
      : null;
    const skipReason = run?.skipped?.find((s) => s.role === role)?.message || refused?.message || null;

    let text = '';
    let part = '';
    let dot = 'idle';
    let chip = null;
    let skipped = false;
    // "Settled" is the Architect's resting state — finished, or waiting for the
    // operator to move. Its border goes green, the same colour every other card
    // uses for "idle, has taken part": there is nothing of ours in flight.
    let settled = false;

    if (role === 'architect') {
      // The Architect's own question first: the operator is the one being waited
      // on, and that outranks anything else the card could say.
      if (form && form.sessionId === state.sessionId) { text = 'Waiting on your answer'; dot = 'live'; }
      else if (run) { text = `Waiting on ${roleLabel(run.role)}`; part = 'initiator'; dot = 'live'; }
      else if (archBusy) { text = archTool ? runPhrase(archTool) : 'Thinking'; part = 'initiator'; dot = 'live'; }
      // Every task is done: the chip says so, and under it the Architect's own
      // one-sentence, customer-facing summary of what was built.
      else if (planFinished) {
        const summary = state.planState?.plan?.summary || '';
        text = summary || 'Plan complete';
        chip = { cls: 'role-done', text: 'Done', note: summary };
        dot = 'ok';
        settled = true;
      }
      // Nothing in flight and work outstanding: the move is the operator's, so
      // the card says it in the same place a worker's task line would be.
      else if (unfinished) { text = 'Waiting on you'; chip = { cls: 'role-waiting', text: 'Waiting on you' }; dot = 'ok'; settled = true; }
    } else if (run && run.role === role) {
      // A worker stopped on a question is not working on its task, whatever the
      // newest tool call was — it is waiting, exactly like the Architect does.
      const asking = form && form.sessionId !== state.sessionId;
      text = asking ? `Waiting on your answer (${run.title})` : `${run.title}${run.tool ? ` (${runPhrase(run.tool)})` : ''}`;
      part = 'worker';
      dot = 'live';
    } else if (skipReason) {
      // This role was tried for the task and the model refused it, or its current
      // model is still marked as refused. Mark it the way a blocker is marked: red
      // border, red label, and a red picker, because the model is what failed and
      // swapping it is the fix. It outlives the run on purpose — the dead model is
      // still selected after the report.
      skipped = true;
      text = `Skipped — ${skipReason}`;
    } else if (blocked) dot = 'err';
    else if (participated) dot = 'ok';

    // Dimmed cards are the ones that have never been in this project at all. A
    // card that is taking part is solid by definition, and the Architect is never
    // dimmed: it is the role that exists before any of this. A skipped card is
    // solid too — it is news, not absence.
    const dim = role !== 'architect' && !participated && !part && !skipped;
    rows.push({ card, text, part, dot, dim, chip, settled, skipped });
    sig += `${role}\u0001${part}\u0001${dot}\u0001${dim ? 1 : 0}\u0001${settled ? 1 : 0}\u0001${skipped ? 1 : 0}\u0001${chip ? chip.text : ''}\u0001${text}\u0002`;
  }

  if (sig === state.roleSig) return;
  state.roleSig = sig;

  // The cards no longer change height here — the subtitle slot is a fixed
  // three-line hole — so this is only a re-measure for safety (a raised
  // `--task-lines`, a font swap). The dock's bottom never moves: the stage has a
  // definite height, so anything that did grow would take room from the
  // transcript's top edge.
  const fromH = Math.ceil($('topologyWrap')?.getBoundingClientRect().height || 0);
  for (const { card, text, part, dot, dim, chip, settled, skipped } of rows) {
    const slot = card.querySelector('.role-task');
    // The status dot is the markup's own — it ships as `idle` and is only ever
    // changed here. Yellow breathes because it means "taking part right now",
    // and the animation is the same `dot-breathe` the sidebar's live dot uses.
    const dotEl = card.querySelector('.role-head .status-dot');
    if (dotEl) {
      dotEl.className = `status-dot ${dot}`;
      dotEl.setAttribute(
        'aria-label',
        dot === 'live' ? 'taking part' : dot === 'err' ? 'blocked' : dot === 'ok' ? 'idle, has taken part' : 'idle',
      );
    }
    card.classList.toggle('is-dim', dim);
    card.classList.toggle('is-initiator', part === 'initiator');
    card.classList.toggle('is-worker', part === 'worker');
    card.classList.toggle('is-settled', settled);
    // A skipped role looks like a blocked one, and its picker says where the
    // problem is: the model, not the role.
    card.classList.toggle('is-skipped', skipped);
    card.querySelector('.model-search')?.classList.toggle('is-skipped', skipped);
    if (!slot) continue;
    // The slot never appears or disappears: it is a fixed three-line hole in the
    // card, so filling it cannot change the card's height and cannot move the
    // chat. The full text rides the tooltip because the slot clamps. A chip is
    // the same size as a line of text for the same reason.
    if (chip) {
      slot.innerHTML =
        `<span class="${chip.cls}">${esc(chip.text)}</span>` +
        (chip.note ? `<span class="role-summary">${esc(chip.note)}</span>` : '');
    } else slot.textContent = text;
    slot.title = text;
  }
  if (state.view === 'session') {
    applyRoleCardsLayout({ animate: true, from: fromH, remeasure: true });
  }
  requestAnimationFrame(drawActivePath);
}

/** Ask what is running. The SSE stream is the fast path; this is what a page
 *  reloaded in the middle of a run starts from. */
async function loadRuns() {
  try {
    const { runs } = await api('GET', '/api/runs');
    state.runs = new Map((runs || []).map((r) => [dirKey(r.dir), r]));
  } catch { /* the stream will catch up */ }
  state.roleSig = '';
  renderRoleActivity();
}

/** One delegated run, live: started, its newest tool call, then finished. */
function handleRunEvent(ev) {
  const key = dirKey(ev.dir);
  if (ev.type === 'run.started' || ev.type === 'run.progress') {
    state.runs.set(key, { ...(state.runs.get(key) || {}), ...ev });
  } else if (ev.type === 'run.finished') {
    state.runs.delete(key);
  } else {
    return;
  }
  renderRoleActivity();
  // The plan pane overlays the live run too (a running task renders as `doing`
  // whatever the file says), so it needs to know when a run starts and stops — but
  // not on every tool call: that would rebuild the rail for nothing.
  if (ev.type !== 'run.progress') renderPlan();
}

// The live path: one solid arrow from the requester down the spine and across
// into the worker, with orange ants travelling it — the design in
// `docs/stage-1-mockup-rev6.pdf`. It is measured from the real boxes at full
// precision (the spine's exact centreline, the dotted band's exact centre) so
// the arrow covers the dots it replaces instead of stepping past them.
function drawActivePath() {
  const layer = $('pathLayer');
  const topo = $('topology');
  if (!layer || !topo) return;
  layer.innerHTML = '';
  if (!topo.offsetParent || topo.clientWidth === 0) return; // hidden view

  const run = currentRun();
  const arch = topo.querySelector('.topo-architect .role-card');
  const dest = run ? cardFor(run.role) : null;
  if (!run || !arch || !dest) return;

  // The row's connector cell owns the band the path runs along, and the spine is
  // that cell's exact centre. The cell is a sibling of the row's two cards —
  // before the right-hand one, after the left-hand one.
  const sibling = (el) => (el && el.classList.contains('link') ? el : null);
  const cell = sibling(dest.previousElementSibling) || sibling(dest.nextElementSibling);
  const spineCell = topo.querySelector('.link') || cell;
  const band = cell?.querySelector('.link-line')?.getBoundingClientRect();
  if (!band || !spineCell) return;

  const box = topo.getBoundingClientRect();
  const a = arch.getBoundingClientRect();
  const d = dest.getBoundingClientRect();
  const s = spineCell.getBoundingClientRect();
  // A card hidden by Single mode has no box: there is nothing to draw a path to.
  if (!d.width || !a.width || !s.width) return;
  const n = (v) => Math.round(v * 1000) / 1000;

  const spineX = n(s.left + s.width / 2 - box.left);
  const y0 = n(a.bottom - box.top);                 // the requester's bottom edge
  const y1 = n(band.top + band.height / 2 - box.top); // exactly the dot centre
  const right = d.left + d.width / 2 > box.left + box.width / 2;
  const x1 = n((right ? d.left : d.right) - box.left); // touches the worker
  const path = `M ${spineX} ${y0} L ${spineX} ${y1} L ${x1} ${y1}`;

  layer.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  layer.setAttribute('preserveAspectRatio', 'none');

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Even pitch rather than a fixed count: a long path gets more ants, so the
  // beads read as one dotted line the whole way, and the speed stays constant
  // instead of the ants sprinting down a short path and crawling down a long one.
  const len = Math.abs(y1 - y0) + Math.abs(x1 - spineX);
  const COUNT = Math.max(5, Math.round(len / 16));
  const DUR = Math.max(2.2, len / 90);
  const ants = reduce
    ? ''
    : Array.from({ length: COUNT }, (_, i) =>
        `<circle r="2.8"><animateMotion dur="${DUR.toFixed(2)}s" begin="${(i * DUR / COUNT).toFixed(2)}s" repeatCount="indefinite" path="${path}"></animateMotion></circle>`,
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
  // Read the reader's intent BEFORE anything resizes the dock. `fitChatHeight()`
  // below can shrink it, and a shrunken dock makes the transcript look "scrolled
  // up" even though nobody moved — which is why new reasoning and tool lines
  // arrived without the chat following them.
  //
  // And while a turn is streaming, follow unconditionally: the operator's words
  // were "they should, to make sure I always see any new info in chat being
  // added". Reading back through history mid-turn will be pulled to the end by
  // the next part; that is the trade they asked for.
  const stick = chatAtBottom() || state.streaming || state.busy;
  // The Architect's card shows what its own turn is doing, read from this same
  // transcript, so it is refreshed wherever the transcript is.
  renderRoleActivity();
  // Only the conversation itself is shown: user turns, assistant turns, and the
  // harness speaking (a worker's report being handed back). Anything else the
  // engine reports (system prompts, scaffolding, context dumps) is not chat and
  // once leaked into the transcript above the user's own message. Errors still
  // show, whatever type carries them.
  //
  // Every part carries a stable key (its message id + index) so an expanded
  // Reasoning block or tool card can be restored after a rebuild — a poll
  // landing mid-read used to snap them shut.
  const tagged = state.messages
    .filter((m) => m.error || m.type === 'user' || m.type === 'assistant' || m.type === 'synthetic')
    .map((m) => (m.parts ? { ...m, parts: m.parts.map((p, i) => ({ ...p, _k: `${m.id}:${i}` })) } : m));
  const showable = groupTurns(tagged);
  // Only permissions stay in the transcript: a form is answered in the panel
  // over the chat, and a card here would both duplicate it and change the
  // transcript's height the moment it appeared.
  const pending = renderPermissions();
  const hasHistory = showable.length > 0 || Boolean(pending);
  // The dock is a bare composer while empty and fills the stage once there is
  // anything to show; the CSS keys off this class, so set it on every render.
  $('chatDock')?.classList.toggle('has-history', hasHistory);
  // An empty dock sits at the bottom of the page, a full one starts under the
  // cards — so the room left for it has to be re-measured on every change.
  fitChatHeight();

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
  if (m.type === 'synthetic') {
    // Synapse speaking: a worker's report, or something the harness needs the
    // Architect to know. Identical block to the Architect's and the operator's —
    // same header, same rule down the left — in Synapse's own colour.
    //
    // The leading "[harness]" is stripped because the header already names the
    // speaker. Reports written before that was true are still in the transcript,
    // so this is done here rather than only at the source.
    const label = m.description ? esc(m.description) : 'report';
    const body = String(m.text || '').replace(/^\s*\[harness\]\s*/i, '');
    return `<div class="msg harness" data-msg="synapse"><div class="msg-body">
      ${stamp}<span class="msg-role">Synapse · ${label}</span>
      <div class="msg-answer">${renderMarkdown(body)}</div>
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

/** A `question` tool call is answered in the panel above the composer, so its
 *  card is the record rather than the interface: it says what was asked, and the
 *  raw payload is one click away like any other tool. */
function questionSummary(part) {
  const questions = Array.isArray(part?.input?.questions) ? part.input.questions : [];
  if (!questions.length) return 'you were asked something';
  const first = questions[0] || {};
  const head = String(first.header || first.question || '').replace(/\s+/g, ' ').trim();
  if (!head) return 'you were asked something';
  const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : '';
  return `${head.length > 88 ? `${head.slice(0, 87)}…` : head}${more}`;
}

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
  const target = String(part.name) === 'question' ? questionSummary(part) : toolTarget(part);
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

// ── the question panel ──────────────────────────────────────────
// A model that asks the operator something blocks the session until it is
// answered, so the question is not a transcript decoration: it is a panel
// painted over the chat, anchored just above the composer. The engine raises a
// form for it, and the form is the interface — the `question` tool card in the
// transcript is only the record.
//
// It lives in an absolutely positioned host (see `.ask-host`), so however tall
// it grows it can never change the chat's size: it only ever covers what is
// already there.

/** The form waiting on the operator.
 *
 *  The open session's own form wins, but any pending form is shown: a hidden
 *  worker session has the same toolset, and if one of those asks something the
 *  operator has to be able to answer it — otherwise the worker sits there until
 *  its timeout reports a failure nobody could see coming. The head says which.
 */
const currentForm = () => {
  const forms = state.forms || [];
  return forms.find((f) => f.sessionId === state.sessionId) || forms[0] || null;
};

/**
 * Below the wide breakpoint the stage is content-sized, so on a short window the
 * card block plus a 70vh chat pushes the composer off the bottom edge — and the
 * one thing the operator needs is the thing that gets cut off.
 *
 * The chat is bottom-anchored: its height is exactly the room between where the
 * cards will settle and the bottom of the window, so the composer sits on the
 * window's bottom edge in every mode and only the chat's *top* moves when the
 * cards collapse or reveal. No ceiling — a ceiling is what left the chat floating
 * short of the bottom with the rail showing underneath it.
 *
 * The room is computed from the *settled* card height (`--reveal-h`, the reveal's
 * target), not from where the dock is this instant: mid-slide that is a layout
 * that no longer exists, and a height that chases the moving top overshoots the
 * window by a frame. `.chat-dock` transitions max-height with the same 260ms ease
 * as the cards, so the two move together and the bottom stays put.
 */
function fitChatHeight() {
  const dock = $('chatDock');
  if (!dock) return;
  const wide = window.matchMedia('(min-width: 1461px)').matches;
  const inSession = state.view === 'session' && dock.classList.contains('has-history');
  if (wide || !inSession) {
    // The wide layout's stage owns the height, and an empty dock is just its
    // composer row: neither takes an inline height.
    if (dock.style.height) dock.style.height = '';
    if (dock.style.maxHeight) dock.style.maxHeight = '';
    return;
  }
  const wrap = $('topologyWrap');
  // `none` in Single: the wrapper is exactly the Architect card.
  const settled = parseFloat(wrap?.style.getPropertyValue('--reveal-h'))
    || wrap?.getBoundingClientRect().height
    || 0;
  const room = window.innerHeight - (stageTop() + settled + stageGap()) - 12;
  const next = `${Math.max(180, Math.floor(room))}px`;
  // A definite height, not a ceiling. A ceiling only ever took room away, so a
  // conversation shorter than the ceiling left the chat stopping above the
  // window's bottom with the rail showing underneath it.
  if (dock.style.height !== next) dock.style.height = next;
  if (dock.style.maxHeight) dock.style.maxHeight = '';
}

/** The stage's top edge in page coordinates — the one reference point every
 *  height below the cards is measured from. */
const stageTop = () => $('stage').getBoundingClientRect().top + window.scrollY;
/** The stage's own row gap, read rather than assumed. */
const stageGap = () => parseFloat(getComputedStyle($('stage')).rowGap) || 0;

function askOption(kind, name, value, label, description) {
  // The models mark their recommendation in the label — "(Recommended)", the
  // convention the question tool documents. Take it out of the sentence and give
  // it a chip: readable as a label, still obvious at a glance.
  const raw = String(label ?? '');
  const recommended = /\(\s*recommended\s*\)\s*$/i.test(raw);
  const text = recommended ? raw.replace(/\s*\(\s*recommended\s*\)\s*$/i, '') : raw;
  return `<label class="ask-opt">
    <input type="${kind}" name="${esc(name)}" value="${esc(value)}" />
    <span class="ask-opt-text">
      <span class="ask-opt-label">${esc(text)}${recommended ? '<span class="ask-rec">Recommended</span>' : ''}</span>
      ${description ? `<span class="ask-opt-desc">${esc(description)}</span>` : ''}
    </span>
  </label>`;
}

/** A choice question may also be answered in the operator's own words — the
 *  engine marks that with `custom`, and so does the tool these models call. */
function askCustom(kind, name) {
  return `<div class="ask-opt ask-opt-other">
    <label class="ask-other-pick">
      <input type="${kind}" name="${esc(name)}" value="__custom" data-ask-custom="1" />
      <span class="ask-opt-label">Something Else…</span>
    </label>
    <input class="ask-input ask-other-text" type="text" placeholder="Type it here" disabled />
  </div>`;
}

/** One field of a form, rendered as the control its type deserves. */
function askField(field, index, all) {
  const key = String(field.key ?? `q${index}`);
  const name = `ask-${key}`;
  const type = String(field.type || 'string');
  const options = Array.isArray(field.options) ? field.options : [];
  // The engine calls this the question's `header` — a short label for telling
  // several questions apart. With only one, it just sits above the real question
  // and models often write a slug there ("--reverse meaning"), which reads like a
  // broken title. Show it only when it separates questions, or when there is no
  // question text to show instead.
  const showTitle = field.title && ((all?.length || 1) > 1 || !field.description);
  const title = showTitle ? `<p class="ask-q-title">${esc(field.title)}</p>` : '';
  const text = field.description ? `<p class="ask-q-text">${esc(field.description)}</p>` : '';
  const req = field.required ? '<span class="ask-req" title="Required">required</span>' : '';

  let body;
  if (type === 'boolean') {
    body = `<div class="ask-opts">${askOption('checkbox', name, 'true', field.title || 'Yes', '')}</div>`;
  } else if (type === 'multiselect') {
    body =
      `<div class="ask-opts">${options.map((o) => askOption('checkbox', name, o.value, o.label, o.description)).join('')}` +
      `${field.custom ? askCustom('checkbox', name) : ''}</div>`;
  } else if (options.length) {
    body =
      `<div class="ask-opts">${options.map((o) => askOption('radio', name, o.value, o.label, o.description)).join('')}` +
      `${field.custom ? askCustom('radio', name) : ''}</div>`;
  } else if (type === 'external') {
    // Nothing to answer: the field is a door to somewhere else.
    body = `<a class="ask-link" href="${esc(field.url || '#')}" target="_blank" rel="noreferrer noopener">${esc(field.title || field.url || 'Open')}</a>`;
  } else if (type === 'number' || type === 'integer') {
    const min = field.minimum != null ? ` min="${esc(field.minimum)}"` : '';
    const max = field.maximum != null ? ` max="${esc(field.maximum)}"` : '';
    body = `<input class="ask-input" type="number" data-ask-key="${esc(key)}"${min}${max} value="${esc(field.default ?? '')}" />`;
  } else {
    body = `<input class="ask-input" type="text" data-ask-key="${esc(key)}" placeholder="${esc(field.placeholder || '')}" value="${esc(field.default ?? '')}" />`;
  }

  // `when` is the engine's own conditional: the field only exists if another
  // answer says so. Hidden fields are not rendered, and never answer anything.
  const when = Array.isArray(field.when) && field.when.length
    ? ` data-ask-when="${esc(JSON.stringify(field.when))}"`
    : '';
  return `<div class="ask-field" data-ask-field="${esc(key)}" data-ask-type="${esc(type)}"${when}${
    field.required ? ' data-ask-required="1"' : ''
  }>${title}${text}${req}${body}</div>`;
}

function renderAskPanel() {
  const host = $('askHost');
  if (!host) return;
  const form = state.view === 'session' ? currentForm() : null;
  if (!form) {
    state.askSig = '';
    host.hidden = true;
    host.innerHTML = '';
    $('chatDock')?.classList.remove('has-ask');
    syncAskState();
    return;
  }
  // The panel is polled like everything else, and rebuilding it would throw away
  // whatever the operator had already answered — so it is only rebuilt when the
  // form itself changed. Answers live in the DOM, and the signature deliberately
  // says nothing about them.
  const sig = `${form.id}|${(form.fields || [])
    .map((f) => `${f.key}:${f.type}:${(f.options || []).map((o) => o.value).join(',')}`)
    .join(';')}`;
  if (sig === state.askSig) {
    host.hidden = false;
    $('chatDock')?.classList.add('has-ask');
    return;
  }
  state.askSig = sig;
  host.hidden = false;
  host.innerHTML = `<div class="ask-panel" role="dialog" aria-label="Question waiting for an answer" data-ask="${esc(form.id)}">
    <div class="ask-head">
      <span class="ask-dot" aria-hidden="true"></span>
      <span class="ask-head-title">${esc(form.title || 'Input Needed')}</span>
      <span class="ask-head-note">${
        form.sessionId === state.sessionId
          ? 'the session is waiting on you'
          : 'another session is waiting on you'
      }</span>
    </div>
    <div class="ask-fields">${(form.fields || []).map(askField).join('')}</div>
    <div class="ask-actions">
      <span class="ask-state" data-ask-state></span>
      <button class="btn btn-ask btn-sm" data-form-reply="${esc(form.id)}">Submit Answer</button>
    </div>
  </div>`;
  $('chatDock')?.classList.add('has-ask');
  applyAskConditions();
  syncAskState();
}

/** The panel's answers, in the shape the engine's form reply wants. */
function collectAskAnswer(form) {
  const panel = document.querySelector('.ask-panel');
  const answer = {};
  if (!panel) return answer;
  for (const field of form.fields || []) {
    const key = String(field.key ?? '');
    const holder = panel.querySelector(`[data-ask-field="${CSS.escape(key)}"]`);
    if (!holder || holder.hidden) continue;
    const type = String(field.type || 'string');
    const one = (sel) => holder.querySelector(sel);
    if (field.hidden || type === 'external') continue;
    if (type === 'boolean') {
      answer[key] = Boolean(one('input[type="checkbox"]')?.checked);
    } else if (type === 'multiselect') {
      const picked = [...holder.querySelectorAll('input[type="checkbox"]:checked')]
        .filter((el) => !el.hasAttribute('data-ask-custom'))
        .map((el) => el.value);
      const other = one('.ask-other-text');
      if (other && other.value.trim()) picked.push(other.value.trim());
      answer[key] = picked;
    } else if (Array.isArray(field.options) && field.options.length) {
      const checked = one('input[type="radio"]:checked');
      if (!checked) continue;
      const other = one('.ask-other-text');
      answer[key] = checked.hasAttribute('data-ask-custom')
        ? String(other?.value || '').trim()
        : checked.value;
    } else if (type === 'number' || type === 'integer') {
      const el = one(`[data-ask-key="${CSS.escape(key)}"]`);
      answer[key] = el?.value === '' || el?.value === undefined ? null : Number(el.value);
    } else {
      answer[key] = String(one(`[data-ask-key="${CSS.escape(key)}"]`)?.value ?? '');
    }
  }
  return answer;
}

/** Required fields, and the free-text box on a choice question, only make sense
 *  live: the Submit button says no until the form can be answered. */
function syncAskState() {
  const panel = document.querySelector('.ask-panel');
  const btn = panel?.querySelector('[data-form-reply]');
  const note = panel?.querySelector('[data-ask-state]');
  if (!panel || !btn) return;
  const form = currentForm();
  if (!form) return;
  const answer = collectAskAnswer(form);
  const missing = (form.fields || []).filter((f) => {
    if (!f.required || f.hidden || f.type === 'external') return false;
    const holder = panel.querySelector(`[data-ask-field="${CSS.escape(String(f.key ?? ''))}"]`);
    if (!holder || holder.hidden) return false;
    const v = answer[String(f.key ?? '')];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
  });
  btn.disabled = missing.length > 0;
  if (note) {
    note.textContent = missing.length ? 'Answer every required question to send.' : '';
    note.hidden = !missing.length;
  }
}

/** Show or hide the fields whose `when` conditions are not met yet. */
function applyAskConditions() {
  const panel = document.querySelector('.ask-panel');
  const form = currentForm();
  if (!panel || !form) return;
  const answer = collectAskAnswer(form);
  for (const holder of panel.querySelectorAll('[data-ask-when]')) {
    let ok = true;
    try {
      for (const rule of JSON.parse(holder.dataset.askWhen)) {
        const actual = answer[String(rule.key)];
        const same = String(actual) === String(rule.value);
        if (rule.op === 'eq' ? !same : same) { ok = false; break; }
      }
    } catch { /* a malformed rule hides nothing */ }
    holder.hidden = !ok;
  }
}

/** The free-text box on a choice question is only usable once its row is picked. */
function syncAskCustoms(target) {
  const row = target.closest('.ask-opt-other');
  if (!row) return;
  const pick = row.querySelector('[data-ask-custom]');
  const text = row.querySelector('.ask-other-text');
  if (text) text.disabled = !pick?.checked;
  if (pick?.checked) text?.focus();
}

async function replyForm(formId) {
  const form = currentForm();
  if (!form || form.id !== formId) return;
  // The form's own session, not the open one: a worker's question is answered
  // in the session that asked it.
  const sessionId = form.sessionId || state.sessionId;
  const answer = collectAskAnswer(form);
  const btn = document.querySelector(`[data-form-reply="${CSS.escape(formId)}"]`);
  if (btn) btn.disabled = true;
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/forms/${encodeURIComponent(formId)}/reply`, { answer });
    state.forms = state.forms.filter((f) => f.id !== formId);
    renderAskPanel();
    renderComposer();
    renderTranscript();
    toast('Answer Sent', 'The session will carry on from it.');
  } catch (err) {
    toast('Could Not Send The Answer', err.message);
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
    p = await api('GET', `/api/pending${state.sessionId ? `?session=${encodeURIComponent(state.sessionId)}` : ''}`);
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
  if (state.view === 'session') {
    renderAskPanel();
    renderComposer();
    renderTranscript();
  }
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
    renderRoleActivity();
    return;
  }
  try {
    state.planState = await api('GET', `/api/sessions/${encodeURIComponent(state.sessionId)}/plan`);
  } catch {
    state.planState = null;
  }
  renderPlan();
  // The cards read the plan too: which roles have taken part, which are blocked,
  // and whether the whole thing is finished. Without this a status change would
  // only reach the dots on the next run or session event.
  renderRoleActivity();
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
  // A task with a worker on it is the step in hand whatever the file says. The
  // Architect only writes the plan when it judges, so during the run the file
  // still says todo and the pane showed the live step as a grey row. The run is
  // the live truth; the file stays the plan.
  const liveRun = currentRun();
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
        const status = liveRun && liveRun.task === t.id ? 'doing' : PLAN_STATUS[t.status] ? t.status : 'todo';
        // The result is not printed under the title: the row stays one line per
        // task, and the detail is a hover away. A blocked note is the exception —
        // that one is the reason the operator is being asked, so it shows.
        //
        // Only while it *is* the reason: a note on a task that is done, or back to
        // todo, is the Architect having moved on without clearing its own note, and
        // showing it made a finished plan look like it was still asking. The file
        // keeps the text (the Architect owns it) — this is just what the pane shows.
        const asking = status === 'blocked' || status === 'failed';
        const tooltip = [t.title, t.result ? `Result: ${t.result}` : '', t.note ? `Note: ${t.note}` : '']
          .filter(Boolean)
          .join('\n\n');
        return `<li class="plan-task" data-status="${status}">
          <span class="plan-dot" role="img" aria-label="${esc(PLAN_STATUS[status])}"></span>
          <span class="plan-main">
            <span class="plan-title" title="${esc(tooltip)}"><span class="plan-id">${esc(t.id || '?')}</span>${esc(t.title)}</span>
            ${t.note && asking ? `<span class="plan-note">${esc(t.note)}</span>` : ''}
          </span>
          <span class="plan-role">${esc(t.role)}</span>
        </li>`;
      })
      .join('')}</ol>` +
    (st.problems?.length
      ? `<div class="plan-problems">` +
        `<span class="plan-problems-head">${st.problems.length} plan note${st.problems.length === 1 ? '' : 's'} for the Architect</span>` +
        `<ul>${st.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` +
        `</div>`
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
/**
 * The composer. While a question is waiting the session genuinely cannot read a
 * message — the engine's turn is blocked on the answer — so the box says so
 * rather than letting a message be typed into nothing.
 */
function renderComposer() {
  const hasSession = Boolean(state.sessionId);
  const asking = Boolean(currentForm());
  // Any pending question blocks this composer, whoever asked it: the operator's
  // attention is the thing the run is waiting on, and a worker's question is no
  // different from the Architect's in that respect.
  $('sendBtn').disabled = (state.busy && !hasSession) || asking;
  $('stopBtn').disabled = !state.busy || !hasSession;
  const input = $('promptInput');
  if (input) {
    input.disabled = asking;
    input.placeholder = asking
      ? 'Answer the question above'
      : state.mode === 'single'
        ? 'Message'
        : 'Message the Architect…';
  }
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
    // Sending is a statement of intent to read the answer: put the newest message
    // in view, and again after the turn's messages land.
    scrollChatToEnd();
    await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/messages`, { text });
    await loadMessages();
    scrollChatToEnd();
  } catch (err) {
    toast('Send failed', err.message);
  } finally {
    state.streaming = false;
    renderComposer();
  }
}

/** Put the newest message in view, and the cards above it.
 *
 *  Two scrollers can both be live: the transcript scrolls itself, and below the
 *  1460px breakpoint the *page* scrolls as well (rail under chat, one column). The
 *  transcript goes to its end, and the page goes to the top of the role cards — so
 *  sending shows the newest message *and* the cards the work will appear in. In the
 *  wide layout the page does not scroll, so only the transcript moves.
 */
function scrollChatToEnd(smooth = true) {
  const el = chatScroller();
  if (el) {
    if (smooth) animateScroll(el, el.scrollHeight, 220);
    else el.scrollTop = el.scrollHeight;
  }
  const cards = $('topologyWrap');
  if (!cards) return;
  if (document.documentElement.scrollHeight <= window.innerHeight + 2) return;
  const to = Math.max(0, window.scrollY + cards.getBoundingClientRect().top - 8);
  if (smooth) animateScroll(null, to, 220);
  else window.scrollTo(0, to);
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
      return;
    }

    // A model earned itself a mark while a run was failing: re-read the catalog
    // so the picker shows it now rather than after the next reload.
    if (ev.kind === 'model') {
      refreshModels();
      return;
    }

    // Synapse's own short note (not an alarm, not a message to any model): the
    // harness declined to do something the operator should know about.
    if (ev.kind === 'note') {
      toast(ev.title || 'Note', ev.body || '');
      return;
    }

    // The harness watchdog: something the models run touched Synapse's own files.
    // This is the one event that must not be missed, so it is loud in both places
    // the operator looks — a toast now, and the error dialog with the paths.
    if (ev.kind === 'alarm') {
      const paths = (ev.paths || []).slice(0, 6).join('\n');
      toast('Harness Tampering Detected', ev.what || 'something touched Synapse itself');
      openError(ev.what || 'Harness Tampering', `${ev.what || ''}\n\n${paths}${ev.note ? `\n\n(${ev.note})` : ''}`);
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

    // Delegated work: the runner's own events, one per project, adding up to the
    // live path and the cards' state. Nothing here is a session event.
    if (ev.kind === 'run') {
      handleRunEvent(ev);
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
    group('Workers',
      f('Timeout per task (seconds)', 'worker.timeoutSec', { type: 'number' }) +
      `<p class="set-note">A delegated task is interrupted after this long and its partial work is reported. ` +
      `A role can override it in the config (<code>roles.&lt;id&gt;.timeoutSec</code>) — the auditor is the one that needs more.</p>`),
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

function openSettings() { renderSettings(); $('settingsModal').hidden = false; }
function closeSettings() { $('settingsModal').hidden = true; }

// ── wiring ──────────────────────────────────────────────────────
function wire() {
  setupModelPickers();
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('stopBtn').addEventListener('click', interrupt);
  $('modeToggle').addEventListener('click', switchMode);
  $('keepBtn').addEventListener('click', toggleKeep);
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
  // The question panel. Its answer changes what is required and what other
  // fields even exist, so every keystroke and every pick re-checks the panel.
  const askHost = $('askHost');
  if (askHost) {
    askHost.addEventListener('input', (e) => {
      syncAskCustoms(e.target);
      applyAskConditions();
      syncAskState();
    });
    askHost.addEventListener('change', (e) => {
      syncAskCustoms(e.target);
      applyAskConditions();
      syncAskState();
    });
    askHost.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-form-reply]');
      if (btn) replyForm(btn.dataset.formReply);
    });
    // Enter in a text field submits, the way any small form should.
    askHost.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      const btn = askHost.querySelector('[data-form-reply]');
      if (btn && !btn.disabled) replyForm(btn.dataset.formReply);
    });
  }

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
    // Ctrl+Enter sends; Enter and Shift+Enter are newlines, the way a chat box
    // with long prompts should behave. The Send button is always there too.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });

  $('projectTree').addEventListener('click', (e) => {
    if (e.target.closest('[data-soon]')) return;
    const stop = e.target.closest('[data-interrupt]');
    if (stop) { interruptSession(stop.dataset.interrupt); return; }
    const renameProjectBtn = e.target.closest('[data-rename-project]');
    if (renameProjectBtn) { renameProject(renameProjectBtn.dataset.renameProject); return; }
    const delProject = e.target.closest('[data-del-project]');
    if (delProject) { removeProject(delProject.dataset.delProject); return; }
    const browse = e.target.closest('[data-browse-project]');
    if (browse) { openProjectFolder(browse.dataset.browseProject, 'browse'); return; }
    const cmd = e.target.closest('[data-cmd-project]');
    if (cmd) { openProjectFolder(cmd.dataset.cmdProject, 'cmd'); return; }
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

  $('dialogOk').addEventListener('click', () =>
    closeDialog(dialogOkResult !== undefined ? dialogOkResult : readDialog()),
  );
  $('dialogExtra').addEventListener('click', () => closeDialog($('dialogExtra').dataset.result || 'extra'));
  $('dialogCancel').addEventListener('click', () => closeDialog(null));
  $('dialogClose').addEventListener('click', () => closeDialog(null));
  $('dialogModal').addEventListener('click', (e) => {
    if (e.target === $('dialogModal') && dialogDismissable) closeDialog(null);
  });
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
    // A non-dismissable dialog (the folder-already-exists question) ignores Escape:
    // the operator must answer it.
    if (!$('dialogModal').hidden) {
      if (dialogDismissable) closeDialog(null);
      else e.preventDefault();
    }
    else if (!$('errorModal').hidden) closeError();
    else if (!$('settingsModal').hidden) closeSettings();
  });

  window.addEventListener('resize', () => requestAnimationFrame(() => {
    fitStageHeight();
    if (state.view === 'session') applyRoleCardsLayout({ animate: false });
    fitChatHeight();
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
        if (state.view === 'session') applyRoleCardsLayout({ animate: false, remeasure: true });
        drawActivePath();
      });
    }).observe($('topology'));
  }
  // Fonts settle a tick after first paint; measure once more when they do.
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (state.view === 'session') applyRoleCardsLayout({ animate: false, remeasure: true });
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
  // Before anything is measured: the cards need their role id and their
  // subtitle slot, and a card's height is what the wrapper is measured against.
  initRoleCards();
  fitStageHeight();
  state.config = await api('GET', '/api/config').catch(() => null);
  // every new session starts Single; an opened session sets its own mode
  state.mode = 'single';
  renderMode();
  setView();
  await refreshStatus();
  await loadModels();
  await loadProjects();
  await loadRuns();
  renderTranscript();
  connectStream();
  refreshPending();
  renderProbe();
  // nothing is auto-opened: the operator picks what to work on
}

boot();

