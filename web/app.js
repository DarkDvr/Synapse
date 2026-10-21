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
  { id: 'inventor', name: 'Inventor' },
  { id: 'designer', name: 'Designer' },
  { id: 'coder-1', name: 'Coder 1' },
  { id: 'coder-2', name: 'Coder 2' },
  { id: 'coder-3', name: 'Coder 3' },
  { id: 'qc', name: 'QC' },
];

const TBD_TITLE = 'TBD';

const state = {
  status: null,
  // What we know about the engine's own version: current, latest, where the
  // newer one was seen. `updating` is the one operation in the whole UI that
  // stops the engine, so it is a state of the app, not of a button.
  update: null,
  updating: false,
  config: null,
  models: [],
  workspace: '',
  projects: [],
  sessionId: null,
  messages: [],
  // The open session's project plan file: its parsed contents, any problems in
  // it, and when it last changed.
  planState: null,
  // What the engine can load and what the role settings expect (GET /api/skills).
  skillsInfo: null,
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
  // What each worker has said and done, keyed `${dir}|${task}|${startedAt}`. A
  // worker runs in its own session, so nothing of its own ever reached this
  // transcript: the chat sat idle for nine minutes and then a report appeared.
  // The trace is shown light grey while it runs and folds to one line at the end.
  traces: new Map(),
  // Signature of what the role cards are showing, so a poll that learned nothing
  // does not re-measure the wrapper and jiggle the chat.
  roleSig: '',
  forms: [],
  // Form ids already announced since this page loaded, so a waiting question is
  // announced once rather than on every poll.
  announcedForms: new Set(),
  // 'single' (one Architect, all tools, no delegation) or 'multi' (delegation
  // allowed, role cards revealed). New sessions start single; the toggle
  // switches the open session live.
  mode: 'single',
  streaming: false,
  streamLive: false,
  // When the last engine event arrived, so the sidebar can say "10s" instead of
  // just naming it. And the stopwatches for the open session (see tickClocks).
  lastEventAt: 0,
  clocks: null,
  collapsed: new Set(),
  // True once the first project list has arrived; see loadProjects.
  collapsedInit: false,
  // Keys of reasoning blocks and tool cards the operator has opened. The
  // transcript is rebuilt on every poll, so expansion state has to live outside
  // the DOM or it dies with the next render.
  open: new Set(),
  renderSig: '',
  // A provider failure shown on a role's card, keyed `${dirKey}|${role}`: red
  // *text*, never a border, and cleared when that role works again.
  roleErrors: new Map(),
  // Signature of what the question panel is showing, so a poll does not rebuild
  // it and discard answers the operator has already given.
  askSig: '',
  // Which question of the form is on screen. A five-question form is five pages,
  // because the ones below the fold were being missed entirely.
  askPage: 0,
  renaming: null,
  view: 'none', // none | session
  // Settings is a draft, not the file: `setDraft` is a copy of the config that
  // the panes edit, `settingsTab` is the open pane, and the provider editor's
  // own state (which row is selected, whether the key is revealed, what the last
  // Refresh List said) lives here because the pane is re-rendered, not patched.
  settingsTab: 'general',
  setDraft: null,
  settingsSnapshot: null,
  setProvSelected: null,
  setKeyRevealed: false,
  setProvFetch: null,
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
function toast(title, body, ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast-icon">◈</span><div><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}</div>`;
  $('toastRegion').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ── error popup ─────────────────────────────────────────────────
function openError(title, text, opts = {}) {
  $('errorHeading').textContent = title;
  $('errorBadge').textContent = opts.badge || '!';
  const lead = $('errorLead');
  lead.textContent = opts.lead || '';
  lead.hidden = !opts.lead;
  const detail = $('errorText');
  detail.textContent = text || '';
  detail.hidden = !text;
  const note = $('errorNote');
  note.textContent = opts.note || '';
  note.hidden = !opts.note;
  $('errorModal').classList.toggle('is-alarm', Boolean(opts.alarm));
  $('errorModal').hidden = false;
  $('closeError').focus();
}

/** An agent touched Synapse itself. Not an error to retry: a report to read, so
 *  it gets a sentence saying what happened and what did not. */
function openAlarm(ev) {
  const what = String(ev.what || '');
  const title = /shell|command/i.test(what)
    ? 'A shell command named Synapse'
    : /write|edit/i.test(what)
      ? 'Something tried to write inside Synapse'
      : 'Synapse was named in a tool call';
  toast('Synapse Activity Warning', what || 'something touched Synapse itself');
  openError(title, (ev.paths || []).slice(0, 6).join('\n'), {
    lead:
      'A model named this folder in a tool call. It is logged, and Synapse takes a restore point before ' +
      'every delegation, so the repository can be put back. Nothing was changed automatically and the run ' +
      'was not stopped — this is the report, not the repair.',
    note: ev.note ? String(ev.note) : '',
    alarm: true,
  });
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
      extraBtn.className = `btn btn-sm ${extra.danger ? 'btn-danger' : 'btn-secondary'}`;
    }
    // "Non-bypassable" means exactly this: no close button, no backdrop dismiss, no
    // Escape. The operator must pick one of the answers.
    $('dialogClose').hidden = !dismissable;
    document.querySelector('#dialogModal .modal')?.classList.toggle('is-clash', tone === 'clash');
    $('dialogBody').innerHTML = fields
      .map((f) => {
        // A checklist is not one control inside one label: every row is its own
        // label, or clicking a row's text would toggle the first box instead.
        if (f.type === 'checklist') {
          const rows = f.options
            .map(
              (o) =>
                `<label class="dlg-check"><input type="checkbox" data-check="${esc(o.v)}"${o.checked ? ' checked' : ''} />` +
                `<span>${esc(o.l)}</span>` +
                (o.hint ? `<small>${esc(o.hint)}</small>` : '') +
                `</label>`,
            )
            .join('');
          return `<div class="set-field wide"><span>${esc(f.label)}</span><div class="dlg-checklist">${rows}</div></div>`;
        }
        // Skills carry two levels: allowed (the engine refuses anything else) and
        // required (the brief demands it, and the runner reports it to the
        // Architect if the worker never loaded it). Two boxes per row; the
        // required box is dead until the skill is allowed, so the two lists can
        // never disagree.
        if (f.type === 'skills') {
          const rows = f.options
            .map(
              (o) =>
                `<div class="dlg-skill">` +
                `<label class="dlg-check"><input type="checkbox" data-skill-allow="${esc(o.v)}"${o.allowed ? ' checked' : ''} />` +
                `<span>${esc(o.l)}</span>` +
                (o.hint ? `<small>${esc(o.hint)}</small>` : '') +
                `</label>` +
                `<label class="dlg-must" title="The brief requires it">` +
                `<input type="checkbox" data-skill-must="${esc(o.v)}"${o.must ? ' checked' : ''}${o.allowed ? '' : ' disabled'} />` +
                `<span>Required</span>` +
                `</label>` +
                `</div>`,
            )
            .join('');
          return `<div class="set-field wide"><span>${esc(f.label)}</span><div class="dlg-checklist">${rows}</div></div>`;
        }
        const control = f.type === 'select'
          ? `<select id="dlg-${esc(f.name)}">${f.options
              .map((o) => `<option value="${esc(o.v)}"${o.v === f.value ? ' selected' : ''}>${esc(o.l)}</option>`)
              .join('')}</select>`
          : f.type === 'textarea'
            ? `<textarea id="dlg-${esc(f.name)}" rows="4" placeholder="${esc(f.placeholder ?? '')}">${esc(f.value ?? '')}</textarea>`
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
    if (f.type === 'checklist') {
      values[f.name] = [...$('dialogBody').querySelectorAll('input[data-check]')]
        .filter((el) => el.checked)
        .map((el) => el.dataset.check);
      continue;
    }
    if (f.type === 'skills') {
      const body = $('dialogBody');
      values[f.name] = [...body.querySelectorAll('input[data-skill-allow]')]
        .filter((el) => el.checked)
        .map((el) => el.dataset.skillAllow);
      values.mustLoad = [...body.querySelectorAll('input[data-skill-must]')]
        .filter((el) => el.checked)
        .map((el) => el.dataset.skillMust);
      continue;
    }
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
  // `opencode v2.1.0`: the v is the version's own, not a word.
  $('engineState').textContent = ready
    ? `${engine.kind} ${versionTag(engine.version)}`.trim()
    : failed ? 'failed' : 'starting';

  // There is no separate "Event stream" row any more: this dot is the stream's
  // state, and the age on its label is the evidence. A row that said "connected"
  // next to a clock that keeps resetting said the same thing twice.
  $('eventDot').className = 'status-dot ' + (state.streamLive ? 'ok' : 'idle');
  renderLastEventAge();
}

const versionTag = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  return /^v/i.test(s) ? s : `v${s}`;
};

/** 10s, 2m, 3h: a unit that never makes you do arithmetic, rounded down. */
function shortSpan(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** HH:MM:SS, hours not padded — a stopwatch, read at a glance. */
function hhmmss(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderLastEventAge() {
  const label = $('lastEventLabel');
  if (!label) return;
  label.textContent = state.lastEventAt
    ? `Last event (${shortSpan(Date.now() - state.lastEventAt)})`
    : 'Last event';
}

/**
 * The sidebar's Local LLM row: the local, OpenAI-compatible servers the config
 * registers. It used to read "not set" permanently, which was true when nothing
 * was wired and a lie the moment one was — the badge on those models is the same
 * fact seen from the other side. Nothing is probed: the dot stays grey, and the
 * first turn is what proves the server is up.
 *
 * It says how many models, never the name of the app serving them: "Bionic" is
 * one machine's runtime, and the row has to mean the same thing on the next one.
 */
function renderLlmStatus() {
  const row = $('llmRow');
  const out = $('llmState');
  if (!row || !out) return;
  const providers = Array.isArray(state.config?.engine?.opencode?.providers)
    ? state.config.engine.opencode.providers
    : [];
  const local = providers.filter(
    (p) => (p.type ? p.type === 'local' : /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(String(p.baseURL || ''))),
  );
  if (!local.length) {
    out.textContent = 'not set';
    row.title = 'No local model server is registered. Add one in Settings > Providers.';
    return;
  }
  const modelCount = local.reduce((n, p) => n + (Array.isArray(p.models) ? p.models.length : 0), 0);
  out.textContent =
    local.length === 1
      ? `${modelCount} model${modelCount === 1 ? '' : 's'}`
      : `${local.length} servers · ${modelCount} models`;
  row.title =
    local
      .map((p) => `${p.baseURL}: ${(p.models || []).map((m) => m.name || m.id).filter(Boolean).join(', ')}`)
      .join('\n') + '\nConfigured, not probed — a turn is what proves it is running.';
}

// ── clocks ──────────────────────────────────────────────────────
// Three stopwatches: how long a card has been working right now, how long that
// role has worked in total this session, and how much wall time the session has
// spent working at all. Two of them are display-only.
//
// Deliberately client-side and derived from what is already on screen — a live
// run for a worker, the open turn for the Architect — because the server has no
// opinion about "working" that the cards do not already show. Totals are kept in
// localStorage per session, so a reload restores them; the current interval is
// restarted from now on load, since time spent with the page closed is not time
// we can honestly claim to have measured.

const clockKey = (id) => `synapse.clocks.${id}`;

function loadClocks(sessionId) {
  const c = { sessionId: sessionId || null, session: { ms: 0, since: null }, roles: {}, ticks: 0 };
  if (!sessionId) return c;
  try {
    const raw = JSON.parse(localStorage.getItem(clockKey(sessionId)) || 'null');
    if (raw && typeof raw === 'object') {
      c.session.ms = Math.max(0, Number(raw.session?.ms) || 0);
      for (const [role, v] of Object.entries(raw.roles || {})) {
        c.roles[role] = {
          ms: Math.max(0, Number(v?.ms) || 0),
          since: null,
          last: Math.max(0, Number(v?.last) || 0),
        };
      }
    }
  } catch { /* a corrupt stopwatch is not worth an error */ }
  return c;
}

function saveClocks() {
  const c = state.clocks;
  if (!c?.sessionId) return;
  try {
    const roles = {};
    for (const [role, v] of Object.entries(c.roles)) roles[role] = { ms: v.ms, last: v.last };
    localStorage.setItem(clockKey(c.sessionId), JSON.stringify({ session: { ms: c.session.ms }, roles }));
  } catch { /* full or blocked storage must not break a turn */ }
}

/** Is this card doing work right now? The same reading its dot uses. */
function roleIsWorking(role) {
  const run = currentRun();
  const form = (state.forms || [])[0];
  const perm = (state.permissions || [])[0];
  if (role === 'architect') {
    // Waiting on the operator is not work, and neither is waiting on a worker —
    // the worker's own card is the one that should be counting.
    if (form && form.sessionId === state.sessionId) return false;
    if (perm && perm.sessionId === state.sessionId) return false;
    if (run) return false;
    return isBusy(state.sessionId);
  }
  if (!run || run.role !== role) return false;
  // A worker stopped on a question is waiting, exactly as its card says.
  return !(form && form.sessionId && form.sessionId !== state.sessionId);
}

function tickClocks() {
  const now = Date.now();
  renderLastEventAge();
  // The plan's per-step stopwatches, before the early return below: they are
  // driven by the harness's run records (data-ms) plus this run's start, so they
  // do not depend on the card clocks existing yet.
  for (const el of document.querySelectorAll('.plan-spent')) {
    const base = Number(el.dataset.ms) || 0;
    const since = Number(el.dataset.since) || 0;
    const ms = base + (since ? now - since : 0);
    el.classList.toggle('is-zero', ms === 0);
    const text = hhmmss(ms);
    if (el.textContent !== text) el.textContent = text;
  }
  const c = state.clocks;
  if (!c) return;
  let changed = false;
  let anyWorking = false;

  for (const card of document.querySelectorAll('#topology .role-card')) {
    const role = card.dataset.role;
    const working = roleIsWorking(role);
    if (working) anyWorking = true;
    const rec = (c.roles[role] ||= { ms: 0, since: null, last: 0 });
    if (working && !rec.since) rec.since = now;
    else if (!working && rec.since) {
      rec.last = now - rec.since;
      rec.ms += rec.last;
      rec.since = null;
      changed = true;
    }
  }

  // The session clock is the union of the cards: it runs while any of them works,
  // so it is stopped by a question, by a permission prompt, and by a finished
  // project — all of which show as "nobody is working" on the cards themselves.
  if (anyWorking && !c.session.since) c.session.since = now;
  else if (!anyWorking && c.session.since) {
    c.session.ms += now - c.session.since;
    c.session.since = null;
    changed = true;
  }

  paintClocks(now);
  // Persist on a real transition, and every so often while running: the totals
  // only move at transitions, so this is a handful of writes per run.
  c.ticks += 1;
  if (changed || c.ticks % 15 === 0) saveClocks();
}

function paintClocks(now) {
  const c = state.clocks;
  if (!c) return;
  for (const card of document.querySelectorAll('#topology .role-card')) {
    const el = card.querySelector('.role-clock');
    if (!el) continue;
    const rec = c.roles[card.dataset.role];
    const running = rec?.since ? now - rec.since : 0;
    if (!rec || (!rec.ms && !rec.since && !rec.last)) {
      el.textContent = '';
      continue;
    }
    el.textContent = `${hhmmss(running || rec.last || 0)} / ${hhmmss(rec.ms + running)}`;
  }
  const clock = $('planClock');
  if (clock) {
    clock.textContent = hhmmss(c.session.ms + (c.session.since ? now - c.session.since : 0));
  }
}

// ── engine updates ──────────────────────────────────────────────
// The engine is a separate program that updates often, and the model catalog
// ships inside it — so "our model list is old" is nearly always "our engine is
// old". The offer is a chip beside Settings: noticeable, never in the way, and
// it says nothing at all when there is nothing to do.
let updateChecking = false;

async function refreshUpdate() {
  try { state.update = await api('GET', '/api/engine/update'); } catch { state.update = null; }
  renderUpdateChip();
}

function renderUpdateChip() {
  const chip = $('updateChip');
  if (!chip) return;
  const u = state.update;
  const show = Boolean(u?.newer) && !state.updating;
  chip.hidden = !show;
  if (show) {
    chip.title =
      `The runtime is ${u.current || 'unknown'}; ${u.latest} is available (${u.source}). ` +
      'The runtime carries the model catalog, so updating it is how the list gets current.';
  }
}

function openUpdateDialog() {
  $('updateModal').hidden = false;
  renderUpdateDialog();
  // Ask npm once, here: opening the dialog is the operator asking. Boot never
  // does, because the app is offline by rule.
  checkEngineUpdate();
}

function closeUpdateDialog() {
  // A click-away must not hide the one operation that restarts the engine.
  if (state.updating) return;
  $('updateModal').hidden = true;
}

function renderUpdateDialog() {
  const u = state.update || {};
  const sub = $('updateSub');
  const body = $('updateBody');
  if (!body) return;

  if (sub) {
    sub.textContent = state.updating
      ? 'Updating. The runtime is stopped, replaced and started again - this takes about a minute.'
      : u.newer
        ? 'A newer runtime is available. The model catalog ships inside it, so this is also how the model list gets current.'
        : 'The runtime carries the model catalog, the tools and the API. Nothing to do right now.';
  }

  const checked = u.checkedAt ? `checked ${ago(Date.parse(u.checkedAt))}` : 'not checked with npm yet';
  const source =
    u.source === 'OpenCode Desktop' ? 'OpenCode Desktop' : u.source === 'npm' ? 'npm' : u.source || '';
  const published = u.publishedAt ? ` · published ${ago(Date.parse(u.publishedAt))}` : '';
  const rows = [
    ['Installed', `<b>opencode ${esc(u.current || 'unknown')}</b>`],
    [
      'Known newest',
      `${u.latest ? `<b>${esc(u.latest)}</b>` : 'unknown'}` +
        (source ? ` <small>${esc(source)}${esc(published)} · ${esc(checked)}</small>` : ''),
    ],
    ['Runtime file', `<code title="${esc(u.binary || '')}">${esc(u.binary || 'auto-detected')}</code>`],
  ];

  const notes = [];
  if (u.onlineError) {
    notes.push(`<p class="upd-note is-warn">npm could not be asked: ${esc(u.onlineError)}</p>`);
  }
  if (!u.managedByNpm) {
    notes.push(
      '<p class="upd-note is-warn">This runtime was not installed with npm, so Synapse will not replace it. ' +
        'Update it where it came from, or point Settings → Engine at an npm install.</p>',
    );
  }
  if (u.blocked) notes.push(`<p class="upd-note is-warn">${esc(u.blocked)}</p>`);
  if (u.newer) {
    notes.push(
      '<p class="upd-note">The npm package publishes no release notes — the version number is all it tells us. ' +
        'The runtime brings its own model catalog, tools and API, and updating restarts it; any turn in flight ' +
        'would be lost, which is why Synapse refuses while one is running.</p>',
    );
  }

  body.innerHTML =
    `<div class="upd-grid">` +
    rows
      .map(
        ([k, v]) =>
          `<span class="upd-k">${esc(k)}</span><span class="upd-v">${v}</span>`,
      )
      .join('') +
    `</div>` +
    (state.updating
      ? '<div class="upd-busy"><span class="upd-bar"></span>' +
        'Stopping the runtime, installing, starting it again…</div>'
      : '') +
    notes.join('');

  const check = $('checkUpdate');
  const apply = $('applyUpdate');
  if (check) {
    check.disabled = state.updating || updateChecking;
    check.textContent = updateChecking ? 'Checking…' : 'Check Again';
  }
  if (apply) {
    apply.disabled = state.updating || updateChecking || !u.newer || !u.canUpdate;
    apply.textContent = state.updating ? 'Updating…' : 'Update Now';
  }
}

async function checkEngineUpdate() {
  if (updateChecking || state.updating) return;
  updateChecking = true;
  renderUpdateDialog();
  try {
    state.update = await api('POST', '/api/engine/update/check');
  } catch (err) {
    toast('Could Not Check for Updates', err.message);
  } finally {
    updateChecking = false;
    renderUpdateChip();
    if (!$('updateModal').hidden) renderUpdateDialog();
  }
}

async function applyEngineUpdate() {
  const u = state.update || {};
  if (state.updating || !u.newer) return;
  state.updating = true;
  renderUpdateChip();
  renderUpdateDialog();
  let r;
  try {
    r = await api('POST', '/api/engine/update');
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  state.updating = false;
  if (r.ok) {
    toast('Runtime Updated', `${r.from || 'previous'} → ${r.to || 'new'}. The model list has been re-read.`);
  } else {
    toast('Update Failed', r.error || 'The runtime was not updated.');
  }
  await refreshStatus();
  await refreshUpdate();
  await loadModels();
  // A model that left the catalog leaves a role pointing at nothing. Say it once
  // here, rather than letting the next turn be the first thing to notice.
  const roles = state.config?.roles || {};
  const missing = Object.entries(roles)
    .filter(([, sel]) => sel?.ref && !modelByRef(sel.ref))
    .map(([id]) => roleLabel(id));
  if (missing.length) {
    toast(
      'Pick a Model',
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} no longer in the catalog.`,
      7000,
    );
  }
  if (!$('updateModal').hidden) renderUpdateDialog();
}

function setEventChip(type) {
  const el = $('lastEvent');
  if (el) el.textContent = String(type || 'idle').replace(/^session\./, '');
  // The age beside the label is the liveness readout now, so this only records
  // when; the dot belongs to the stream and is not flashed here.
  state.lastEventAt = Date.now();
  renderLastEventAge();
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

// Where a model comes from is part of its identity. Two engine providers, not
// three: `opencode` **is** OpenCode Zen — the free models need no key at all, and
// a Zen key on the same provider unlocks the paid ones. `opencode-go` is the Go
// plan, a separate provider with its own key. Both keys live in the engine, never
// here. A provider the operator adds in Settings is labelled by its *type* —
// `Local` for anything on this machine, its own name for a vendor (DeepSeek).
const ENGINE_PROVIDERS = [
  { id: 'opencode', label: 'OC Zen', note: 'Free models need no key; a Zen key unlocks the paid ones.' },
  { id: 'opencode-go', label: 'OC Go', note: 'Paid plan — its key lives in the engine.' },
];
const ENGINE_BADGES = Object.fromEntries(ENGINE_PROVIDERS.map((p) => [p.id, p.label]));
const PROVIDER_LABELS = id => ENGINE_BADGES[id];
const providerLabel = (p) => {
  const id = String(p || 'unknown');
  const configured = (state.config?.engine?.opencode?.providers || []).find((x) => x.id === id);
  // A local server is labelled by what it *is*, not by the app that happens to
  // be running it: the next machine's may be Ollama or vLLM, and a badge naming
  // one of them would be wrong everywhere else.
  if (configured) return configured.type === 'local' ? 'Local' : configured.name || id;
  if (ENGINE_BADGES[id]) return ENGINE_BADGES[id];
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

/**
 * Place the menu inside the window, always.
 *
 * It is fixed-positioned so it can escape the role cards' clipped wrapper, which
 * also means nothing clamps it: in the right-hand card column it ran off the
 * window, and on a second monitor it ran off the screen. Width first, then a
 * horizontal clamp, then down when there is room and up when there is not — and
 * never taller than the space it has, scrolling inside that.
 */
function positionModelMenu(input, menu) {
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
  // A rule between provider groups. Eleven rows of eight different sources read
  // as one list until the source changes are visible: the chip alone was too
  // quiet, and the selection highlight made it worse when it landed across two.
  const rows = [];
  let previousProvider = null;
  for (const m of list) {
    if (previousProvider !== null && m.provider !== previousProvider) {
      rows.push('<div class="model-sep" role="separator"></div>');
    }
    previousProvider = m.provider;
    rows.push(`<div class="model-opt${m.ref === p.sel.value ? ' is-current' : ''}" role="option" data-ref="${esc(m.ref)}">
            <span class="mo-src">${esc(providerLabel(m.provider))}</span>
            <span class="mo-name">${esc(shortModel(m.name))}</span>
            ${m.issues?.length ? `<span class="mo-issues" data-clear-issues="${esc(m.ref)}" title="${esc(issuesTitle(m))}">Issues</span>` : ''}
            <span class="mo-meta">${esc(modelMeta(m))}</span>
          </div>`);
  }
  menu.innerHTML = rows.length ? rows.join('') : '<div class="model-empty">No models match</div>';
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
async function editRoleSettings(roleId) {
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

  const result = await openDialog({
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
    // The Architect's own session runs under a ruleset, so the change reaches it
    // now rather than at the next restart - the same PATCH the mode switch uses.
    if (roleId === 'architect' && state.sessionId) {
      await api('PATCH', `/api/sessions/${encodeURIComponent(state.sessionId)}`, {
        permissions: state.mode === 'single' ? SINGLE_PERMISSIONS : [],
      });
    }
  } catch (err) {
    toast('Could Not Save the Role', err.message);
  }
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
  // On a fresh page, every project starts closed except General. It is done once
  // per load, not on every refresh of the list: `loadProjects` also runs after
  // creating a session or adding a project, and re-collapsing then would shut the
  // project the operator is working in.
  if (!state.collapsedInit) {
    state.collapsedInit = true;
    for (const p of state.projects) if (!p.general) state.collapsed.add(p.id);
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

/**
 * What a session is stopped on, if anything.
 *
 * A session waiting on an answer emits nothing, exactly like an idle one, and
 * the question panel only exists inside an open session — so after a reload a
 * blocked session used to look like any other and the operator had no way to
 * know a question was sitting there. The rail says it instead.
 */
function waitingFor(sessionId) {
  if (!sessionId) return null;
  if ((state.forms || []).some((f) => f.sessionId === sessionId)) return 'answer';
  if ((state.permissions || []).some((p) => p.sessionId === sessionId)) return 'decision';
  return null;
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
  const waiting = waitingFor(s.id);
  const waitNote = waiting === 'answer' ? ' · waiting on your answer' : waiting === 'decision' ? ' · waiting for your decision' : '';
  return `<div class="tree-row session${current ? ' is-current' : ''}" data-session="${esc(s.id)}">
    <button class="tree-open" title="${esc(title)}${when ? ` · ${esc(when)}` : ''}${busy ? ' · working' : ''}${waitNote}">
      <span class="tree-name">${esc(title)}</span>
    </button>
    <span class="tree-actions">
      <button class="tree-edit ic-edit" data-rename="${esc(s.id)}" title="Rename Session" aria-label="Rename Session">✎</button>
      ${waiting ? `<span class="tree-wait" title="${waiting === 'answer' ? 'Waiting on your answer' : 'Waiting for your decision'}">${waiting === 'answer' ? 'Answer' : 'Decide'}</span>` : ''}
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
      ${
        open
          ? `<div class="tree-project-body">
        <div class="tree-project-actions">
          <button class="btn-thin" data-browse-project="${esc(p.id)}" title="Open this project's folder in Explorer">Browse</button>
          <button class="btn-thin" data-cmd-project="${esc(p.id)}" title="Open a command prompt in this project's folder">Cmd</button>
        </div>
        <div class="tree-sessions-label">Sessions:</div>
        <div class="tree-sessions">${p.sessions.map(sessionRow).join('')}${newSessionRow(p.id)}</div>
      </div>`
          : ''
      }`);
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
  // A stopwatch belongs to the session it measured, so opening another one swaps
  // the totals rather than carrying them across.
  state.clocks = loadClocks(id);
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
  state.clocks = null;
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

/** The first sentence of a provider error, short enough for one card line. The
 *  full sentence rides the slot's tooltip, like every other card text. */
const shortErr = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const first = t.split(/(?<=[.!?])\s/)[0] || t;
  return first.length > 92 ? `${first.slice(0, 91)}…` : first;
};

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
    // The verdict chip (DONE / WAITING ON YOU) belongs beside the name, not in the
    // text slot: in the slot it took the first of the Architect's three lines and
    // left the two that were left for one line of summary. Created here rather
    // than in index.html so a card added there gets its holder without a second
    // edit, the same way the text slot above does.
    if (!card.querySelector('.role-chip')) {
      const hold = document.createElement('span');
      hold.className = 'role-chip';
      card.querySelector('.role-head h3')?.after(hold);
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
        chip = { cls: 'role-done', text: 'Done' };
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

    // A provider failure is *news*, shown as red text while it lasts. The border
    // keeps its own meaning — blocked, live, settled — so an error never borrows
    // it. The live run's own retry state is the freshest source; `roleErrors`
    // covers the Architect's wake, which happens after the run is gone.
    const cardErr =
      (run && run.role === role && run.retry) ||
      state.roleErrors.get(`${dirKey(currentProject()?.directory)}|${role}`) ||
      null;
    if (cardErr) {
      const at = Number(cardErr.at) || 0;
      const head = shortErr(cardErr.message);
      text = cardErr.retrying !== false && at ? `Retrying at ${hhmm(at)} — ${head}` : head;
    }

    // Dimmed cards are the ones that have never been in this project at all. A
    // card that is taking part is solid by definition, and the Architect is never
    // dimmed: it is the role that exists before any of this. A skipped card is
    // solid too — it is news, not absence.
    const dim = role !== 'architect' && !participated && !part && !skipped;
    rows.push({ card, text, part, dot, dim, chip, settled, skipped, err: Boolean(cardErr) });
    sig += `${role}\u0001${part}\u0001${dot}\u0001${dim ? 1 : 0}\u0001${settled ? 1 : 0}\u0001${skipped ? 1 : 0}\u0001${chip ? chip.text : ''}\u0001${cardErr ? 1 : 0}\u0001${text}\u0002`;
  }

  if (sig === state.roleSig) return;
  state.roleSig = sig;

  // The cards no longer change height here — the subtitle slot is a fixed
  // three-line hole — so this is only a re-measure for safety (a raised
  // `--task-lines`, a font swap). The dock's bottom never moves: the stage has a
  // definite height, so anything that did grow would take room from the
  // transcript's top edge.
  const fromH = Math.ceil($('topologyWrap')?.getBoundingClientRect().height || 0);
  for (const { card, text, part, dot, dim, chip, settled, skipped, err } of rows) {
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
    // The chip goes beside the name; the slot carries only the role's own text.
    const chipHost = card.querySelector('.role-chip');
    if (chipHost) chipHost.innerHTML = chip ? `<span class="${chip.cls}">${esc(chip.text)}</span>` : '';
    slot.textContent = text;
    // Red ink for a provider failure, cleared when the role works again. A class
    // on the text slot only: the card's border is a different sentence.
    slot.classList.toggle('is-err', Boolean(err));
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
    // A page opened mid-run has no trace of its own yet: make one from what the
    // server knows, so the chat shows the worker working straight away rather
    // than waiting for the next progress tick.
    for (const run of runs || []) {
      const key = traceKeyOf(run);
      if (!state.traces.has(key)) {
        state.traces.set(key, {
          key,
          dir: run.dir,
          role: run.role,
          task: run.task,
          title: run.title,
          startedAt: Number(run.startedAt) || Date.now(),
          finishedAt: 0,
          lines: [],
        });
      }
    }
  } catch { /* the stream will catch up */ }
  state.roleSig = '';
  renderRoleActivity();
}

/** One delegated run, live: started, its newest tool call, then finished. */
function handleRunEvent(ev) {
  const key = dirKey(ev.dir);
  if (ev.type === 'run.started' || ev.type === 'run.progress') {
    // A run reaching a role is that role working again, so its last error is no
    // longer the news. `run.progress` cannot clear it: the runner sends one right
    // after a retry notice, which would erase the notice it just sent.
    if (ev.type === 'run.started' && ev.role) state.roleErrors.delete(`${key}|${ev.role}`);
    state.runs.set(key, { ...(state.runs.get(key) || {}), ...ev });
    const run = state.runs.get(key);
    const trace = traceOf(run);
    if (!trace && ev.type === 'run.started') {
      state.traces.set(traceKeyOf(run), {
        key: traceKeyOf(run),
        dir: run.dir,
        role: run.role,
        task: run.task,
        title: run.title,
        startedAt: Number(run.startedAt) || Date.now(),
        finishedAt: 0,
        lines: [],
      });
    } else if (trace && run.tool) {
      // One line per new tool call, not one per event: the runner repeats the
      // same call on every progress tick. A call with no target ("reading") is
      // dropped when the line above it already said "reading <file>" — the
      // engine reports the target a moment after the call starts.
      const said = runPhrase(run.tool);
      const last = [...trace.lines].reverse().find((l) => l.kind === 'tool');
      const generic = !String(run.tool.target || '').trim();
      const repeated = generic && last && last.text.split(' ')[0] === said.split(' ')[0];
      // A shell line carries the whole command, quotes and all. One line of the
      // trace is not the place to read it; the card's tooltip and the report are.
      const line = said.length > 84 ? `${said.slice(0, 83)}…` : said;
      if (!repeated && !trace.lines.some((l) => l.kind === 'tool' && l.text === line)) {
        trace.lines.push({ kind: 'tool', text: line });
      }
    }
  } else if (ev.type === 'run.finished') {
    // A finished, successful run is the role working again; a run that failed is
    // the one case where the red line stays until the next attempt.
    if (ev.role && ev.outcome === 'completed') state.roleErrors.delete(`${key}|${ev.role}`);
    const done = state.runs.get(key);
    const trace = done ? traceOf(done) : null;
    if (trace) {
      // Folded, not deleted: the report is the thing to read, but the evidence of
      // what the worker actually did stays one click away.
      trace.finishedAt = Date.now();
      trace.ms = Number(ev.ms) || 0;
      trace.files = Number(ev.files) || 0;
      trace.outcome = ev.outcome || 'finished';
    }
    state.runs.delete(key);
  } else {
    return;
  }
  renderRoleActivity();
  // The plan pane overlays the live run too (a running task renders as `doing`
  // whatever the file says), so it needs to know when a run starts and stops — but
  // not on every tool call: that would rebuild the rail for nothing.
  if (ev.type !== 'run.progress') renderPlan();
  else renderTranscript();
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
  // Half the speed of the first version (2.2s/90 was a sprint at 1200px). The
  // `begin` offsets are fractions of DUR, so the pitch scales with it.
  const DUR = Math.max(4.4, len / 45);
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
  // A question needs room even when the conversation is empty: the panel is the
  // dock's own child and takes its height from the dock, so a freshly opened
  // session (a strip of composer) would show a 64px form with its buttons
  // hanging outside it. A form is something to read, so the dock opens for it.
  const hasHistory = showable.length > 0 || Boolean(pending) || Boolean(currentForm());
  // The dock is a bare composer while empty and fills the stage once there is
  // anything to show; the CSS keys off this class, so set it on every render.
  $('chatDock')?.classList.toggle('has-history', hasHistory);
  // An empty dock sits at the bottom of the page, a full one starts under the
  // cards — so the room left for it has to be re-measured on every change.
  fitChatHeight();

  // Nothing in the conversation changed since the last render: leave the DOM —
  // and whatever the operator has open — exactly as it is.
  const sig = hasHistory
    ? `${showable.map((m) => `${m.id}:${m.completed || 0}:${(m.parts || []).length}`).join(',')}|${pending.length}|${state.streaming}|${traceSig()}`
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
  // The conversation, with each worker's trace where it happened: a run that
  // started at 19:45 belongs above the report that arrives at 19:54, not under
  // it. Traces are merged by start time and fall off the end when they outlast
  // the newest message.
  const traces = tracesFor(currentProject()?.directory).sort((a, b) => a.startedAt - b.startedAt);
  let html = '';
  let next = 0;
  for (const m of showable) {
    const at = Number(m.created) || 0;
    while (next < traces.length && at && traces[next].startedAt < at) html += renderTrace(traces[next++]);
    html += renderMessage(m);
  }
  while (next < traces.length) html += renderTrace(traces[next++]);
  el.innerHTML = html + pending;
  if (stick) scrollChatToBottom();
  renderChatNav();
}

/**
 * What a worker is doing, in the chat, while it does it.
 *
 * A worker's session is its own, so its turns never reach this transcript — the
 * operator watched a nine-minute design run with nothing on screen and then one
 * report. Its newest tool call (from the runner) and its newest sentence (read
 * from its session, because that is the only honest source) are shown light grey
 * so the chat is visibly alive, and the whole thing folds to a single line once
 * the run ends: the report is the thing to read, not the transcript behind it.
 */
function renderTrace(t) {
  const name = roleLabel(t.role);
  const head = [name, t.task, t.title].filter(Boolean);
  const lines = (t.lines || [])
    .slice(-8)
    .map((l) =>
      l.kind === 'word'
        ? `<div class="trace-line is-word">“${esc(l.text)}”</div>`
        : `<div class="trace-line">${esc(l.text)}</div>`,
    )
    .join('');
  if (!t.finishedAt) {
    return `<div class="trace is-live" data-trace="${esc(t.key)}">
      <div class="trace-head">${esc(head.join(' · '))}</div>
      <div class="trace-lines">${lines || '<div class="trace-line">starting…</div>'}</div>
    </div>`;
  }
  const took = t.ms ? ` · ${shortSpan(t.ms)}` : '';
  const written = t.files ? ` · ${t.files} file${t.files === 1 ? '' : 's'}` : '';
  return `<details class="trace is-fold" data-trace="${esc(t.key)}">
    <summary>${esc(head.join(' · '))}${took}${written}</summary>
    <div class="trace-lines">${lines}</div>
  </details>`;
}

/** The traces that belong to a project, in the order they started. */
function tracesFor(dir) {
  const key = dirKey(dir);
  return [...state.traces.values()].filter((t) => dirKey(t.dir) === key);
}

// A worker's own words are read from its session rather than guessed from the
// event stream: the delta payload is the engine's business and has changed
// shape before. One read per finished text block, debounced, and only while a
// run for this project is live.
const wordTimers = new Map();
function noteWorkerWords(sessionId) {
  const run = currentRun();
  if (!run || !sessionId || run.workerId !== sessionId) return;
  clearTimeout(wordTimers.get(sessionId));
  wordTimers.set(
    sessionId,
    setTimeout(async () => {
      try {
        const { messages } = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages`);
        let said = '';
        for (const m of messages || []) {
          if (m.type !== 'assistant') continue;
          for (const p of m.parts || []) if (p.type === 'text' && p.text && String(p.text).trim()) said = String(p.text);
        }
        said = said.replace(/\s+/g, ' ').trim();
        if (!said) return;
        const trace = traceOf(run);
        if (!trace) return;
        const short = said.length > 220 ? `${said.slice(0, 219)}…` : said;
        if (trace.lines.some((l) => l.kind === 'word' && l.text === short)) return;
        trace.lines.push({ kind: 'word', text: short });
        renderTranscript();
      } catch { /* the worker's session may be gone; the tool line still moves */ }
    }, 400),
  );
}

const traceKeyOf = (run) => `${dirKey(run.dir)}|${run.task}|${Number(run.startedAt) || 0}`;
function traceOf(run) {
  return run ? state.traces.get(traceKeyOf(run)) || null : null;
}

/** What the traces are showing, so a rebuilt transcript is not rebuilt for
 *  nothing while they sit still. */
function traceSig() {
  return [...state.traces.values()]
    .map((t) => `${t.key}:${t.finishedAt || 0}:${(t.lines || []).length}`)
    .join(';');
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
  // No internal scroller: the whole conversation fits its box. "At the bottom"
  // then means the chat's own bottom edge is in view — not that the *page* has
  // reached its end. Below 1460px the page continues past the chat into the
  // rail, so the document's bottom is hundreds of pixels below the conversation
  // and asking about it always answered "scrolled up".
  const box = $('transcript');
  if (!box) return true;
  return box.getBoundingClientRect().bottom <= window.innerHeight + slack;
}

function scrollChatToBottom(behavior = 'auto') {
  const el = chatScroller();
  if (el) { el.scrollTo({ top: el.scrollHeight, behavior }); return; }
  // The transcript already fits its box: the newest message is laid out and
  // there is nothing to scroll to. This used to fall through to the WINDOW and
  // jump to `documentElement.scrollHeight` — past the chat, to the very bottom
  // of the page, which in the stacked layout is the rail. That is the "the
  // central panel scrolled itself" report, and it only happened while the
  // conversation was still short enough not to scroll inside its own box; once
  // it grew, the branch above took over and the jump stopped. The page is moved
  // deliberately in exactly two places (Send and opening a session), never by a
  // render.
}

const navMessages = () => [...document.querySelectorAll('#transcript .msg[data-msg]')];

function myMessageTops() {
  const el = chatScroller();
  if (el) {
    const sRect = el.getBoundingClientRect();
    return navMessages().map((n) => n.getBoundingClientRect().top - sRect.top + el.scrollTop);
  }
  return navMessages().map((n) => n.getBoundingClientRect().top + window.scrollY);
}

/**
 * Which message currently owns the top of the viewport. `cur` is the last
 * message whose top is at or above the fold; -1 means the view sits above every
 * message. Comparing raw scroll offsets is not enough: the first message often
 * sits ~10px below the content top, so a "first one below the fold" test kept
 * re-selecting it and the DOWN button never advanced past message one.
 *
 * Anchors are every turn, including Synapse's own reports: the rule between
 * speakers is the only structure the transcript has, so the bars are the anchors
 * and a chat with two of them has somewhere to jump.
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
  // The transcript's only structure is the rule between speakers, so the bars
  // are what the buttons step through: two of them means there is something to
  // jump between. (Messages = bars + 1.)
  const count = navMessages().length;
  const show = count >= 3;
  nav.hidden = !show;
  if (!show) return;

  // No JS anchoring: the nav is absolutely positioned inside the dock, so it is
  // clipped to the chat pane and stays put when the window resizes.

  const { tops, cur } = navAnchors();
  // Never offer a jump that cannot happen: with nothing to scroll, all four rest.
  const el = chatScroller();
  const canScroll = el ? el.scrollHeight - el.clientHeight > 2 : document.documentElement.scrollHeight > window.innerHeight + 2;
  const at = el ? el.scrollTop : window.scrollY;
  const atEnd = el ? el.scrollHeight - el.clientHeight : document.documentElement.scrollHeight - window.innerHeight;
  const atBottom = at >= atEnd - 1;
  $('navTop').disabled = !canScroll || at <= 1;
  $('navPrev').disabled = !canScroll || cur <= 0;
  // At the bottom the last message is already in view, but its anchor can sit
  // below the fold — so `cur` still points at the one before it and Next looked
  // available with nowhere to go. The bottom button is the honest authority.
  $('navNext').disabled = !canScroll || atBottom || cur >= tops.length - 1;
  $('navBottom').disabled = !canScroll || atBottom;
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
  return `<div class="ask-field" data-ask-field="${esc(key)}" data-ask-index="${index}" data-ask-type="${esc(type)}"${when}${
    field.required ? ' data-ask-required="1"' : ''
  }>${title}${text}${req}${body}</div>`;
}

function renderAskPanel() {
  const host = $('askHost');
  if (!host) return;
  const form = state.view === 'session' ? currentForm() : null;
  if (!form) {
    state.askSig = '';
    state.askPage = 0;
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
      <span class="ask-progress" data-ask-progress hidden></span>
      <button class="btn btn-ghost btn-sm" data-ask-back hidden>Back</button>
      <button class="btn btn-ask btn-sm" data-ask-next hidden>Next</button>
      <button class="btn btn-ask btn-sm" data-form-reply="${esc(form.id)}" hidden>Submit Answer</button>
    </div>
  </div>`;
  // A new form starts at its first question. The page is *not* reset on a poll:
  // an unchanged signature returns above, so a rebuild never moves the operator.
  state.askPage = 0;
  $('chatDock')?.classList.add('has-ask');
  refreshAskPanel();
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

/** The questions of a form in the order they are asked. A field the engine marks
 *  `hidden` is not a question at all and never becomes a page. */
function askPageList(panel, form) {
  return (form?.fields || [])
    .map((field, index) => ({ field, holder: panel.querySelector(`.ask-field[data-ask-index="${index}"]`) }))
    // `when` hides a question whose premise the operator has not chosen; it must
    // not become a page they cannot reach an answer for either.
    .filter(({ field, holder }) => !field.hidden && holder && !holder.hidden);
}

/** Show the question at `state.askPage` and nothing else. A five-question form
 *  used to be one long scroll and the questions below the fold were missed.
 *  Every field stays in the DOM — off-page is a class, never `hidden` — so
 *  answers survive paging and the `when` rules keep working. */
function applyAskPage(panel = document.querySelector('.ask-panel')) {
  const form = currentForm();
  if (!panel || !form) return;
  const pages = askPageList(panel, form);
  const last = Math.max(0, pages.length - 1);
  if (state.askPage > last) state.askPage = last;
  if (state.askPage < 0) state.askPage = 0;
  const active = pages[state.askPage]?.holder || null;
  for (const holder of panel.querySelectorAll('.ask-field')) {
    holder.classList.toggle('ask-page-off', Boolean(active) && holder !== active);
  }
  const many = pages.length > 1;
  const progress = panel.querySelector('[data-ask-progress]');
  if (progress) {
    progress.hidden = !many;
    progress.textContent = many ? `Question ${state.askPage + 1} of ${pages.length}` : '';
  }
  const back = panel.querySelector('[data-ask-back]');
  const next = panel.querySelector('[data-ask-next]');
  const submit = panel.querySelector('[data-form-reply]');
  // One question keeps the old shape: no counter, no paging, just Submit.
  if (back) back.hidden = !many || state.askPage === 0;
  if (next) next.hidden = !many || state.askPage >= last;
  if (submit) submit.hidden = many && state.askPage < last;
}

function moveAskPage(delta) {
  const panel = document.querySelector('.ask-panel');
  if (!panel) return;
  const before = state.askPage;
  state.askPage += delta;
  applyAskPage(panel);
  if (state.askPage === before) return;
  syncAskState();
  // A new question starts at its own top: a long list of options must not open
  // where the previous page happened to be scrolled to.
  const fields = panel.querySelector('.ask-fields');
  if (fields) fields.scrollTop = 0;
}

/** Conditions first, then which page that leaves, then the buttons: a `when`
 *  rule can hide the question the operator was looking at. */
function refreshAskPanel() {
  applyAskConditions();
  applyAskPage();
  syncAskState();
}

/** Required fields, and the free-text box on a choice question, only make sense
 *  live: Next says no until this page can be answered, Submit until the whole
 *  form can. */
function syncAskState() {
  const panel = document.querySelector('.ask-panel');
  const form = currentForm();
  if (!panel || !form) return;
  const btn = panel.querySelector('[data-form-reply]');
  const next = panel.querySelector('[data-ask-next]');
  const note = panel.querySelector('[data-ask-state]');
  if (!btn) return;
  const answer = collectAskAnswer(form);
  const blank = (field) => {
    const v = answer[String(field.key ?? '')];
    return (
      v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)
    );
  };
  const missing = (form.fields || []).filter((f) => {
    if (!f.required || f.hidden || f.type === 'external') return false;
    const holder = panel.querySelector(`[data-ask-field="${CSS.escape(String(f.key ?? ''))}"]`);
    if (!holder || holder.hidden) return false;
    return blank(f);
  });
  const active = askPageList(panel, form)[state.askPage]?.field;
  const activeMissing = Boolean(active && active.required && active.type !== 'external' && blank(active));
  btn.disabled = missing.length > 0;
  if (next) next.disabled = activeMissing;
  if (note) {
    // On a page with a Next, only *this* question can block you — naming a
    // question further down the form would be a warning about something the
    // operator cannot even see yet. Submit is the one that speaks for the form.
    const text = !next || next.hidden
      ? missing.length
        ? 'Answer every required question to send.'
        : ''
      : activeMissing
        ? 'Answer this question to continue.'
        : '';
    note.textContent = text;
    note.hidden = !text;
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
    // The rail's Answer mark is part of the same fact: clear it now, or it
    // outlives the question until the next poll.
    renderTree();
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

  // A question must not be able to hide. The panel lives inside the session
  // view and a reload opens no session, so a waiting question says so once —
  // and the rail carries a mark on the session that asked it, so a page left
  // open on the project list still shows where the run is stuck.
  for (const form of state.forms) {
    if (state.announcedForms.has(form.id)) continue;
    state.announcedForms.add(form.id);
    if (state.view === 'session') continue; // the panel is on screen already
    const who = findSession(form.sessionId)?.title || TBD_TITLE;
    toast('Answer Needed', `${who} is waiting on a question. Open it in the rail to answer.`);
  }

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
const PLAN_STATUS = {
  todo: 'Todo',
  doing: 'Doing',
  // Not a plan file status: a step whose worker has reported and whose result the
  // Architect has not judged yet. See renderPlan.
  review: 'Reported, waiting for review',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
};

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
      `<p class="rail-note plan-meta"><span>${esc(rel)}</span>${planClockMarkup()}</p>`;
    return;
  }

  const tasks = st?.plan?.tasks || [];
  // A task with a worker on it is the step in hand whatever the file says. The
  // Architect only writes the plan when it judges, so during the run the file
  // still says todo and the pane showed the live step as a grey row. The run is
  // the live truth; the file stays the plan.
  const liveRun = currentRun();
  if (!tasks.length) {
    body.innerHTML =
      `<p class="rail-note">No plan yet. Ask the Architect to plan this job - it owns ${esc(rel)}.</p>` +
      `<p class="rail-note plan-meta"><span></span>${planClockMarkup()}</p>`;
    return;
  }

  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  // The line has to fit a 300px rail beside the session clock, so it carries the
  // three facts that change and nothing else: how far the plan got, how much is
  // running, how much is blocked. "done" rides on the fraction only when the
  // plan is finished (it then says the job is closed); the plan's age moved into
  // the tooltip, where it costs no width.
  const done = counts.done || 0;
  const meta = [done === tasks.length ? `${done}/${tasks.length} done` : `${done}/${tasks.length}`];
  if (counts.doing) meta.push(`${counts.doing} running`);
  if (counts.blocked) meta.push(`${counts.blocked} blocked`);
  if (counts.failed) meta.push(`${counts.failed} failed`);
  const metaTitle = `${done} of ${tasks.length} tasks done${st.mtime ? `; the plan changed ${ago(st.mtime)}` : ''}`;

  // Work already spent on each step, from the harness's own run records. A step
  // with a worker on it keeps counting from the live run's start.
  const spent = st.spent || {};
  // Steps whose worker has reported and whose result the Architect has not
  // written back yet (see the plan route).
  const reported = new Set(st.reported || []);
  body.innerHTML =
    (st.plan.goal ? `<p class="plan-goal">${esc(st.plan.goal)}</p>` : '') +
    `<ol class="plan-list">${tasks
      .map((t) => {
        const status = liveRun && liveRun.task === t.id ? 'doing' : PLAN_STATUS[t.status] ? t.status : 'todo';
        // Between the worker's result and the Architect's judgement the plan file
        // still says `todo`, but the step is not untouched: it is in review. Shown
        // as `review` so the row keeps a mark of its own instead of dropping back
        // to grey, which read as a revert.
        const shown = status === 'todo' && reported.has(t.id) ? 'review' : status;
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
        // The step's own stopwatch: what the harness recorded for it, plus this
        // run so far while it is in hand. Under the role badge, so the row is two
        // lines tall whatever the title does.
        const base = Number(spent[t.id]) || 0;
        const since = liveRun && liveRun.task === t.id ? Number(liveRun.startedAt) || 0 : 0;
        const total = base + (since ? Date.now() - since : 0);
        return `<li class="plan-task" data-status="${shown}">
          <span class="plan-node">
            <span class="plan-dot" role="img" aria-label="${esc(PLAN_STATUS[shown])}"></span>
            <span class="plan-id">${esc(t.id || '?')}</span>
          </span>
          <span class="plan-main">
            <span class="plan-title" title="${esc(tooltip)}">${esc(t.title)}</span>
            ${t.note && asking ? `<span class="plan-note">${esc(t.note)}</span>` : ''}
          </span>
          <span class="plan-side">
            <span class="plan-role">${esc(t.role)}</span>
            <span class="plan-spent${total ? '' : ' is-zero'}" data-ms="${base}"${
              since ? ` data-since="${since}"` : ''
            } title="Time spent on this step so far">${hhmmss(total)}</span>
          </span>
        </li>`;
      })
      .join('')}</ol>` +
    // The plan's complaints are for the Architect, not the operator: they name
    // feature ids, task ids and file paths, and every one of them is something
    // the Architect is already being told to fix in its own instruction block.
    // Printing them here put four lines of housekeeping under the operator's
    // plan and asked them to care about a job that was not theirs. The log keeps
    // them (`logPlanState`), which is where a run is read afterwards.
    `<p class="rail-note plan-meta"><span title="${esc(metaTitle)}">${esc(meta.join(' · '))}</span>${planClockMarkup()}</p>`;
}

/** The session's own stopwatch, in the plan footer: time spent working, paused
 *  whenever the cards show nobody working. It is rendered here so a plan poll
 *  repaints it with the right value instead of zeroing it. */
function planClockMarkup() {
  const c = state.clocks;
  if (!c) return '';
  const ms = c.session.ms + (c.session.since ? Date.now() - c.session.since : 0);
  return `<span class="plan-clock" id="planClock" title="Time this session has spent working — it pauses whenever no card is working, and whenever you are being waited on.">${hhmmss(ms)}</span>`;
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
          ? 'not offered'
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
  // Stop has to work while a worker is running or waiting out a retry, when the
  // open session is idle — that is exactly when it is the only way out.
  $('stopBtn').disabled = !(state.busy || (hasSession && currentRun())) || !hasSession;
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
  // A delegated run is the thing to stop when one is live: the open session is
  // the Architect, and it is usually idle while a worker works. Stopping the
  // session instead would leave the worker running and the project locked.
  const run = currentRun();
  if (run) {
    try {
      const { ok } = await api('POST', '/api/runs/cancel', { dir: run.dir });
      toast(ok ? 'Stopping' : 'Nothing To Stop', ok ? `${run.title || run.task} is being stopped.` : 'That run had already finished.');
    } catch (err) {
      toast('Stop failed', err.message);
    }
    return;
  }
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

    // The engine's version moved (an update finished): the chip and the dialog
    // both read from this, and the catalog may have changed with it.
    if (ev.kind === 'engine-update') {
      if (ev.update) state.update = ev.update;
      renderUpdateChip();
      if (!$('updateModal').hidden) renderUpdateDialog();
      return;
    }

    // Synapse's own short note (not an alarm, not a message to any model): the
    // harness declined to do something the operator should know about.
    if (ev.kind === 'note') {
      toast(ev.title || 'Note', ev.body || '');
      return;
    }

    // A provider failure against a role: red text on that role's card, cleared
    // when it works again. Not a blocker and not a border — it is news the
    // operator should notice while it is true, and forget afterwards.
    if (ev.kind === 'role-error') {
      const key = `${dirKey(ev.dir)}|${ev.role || ''}`;
      if (ev.clear) state.roleErrors.delete(key);
      else {
        state.roleErrors.set(key, {
          message: ev.message || '',
          attempt: Number(ev.attempt) || 0,
          at: Number(ev.at) || Date.now(),
          retrying: ev.retrying !== false,
        });
      }
      state.roleSig = '';
      renderRoleActivity();
      return;
    }

    // The harness watchdog: something the models run touched Synapse's own files.
    // This is the one event that must not be missed, so it is loud in both places
    // the operator looks — a toast now, and the error dialog with the paths.
    if (ev.kind === 'alarm') {
      openAlarm(ev);
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
    // A worker's session is not the open one, so nothing of it renders through
    // `mine`. Its words are read here instead, for the trace in the chat.
    if (ev.type === 'session.text.ended') noteWorkerWords(ev.sessionId);
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

/**
 * What the engine can load, and whether a role expects something that is not
 * here.
 *
 * The failure this exists for is silent: a role's skill list survives a move to
 * another machine, the folder does not, and the ruleset still "allows" a name
 * that can never load. Nothing errors — the Architect simply stops being able to
 * look at a mock. So the gap is named once at boot, and again in Settings.
 */
async function checkSkills({ quiet = false } = {}) {
  try {
    state.skillsInfo = await api('GET', '/api/skills');
  } catch {
    state.skillsInfo = null;
    return;
  }
  if (quiet) return;
  const missing = state.skillsInfo?.missing || [];
  const gone = (state.skillsInfo?.paths || []).filter((p) => !p.exists);
  const dupes = (state.skillsInfo?.paths || []).flatMap((p) => (p.duplicates || []).map((n) => `${n} (also in ${p.path})`));
  if (!missing.length && !gone.length && !dupes.length) return;
  const parts = [];
  if (missing.length) {
    const roles = [...new Set(missing.flatMap((m) => m.roles))];
    parts.push(`${missing.map((m) => m.name).join(', ')} — used by ${roles.join(', ')}`);
  }
  if (gone.length) parts.push(`folder not found: ${gone.map((p) => p.path).join(', ')}`);
  if (dupes.length) parts.push(`two copies of ${dupes.join(', ')} — the engine picks one`);
  toast('Some Skills Are Missing', `${parts.join('. ')}. Settings → Skills says where they go.`, 9000);
}

/** One line for the Settings panel, kept short enough to read at a glance. */
function skillsSummary() {
  const info = state.skillsInfo;
  if (!info) return 'Skills have not been read yet.';
  const total = (info.skills || []).length;
  const missing = (info.missing || []).map((m) => `${m.name} (${m.roles.join(', ')})`);
  const gone = (info.paths || []).filter((p) => !p.exists).map((p) => p.path);
  const dupeNames = [...new Set((info.paths || []).flatMap((p) => p.duplicates || []))];
  const bits = [`${total} skill(s) load, ${info.bundled ? `including Synapse's own in ${info.bundled}` : 'from the skills folder'}`];
  if (missing.length) bits.push(`not installed: ${missing.join(', ')}`);
  if (gone.length) bits.push(`extra folder missing: ${gone.join(', ')}`);
  if (dupeNames.length) bits.push(`also in your folder, so either copy may load: ${dupeNames.join(', ')}`);
  return bits.join(' · ');
}

// ── settings: six tabs over one config file ─────────────────────
// It used to be one long column of fourteen sections, which read as a wall: the
// port you need and the log level you never change had the same weight. The tabs
// are the app's own vocabulary - server, engine, providers, workers, tools,
// logging - and they buy the room to make Providers a real editor instead of two
// JSON blobs in a text field.
//
// Every pane renders from a *draft* (state.setDraft), not from the saved file.
// Leaving a tab collects its fields into the draft first, so a half-typed port
// survives a look at Providers, and Revert is then exactly "throw the draft away".
// Nothing reaches disk until Save Changes.

const ICONS = {
  sliders:
    '<path d="M2 5h6.4M11.4 5H14M2 11h3.4M8.4 11H14"/><circle cx="9.9" cy="5" r="1.5"/><circle cx="6.9" cy="11" r="1.5"/>',
  engine:
    '<rect x="3.6" y="3.6" width="8.8" height="8.8" rx="2"/><path d="M6.2 1.9v1.7M9.8 1.9v1.7M6.2 12.4v1.7M9.8 12.4v1.7M1.9 6.2h1.7M1.9 9.8h1.7M12.4 6.2h1.7M12.4 9.8h1.7"/>',
  plug: '<path d="M5.3 1.9v3.3M10.7 1.9v3.3"/><path d="M3.7 5.2h8.6v1.9a4.3 4.3 0 0 1-8.6 0z"/><path d="M8 11.4v2.6"/>',
  nodes:
    '<circle cx="8" cy="3.1" r="1.6"/><circle cx="3.5" cy="12.3" r="1.6"/><circle cx="12.5" cy="12.3" r="1.6"/><path d="M8 4.7v3M8 7.7 4.6 11M8 7.7 11.4 11"/>',
  tools:
    '<path d="M2.5 9.5h2.8l1 1.9h3.4l1-1.9h2.8"/><rect x="2.5" y="2.9" width="11" height="10.3" rx="2"/>',
  lines: '<path d="M2.7 4.1h10.6M2.7 8h10.6M2.7 11.9h6.2"/>',
  eye: '<path d="M1.7 8S4 3.9 8 3.9 14.3 8 14.3 8 12 12.1 8 12.1 1.7 8 1.7 8z"/><circle cx="8" cy="8" r="1.9"/>',
  eyeOff:
    '<path d="M2.3 9.3C3.6 6.4 5.6 5 8 5s4.4 1.4 5.7 4.3"/><path d="M4 11.2 2.7 12.9M8 10.3v2.3M12 11.2 13.3 12.9"/>',
};

const setIcon = (name) =>
  `<svg class="set-ic" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" ` +
  `stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

const SETTINGS_TABS = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'engine', label: 'Runtime', icon: 'engine' },
  { id: 'providers', label: 'Providers', icon: 'plug' },
  { id: 'workers', label: 'Workers', icon: 'nodes' },
  { id: 'tools', label: 'Tools', icon: 'tools' },
  { id: 'logging', label: 'Logging', icon: 'lines' },
];

// Every control carries a plain-English tooltip: the config file is the source
// of truth, but this screen is where a number is actually chosen, and "what is
// this?" should not require reading the source. Units live in the label, and
// anything long is in minutes — nobody reads 1200 and thinks "twenty minutes".
function setField(c, label, path, opts = {}) {
  const scale = Number(opts.scale) || 1;
  const raw = opts.value !== undefined ? opts.value : readPath(c, path);
  const shown = scale === 1 ? raw : Number(raw) / scale;
  const badge = opts.restart ? ' <em class="set-restart">Restart</em>' : '';
  return `
    <label class="set-field${opts.wide ? ' wide' : ''}" title="${esc(opts.hint || '')}">
      <span>${esc(label)}${badge}</span>
      <input data-path="${path}"${scale !== 1 ? ` data-scale="${scale}"` : ''} type="${opts.type || 'text'}" value="${esc(shown)}" ${opts.attr || ''} />
    </label>`;
}

function setSelect(c, label, path, options, opts = {}) {
  const badge = opts.restart ? ' <em class="set-restart">Restart</em>' : '';
  return `
    <label class="set-field${opts.wide ? ' wide' : ''}" title="${esc(opts.hint || '')}">
      <span>${esc(label)}${badge}</span>
      <select data-path="${path}">
        ${options.map((o) => `<option value="${esc(o.v)}"${o.v === readPath(c, path) ? ' selected' : ''}>${esc(o.l)}</option>`).join('')}
      </select>
    </label>`;
}

const setCheck = (c, label, path, hint = '') => `
    <label class="set-check" title="${esc(hint)}">
      <input data-path="${path}" type="checkbox" ${readPath(c, path) ? 'checked' : ''} />
      <span>${esc(label)}</span>
    </label>`;

const setGroup = (title, body, cols) =>
  `<section class="set-group"><h4>${title}</h4><div class="set-grid${cols === 3 ? ' cols-3' : ''}">${body}</div></section>`;

// ── panes ───────────────────────────────────────────────────────

function settingsGeneral(c) {
  return [
    setGroup(
      'Server',
      setField(c, 'Host', 'server.host', {
        restart: true,
        hint: 'The address the Synapse window is served on. 127.0.0.1 means only this machine can open it.',
      }) +
        setField(c, 'Port', 'server.port', {
          type: 'number',
          restart: true,
          hint: 'The port the Synapse window uses. Change it only if another program already uses this one.',
        }) +
        setCheck(
          c,
          'Open browser on start',
          'server.openBrowser',
          'Open a browser tab on Synapse when it starts. Off means you open it yourself.',
        ),
    ),
    setGroup(
      'Working Directory',
      setField(c, 'Where new sessions run (blank = workspace)', 'defaults.directory', {
        wide: true,
        hint: 'The folder new sessions start in when no project is chosen. Blank uses the projects folder.',
      }),
    ),
  ].join('');
}

function settingsEngine(c) {
  // Show what the engine actually resolved when the config is blank: these two
  // fields mean "auto" when empty, and an empty box hides the path in use.
  const detected = state.status?.engine || {};
  const binaryValue = readPath(c, 'engine.opencode.binary') || detected.binary || '';
  const homeValue = readPath(c, 'engine.opencode.home') || detected.home || '';
  return [
    setGroup(
      'Runtime',
      setSelect(
        c,
        'Runtime',
        'engine.type',
        [{ v: 'opencode', l: 'OpenCode' }],
        { hint: 'Which agent engine Synapse drives. Only OpenCode is implemented.', restart: true },
      ) +
        setField(c, 'Runtime port', 'engine.opencode.port', {
          type: 'number',
          restart: true,
          hint: 'The port Synapse asks the engine to listen on. It must differ from the Synapse port.',
        }) +
        setField(c, 'opencode.exe path (blank = auto-detect)', 'engine.opencode.binary', {
          wide: true,
          restart: true,
          value: binaryValue,
          hint: 'The engine program. Leave it blank and Synapse finds it by itself.',
        }) +
        setField(c, 'Password (blank = keep existing)', 'engine.opencode.password', {
          type: 'password',
          restart: true,
          attr: 'placeholder="unchanged"',
          hint: "Password for the runtime's local API. Leave it blank to keep the password already saved.",
        }) +
        setField(c, 'Start timeout (seconds)', 'engine.opencode.startTimeoutMs', {
          type: 'number',
          scale: 1000,
          restart: true,
          hint: 'How long Synapse waits for the engine to report ready when it starts. Seconds.',
        }) +
        setField(c, 'Runtime home (blank = data\\engine\\opencode)', 'engine.opencode.home', {
          wide: true,
          restart: true,
          value: homeValue,
          hint: 'Where the engine keeps its own settings, logs and data. Blank uses the copy inside Synapse; the machine-wide OpenCode install is never touched.',
        }) +
        `<p class="set-note">Running <strong>${esc(detected.version || 'not started')}</strong> from ` +
        `<code>${esc(detected.binary || 'auto-detected')}</code>. The model list is read from this runtime at ` +
        `every launch, but the catalog ships inside its binary — so a stale model list means a stale copy. ` +
        `A copy inside <code>bin\\opencode</code> travels with Synapse and wins over a global install; ` +
        `Check for Updates fetches the newest from npm and copies it over this one.</p>` +
        `<div class="set-field wide" title="Ask npm whether a newer engine has been published. The engine carries the model catalog, so this is also how the model list gets current."><span>Runtime version</span>` +
        `<button type="button" class="btn btn-secondary btn-sm" data-check-update>Check for Updates</button></div>`,
    ),
    setGroup(
      'Model Checks',
      setField(c, 'Max asks per model (1–20)', 'modelChecks.maxAsks', {
        type: 'number',
        hint: 'How many times Synapse may ask one model which tools it has before it stops asking. Between 1 and 20, counted across sessions and restarts.',
      }) +
        `<div class="set-field" title="Set every model's ask count back to zero. Answers already learned are kept."><span>Ask counters</span>` +
        `<button type="button" class="btn btn-warn btn-sm" data-reset-asks>Reset Ask Counters</button></div>`,
    ),
  ].join('');
}

function settingsWorkers(c) {
  return [
    setGroup(
      'Timers',
      setField(c, 'Restart after silence (minutes)', 'worker.stallSec', {
        type: 'number',
        scale: 60,
        hint: 'If a worker writes, reads and says nothing at all for this long, Synapse interrupts it and tells it to carry on from where it stopped. Any activity resets the clock, so a slow turn is never cut short however long it takes. Minutes.',
      }) +
        setField(c, 'Restarts allowed per task', 'worker.resumeMax', {
          type: 'number',
          hint: 'How many times one task may be interrupted for silence and told to continue before it is reported as stuck. 0 turns restarts off.',
        }) +
        setField(c, 'First retry wait (seconds)', 'worker.retryBaseSec', {
          type: 'number',
          hint: 'After a rate limit or a dropped connection, how long Synapse waits before asking the same worker to continue. It doubles with each retry. Seconds.',
        }) +
        setField(c, 'Longest retry wait (minutes)', 'worker.retryCapSec', {
          type: 'number',
          scale: 60,
          hint: 'The ceiling for that wait. Recoverable failures are retried indefinitely at this interval; there is no attempt limit, so only Stop ends one. Minutes.',
        }) +
        `<p class="set-note">Rate limits, dropped connections and server errors are retried for as long as it takes, and they do not count as attempts: the worker keeps its progress. A retired model, a wrong key or a malformed request is final, and is reported. Every provider failure is written to <code>data\\provider-errors.log</code>, which keeps 30 days regardless of the log retention below.</p>`,
    ),
    setGroup(
      'Escalation',
      setField(c, 'Coder ladder (role ids, in order)', 'worker.ladder', {
        wide: true,
        value: (readPath(c, 'worker.ladder') || []).join(', '),
        hint: 'Roles that can stand in for one another, in escalation order. When a coder cannot do the job, the same task moves down this list.',
      }) +
        `<p class="set-note">A task is written for one role. When that coder cannot do the job, the harness hands the same task down this list — never to a role that is not on it.</p>`,
    ),
  ].join('');
}

function settingsTools(c) {
  return [
    setGroup(
      'Tool Census',
      setCheck(
        c,
        'Clear the tool census on every start',
        'tools.resetOnBoot',
        'Start the tool-call counts from zero each time Synapse starts, so they describe this session rather than every test run ever.',
      ) +
        `<div class="set-field wide" title="Delete the tool-call counts now."><span>Counts</span>` +
        `<button type="button" class="btn btn-warn btn-sm" data-clear-tools>Clear Tool Census</button></div>`,
    ),
    setGroup(
      'Skills',
      setField(c, 'Extra skill folders (separate with ;)', 'engine.opencode.skillPaths', {
        wide: true,
        restart: true,
        value: (c.engine?.opencode?.skillPaths || []).join(';'),
        hint: "Extra folders of agent skills, separated by semicolons. Synapse's own skills and your ~/.agents/skills always load; add a folder here only for skills in neither.",
      }) +
        `<p class="set-note">${esc(skillsSummary())}</p>` +
        `<p class="set-note">Synapse's own skills ship in <code>skills\\</code> beside the app and always load, ` +
        `so the pipeline works on a fresh machine with nothing installed. The engine also reads your own ` +
        `<code>~/.agents/skills</code>, which is why your library appears here too — and where a name exists in ` +
        `both places, the copy Synapse ships is the one that loads. A skill a role names but this machine does ` +
        `not have is listed above instead of disappearing quietly.</p>`,
    ),
  ].join('');
}

function settingsLogging(c) {
  return [
    setGroup(
      'Logging',
      setSelect(
        c,
        'Level',
        'logging.level',
        [
          { v: 'debug', l: 'Debug' },
          { v: 'info', l: 'Info' },
          { v: 'warn', l: 'Warn' },
          { v: 'error', l: 'Error' },
        ],
        {
          hint: 'How much Synapse writes to its own logs. Debug is for diagnosing a problem; Info is the normal setting.',
        },
      ) +
        setField(c, 'Retention (days)', 'logging.retentionDays', {
          type: 'number',
          hint: 'How many days the app, engine, session and tool logs are kept. Days.',
        }) +
        setField(c, 'Max file size (MB)', 'logging.maxFileMb', {
          type: 'number',
          hint: 'When a log file reaches this size it is rotated to a .1 file and a fresh one is started. Megabytes.',
        }) +
        `<p class="set-note">One file per channel: <code>app</code>, <code>engine</code>, <code>session</code> and ` +
        `<code>tools</code>, in <code>logs\\</code>. The console mirrors the app channel and every warning or error ` +
        `from any channel, so a retry or a stall shows up in the window Synapse was started from. ` +
        `<code>data\\provider-errors.log</code> keeps 30 days on its own.</p>`,
    ),
  ].join('');
}

// ── providers: the only editable list in this window ────────────

/** `sk-efn1***f7df`: enough to tell two keys apart, never enough to use one. */
function maskSecret(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return `${k.slice(0, 2)}${'*'.repeat(6)}`;
  return `${k.slice(0, 6)}***${k.slice(-3)}`;
}

/** The same rule as src/providers.js: one id, chosen once, used in model refs. */
function slugify(name) {
  return (
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'provider'
  );
}

/** Models as the editor shows them: `id | name | context | output`. */
function modelLines(models) {
  return (models || [])
    .map((m) => [m.id, m.name && m.name !== m.id ? m.name : '', m.context || '', m.output || ''].join(' | ').replace(/(\s*\|\s*)+$/, ''))
    .join('\n');
}

function parseModelLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = '', name = '', context = '', output = ''] = line.split('|').map((s) => s.trim());
      if (!id) return null;
      const model = { id, name: name || id };
      const ctx = Number.parseInt(context, 10);
      const out = Number.parseInt(output, 10);
      if (Number.isFinite(ctx) && ctx > 0) model.context = ctx;
      if (Number.isFinite(out) && out > 0) model.output = out;
      return model;
    })
    .filter(Boolean);
}

function providerEditor(providers, index) {
  const p = providers[index];
  if (!p) return '';
  const key = String(p.apiKey || '');
  const revealed = Boolean(state.setKeyRevealed);
  const fromEnv = /^env:/i.test(key);
  const typed = Boolean(key) && !fromEnv;              // typed in this window, never sent by the server
  const stored = Boolean(p.apiKeySet) && !p.apiKeyRemoved;
  const shown = typed ? (revealed ? key : maskSecret(key)) : fromEnv ? key : stored ? p.apiKeyMasked || '' : '';
  const canReveal = typed;
  const taken = providers.filter((q, i) => i !== index).map((q) => q.id || slugify(q.name));
  const previewId = p.id || slugify(p.name || '') || 'provider';
  const clash = !p.id && taken.includes(previewId);
  const fetchNote = state.setProvFetch;
  const roles = Object.entries(state.setDraft?.roles || {})
    .filter(([, r]) => String(r?.ref || '').startsWith(`${p.id || previewId}/`))
    .map(([role]) => role);

  return `
  <section class="prov-edit" data-prov-edit-form>
    <div class="set-grid">
      <label class="set-field" title="A local server runs on this machine. An OpenAI-compatible endpoint can be anything that speaks the same API, including a paid service.">
        <span>Type</span>
        <select data-prov="type">
          <option value="local"${p.type === 'local' ? ' selected' : ''}>Local provider</option>
          <option value="openai"${p.type !== 'local' ? ' selected' : ''}>OpenAI Compatible</option>
        </select>
      </label>
      <label class="set-field" title="The name on the badge beside this provider's models in every role's menu.">
        <span>Name</span>
        <input data-prov="name" value="${esc(p.name || '')}" placeholder="DeepSeek" />
      </label>
      <label class="set-field wide" title="The server's address, including /v1 when it needs one. Nothing is contacted until you press Refresh List or run a turn.">
        <span>Server URL</span>
        <input data-prov="baseURL" value="${esc(p.baseURL || '')}" placeholder="http://localhost:1234/v1" spellcheck="false" />
      </label>
      ${p.type === 'local' ? `<label class="set-field" title="Which endpoint Refresh List asks for the model list. Chat goes through the OpenAI-compatible URL either way; the other endpoint is tried automatically if this one fails.">
        <span>Format</span>
        <select data-prov="format">
          <option value="openai"${p.format !== 'ollama' ? ' selected' : ''}>OpenAI API (/models)</option>
          <option value="ollama"${p.format === 'ollama' ? ' selected' : ''}>Ollama (/api/tags)</option>
        </select>
        <small class="prov-hint">${p.format === 'ollama' ? 'Ollama' : 'LM Studio, vLLM, llama.cpp'} — either one answers the other endpoint too, so this only decides which is asked first.</small>
      </label>` : ''}
      <div class="set-field wide" title="Sent as a bearer token. A key typed here is stored beside the app's data (not in the config file); env:NAME reads the environment when Synapse starts.">
        <span>API Key</span>
        <div class="set-key">
          <input data-prov="apiKey" value="${esc(shown)}" data-masked="${typed && !revealed ? '1' : '0'}" type="text" spellcheck="false"
                 placeholder="${p.type === 'local' ? 'Empty for local servers' : 'sk-…'}" autocomplete="off" />
          ${canReveal ? `<button type="button" class="input-eye" data-prov-eye aria-label="${revealed ? 'Hide the key' : 'Show the key'}" title="${revealed ? 'Hide the key' : 'Show the key'}">${setIcon(revealed ? 'eyeOff' : 'eye')}</button>` : ''}
        </div>
        <small class="prov-hint">${
          p.apiKeyRemoved
            ? 'The stored key is removed when you save.'
            : fromEnv
              ? `Read from the environment when Synapse starts — the config file keeps the variable's name, not the key. Type over it to store a key beside the app instead.`
              : stored
                ? `Stored beside the app's data, not in the config file — type over it to replace it.`
                : 'Kept beside the app\'s data, never in the config file. Only needed for a service.'
        }</small>
        ${stored || fromEnv ? `<div class="prov-tools"><button type="button" class="btn btn-danger btn-sm" data-prov-remove>Remove Key</button></div>` : ''}
      </div>
      <div class="set-field wide">
        <span>Models</span>
        <textarea data-prov="models" rows="4" spellcheck="false">${esc(modelLines(p.models))}</textarea>
        <div class="prov-tools">
          <button type="button" class="btn btn-secondary btn-sm" data-prov-fetch>Refresh List</button>
          <span class="prov-fetch-state${fetchNote ? (fetchNote.ok ? ' is-ok' : ' is-bad') : ''}">${esc(fetchNote?.text || '')}</span>
        </div>
        <small class="prov-hint">One model per line: <code>id | name | context | output</code>. Only the id is required; the window is what the watchdog and the engine budget from.</small>
      </div>
    </div>
    <p class="prov-badge-line">
      Model refs use <code>${esc(p.id || previewId)}/…</code>.
      ${(p.models || []).length ? '' : '<span class="prov-warn">No models yet — saved, but not registered with the engine until it has one.</span>'}
      ${clash ? '<span class="prov-warn">That id is already used — pick another name.</span>' : ''}
      ${roles.length ? `<span class="prov-inuse">In use by ${esc(roles.join(', '))}.</span>` : ''}
    </p>
  </section>`;
}

function settingsProviders(c) {
  const providers = c.engine?.opencode?.providers || [];
  const selected = Number.isInteger(state.setProvSelected) ? state.setProvSelected : -1;
  const countsByProvider = (state.models || []).reduce((acc, m) => {
    acc[m.provider] = (acc[m.provider] || 0) + 1;
    return acc;
  }, {});
  const builtins = ENGINE_PROVIDERS.map((p) => {
    const count = countsByProvider[p.id] || 0;
    return `<div class="prov-row is-builtin" title="${esc(p.note)}">
        <span class="prov-type">${esc(p.label)}</span>
        <span class="prov-name">Engine catalog</span>
        <span class="prov-url">${esc(p.note)}</span>
        <span class="prov-meta">${count ? `${count} model${count === 1 ? '' : 's'}` : 'not connected'}</span>
      </div>`;
  }).join('');

  const rows = providers
    .map((p, i) => {
      const used = Object.entries(c.roles || {}).filter(([, r]) => String(r?.ref || '').startsWith(`${p.id || slugify(p.name)}/`));
      const count = (p.models || []).length;
      return `<div class="prov-row${i === selected ? ' is-active' : ''}" data-prov-row="${i}" role="button" tabindex="0"
                   aria-label="Edit ${esc(p.name || 'provider')}">
        <span class="prov-type">${p.type === 'openai' ? 'OpenAI' : 'Local'}</span>
        <span class="prov-name">${esc(p.name || 'Untitled provider')}</span>
        <span class="prov-url">${esc(p.baseURL || 'no server URL yet')}</span>
        <span class="prov-meta">${count} model${count === 1 ? '' : 's'}${used.length ? ` · ${used.length} role${used.length === 1 ? '' : 's'}` : ''}</span>
        <span class="prov-acts">
          <button type="button" class="role-btn ic-edit" data-prov-edit="${i}" title="Edit ${esc(p.name || 'this provider')}" aria-label="Edit ${esc(p.name || 'this provider')}">✎</button>
          <button type="button" class="role-btn prov-del" data-prov-del="${i}" title="Remove ${esc(p.name || 'this provider')}" aria-label="Remove ${esc(p.name || 'this provider')}">✕</button>
        </span>
      </div>`;
    })
    .join('');

  return `
    <section class="set-group"><h4>Providers <em class="set-restart">Restart</em></h4>
      <div class="prov-add">
        <button type="button" class="btn btn-provider btn-sm" data-prov-add>+ Add Provider</button>
        <div class="prov-add-menu" id="provAddMenu" hidden>
          <button type="button" data-prov-new="local">Local Provider</button>
          <button type="button" data-prov-new="openai">OpenAI Compatible</button>
          <button type="button" disabled title="The engine's own catalog is always registered. A second copy would list the same models twice.">OpenCode (built in)</button>
        </div>
      </div>
      <div class="prov-list">
        ${builtins}
        ${rows}
      </div>
      <hr class="prov-divider" />
      ${providerEditor(providers, selected)}
      <p class="set-note">A new or changed provider reaches the model menu after a restart: the engine reads its
      provider list when it starts. A key written as <code>env:NAME</code> is read from the environment at boot;
      a key typed here is kept beside the app's data, never in the config file.</p>
    </section>`;
}

const SETTINGS_PANES = {
  general: settingsGeneral,
  engine: settingsEngine,
  providers: settingsProviders,
  workers: settingsWorkers,
  tools: settingsTools,
  logging: settingsLogging,
};

function renderSettingsTabs() {
  const nav = $('settingsTabs');
  if (!nav) return;
  nav.innerHTML = SETTINGS_TABS.map(
    (t) =>
      `<button type="button" class="set-tab${t.id === state.settingsTab ? ' is-active' : ''}" role="tab" ` +
      `aria-selected="${t.id === state.settingsTab}" data-set-tab="${t.id}">${setIcon(t.icon)}<span>${t.label}</span></button>`,
  ).join('');
}

function renderSettings({ scrollTop } = {}) {
  const c = state.setDraft;
  if (!c) {
    $('settingsBody').innerHTML = '<p class="rail-note">Config unavailable.</p>';
    $('settingsTabs').innerHTML = '';
    return;
  }
  if (!SETTINGS_PANES[state.settingsTab]) state.settingsTab = 'general';
  const body = $('settingsBody');
  // Keep the pane where it was. Every edit re-renders this markup — a Refresh
  // List, an eye toggle, a provider picked — and jumping to the top after each
  // one loses the operator's place, which is worst for the button they just
  // pressed. Only a tab switch or opening the window starts at the top.
  const keep = scrollTop === undefined ? body.scrollTop : scrollTop;
  renderSettingsTabs();
  body.innerHTML = SETTINGS_PANES[state.settingsTab](c);
  body.scrollTop = keep;
}

/** The visible pane's controls into the draft. Called before switching tabs and
 *  before saving, so nothing typed is lost by looking at something else. */
function collectSettings() {
  const c = state.setDraft;
  if (!c) return null;
  for (const el of $('settingsBody').querySelectorAll('[data-path]')) {
    const path = el.dataset.path;
    let value = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') value = Number(value);
    if (el.type === 'number' && !Number.isFinite(value)) continue;
    // A field shown in seconds or minutes but stored in the base unit: the
    // conversion belongs with the setting, not in the operator's head.
    if (el.dataset.scale) value = Math.round(value * Number(el.dataset.scale));
    // A folder list is one line in the form and an array in the config.
    if (path === 'engine.opencode.skillPaths') {
      writePath(c, path, String(value).split(';').map((p) => p.trim()).filter(Boolean));
      continue;
    }
    // The ladder is a comma list in the form and an array in the config.
    if (path === 'worker.ladder') {
      writePath(c, path, String(value).split(',').map((r) => r.trim()).filter(Boolean));
      continue;
    }
    writePath(c, path, value);
  }
  return c;
}

function switchSettingsTab(id) {
  if (id === state.settingsTab) return;
  collectSettings();
  state.settingsTab = id;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings({ scrollTop: 0 });
}

// ── providers: the editor's own small state machine ─────────────

function providerAt(index) {
  const list = state.setDraft?.engine?.opencode?.providers;
  return Array.isArray(list) && list[index] ? list[index] : null;
}

function addProvider(type) {
  const c = collectSettings();
  if (!c) return;
  c.engine.opencode = c.engine.opencode || {};
  const list = Array.isArray(c.engine.opencode.providers) ? c.engine.opencode.providers : (c.engine.opencode.providers = []);
  list.push({
    id: '',
    type,
    name: type === 'local' ? 'Local Server' : 'OpenAI Compatible',
    baseURL: '',
    apiKey: '',
    models: [],
  });
  state.setProvSelected = list.length - 1;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings();
  $('settingsBody').querySelector('[data-prov="name"]')?.focus();
}

async function removeProvider(index) {
  const p = providerAt(index);
  if (!p) return;
  const c = state.setDraft;
  const used = Object.entries(c.roles || {}).filter(([, r]) =>
    String(r?.ref || '').startsWith(`${p.id || slugify(p.name)}/`),
  );
  if (used.length) {
    const ok = await openDialog({
      title: 'Remove Provider',
      message:
        `${p.name || 'This provider'} is in use by ${used.map(([role]) => role).join(', ')}. ` +
        `Removing it leaves those roles pointing at models that will no longer exist, until you pick another on the card.`,
      confirmLabel: 'Remove',
      danger: true,
      okResult: true,
    });
    if (!ok) return;
  }
  c.engine.opencode.providers.splice(index, 1);
  state.setProvSelected = null;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings();
}

async function refreshProviderModels(index) {
  const p = providerAt(index);
  if (!p) return;
  const stateEl = $('settingsBody').querySelector('.prov-fetch-state');
  if (stateEl) { stateEl.className = 'prov-fetch-state'; stateEl.textContent = 'Asking the server…'; }
  const r = await api('POST', '/api/providers/models', {
    id: p.id,
    baseURL: p.baseURL,
    apiKey: p.apiKey,
    format: p.format,
    type: p.type,
  }).catch((err) => ({
    ok: false,
    models: [],
    error: err.message,
  }));
  if (!r.ok) {
    state.setProvFetch = { ok: false, text: r.error || 'The server did not answer.' };
    renderSettings();
    return;
  }
  const have = new Map((p.models || []).map((m) => [m.id, m]));
  const added = r.models.filter((m) => !have.has(m.id));
  // Refresh is not only "add what is new": a runtime reports the window of the
  // model it has *loaded*, and that changes when the operator reloads it with a
  // different context. So a reported window overwrites the old one — otherwise
  // the number stays whatever was true the first time this list was fetched.
  for (const m of r.models) {
    const entry = have.get(m.id);
    if (!entry || !m.context) continue;
    entry.context = m.context;
  }
  p.models = [
    ...(p.models || []),
    ...added.map((m) => ({ id: m.id, name: m.name || m.id, ...(m.context ? { context: m.context } : {}) })),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const withWindow = p.models.filter((m) => m.context).length;
  state.setProvFetch = {
    ok: true,
    text:
      `${r.models.length} on the server · ${added.length} added` +
      (have.size ? ` · ${have.size} already listed` : '') +
      (withWindow < p.models.length ? ` · ${p.models.length - withWindow} without a reported window` : ''),
  };
  renderSettings();
}

function selectProvider(index) {
  collectSettings();
  state.setProvSelected = index;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings();
}

// The editor's fields write straight into the selected draft provider: there is
// no data-path for them because a provider is an object in a list, not a path.
function onSettingsInput(e) {
  const el = e.target.closest('[data-prov]');
  if (!el) return;
  const p = providerAt(state.setProvSelected);
  if (!p) return;
  const field = el.dataset.prov;
  if (field === 'models') { p.models = parseModelLines(el.value); return; }
  if (field === 'apiKey') {
    p.apiKey = el.value;
    p.apiKeyRemoved = false;
    el.dataset.masked = '0';
    return;
  }
  if (field === 'type') {
    p.type = el.value === 'local' ? 'local' : 'openai';
    if (p.type !== 'local') p.format = 'openai';
    renderSettings();
    return;
  }
  p[field] = el.value;
  // A hand-typed key is no longer the mask, and the hint under the field says so
  // — but re-rendering on every keystroke would take the caret with it.
  if (field === 'name') {
    const row = $('settingsBody').querySelector(`[data-prov-row="${state.setProvSelected}"] .prov-name`);
    if (row) row.textContent = el.value.trim() || 'Untitled provider';
    if (!p.id) {
      const code = $('settingsBody').querySelector('.prov-badge-line code');
      if (code) code.textContent = `${slugify(el.value)}/…`;
    }
  }
}

async function onSettingsClick(e) {
  const add = e.target.closest('[data-prov-add]');
  if (add) {
    const menu = $('provAddMenu');
    if (menu) menu.hidden = !menu.hidden;
    return;
  }
  const newProvider = e.target.closest('[data-prov-new]');
  if (newProvider) {
    const menu = $('provAddMenu');
    if (menu) menu.hidden = true;
    addProvider(newProvider.dataset.provNew);
    return;
  }
  const del = e.target.closest('[data-prov-del]');
  if (del) { await removeProvider(Number(del.dataset.provDel)); return; }
  const row = e.target.closest('[data-prov-row]');
  if (row) { selectProvider(Number(row.dataset.provRow)); return; }
  if (e.target.closest('[data-prov-eye]')) {
    if (providerAt(state.setProvSelected)) {
      state.setKeyRevealed = !state.setKeyRevealed;
      renderSettings();
      // Put the caret back at the end of the key rather than at the start.
      const field = $('settingsBody').querySelector('[data-prov="apiKey"]');
      if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); }
    }
    return;
  }
  if (e.target.closest('[data-prov-remove]')) {
    const p = providerAt(state.setProvSelected);
    if (p) {
      p.apiKey = null;
      p.apiKeySet = false;
      p.apiKeyRemoved = true;
      state.setKeyRevealed = false;
      renderSettings();
    }
    return;
  }
  if (e.target.closest('[data-prov-fetch]')) {
    await refreshProviderModels(state.setProvSelected);
  }
}

async function saveSettings() {
  const draft = collectSettings();
  if (!draft) return;
  // A provider row added by mistake - never named, never given a server - is
  // dropped here rather than half-registered. One that has a name and a server
  // but no models yet is kept: that is work in progress, and the engine simply
  // does not register it until it has something to serve.
  const providers = draft.engine?.opencode?.providers;
  if (Array.isArray(providers)) {
    draft.engine.opencode.providers = providers.filter(
      (p) => String(p.name || '').trim() || String(p.baseURL || '').trim(),
    );
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
    const restart = restartNeeded(state.settingsSnapshot || state.config, draft);
    state.config = await api('PUT', '/api/config', draft);
    state.setDraft = JSON.parse(JSON.stringify(state.config));
    state.setProvSelected = null;
    renderLlmStatus();
    await loadModels();
    // A new skills folder is worth reading before the operator closes the panel.
    await checkSkills({ quiet: true });
    renderSettings();
    // Only changes the engine or the server reads at start need the question.
    if (restart) await askRestart();
    else toast('Settings Saved', 'These take effect straight away.');
  } catch (err) {
    toast('Could not save settings', err.message);
  }
}

/**
 * Which saved values only take effect when Synapse starts again. Everything else
 * — roles, worker timers, log level, the tool census flag — is read at the moment
 * it is used, so changing it is done the instant Save returns and asking for a
 * restart would be noise. These are the paths the UI badges with "Restart".
 */
function restartNeeded(before, after) {
  const changed = (path) => JSON.stringify(readPath(before, path) ?? null) !== JSON.stringify(readPath(after, path) ?? null);
  const paths = [
    'server.host',
    'server.port',
    'engine.type',
    'engine.opencode.port',
    'engine.opencode.binary',
    'engine.opencode.home',
    'engine.opencode.password',
    'engine.opencode.startTimeoutMs',
    'engine.opencode.skillPaths',
  ];
  if (paths.some(changed)) return true;
  // Providers are one more thing the engine reads at start: adding a server,
  // editing its address, its models or its key all change what it serves.
  const shape = (c) =>
    JSON.stringify(
      (c?.engine?.opencode?.providers || []).map((p) => [
        p.id,
        p.type,
        p.format,
        p.name,
        p.baseURL,
        p.apiKey,
        p.models,
      ]),
    );
  return shape(before) !== shape(after);
}

/**
 * After a save: restart now, undo it, or leave it for the next start.
 *
 * The middle option is the one that needs explaining. "Revert All Changes"
 * writes back the config as it was when this window opened — the file, not just
 * the form — so a save that turns out to be a mistake is undone in one click
 * instead of by hand-editing JSON.
 */
async function askRestart() {
  const choice = await openDialog({
    title: 'Settings Saved',
    message:
      'The config file is written. The engine, the providers and the server port are read when Synapse ' +
      'starts, so a restart is what applies them. Changes to roles, workers and logging apply straight away.',
    confirmLabel: 'Restart Now',
    okResult: 'restart',
    extra: { label: 'Revert All Changes', result: 'revert', danger: true },
  });
  if (choice === 'restart') return restartSynapse();
  if (choice === 'revert') return revertSavedSettings();
  toast('Settings Saved', 'They apply the next time Synapse starts.');
}

/** Wait for the new process to answer, then bring this window back. */
async function restartSynapse() {
  $('restartCurtain').hidden = false;
  $('restartState').textContent = 'Stopping Synapse…';
  try {
    await api('POST', '/api/restart');
  } catch {
    // The connection dropping is the expected answer: the server is going away.
  }
  $('restartState').textContent = 'Waiting for Synapse to come back…';
  const back = await waitForSynapse(90000);
  if (!back) {
    $('restartState').textContent =
      'Synapse did not come back by itself. Start it with start.bat, then reload this page.';
    $('restartCurtain').classList.add('is-stuck');
    return;
  }
  $('restartState').textContent = 'Back. Reopening…';
  // Closing is what the operator asked for; a tab that was not opened by script
  // cannot be closed, and then reloading is the useful thing instead.
  try { window.close(); } catch { /* blocked, fall through */ }
  setTimeout(() => location.reload(), 350);
}

async function waitForSynapse(timeoutMs) {
  const started = Date.now();
  // The old process needs a moment to die; asking straight away would get the
  // answer from the server we are waiting to replace.
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        if (body?.engine?.endpoint) return true;
      }
    } catch { /* still down */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Put the config file (and the form) back to what this window opened with. */
async function revertSavedSettings() {
  if (!state.settingsSnapshot) return;
  try {
    state.config = await api('PUT', '/api/config', state.settingsSnapshot);
    state.setDraft = JSON.parse(JSON.stringify(state.config));
    state.setProvSelected = null;
    state.setKeyRevealed = false;
    state.setProvFetch = null;
    renderLlmStatus();
    await loadModels();
    await checkSkills({ quiet: true });
    renderSettings();
    toast('Changes Reverted', 'The config file is back to what it held when this window opened.');
  } catch (err) {
    toast('Could Not Revert', err.message);
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

function openSettings() {
  if (!state.config) { toast('Config Unavailable', 'Synapse could not read its own config file.'); return; }
  // Every edit in this window happens to a copy; the file only changes on Save.
  state.setDraft = JSON.parse(JSON.stringify(state.config));
  // And this copy is what "Revert All Changes" puts back if the save was a
  // mistake — the file as it was when the window opened, not the form.
  state.settingsSnapshot = JSON.parse(JSON.stringify(state.config));
  state.settingsTab = state.settingsTab || 'general';
  state.setProvSelected = null;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings({ scrollTop: 0 });
  $('settingsModal').hidden = false;
}
function closeSettings() {
  $('settingsModal').hidden = true;
  state.setDraft = null;
}
/** Throw the draft away and read the file again, without closing the window. */
function revertSettings() {
  if (!state.config) return;
  state.setDraft = JSON.parse(JSON.stringify(state.config));
  state.setProvSelected = null;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings();
  toast('Changes Discarded', 'The form shows what is saved in the config file.');
}

// ── wiring ──────────────────────────────────────────────────────
function wire() {
  setupModelPickers();
  // One stopwatch per card and one for the session, on a single one-second
  // interval: HH:MM:SS needs a second's resolution and this is a text node per
  // tick, so it costs nothing measurable.
  for (const card of document.querySelectorAll('#topology .role-card')) {
    if (!card.querySelector('.role-clock')) {
      const el = document.createElement('span');
      el.className = 'role-clock';
      el.setAttribute('aria-hidden', 'true');
      card.append(el);
    }
  }
  setInterval(tickClocks, 1000);
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('stopBtn').addEventListener('click', interrupt);
  $('modeToggle').addEventListener('click', switchMode);
  $('keepBtn').addEventListener('click', toggleKeep);
  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('emptyNewSession').addEventListener('click', () => createSession(state.projects.find((p) => p.general)?.id));
  $('addProjectBtn').addEventListener('click', addProject);

  // conversation navigation + collapsible tool calls. Four buttons on one row:
  // the pair in the middle steps one message, the outer pair goes all the way.
  $('navTop').addEventListener('click', () => {
    const el = chatScroller();
    if (el) animateScroll(el, 0);
    else window.scrollTo({ top: 0 });
  });
  $('navPrev').addEventListener('click', () => jumpMessage(-1));
  $('navNext').addEventListener('click', () => jumpMessage(1));
  $('navBottom').addEventListener('click', () => {
    const el = chatScroller();
    if (el) animateScroll(el, el.scrollHeight);
    else scrollChatToBottom();
  });
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
      refreshAskPanel();
    });
    askHost.addEventListener('change', (e) => {
      syncAskCustoms(e.target);
      refreshAskPanel();
    });
    askHost.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-form-reply]');
      if (btn) { replyForm(btn.dataset.formReply); return; }
      if (e.target.closest('[data-ask-next]')) { moveAskPage(1); return; }
      if (e.target.closest('[data-ask-back]')) { moveAskPage(-1); return; }
    });
    // Enter in a text field moves on, the way any small form should — Submit is
    // only the last page's word for it.
    askHost.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      const next = askHost.querySelector('[data-ask-next]');
      if (next && !next.hidden) {
        if (!next.disabled) moveAskPage(1);
        return;
      }
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
  $('revertSettings').addEventListener('click', revertSettings);
  $('saveSettings').addEventListener('click', saveSettings);
  $('settingsTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-set-tab]');
    if (tab) switchSettingsTab(tab.dataset.setTab);
  });
  // One delegated pair for the whole pane: the Providers editor rebuilds its own
  // markup on every change (a new row, a revealed key, a refreshed list), so
  // per-element listeners would have to be re-attached each time.
  $('settingsBody').addEventListener('click', onSettingsClick);
  $('settingsBody').addEventListener('input', onSettingsInput);
  // A masked key is far shorter than the real one; selecting it on focus means
  // typing replaces it instead of appending to the mask.
  $('settingsBody').addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-prov="apiKey"]');
    if (el && el.dataset.masked === '1') el.select();
  });
  // And leaving the field re-masks it: a key stays on screen only while it is
  // being typed into or was deliberately revealed.
  $('settingsBody').addEventListener('focusout', (e) => {
    const el = e.target.closest('[data-prov="apiKey"]');
    if (!el) return;
    const p = providerAt(state.setProvSelected);
    if (!p) return;
    const literal = String(p.apiKey || '') && !String(p.apiKey).startsWith('env:');
    if (literal && !state.setKeyRevealed) renderSettings();
  });

  // The engine's own version: the chip, its dialog, and the two buttons.
  $('updateChip').addEventListener('click', openUpdateDialog);
  $('closeUpdate').addEventListener('click', closeUpdateDialog);
  $('closeUpdateFoot').addEventListener('click', closeUpdateDialog);
  $('checkUpdate').addEventListener('click', checkEngineUpdate);
  $('applyUpdate').addEventListener('click', applyEngineUpdate);

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
  document.querySelectorAll('#topology .ic-edit').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const role = btn.closest('.role-card')?.querySelector('.role-model')?.dataset.role;
      if (role) editRoleSettings(role);
    }),
  );

  // mockup affordances: clearly announce what is not wired yet
  document.addEventListener('click', (e) => {
    // a click anywhere outside the open model menu closes it
    if (menuRole && !e.target.closest('.model-search') && !e.target.closest('#modelMenu')) closeModelMenu();

    const resetAsks = e.target.closest('[data-reset-asks]');
    if (resetAsks) { e.preventDefault(); resetModelAsks(); return; }

    // Settings has the engine's version in it, so the check lives there too -
    // otherwise the offer would only exist when an update is already known.
    if (e.target.closest('[data-check-update]')) {
      e.preventDefault();
      closeSettings();
      openUpdateDialog();
      return;
    }

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
  $('updateModal').addEventListener('click', (e) => { if (e.target === $('updateModal')) closeUpdateDialog(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // A non-dismissable dialog (the folder-already-exists question) ignores Escape:
    // the operator must answer it.
    if (!$('dialogModal').hidden) {
      if (dialogDismissable) closeDialog(null);
      else e.preventDefault();
    }
    else if (!$('errorModal').hidden) closeError();
    else if (!$('updateModal').hidden) closeUpdateDialog();
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
  renderLlmStatus();
  // every new session starts Single; an opened session sets its own mode
  state.mode = 'single';
  renderMode();
  setView();
  await refreshStatus();
  await refreshUpdate();
  await loadModels();
  await loadProjects();
  await checkSkills();
  await loadRuns();
  renderTranscript();
  connectStream();
  refreshPending();
  renderProbe();
  // nothing is auto-opened: the operator picks what to work on
}

boot();

