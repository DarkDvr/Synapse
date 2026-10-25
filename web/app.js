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
import { newStream, pushStream, slideTarget, nextOffset, takePending, freezeStream, STREAM_BUFFER } from './stream-view.js';

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
  // Tokens per second for each project's live run: the tokens a step wrote over
  // the time between its first and last streamed piece, which is what the model's
  // own log calls speed. Empty the moment there is nothing to measure.
  rates: new Map(),
  // Files the operator attached to the message they are writing: { id, name, mime,
  // size, data }, where `data` is base64 without the data: prefix. Cleared on a
  // successful send, kept on a failed one.
  attachments: [],
  // The open session's own last prompt, for the corner of the Architect's card: it
  // is not a delegated run, so nothing in `runs` describes it. Kept with the
  // session id that sent it, so switching sessions cannot show the old one's size.
  archCtx: null,
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
  // What this PC can build with, for Settings → Windows (src/toolchain.js).
  toolchain: null,
  // When the last engine event arrived, so the sidebar can say "10s" instead of
  // just naming it, and which session it came from: a clock that ages beside an
  // event from a session the operator has deleted is describing something that
  // no longer exists. And the stopwatches for the open session (see tickClocks).
  lastEventAt: 0,
  lastEventSessionId: null,
  // Things a model did to Synapse itself. They used to be a modal dialog, which
  // was one click to dismiss and impossible to act on; the log has the detail, so
  // the chat gets a line and the operator gets on with their work.
  alarms: [],
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

// The model's own name, whole.
//
// It used to have "free" stripped out and be cut at 28 characters, because a
// `<select>` cannot ellipsize. That hid the one word that says a model costs
// nothing — "Beam" and "Beam Free" are the same list entry otherwise — and cut
// `Nemotron 3.5 Super VL Free` to `Nemotron 3.5 Super VL Free` for no reason the
// operator could see. Nothing logical reads this text (the ref is what is stored),
// so it is the full name and CSS does the ellipsizing where it really does not fit.
const modelLabel = (name) => String(name || '').trim();

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

/** An agent touched Synapse itself. Not an error to retry and not something the
 *  operator can act on: it is *news*, and the log has the detail. It used to open
 *  a modal — one click to close, nothing to do — so it is a line in the chat now,
 *  in the same amber as a compaction, and the popup is gone. */
function openAlarm(ev) {
  const what = String(ev.what || 'something touched Synapse itself');
  const paths = (ev.paths || []).map(String);
  // Which project this belongs to, when it came from a delegated run: a worker's
  // session cannot be opened from the rail, so a line only shown in the session it
  // came from would be a line the operator never sees.
  const run = ev.sessionId ? [...state.runs.values()].find((r) => r.workerId === ev.sessionId) : null;
  const line = {
    at: Date.now(),
    sessionId: ev.sessionId || null,
    dir: run?.dir || null,
    what,
    paths,
    note: ev.note ? String(ev.note) : '',
  };
  state.alarms.push(line);
  // One page, not a history: the log keeps every one of them.
  if (state.alarms.length > 20) state.alarms.splice(0, state.alarms.length - 20);
  renderTranscript();
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
        if (f.type === 'check') {
          // One flag, not a list: the dialog's checklist is a set of choices, and
          // readDialog collects every checkbox it finds for those. A separate
          // attribute keeps the two kinds apart.
          //
          // It gets its own bordered row with a title and a line of consequence:
          // as a bare checkbox under the message it read as the tail of the
          // sentence, which is the worst thing an option that deletes a plan can
          // read as.
          return `<label class="dlg-option">
            <input type="checkbox" data-flag="${esc(f.name)}"${f.value ? ' checked' : ''} />
            <span class="dlg-option-text">
              <span>${esc(f.label)}</span>
              ${f.hint ? `<small>${esc(f.hint)}</small>` : ''}
            </span>
          </label>`;
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
  // Single flags first: they are read by their own attribute, so a checklist of
  // options and a yes/no choice can live in the same dialog without meeting.
  for (const el of $('dialogBody').querySelectorAll('input[data-flag]')) {
    values[el.dataset.flag] = el.checked;
  }
  for (const f of dialogFields) {
    if (f.type === 'check') continue;
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

/** Is this provider a server on this machine? True for `local` and for
 *  `llamacpp`, which is the same kind of thing speaking a slightly different
 *  dialect about itself. Mirrors providerType() in src/providers.js — the UI has no
 *  imports from the server, so the rule is written once here too. */
function isLocalServer(p) {
  const type = String(p?.type || '').toLowerCase();
  if (type === 'local' || type === 'llamacpp') return true;
  if (type) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(String(p?.baseURL || ''));
}

/** The badge beside this provider's models.
 *
 * There is one badge for every server on this machine, whichever dialect it speaks.
 * A `llamacpp` server is a local LLM exactly as an LM Studio one is — the difference
 * is which endpoint answers "what is your window", not what kind of thing it is —
 * so labelling it separately split the model picker into a second LOCAL-looking
 * section for no reason the operator cares about. */
function providerBadge(p) {
  return isLocalServer(p) ? 'Local' : p?.name || '';
}

/**
 * The sidebar's Local LLM row: which local model servers are answering right now.
 *
 * It used to count them — "2 servers · 9 models" — which describes the shape of
 * the config and nothing the operator can act on. They turn a server on and want
 * to know Synapse can see it, so the row names the ones that answer: "Strata,
 * Bionic". The count is in the tooltip, where it costs nothing.
 *
 * One dot, four meanings, and each is a different colour on purpose:
 *   grey   - nothing is registered here
 *   red    - registered, and none of it answers
 *   green  - answering, and nothing is using it
 *   yellow - answering, and serving a turn right now
 */
async function renderLlmStatus() {
  const row = $('llmRow');
  const out = $('llmState');
  if (!row || !out) return;
  const dot = row.querySelector('.status-dot');
  const paint = (state, text, title) => {
    if (dot) dot.className = `status-dot ${state}`;
    if (out.textContent !== text) out.textContent = text;
    if (row.title !== title) row.title = title;
  };

  const providers = Array.isArray(state.config?.engine?.opencode?.providers)
    ? state.config.engine.opencode.providers
    : [];
  const local = providers.filter(isLocalServer);
  if (!local.length) {
    paint('idle', 'not set', 'No local model server is registered. Add one in Settings > Providers.');
    return;
  }

  let servers = [];
  try {
    servers = (await api('GET', '/api/providers/health')).servers || [];
    state.llmAsked = true;
  } catch {
    // Asking failed, so the row must not guess. Grey and "unknown" is the honest
    // reading: it is what a server that cannot answer the question looks like,
    // and it is not a claim about any model server.
    paint('idle', 'unknown', 'Cannot ask Synapse which local servers are answering right now. The Runtime row says whether the engine itself is up.');
    return;
  }
  const up = servers.filter((s) => s.up);
  const down = servers.filter((s) => !s.up);
  const count = `${local.length} server${local.length === 1 ? '' : 's'}, ` +
    `${local.reduce((n, p) => n + (Array.isArray(p.models) ? p.models.length : 0), 0)} models`;
  const detail = servers
    .map((s) => `${s.name}: ${s.up ? 'answering' : 'not answering'}`)
    .join('\n');

  if (!up.length) {
    // Red is a claim that something that should answer does not. Before the row
    // has had one answer at all it cannot make that claim: a server still loading
    // its model, or one busy enough to be slow for a moment, is not down.
    if (!state.llmAsked) {
      paint('idle', 'asking…', `${count}\n${detail}`);
      return;
    }
    paint('err', 'no answer', `${count}\n${detail}\nA configured server that does not answer fails its turn.`);
    return;
  }

  // Yellow only when the server doing the work is one of these: a cloud turn must
  // not make the local row look busy.
  const working = Boolean(currentRun()) || isBusy(state.sessionId);
  const busyRef = currentRun()?.model || architectSelection()?.ref || '';
  const busyId = String(busyRef).split('/')[0];
  const serving = working && up.some((s) => s.id === busyId);

  paint(
    serving ? 'live' : 'ok',
    up.map((s) => s.name).join(', '),
    `${count}\n${detail}` + (serving ? '\nServing a turn right now.' : ''),
  );
  if (down.length && out) out.title = `${out.textContent} (${down.length} not answering)`;
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

/**
 * How long a role's work took, from the record rather than from this page.
 *
 * `GET /api/plan` sums every completed run for a task out of `runs.jsonl`, and the
 * live run adds its own elapsed time on top. That means the number is the same
 * after a reload as it was before one — which is what a stopwatch kept in
 * localStorage could never do: it started again from zero on every page load, and
 * knew nothing about time spent before this browser was open.
 */
function roleTime(role, now) {
  // The Architect has no task in the plan, so the plan has nothing to say about
  // it. Its clock is the one tickClocks keeps per card: time it was actually
  // working, which the same reading that lights its dot stops for a waiting
  // question, a permission prompt and a delegation in flight.
  if (role === 'architect') {
    const rec = state.clocks?.roles?.architect;
    if (!rec) return { total: 0, running: 0, last: 0 };
    const running = rec.since ? Math.max(0, now - rec.since) : 0;
    return { total: rec.ms + running, running, last: rec.last || 0 };
  }
  const tasks = state.planState?.plan?.tasks || [];
  const spent = state.planState?.spent || {};
  const live = currentRun();
  let total = 0;
  let running = 0;
  let last = 0;
  for (const t of tasks) {
    if (t.role !== role) continue;
    const base = Number(spent[t.id]) || 0;
    total += base;
    if (base > 0) last = base;
    if (live && live.task === t.id) {
      running = Math.max(0, now - (Number(live.startedAt) || now));
      total += running;
    }
  }
  return { total, running, last };
}

function paintClocks(now) {
  const c = state.clocks;
  if (!c) return;
  for (const card of document.querySelectorAll('#topology .role-card')) {
    const el = card.querySelector('.role-clock');
    if (!el) continue;
    const { total, running, last } = roleTime(card.dataset.role, now);
    if (!total) {
      el.textContent = '';
      continue;
    }
    el.textContent = `${hhmmss(running || last || 0)} / ${hhmmss(total)}`;
  }
  const clock = $('planClock');
  if (clock) {
    clock.textContent = hhmmss(c.session.ms + (c.session.since ? now - c.session.since : 0));
  }
  paintRates(now);
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

/**
 * The sidebar's liveness clock: when a *session* last did something.
 *
 * The age beside the label is the readout now, so this only records when; the dot
 * belongs to the stream and is not flashed here. Two rules keep it honest:
 * an event with no session behind it is not work — `project.updated` and the other
 * registry events arrive whenever the rail is reloaded, including on the delete
 * itself, so counting them kept the clock ticking over a session that was gone —
 * and a `null` type is the reset, used when the session that emitted the event is
 * deleted: there is nothing left for the age to describe.
 */
function setEventChip(type, sessionId) {
  const clear = !type;
  if (!clear && !sessionId) return;
  const el = $('lastEvent');
  if (el) el.textContent = clear ? 'idle' : String(type).replace(/^session\./, '');
  state.lastEventAt = clear ? 0 : Date.now();
  state.lastEventSessionId = clear ? null : sessionId;
  renderLastEventAge();
}

/** The engine events that are a *model doing something*. Everything else is news
 *  about the rail — a session being deleted, renamed, or its instructions being
 *  rewritten — and used to leave this clock reading "deleted" for hours after a
 *  project was finished, gently counting up at a session that no longer existed. */
const WORK_EVENT = /^(step|text|reasoning|tool|usage|idle|execution|compaction|inbox|instructions|retry|permission|question)\b/;

/** How long the last event stays on the clock after the work stops, so the final
 *  one can be read before the row goes quiet. */
const CHIP_QUIET_MS = 30000;

/**
 * Nothing is working: stop counting.
 *
 * An age that climbs for ever is worse than no age — after a while it says
 * "something is still going on" about a project that finished this morning, and
 * there is no way to tell it apart from a run that is genuinely stuck. So when no
 * session is active and no run is live, the row returns to idle instead of
 * timing the silence.
 */
function settleEventChip(active) {
  if (!state.lastEventAt) return;
  if ((active && active.size) || state.runs.size) return;
  if (Date.now() - state.lastEventAt < CHIP_QUIET_MS) return;
  setEventChip(null, null);
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
  if (configured) return providerBadge(configured) || id;
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
  toast('Issues Cleared', `${m ? modelLabel(m.name) : ref} is unmarked.`);
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
  const ref = p.sel.value;
  const m = modelByRef(ref);
  // The name of the model the operator chose, or the ref itself when the catalog
  // is not offering it at the moment. Never another model's name: two providers
  // can serve the same name, and that is exactly how a card lies.
  input.value = m ? modelLabel(m.name) : ref ? String(ref).split('/').pop() : '';
  const issues = m?.issues?.length ? ` · ISSUES: ${m.issues[0].message}` : '';
  input.title = m
    ? `${modelTitle(m)}${issues} · type to search`
    : ref
      ? `${ref} is not in the engine's catalog right now · type to search`
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
    // Grouped by the chip the operator reads, not by provider id. Two local
    // servers (a runtime on 1235 and a llama.cpp one on 8080) are one visually
    // distinct group of "Local", so sorting by id put the second one after every
    // hosted provider — the same badge twice, with other sources in between.
    .sort(
      (a, b) =>
        providerLabel(a.provider).localeCompare(providerLabel(b.provider)) ||
        String(a.provider).localeCompare(String(b.provider)) ||
        a.name.localeCompare(b.name),
    );
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
            <span class="mo-name">${esc(modelLabel(m.name))}</span>
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
  chatFitTimer = setTimeout(() => { fitChatHeight(); updatePlanOverflow(); }, 340);

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
  document.querySelectorAll('.role-model').forEach((sel, i) => {
    const role = sel.dataset.role || String(i);
    sel.innerHTML = state.models
      .map((m) => `<option value="${esc(m.ref)}">${esc(modelLabel(m.name))}</option>`)
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
      sel.insertAdjacentHTML(
        'beforeend',
        `<option value="${esc(chosen)}">${esc(id)} — not in the catalog</option>`,
      );
    }
    // Nothing saved at all is the only case where a model is offered: the first
    // free one, so a fresh install has something selectable rather than a blank.
    const fallback = state.models.find((m) => m.free) || state.models[0];
    sel.value = chosen || fallback.ref;
    sel.title = known
      ? modelTitle(known)
      : chosen
        ? `${chosen} is not in the engine's catalog right now — the choice is kept, not replaced`
        : `Model for the ${role} role`;
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
/**
 * Is anything being done on this session's behalf?
 *
 * The engine only knows about its own turns, and the Architect's turn ends the
 * moment it delegates: for the whole worker run that follows, the engine says
 * the session is idle. The rail then showed a yellow breathing dot while the
 * Architect was thinking and a dead one while a worker built the thing — the
 * exact opposite of when the work is happening. So a run the session started
 * counts as work too.
 */
const sessionWorking = (sessionId) => {
  if (!sessionId) return false;
  if (isBusy(sessionId)) return true;
  const project = projectOf(sessionId);
  const run = project ? runIn(project) : null;
  return Boolean(run && (!run.architect || run.architect === sessionId));
};
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

function liveDot(sessionId, { clickable = true, on = sessionWorking(sessionId) } = {}) {
  const stalled = isStalled(sessionId);
  if (stalled && clickable) {
    return `<button class="tree-live on stalled" data-interrupt="${esc(sessionId)}" title="No response for over ${Math.round(STALL_MS / 1000)}s — click to interrupt"></button>`;
  }
  if (stalled) return '<span class="tree-live on stalled" title="Stalled"></span>';
  return `<span class="tree-live${on ? ' on' : ''}" title="${on ? 'Working' : ''}"></span>`;
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
  const busy = sessionWorking(s.id);
  const waiting = waitingFor(s.id);
  const waitNote = waiting === 'answer' ? ' · waiting on your answer' : waiting === 'decision' ? ' · waiting for your decision' : '';
  return `<div class="tree-row session${current ? ' is-current' : ''}${busy ? ' has-work' : ''}${waiting ? ' has-question' : ''}" data-session="${esc(s.id)}">
    <button class="tree-open" title="${esc(title)}${when ? ` · ${esc(when)}` : ''}${busy ? ' · working' : ''}${waitNote}">
      <span class="tree-name">${esc(title)}</span>
    </button>
    <span class="tree-actions">
      ${waiting ? `<span class="tree-wait" title="${waiting === 'answer' ? 'Waiting on your answer' : 'Waiting for your decision'}" aria-label="${waiting === 'answer' ? 'Waiting on your answer' : 'Waiting for your decision'}">?</span>` : ''}
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
    // The rule down the left of a project carries its state: yellow while one of
    // its sessions is working, green when a session is chosen and waiting.
    const working = p.sessions.some((s) => sessionWorking(s.id));
    html.push(`<div class="tree-project">
      <div class="tree-row project${current ? ' is-current' : ''}${working ? ' has-work' : ''}">
        <button class="tree-open" data-project="${esc(p.id)}" aria-expanded="${open}" title="${esc(p.name)}">
          <span class="tree-caret" aria-hidden="true"></span>
          <span class="tree-name">${esc(p.name)}</span>
        </button>
        ${p.exists === false ? '<span class="tree-missing" title="This folder no longer exists — sessions cannot run here">!</span>' : ''}
        <span class="tree-actions">
          ${p.general ? '' : `<button class="tree-edit ic-edit" data-rename-project="${esc(p.id)}" title="Rename Project" aria-label="Rename Project">✎</button>`}
          ${liveDot('', { clickable: false, on: p.sessions.some((s) => sessionWorking(s.id)) })}
          ${p.general ? '' : `<button class="tree-x" data-del-project="${esc(p.id)}" title="Delete Project" aria-label="Delete Project">✕</button>`}
        </span>
      </div>
      ${
        open
          ? `<div class="tree-project-body${working ? ' has-work' : ''}">
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
  const project = projectOf(id);
  // The plan, the requirement, the answers and the findings live in the project's
  // folder, not in the session, so deleting the *last* session leaves them behind
  // and the next one opens onto the previous session's work. That is not a bug in
  // itself — a new session continuing a plan is a normal thing to want — but the
  // operator has to be able to say which they mean, and to see what is at stake.
  const last = Boolean(project && project.sessions.filter((x) => x.id !== id).length === 0);
  let plan = null;
  if (last) {
    try {
      const state = await api('GET', `/api/sessions/${encodeURIComponent(id)}/plan`);
      if (state?.exists !== false && state?.plan?.tasks?.length) plan = state.plan;
    } catch { /* the question is still worth asking without the count */ }
  }
  const ok = await openDialog({
    title: 'Delete Session',
    message: `"${s?.title || TBD_TITLE}" and its whole transcript are removed from the engine. This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
    // No plan, no question: offering to delete something that is not there is how
    // a dialog teaches the operator to stop reading it.
    ...(plan
      ? {
          fields: [
            {
              name: 'forget',
              type: 'check',
              value: false,
              label: `Forget ${project.name}'s plan too`,
              hint:
                `${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'} on file, with the request, the answers, ` +
                `the design, the ideas, the findings and the run log in .synapse. Leave it unticked to let the next ` +
                `session here carry on with them.`,
            },
          ],
          // The button says what it will do, and changes when the answer does.
          afterRender: () => {
            const box = $('dialogBody').querySelector('input[data-flag="forget"]');
            const btn = $('dialogOk');
            const label = () => {
              btn.textContent = box?.checked ? 'Delete and Forget Plan' : 'Delete';
            };
            box?.addEventListener('change', label);
            label();
          },
        }
      : {}),
  });
  if (!ok) return;
  try {
    const q = ok.forget ? '?forget=1' : '';
    const res = await api('DELETE', `/api/sessions/${encodeURIComponent(id)}${q}`);
    state.busySessions.delete(id);
    // The sidebar's last-event clock was reading that session's traffic. With the
    // session gone, an age beside its name is a leftover, not news.
    if (state.lastEventSessionId === id) setEventChip(null, null);
    if (state.sessionId === id) showNothing();
    await loadProjects();
    const forgotten = res?.forgotten;
    if (ok.forget && forgotten && !forgotten.ok) {
      toast('The Plan Was Kept', forgetReason(forgotten.reason));
    } else if (forgotten?.ok) {
      toast('Plan Forgotten', `${project.name}'s plan and scratch files are gone.`);
    }
  } catch (err) {
    toast('Could not delete the session', err.message);
  }
}

/** The server's own words for why a plan was not removed, in the operator's terms. */
function forgetReason(reason) {
  const text = String(reason || 'the server did not say why');
  if (/run is still working/i.test(text)) return 'A run was still working in that project. Try again when it has stopped.';
  if (/sessions still use/i.test(text)) return 'Another session in this project still uses that plan.';
  if (/no \.synapse/i.test(text)) return 'There was nothing to delete.';
  return text;
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
  // The next page load opens this one again (see restoreOpenSession).
  rememberSession(id);
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
          notes: [],
          stream: null,
          // Runs already compacted before this page was opened. Without it the
          // count starts at nothing and the chat says nothing about a run that is
          // on its fourth compaction — the operator watched exactly that.
          compactions: Number(run.compactions) || 0,
          compactAt: Number(run.compactAt) || 0,
          compactLimit: Number(run.compactLimit) || 0,
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
  // A compaction is news about the run, not a step in it: it lands on the trace as
  // a pinned line, and it is the one note that must survive the four-line tail.
  if (ev.type === 'run.note') {
    const trace = traceFor(ev);
    if (trace && ev.kind === 'compact') noteCompaction(trace, ev);
    renderTranscript();
    return;
  }
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
        notes: [],
        stream: null,
      });
    } else if (trace && run.tool) {
      // One note per new tool call, not one per event: the runner repeats the
      // same call on every progress tick. A call with no target ("reading") is
      // dropped when the note above it already said "reading <file>" — the
      // engine reports the target a moment after the call starts.
      const said = runPhrase(run.tool);
      const last = trace.notes[trace.notes.length - 1];
      const generic = !String(run.tool.target || '').trim();
      const repeated = generic && last && last.split(' ')[0] === said.split(' ')[0];
      // A shell note carries the whole command, quotes and all. One line of the
      // trace is not the place to read it; the card's tooltip and the report are.
      const line = said.length > 300 ? `${said.slice(0, 299)}…` : said;
      if (!repeated && !trace.notes.includes(line)) {
        trace.notes.push(line);
        if (trace.notes.length > 60) trace.notes.splice(0, trace.notes.length - 60);
      }
      // The step is over: whatever it was saying belonged to the step that just
      // ended, and the note is what remains of it. The window it was showing is
      // left in place, dimmed and still — removing it made the chat shrink by
      // eleven lines and grow again at every step, which a fast model does several
      // times a second.
      if (trace.stream) freezeStream(trace.stream);
    }
    // Every progress tick carries the run's own compaction tally, which was read
    // from the transcript by the runner. Taking it here is what makes the count
    // survive a page reload — the `run.note` for a compaction may well have been
    // sent while this page was not listening, and a trace rebuilt from
    // `/api/runs` starts with no notes at all.
    if (trace && Number(run.compactions) > (Number(trace.compactions) || 0)) {
      trace.compactions = Number(run.compactions);
      if (Number(run.compactAt)) trace.compactAt = Number(run.compactAt);
      if (Number(run.compactLimit)) trace.compactLimit = Number(run.compactLimit);
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
  paintRates();
  // The rail's dot says whether anything is being done for a project, and a run
  // starting or ending is exactly that — the engine's own busy state cannot see
  // a worker, because the Architect's turn is already over by then.
  if (ev.type !== 'run.progress') renderTree();
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
    // The Architect's card reads its window from the usage event, which a page
    // opened later never saw. The transcript carries the same number, so seed it
    // here rather than showing an empty corner until the next turn.
    state.archCtx = lastPromptOf(state.messages) || state.archCtx;
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
  // And then follow only if the reader was already at the end. This used to stick
  // unconditionally while a turn was running, which meant a report arriving under
  // a worker's trace dragged the page down while the operator was reading an old
  // message. Being pulled away from what you are reading is worse than missing
  // the end of a long turn: the scroll button and the rail already say something
  // arrived.
  const stick = chatAtBottom();
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
  const hasHistory = showable.length > 0 || Boolean(pending) || Boolean(currentForm()) || alarmsHere().length > 0;
  // The dock is a bare composer while empty and fills the stage once there is
  // anything to show; the CSS keys off this class, so set it on every render.
  $('chatDock')?.classList.toggle('has-history', hasHistory);
  // An empty dock sits at the bottom of the page, a full one starts under the
  // cards — so the room left for it has to be re-measured on every change.
  fitChatHeight();

  // Nothing in the conversation changed since the last render: leave the DOM —
  // and whatever the operator has open — exactly as it is.
  const sig = hasHistory
    ? `${showable.map((m) => `${m.id}:${m.completed || 0}:${(m.parts || []).length}`).join(',')}|${pending.length}|${state.streaming}|${traceSig()}|${alarmsHere().length}`
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
  // the newest message. An alarm is merged the same way for the same reason: it is
  // a line *in* the conversation, so it scrolls up and away with the rest of it
  // instead of standing at the bottom for ever.
  const items = [
    ...tracesFor(currentProject()?.directory).map((t) => ({ at: Number(t.startedAt) || 0, html: renderTrace(t) })),
    ...alarmsHere().map((a) => ({ at: Number(a.at) || 0, html: renderAlarm(a) })),
  ].sort((x, y) => x.at - y.at);
  let html = '';
  let next = 0;
  for (const m of showable) {
    const at = Number(m.created) || 0;
    while (next < items.length && at && items[next].at < at) html += items[next++].html;
    html += renderMessage(m);
  }
  while (next < items.length) html += items[next++].html;
  el.innerHTML = html + pending;
  if (stick) scrollChatToBottom();
  renderChatNav();
}

/** The alarms that belong in this conversation: this session's, or this project's
 *  when a delegated worker was the one that named the harness. */
function alarmsHere() {
  const dir = currentProject()?.directory;
  return state.alarms.filter(
    (a) => !a.sessionId || a.sessionId === state.sessionId || (a.dir && dir && dirKey(a.dir) === dirKey(dir)),
  );
}

/**
 * A model touched Synapse itself, said in the chat.
 *
 * Amber, like a compaction, because it is the same kind of news: something the
 * harness noticed about the run rather than a step in it. The command is cut to one
 * line and the full text is in the tooltip and the log — the operator cannot act on
 * it, so what they need is to know it happened, not to read it.
 */
function renderAlarm(a) {
  const title = /write|edit/i.test(a.what) ? 'Something tried to write inside Synapse' : 'A model named Synapse in a tool call';
  const detail = a.paths.join(' | ');
  const shown = detail.length > 150 ? `${detail.slice(0, 149)}…` : detail;
  return `<div class="chat-alarm" title="${esc(`${title}: ${detail}${a.note ? ` — ${a.note}` : ''}`)}">
    <span class="chat-alarm-mark">⚠</span>
    <span class="chat-alarm-text">${esc(title)}${shown ? ` · ${esc(shown)}` : ''}</span>
  </div>`;
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
  const note = (text) => `<div class="trace-line">${esc(text)}</div>`;
  const notes = t.notes || [];
  // Only the last few steps stay open. Everything before is one line that opens:
  // a worker ten minutes in has done forty things, and forty lines of it is the
  // whole chat. This is the shape an editor's agent uses, for the same reason.
  const tail = notes.slice(-4);
  const older = notes.slice(0, Math.max(0, notes.length - 4));
  const archive = older.length
    ? `<details class="trace-archive"><summary>${older.length} earlier step${older.length === 1 ? '' : 's'}</summary>${older
        .map(note)
        .join('')}</details>`
    : '';
  // What it is saying *now*. The words stream in as they are written, and the last
  // window stays on screen when the step ends — still, and dimmed. Removing it took
  // eleven lines out of the chat and put them back at every step boundary, which a
  // fast model does several times a second. The whole block is rendered and the
  // panel keeps its window; nothing is sliced here, so a re-render never changes a
  // line break.
  const streaming = t.stream && t.stream.text
    ? `<div class="trace-flow${t.stream.kind === 'think' ? ' is-think' : ''}${t.stream.ended ? ' is-idle' : ''}"><div class="trace-flow-view"><div class="trace-flow-body">${esc(
        t.stream.text,
      )}</div></div></div>`
    : '';
  // A compaction line is pinned: the four-line tail is for steps, and this is not
  // a step — it is the reason the next step is slower and the window is empty
  // again. It stays for the whole run, and the folded summary counts it.
    const packed = Number(t.compactions) || 0;
  const compacting = Number(t.compactingSince) || 0;
  // While one is in flight the count is "the ones that have finished, plus this
  // one" — `compactions` only ever counts finished compactions, so the number here
  // is the number of the one being written.
  const compactLine = compacting
    ? `<div class="trace-line is-compact">⏳ Compacting ×${packed + 1}</div>`
    : packed
      ? `<div class="trace-line is-compact">⏳ Compacted ×${packed}` +
        (t.compactAt ? ` · context at ${fmtTokens(t.compactAt)}${t.compactLimit ? `/${fmtTokens(t.compactLimit)}` : ''}` : '') +
        '</div>'
      : '';
  const body = `${archive}${compactLine}${tail.map(note).join('')}${streaming}`;
  if (!t.finishedAt) {
    return `<div class="trace is-live" data-trace="${esc(t.key)}">
      <div class="trace-head" title="${esc(head.join(' · '))}">${esc(head.join(' · '))}</div>
      <div class="trace-lines">${body || '<div class="trace-line">starting…</div>'}</div>
    </div>`;
  }
  const took = t.ms ? ` · ${shortSpan(t.ms)}` : '';
  const written = t.files ? ` · ${t.files} file${t.files === 1 ? '' : 's'}` : '';
  // A compaction is not a step of the work, and it is the one thing the operator
  // needs to still see an hour later, so it rides the folded line too.
  const packedNote = Number(t.compactions) ? ` · compacted ×${t.compactions}` : '';
  // The task's own title belongs on the folded line: "Coder 1 · t8" says where,
  // not what. It ellipsizes when the column is short, and the tooltip has the lot.
  const foldHead = [name, t.task, t.title].filter(Boolean).join(' · ');
  return `<details class="trace is-fold" data-trace="${esc(t.key)}">
    <summary title="${esc(foldHead)}">${esc(foldHead)}${took}${written}${packedNote}</summary>
    <div class="trace-lines">${body}</div>
  </details>`;
}

/** The traces that belong to a project, in the order they started. */
function tracesFor(dir) {
  const key = dirKey(dir);
  return [...state.traces.values()].filter((t) => dirKey(t.dir) === key);
}

// The worker's own words, streamed.
//
// The engine sends `session.text.delta` and `session.reasoning.delta` with the
// piece of text in `data.delta` (measured, 21 Oct), so there is nothing to guess
// and nothing to poll: the page accumulates what arrives and shows the tail. The
// block is dropped when its step ends — a text block ending, or the next tool
// call — because a chat cannot be a transcript of every sentence every worker
// thought. The one-line note of the tool call is what survives.
// Streaming text, inside a panel that slides.
//
// Two costs had to stay out of this. It must not rebuild the transcript — that is
// an innerHTML of every message. And it must not rewrite the text each frame: the
// old window replaced the *front* of the paragraph sixty times a second, which
// re-broke every line and forced a layout of the whole chat. So the text node is
// written once per delta and never touched in between, and a frame does one thing
// only — move the block by a few pixels with `transform`, which the compositor
// handles without laying anything out. Frames stop as soon as the slide settles.
//
// The travel itself is `nextOffset` in ./stream-view.js: a damped spring, so the
// text is dragged along by the writing and eases to a stop when the model pauses.
let streamRaf = 0;
let streamEl = null; // { mask, view, body, node, scrolling } once the panel is on screen
let streamFrameAt = 0; // performance.now() of the last frame, for the real dt
const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

// Is the chat still being carried along by the writing?
//
// A distance test alone cannot answer that. Within any slack at all, every written
// frame snapped the chat back to the end, so a reader who scrolled up was fighting
// the page for the width of the slack — and the wheel always lost, because the snap
// ran sixty times a second. So the rule is now: two lines from the end is "following",
// and an upward scroll is a reader who has taken over — the follow lets go at once
// and stays let go until they are back at the end. Nothing is disabled; it is a
// hand-off, and the hand comes back.
let chatFollowArmed = true;
let lastChatTop = 0;
const CHAT_FOLLOW_SLACK = 48; // two lines
// The last time the operator themselves moved the conversation: a wheel, a key, a
// finger. A scroll *event* cannot tell their move from ours, and that was the bug:
// a rebuild resets the scroller and our own follow fires an event, so a declining
// scrollTop read as "the reader took over" and the follow let go in the middle of a
// stream. It came back when the block folded and the next render re-armed it, which
// is why it looked intermittent and why it only happened while thinking streamed.
let chatUserMovedAt = 0;
const CHAT_USER_WINDOW_MS = 1500;

function noteChatScroll() {
  const el = chatScroller();
  if (!el) return;
  const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
  const byReader = Date.now() - chatUserMovedAt < CHAT_USER_WINDOW_MS;
  if (byReader && el.scrollTop < lastChatTop - 4) chatFollowArmed = false;
  else if (fromEnd <= CHAT_FOLLOW_SLACK) chatFollowArmed = true;
  lastChatTop = el.scrollTop;
}

/** The operator moved the conversation. Only this may release the follow. */
function noteUserScrollIntent(deltaY) {
  // A wheel down at the end is them coming back, not leaving.
  if (deltaY > 0 && chatAtBottom(CHAT_FOLLOW_SLACK)) chatFollowArmed = true;
  else chatUserMovedAt = Date.now();
}

/** The panel's parts, or null if it is not on screen yet. */
function findStreamEl(key) {
  const mask = document.querySelector(`.trace.is-live[data-trace="${CSS.escape(key)}"] .trace-flow`);
  const view = mask?.querySelector('.trace-flow-view');
  const body = view?.firstElementChild;
  const node = body?.firstChild;
  if (!body || !node || node.nodeType !== Node.TEXT_NODE) return null;
  return { mask, view, body, node, scrolling: null };
}

/** How far the text has to move up for its last line to sit at the bottom edge. */
function measureStream(s) {
  if (!streamEl) return 0;
  s.target = slideTarget(streamEl.body.offsetHeight, streamEl.view.clientHeight);
  return s.target;
}

function appendStream(kind, delta) {
  const trace = traceOf(currentRun());
  if (!trace || !delta) return;
  if (!trace.stream || trace.stream.kind !== kind || trace.stream.ended) {
    // A new block (thinking, then speech). Its class differs, so the panel is
    // replaced on the next frame rather than patched; nothing is on screen between
    // the two, because the previous block was frozen when its step ended.
    trace.stream = newStream(kind);
    streamEl = null;
    // A new block is a fresh start: whatever the reader did with the last one does
    // not hold this one hostage.
    chatFollowArmed = true;
    lastChatTop = chatScroller()?.scrollTop || 0;
  }
  pushStream(trace.stream, delta);
  if (!streamRaf) {
    streamFrameAt = 0;
    streamRaf = requestAnimationFrame(pumpStream);
  }
}

function pumpStream(now) {
  streamRaf = 0;
  const trace = traceOf(currentRun());
  const s = trace?.stream;
  if (!s || !s.text) {
    streamEl = null;
    return;
  }
  if (!streamEl || !streamEl.mask.isConnected) {
    streamEl = findStreamEl(trace.key);
    if (!streamEl) {
      // Not on screen — the first delta of a run, or a rebuild in between. One
      // render puts it there; the next frame finds it.
      renderTranscript();
      return;
    }
    // A panel that appears mid-block is already showing its last line: start it
    // there rather than sliding the whole block up from the beginning. A *fresh*
    // block starts at its own top — the panel still holds the previous block's
    // words, and measuring those would start this block scrolled by their height.
    s.velocity = 0;
    s.offset = s.shown > 0 ? measureStream(s) : 0;
  }
  let follow = false;
  if (s.dirty) {
    // Read the chat's position *before* the text grows, the same rule the
    // transcript uses for new messages, and only on a frame that writes.
    const scroller = chatScroller();
    follow = Boolean(scroller && chatFollowArmed && chatAtBottom(CHAT_FOLLOW_SLACK));
    // Append, never rewrite: the block can be twenty thousand characters and
    // replacing its text re-breaks every line of it, once per frame.
    const piece = takePending(s);
    if (piece.reset) streamEl.node.data = piece.text;
    else if (piece.text) streamEl.node.data += piece.text;
    s.dirty = false;
    measureStream(s);
  }
  const scrolling = (s.target || 0) > 0.5;
  if (scrolling !== streamEl.scrolling) {
    // The fade at the top edge only belongs there while text is leaving through
    // it; a short block sits in the same panel unclipped.
    streamEl.scrolling = scrolling;
    streamEl.mask.classList.toggle('is-scrolling', scrolling);
  }
  const dt = streamFrameAt ? (now - streamFrameAt) / 1000 : 1 / 60;
  streamFrameAt = now;
  const was = s.offset;
  const offset = nextOffset(s, s.target || 0, dt, { reduced: reducedMotion });
  // The slide is damped, so a fast model outruns it: the target grows faster than
  // the spring arrives, and the newest lines sit below the panel's edge until it
  // catches up — text the operator is watching arrive but cannot read. When the
  // chat is following, the lag is capped at a sliver, so the last line is always
  // readable and the easing only shows when the writing slows down.
  const bounded = follow ? Math.max(offset, (s.target || 0) - STREAM_MAX_LAG) : offset;
  if (bounded !== was) {
    s.offset = bounded;
    streamEl.body.style.transform = `translate3d(0, ${-bounded}px, 0)`;
  }
  if (follow) {
    const scroller = chatScroller();
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      // The follow's own move is not the reader scrolling: keep the comparison
      // baseline in step, or the next frame reads it as an upward scroll.
      lastChatTop = scroller.scrollTop;
    }
  }
  if (!s.settled || s.dirty) streamRaf = requestAnimationFrame(pumpStream);
}

function endStream() {
  const trace = traceOf(currentRun());
  if (!trace || !trace.stream) return;
  // The last window stays on screen, still, until the next block replaces it or
  // the run folds. Taking it away here pulled eleven lines out of the chat at every
  // step boundary and put them back at the next one — a fast model does that
  // several times a second. Let any frame already queued finish the slide, then
  // stop: the text is frozen, so nothing new arrives.
  freezeStream(trace.stream);
  streamEl = null;
  renderTranscript();
}

// Tokens per second, from the engine's own meter.
//
// `session.usage.updated` carries the running token counts for the session
// (measured: `{input, output, reasoning, cache}`), so the rate is the change in
// written tokens over the time between two of them. It is the rate of the last
// step, not of the last three seconds — the engine reports per step, so there is
// nothing finer to average — and it is shown only while the step is recent.
const usageSamples = new Map(); // dirKey -> { at, tokens }
const RATE_FRESH_MS = 45000;
// How much of the newest line the damped slide may hide while the chat follows.
// Under a line's height, so nothing readable is ever behind the edge.
const STREAM_MAX_LAG = 8;

/**
 * When a step's first and last piece were streamed, per session.
 *
 * This is the only place a speed can honestly be measured. The engine stamps a
 * turn with when it started and when its last piece left, and that difference
 * contains reading the prompt: on the turn the provider's own log recorded as
 * `60 tokens in 8 s (93.4 tok/s)`, 4 s of the 8 were a 28,700-token prompt being
 * read, so the card said 8. Counting from the first piece leaves the prompt, the
 * round trip and the tool out of it — which is what "tokens per second" means.
 */
const deltaWindow = new Map(); // sessionId -> { first, last }
function noteDelta(ev) {
  if (!ev.sessionId) return;
  const w = deltaWindow.get(ev.sessionId) || { first: 0, last: 0 };
  const now = Date.now();
  if (!w.first) w.first = now;
  w.last = now;
  deltaWindow.set(ev.sessionId, w);
}

/**
 * The open session's own last prompt, for the Architect's card.
 *
 * A worker's usage arrives for the worker's session and is read by the runner; the
 * Architect's own never went anywhere, so its card could say how long it had been
 * working and nothing about what it was carrying. The event is the same one, on
 * the same stream, so this is a copy and not a measurement of its own.
 */
function noteArchitectUsage(ev) {
  const tokens = ev.raw?.data?.tokens;
  if (!tokens) return;
  state.archCtx = {
    sessionId: ev.sessionId,
    used: (Number(tokens.input) || 0) + (Number(tokens.cache?.read) || 0),
    at: Date.now(),
  };
  paintRates();
}

/** The same number, from the transcript: the open session's newest prompt. */
function lastPromptOf(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.type === 'assistant' && m.raw?.tokens);
  const t = last?.raw?.tokens;
  if (!t) return null;
  return {
    sessionId: state.sessionId,
    used: (Number(t.input) || 0) + (Number(t.cache?.read) || 0),
    at: Date.now(),
  };
}

function noteWorkerUsage(ev) {
  const run = currentRun();
  if (!run || !ev.sessionId || ev.sessionId !== run.workerId) return;
  const tokens = ev.raw?.data?.tokens;
  if (!tokens) return;
  const total = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
  const key = dirKey(run.dir);
  const prev = usageSamples.get(key);
  const at = Number(ev.ts) || Date.now();
  usageSamples.set(key, { at, total });
  // The window belongs to the step this usage figure is about, so it is taken
  // whatever the outcome: a step that wrote nothing must not leave its timings
  // behind to be paired with the next step's tokens.
  const w = deltaWindow.get(ev.sessionId);
  deltaWindow.delete(ev.sessionId);
  if (!prev || total <= prev.total) return;
  const written = total - prev.total;
  const streamed = w && w.last - w.first >= 250 ? (w.last - w.first) / 1000 : 0;
  const tps = streamed ? written / streamed : written / Math.max(0.25, (at - prev.at) / 1000);
  state.rates.set(key, { role: run.role, tps, at });
  paintRates();
}

function paintRates(now = Date.now()) {
  const run = currentRun();
  const rate = run ? state.rates.get(dirKey(run.dir)) : null;
  // The Architect is not a delegated run, so no `runs` record describes it. Its
  // window comes from the usage event its own session sends, and the window size
  // from the model on its card — the same pair, in the same corner.
  const arch = state.archCtx?.sessionId === state.sessionId ? state.archCtx : null;
  const archLimit = arch ? Number(modelByRef(selectionFor('architect').ref)?.context) || 0 : 0;
  for (const card of document.querySelectorAll('#topology .role-card')) {
    const el = card.querySelector('.role-rate');
    if (!el) continue;
    const mine = run && rate && rate.role === card.dataset.role && now - rate.at < RATE_FRESH_MS;
    const bits = [];
    // The live rate first: it is measured between the first and the last piece the
    // model streamed, which is the number the model's own log prints. The runner's
    // figure (`run.tps`) is the same idea from the transcript, and it carries the
    // prompt read inside it — so it is the fallback for a page that opened mid-run
    // and has not seen a stream yet.
    const measured = run && run.role === card.dataset.role ? Number(run.tps) || 0 : 0;
    if (mine) bits.push(`${Math.round(rate.tps)} tok/s`);
    else if (measured) bits.push(`${measured} tok/s`);
    // The window, in the corner the operator already looks at: "27k/60k ctx". It
    // is the pair that explains a slowdown (a full window is re-read every turn)
    // and the compaction that follows. Shown even when the rate has gone stale —
    // the fill of the window is true whether or not the model is writing.
    let tip = '';
    if (card.dataset.role === 'architect' && Number(arch?.used) > 0) {
      bits.push(`${fmtTokens(arch.used)}${archLimit ? `/${fmtTokens(archLimit)}` : ''} ctx`);
      tip = `The Architect's last prompt: ${arch.used} tokens` + (archLimit ? ` of ${archLimit}` : '');
    } else if (run && run.role === card.dataset.role && Number(run.ctx) > 0) {
      bits.push(`${fmtTokens(run.ctx)}${run.ctxLimit ? `/${fmtTokens(run.ctxLimit)}` : ''} ctx`);
      tip =
        `Prompt ${run.ctx} tokens of ${run.ctxLimit || 'an unknown window'}` +
        (run.ctxRoom ? `; Synapse compacts near ${run.ctxRoom}` : '');
    }
    const text = bits.join(' · ');
    if (el.textContent !== text) el.textContent = text;
    if (el.title !== tip) el.title = tip;
  }
}

const traceKeyOf = (run) => `${dirKey(run.dir)}|${run.task}|${Number(run.startedAt) || 0}`;
function traceOf(run) {
  return run ? state.traces.get(traceKeyOf(run)) || null : null;
}

/**
 * The trace a runner event belongs to.
 *
 * Its own key when the page saw the run start, and otherwise the newest trace for
 * that task in that project: the same run before a reload has a different
 * `startedAt` (the page rebuilds it from `/api/runs`), and a note that lands in
 * that gap must still reach the right line rather than being dropped in silence.
 */
function traceFor(ev) {
  const exact = state.traces.get(traceKeyOf(ev));
  if (exact) return exact;
  const dir = dirKey(ev.dir);
  let best = null;
  for (const t of state.traces.values()) {
    if (dirKey(t.dir) !== dir || t.task !== ev.task) continue;
    if (!best || (Number(t.startedAt) || 0) > (Number(best.startedAt) || 0)) best = t;
  }
  return best;
}

/** One compaction, on a trace. `times` is the transcript's own tally, so the
 *  count only ever goes up: a note repeated (a re-sent event, two pages open) must
 *  not become "Compacting ×2" for one compaction. */
function noteCompaction(trace, { times, used, context } = {}) {
  const counted = Number(times) || 0;
  const known = Number(trace.compactions) || 0;
  trace.compactions = counted > known ? counted : known || 1;
  if (Number(used)) trace.compactAt = Number(used);
  if (Number(context)) trace.compactLimit = Number(context);
}

/** The trace of a delegated run whose worker session is this one, if any. */
function traceForSession(sessionId) {
  if (!sessionId) return null;
  for (const run of state.runs.values()) {
    if (run.workerId === sessionId) return traceOf(run);
  }
  return null;
}

/**
 * The engine compacting a worker's transcript, seen on its own stream.
 *
 * `started` puts the line in the chat while it is happening — the operator watched
 * "compaction.started" sit in the status rail with nothing in the chat beside it,
 * which is the one moment they could have used a word in the conversation. `ended`
 * counts it; `failed` clears the line and counts nothing. The size beside it is the
 * prompt the run last reported, which is the size that caused it.
 */
function noteCompactionEvent(ev) {
  const trace = traceForSession(ev.sessionId);
  if (!trace) return;
  if (ev.type === 'session.compaction.started') {
    trace.compactingSince = Date.now();
  } else {
    trace.compactingSince = 0;
    if (ev.type === 'session.compaction.ended') {
      // Count it; do not guess its size. The runner reads the compaction's own
      // usage out of the transcript and sends it a moment later, and that is the
      // only number worth printing — `run.ctx` here is *this* poll's prompt, which
      // is the small one if the transcript has already shrunk. Showing that was
      // the "Compacted ×2 · context at 11K" the operator was rightly suspicious of.
      noteCompaction(trace, { times: (Number(trace.compactions) || 0) + 1 });
    }
  }
  renderTranscript();
}

/** What the traces are showing, so a rebuilt transcript is not rebuilt for
 *  nothing while they sit still.
 *
 *  The compaction count is part of it and has to be: a compaction changes no note
 *  and no stream, so without this the `run.note` arrived, set the count, asked for
 *  a re-render — and the re-render found nothing new in this signature and
 *  returned, which is why the operator saw "compaction" in the chip and nothing
 *  in the chat. */
function traceSig() {
  return [...state.traces.values()]
    .map(
      (t) =>
        `${t.key}:${t.finishedAt || 0}:${(t.notes || []).length}:${t.stream ? t.stream.text.length : 0}:` +
        `${t.stream?.ended ? 1 : 0}:${Number(t.compactions) || 0}:${Number(t.compactingSince) || 0}`,
    )
    .join(';');
}

// The role label shares the first line with the text; the time rides the right.
function renderMessage(m) {
  const t = hhmm(m.created);
  const stamp = t ? `<span class="msg-time">${t}</span>` : '';

  if (m.type === 'user') {
    // What was attached is part of the message, not a footnote to it: the operator
    // asked about a file, and a transcript that shows the sentence and hides the
    // file cannot be read later.
    const files = Array.isArray(m.files) ? m.files : [];
    const chips = files.length
      ? `<span class="msg-files">${files
          .map((f) => `<span class="msg-file" title="${esc(f.name)}">${esc(shortName(f.name))}</span>`)
          .join('')}</span>`
      : '';
    return `<div class="msg user" data-msg="user"><div class="msg-body">
      ${stamp}<span class="msg-role">You</span><span class="msg-text">${esc(m.text)}</span>${chips}
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

/** Is the reader at the end of the conversation — close enough to be followed?
 *
 *  The window is two lines (48px), not four. Four was enough room to be "at the
 *  bottom" while reading the last thing said, so a new message arriving pulled the
 *  page out from under a reader who had not finished it. Two lines still forgives
 *  the odd stray pixel of sub-pixel layout, and forgiving any more than that is not
 *  forgiveness, it is being yanked.
 */
function chatAtBottom(slack = 48) {
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
  // When the plan sits beside the cards it shares their row, and in Single its
  // floor is taller than the Architect card — so the row, not the wrapper, is
  // what the chat has to start below. On a window too narrow for that, the plan
  // is placed under the chat and counts for nothing here.
  const planEl = $('stage')?.querySelector('.rail-plan');
  const planInRow = planEl && getComputedStyle(planEl).gridRowStart === '1';
  const rowH = Math.max(settled, planInRow ? planEl.getBoundingClientRect().height : 0);
  const room = window.innerHeight - (stageTop() + rowH + stageGap()) - 12;
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
    // A question can be cancelled under us: the engine rebuilds its locations when
    // it restarts, and every pending form goes with them. Answering one that no
    // longer exists is not the operator's mistake, and leaving the dead panel up
    // means they keep pressing a button that cannot work.
    if (/Form not found/i.test(String(err.message || ''))) {
      state.forms = state.forms.filter((f) => f.id !== formId);
      renderAskPanel();
      renderComposer();
      renderTranscript();
      toast('That Question Is Gone', 'The session was restarted and the engine cancelled it. Message the session to carry on.');
      return;
    }
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
  // A page opened, or reloaded, in the middle of a turn never saw the
  // `session.execution.started` that began it — so the composer showed no Stop and
  // the card looked idle while the engine was working. The engine's own list of
  // active sessions is the authority, and it is already in hand here. It only ever
  // turns this *on*: clearing it is the transcript's job (`updateBusyFromMessages`)
  // and the turn's own end event, so a poll that races the engine cannot take the
  // Stop button away from a session that is working.
  if (state.sessionId && active.has(state.sessionId) && !state.busy) {
    state.busy = true;
    renderComposer();
  }

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

  // The same poll is the only place that knows, for certain, that nothing is
  // running anywhere — so it is where the sidebar clock is allowed to stop.
  settleEventChip(state.busySessions);

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
  paintPlan(body);
  updatePlanOverflow();
}

/** The plan box is as tall as the role cards, so a long plan is routinely cut
 *  mid-row. Mark the panel while there is more below the fold, so its bottom
 *  edge fades instead of drawing a hard line through a card. */
function updatePlanOverflow() {
  const body = $('planBody');
  const panel = body?.closest('.rail-plan');
  if (!body || !panel) return;
  const more = body.scrollHeight - body.scrollTop - body.clientHeight > 2;
  panel.classList.toggle('is-clipped', more);
}

function paintPlan(body) {
  const st = state.planState;
  const rel = st?.relative || '.synapse\\plan.json';

  // Single mode is a chat, not a run: there are no roles and no work list, so the
  // panel says what the conversation is about and how long it has run, and nothing
  // else. It is short on purpose — the card beside it is the subject.
  if (state.mode === 'single') {
    const goal = String(st?.plan?.goal || '').trim();
    body.innerHTML =
      `<p class="plan-goal plan-goal-single">${goal ? esc(goal) : 'A conversation with the Architect: it answers here, with no workers and no list.'}</p>` +
      `<p class="rail-note plan-meta"><span></span>${planClockMarkup()}</p>`;
    return;
  }

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
            <span class="plan-id">${esc(t.id || '?')}</span>${
              t.origin === 'found'
                ? `<span class="plan-origin" title="Noticed during the work - this row was not in the list when the operator first saw it">NEW</span>`
                : ''
            }
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

/**
 * A popup opened from the rail's foot.
 *
 * The two tables used to render into panels under the conversation; the ids and
 * the renderers are unchanged, so opening one is: show the backdrop, then let the
 * caller refresh what is inside it. Closing is the same in reverse, and the
 * refresh is skipped when the panel is not on screen.
 */
function openRailModal(id, refresh) {
  const el = $(id);
  if (!el) return;
  el.hidden = false;
  const focusable = el.querySelector('[data-close-modal], .close-x, button');
  focusable?.focus?.();
  Promise.resolve(refresh?.()).catch(() => {});
}

function closeRailModal(id) {
  const el = $(id);
  if (el) el.hidden = true;
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
    note.textContent = `No tool calls yet. The census is cleared when a new session starts.`;
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
  const files = state.attachments.slice();
  if (!text && !files.length) return;

  if (!state.sessionId) {
    toast('No session open', 'Pick a session on the left, or start a new one.');
    return;
  }

  input.value = '';
  autoGrow(input);
  // Sending is the moment the operator knows work is starting, and the rail should
  // say so on the same click — the engine's first status event can arrive a second
  // later, and a green row after pressing Send reads as "nothing happened".
  state.busySessions.add(state.sessionId);
  renderTree();
  try {
    await ensureSession();
    state.streaming = true;
    state.busy = true;
    renderComposer();
    state.messages.push({
      id: 'local-' + Date.now(),
      type: 'user',
      text,
      created: Date.now(),
      files: files.map((f) => ({ name: f.name, mime: f.mime })),
    });
    renderTranscript();
    // Sending is a statement of intent to read the answer: put the newest message
    // in view, and again after the turn's messages land.
    scrollChatToEnd();
    await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/messages`, {
      text,
      // The bytes go with the message, in the engine's own shape, so the file is
      // the operator's message rather than something the harness put on disk.
      files: files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })),
    });
    // Only after the server has taken them: a failed send must not eat the files.
    state.attachments = [];
    renderAttachments();
    await loadMessages();
    scrollChatToEnd();
  } catch (err) {
    // The send failed, so the work the rail was told about is not happening.
    state.busySessions.delete(state.sessionId);
    renderTree();
    toast('Send failed', err.message);
  } finally {
    state.streaming = false;
    renderComposer();
  }
}

/** A file name that fits a chip: the last 14 characters, with an ellipsis. */
function shortName(name) {
  const s = String(name || '');
  return s.length <= 14 ? s : `${s.slice(0, 13)}…`;
}

/** Read a picked file into the shape the message needs. */
function readFileAsAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const url = String(reader.result || '');
      const comma = url.indexOf(',');
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        data: comma >= 0 ? url.slice(comma + 1) : '',
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * The attachments waiting to be sent, as panels above the box.
 *
 * They sit inside the composer rather than floating over the transcript: the
 * operator's own sketch had them overlaying the chat's last line, and in practice
 * that hides the sentence you are about to send. The strip takes its own row, so
 * nothing is covered and the box does not move when the first file is added.
 */
function renderAttachments() {
  const strip = $('attachStrip');
  if (!strip) return;
  const list = state.attachments || [];
  strip.hidden = list.length === 0;
  strip.innerHTML = list
    .map(
      (f) => {
        const image = /^image\//i.test(f.mime);
        // A picture says more than its name, so the chip carries the bytes for a
        // preview; anything else keeps the tooltip that already showed its name.
        return `<span class="attach-chip" data-attach="${esc(f.id)}"${image ? ' data-image="1"' : ''} title="${image ? '' : `${esc(f.name)} · ${fmtBytes(f.size)}`}">
        <span class="attach-name">${esc(shortName(f.name))}</span>
        <button type="button" class="attach-x" data-detach="${esc(f.id)}" title="Remove ${esc(f.name)}" aria-label="Remove ${esc(f.name)}">✕</button>
      </span>`;
      },
    )
    .join('');
}

/**
 * The picture behind an image chip, on hover.
 *
 * Fixed-position and outside the composer: a popup drawn inside it would be
 * clipped by the dock at the exact moment you wanted to look at it. It appears
 * above the chip, and never off the top of the window - the composer is at the
 * bottom, which is where the room is.
 */
function showAttachPreview(id) {
  const box = $('attachPreview');
  const img = $('attachPreviewImg');
  const name = $('attachPreviewName');
  const f = (state.attachments || []).find((a) => a.id === id);
  const chip = document.querySelector(`.attach-chip[data-attach="${CSS.escape(String(id))}"]`);
  if (!box || !img || !name || !f || !chip) return;
  img.src = `data:${f.mime};base64,${f.data}`;
  name.textContent = f.name;
  box.hidden = false;
  const c = chip.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const left = Math.max(8, Math.min(c.left, window.innerWidth - b.width - 8));
  box.style.left = `${left}px`;
  box.style.top = `${Math.max(8, c.top - b.height - 8)}px`;
}

function hideAttachPreview() {
  const box = $('attachPreview');
  if (box) box.hidden = true;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
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

    // Only work moves the clock. A `session.deleted` or `session.named` is about
    // the rail, and the chip is about what a model is doing.
    if (WORK_EVENT.test(String(ev.type || '').replace(/^session\./, ''))) setEventChip(ev.type, ev.sessionId);
    // A compaction is the engine's own decision, and the chip has always said so
    // (`session.compaction.started`) while the chat said nothing at all. Taking it
    // from here is the honest source: whatever asked for it — the engine's rule or
    // our watchdog — this is the one event that proves one is happening.
    if (ev.sessionId && /^session\.compaction\.(started|ended|failed)$/.test(ev.type)) {
      noteCompactionEvent(ev);
    }
    const mine = !ev.sessionId || ev.sessionId === state.sessionId;
    // A worker's session is not the open one, so nothing of it renders through
    // `mine`. Its words and its thinking stream in here instead, and its steps
    // become the one-line notes in the trace.
    const liveRun = currentRun();
    if (liveRun && ev.sessionId && ev.sessionId === liveRun.workerId) {
      if (ev.type === 'session.text.delta') { noteDelta(ev); appendStream('word', ev.raw?.data?.delta); }
      else if (ev.type === 'session.reasoning.delta') { noteDelta(ev); appendStream('think', ev.raw?.data?.delta); }
      else if (ev.type === 'session.usage.updated') noteWorkerUsage(ev);
      else if (ev.type === 'session.text.ended' || ev.type === 'session.reasoning.ended') endStream();
    }
    // The Architect's own card gets the same number from the same event. Its
    // session is never a worker's, so the two cannot both claim it.
    if (ev.sessionId && ev.sessionId === state.sessionId && ev.type === 'session.usage.updated') noteArchitectUsage(ev);
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
  { id: 'windows', label: 'Windows', icon: 'engine' },
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
    setGroup(
      'Compaction',
      setField(c, 'Keep after compacting (tokens, 0 = engine default)', 'engine.opencode.compactionKeepTokens', {
        type: 'number',
        restart: true,
        hint: 'When the engine compacts, it writes a summary and carries the last N tokens of the conversation over word for word. 15,000 by default. The summary itself is the engine\'s and cannot be shortened; this can, and it is most of the prompt afterwards. 0 leaves the engine alone.',
      }) +
        `<p class="set-note">The engine compacts by itself once the prompt reaches its own ceiling: the window it was told,
      minus the larger of 15% of it or 16,000 tokens. On a 60,160 window that is 44,160. The summary it writes is about
      2,500 tokens and is not configurable; the text carried over beside it is, with the number above. A smaller
      number means less to re-read after a compaction and the same ceiling to reach, so the window lasts longer.</p>`,
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

/**
 * Settings → Windows: what this machine can build with.
 *
 * A Windows app is a WPF window hosting a WebView2 page, so it needs two things
 * here — the .NET SDK to build it, the WebView2 runtime to run it — plus the
 * template it is copied from and the checker that photographs its window. The point
 * of the pane is a *copied* Synapse: on a new PC it says what that PC is missing,
 * rather than a build dying three turns into a project.
 */
function settingsWindows(c) {
  const t = state.toolchain;
  const row = (label, item, extra) => {
    const ok = Boolean(item?.ok);
    const state = ok ? (item.version || 'ready') : 'missing';
    return `
      <div class="set-field wide" title="${esc(item?.note || '')}">
        <span>${esc(label)} <b class="${ok ? 'tool-ok' : 'tool-bad'}">${esc(state)}</b></span>
        <span class="set-note" style="margin:0">${esc(extra || item?.note || '')}</span>
      </div>`;
  };
  if (!t) {
    return setGroup(
      'Building Windows Apps',
      '<p class="set-note">Checking this machine…</p>',
    );
  }
  return [
    setGroup(
      `Building Windows Apps ${t.ready ? '— ready' : '— something is missing'}`,
      row('The window shell (.NET SDK)', t.dotnet, 'Builds the WPF window and the exe. Not needed to run one.') +
        row('The page engine (WebView2 runtime)', t.webview2, 'What draws the interface inside the window.') +
        row('The app template', t.template, t.template?.path || '') +
        row('The window checker', t.appCheck, 'Launches a built app, photographs its window, says whether it survived.') +
        row('Rust (optional)', t.rust, 'Only for the smaller Tauri shell — not needed for the C# one.') +
        `<div class="set-field wide"><span>&nbsp;</span>` +
        `<button type="button" class="btn btn-sm" data-check-toolchain>Check Again</button></div>` +
        `<p class="set-note">A new app is copied from <code>templates\\win-app</code>: a window, a <code>ui\\</code> ` +
        `folder holding the interface, and a <code>build.ps1</code> that publishes one folder you can copy to ` +
        `another PC and run. The interface inside is a web page, so the Designer mocks it and QC measures it with ` +
        `the visual-review tool; the window around it is checked with <code>skills\\app-check</code>.</p>`,
    ),
  ].join('');
}

async function loadToolchain(force = false) {
  try {
    state.toolchain = await api('GET', `/api/toolchain${force ? '?force=1' : ''}`);
  } catch (err) {
    state.toolchain = null;
    if (force) toast('Could not check', err.message);
  }
  if (state.settingsTab === 'windows' && state.setDraft) renderSettings({ scrollTop: 0 });
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

/** Models as the editor shows them.
 *
 * A local runtime owns the window, so its lines carry none: Synapse asks the
 * server what it has loaded at every boot, and that is the number the engine and
 * the watchdog both use. A remote provider has nobody to ask, so its window is
 * typed here — `id | name | context | output` — and it is the only number the
 * engine will have. */
function modelLines(models, withWindow = true) {
  return (models || [])
    .map((m) => {
      const bits = [m.id, m.name && m.name !== m.id ? m.name : ''];
      if (withWindow) bits.push(m.context || '', m.output || '');
      return bits.join(' | ').replace(/(\s*\|\s*)+$/, '');
    })
    .join('\n');
}

/** Lines back into models. A window the line does not mention is kept from the
 *  model that was already there: editing a name used to drop a context with it,
 *  silently, and for a local runtime nothing in the form would ever put it back. */
function parseModelLines(text, previous = []) {
  const had = new Map((previous || []).map((m) => [m.id, m]));
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = '', name = '', context = '', output = ''] = line.split('|').map((s) => s.trim());
      if (!id) return null;
      const old = had.get(id) || {};
      const model = { id, name: name || id };
      const ctx = Number.parseInt(context, 10) || Number(old.context) || 0;
      const out = Number.parseInt(output, 10) || Number(old.output) || 0;
      if (ctx > 0) model.context = ctx;
      if (out > 0) model.output = out;
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
      <label class="set-field" title="A local server runs on this machine. llama.cpp Server is one of those too: the same kind of server, which reports its window at /props. An OpenAI-compatible endpoint can be anything that speaks the same API, including a paid service.">
        <span>Type</span>
        <select data-prov="type">
          <option value="local"${p.type === 'local' || !p.type ? ' selected' : ''}>Local provider (LM Studio)</option>
          <option value="llamacpp"${p.type === 'llamacpp' ? ' selected' : ''}>Local provider (llama.cpp)</option>
          <option value="openai"${p.type && p.type !== 'local' && p.type !== 'llamacpp' ? ' selected' : ''}>OpenAI Compatible</option>
        </select>
        <small class="prov-hint">${
          p.type === 'llamacpp'
            ? 'Strata, llama-server and KoboldCpp all speak this one: the window comes from /props, and no key is needed on this machine.'
            : p.type === 'openai'
              ? 'Reached over the network. Its window is whatever you type in the model list — nobody can be asked.'
              : 'LM Studio and friends: the window is asked for at /api/v0/models.'
        }</small>
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
                 placeholder="${isLocalServer(p) ? 'Empty for local servers' : 'sk-…'}" autocomplete="off" />
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
        <textarea data-prov="models" rows="4" spellcheck="false">${esc(modelLines(p.models, !isLocalServer(p)))}</textarea>
        <div class="prov-tools">
          <button type="button" class="btn btn-secondary btn-sm" data-prov-fetch>Refresh List</button>
          <span class="prov-fetch-state${fetchNote ? (fetchNote.ok ? ' is-ok' : ' is-bad') : ''}">${esc(fetchNote?.text || '')}</span>
        </div>
        <small class="prov-hint">${
          isLocalServer(p)
            ? 'One model per line: <code>id | name</code>. The context window is read from the server at every start — that is the number the engine compacts on, so there is nothing to type here.'
            : 'One model per line: <code>id | name | context | output</code>. Only the id is required; nobody can be asked for the window, so this is the one the engine budgets from.'
        }</small>
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
        <span class="prov-type">${esc(providerBadge(p))}</span>
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
          <button type="button" data-prov-new="llamacpp">Local Provider (llama.cpp)</button>
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
  windows: settingsWindows,
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
    // Three kinds, two behaviours: a `llamacpp` server *is* a local server, it just
    // answers /props rather than LM Studio's /api/v0/models. Named for the dialect
    // so it fits every wrapper of it, not one product.
    name: type === 'local' ? 'Local Server' : type === 'llamacpp' ? 'Local Server' : 'OpenAI Compatible',
    format: 'openai',
    baseURL: type === 'llamacpp' ? 'http://localhost:8080/v1' : '',
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
  if (field === 'models') { p.models = parseModelLines(el.value, p.models); return; }
  if (field === 'apiKey') {
    p.apiKey = el.value;
    p.apiKeyRemoved = false;
    el.dataset.masked = '0';
    return;
  }
  if (field === 'type') {
    // Three choices, two behaviours: llama.cpp is a local server that answers
    // `/props` instead of LM Studio's list endpoint.
    p.type = el.value === 'llamacpp' ? 'llamacpp' : el.value === 'local' ? 'local' : 'openai';
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
  // Settings → Windows answers "what can this PC build", which is a machine probe
  // and not config: read it once when the window opens, and again on demand.
  loadToolchain();
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
    // The other corner: how fast this role's model is writing. Only while it is
    // writing — a rate with nothing being written is a lie.
    if (!card.querySelector('.role-rate')) {
      const el = document.createElement('span');
      el.className = 'role-rate';
      el.setAttribute('aria-hidden', 'true');
      card.append(el);
    }
  }
  setInterval(tickClocks, 1000);
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  // The paperclip opens the system picker; the picker's own change event is what
  // adds the files, so a cancelled dialog adds nothing.
  $('attachBtn').addEventListener('click', () => $('attachInput').click());
  $('attachInput').addEventListener('change', async (e) => {
    const picked = [...(e.target.files || [])];
    e.target.value = '';
    for (const file of picked) {
      if (file.size > 8 * 1024 * 1024) {
        toast('File Too Large', `${file.name} is ${fmtBytes(file.size)}; the limit is 8 MB.`);
        continue;
      }
      if (state.attachments.length >= 6) {
        toast('Too Many Files', 'Six attachments is the limit for one message.');
        break;
      }
      try {
        state.attachments.push(await readFileAsAttachment(file));
      } catch (err) {
        toast('Could Not Read That File', err.message);
      }
    }
    renderAttachments();
  });
  $('attachStrip').addEventListener('click', (e) => {
    const x = e.target.closest('[data-detach]');
    if (!x) return;
    state.attachments = state.attachments.filter((f) => f.id !== x.dataset.detach);
    hideAttachPreview();
    renderAttachments();
  });
  $('attachStrip').addEventListener('mouseover', (e) => {
    const chip = e.target.closest('.attach-chip[data-image]');
    if (chip) showAttachPreview(chip.dataset.attach);
  });
  $('attachStrip').addEventListener('mouseout', (e) => {
    const chip = e.target.closest('.attach-chip');
    if (chip && !chip.contains(e.relatedTarget)) hideAttachPreview();
  });
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
  // A real gesture, before the scroll it causes arrives.
  $('transcript').addEventListener('wheel', (e) => noteUserScrollIntent(-e.deltaY), { passive: true });
  $('transcript').addEventListener('touchmove', () => noteUserScrollIntent(-1), { passive: true });
  $('transcript').addEventListener('keydown', (e) => {
    if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) noteUserScrollIntent(-1);
    else if (['PageDown', 'ArrowDown', 'End'].includes(e.key)) noteUserScrollIntent(1);
  });
  $('transcript').addEventListener('scroll', () => {
    // The reader's own position, first and on every event: a stream is allowed to
    // follow a chat that is at the end, and must let go the moment it is not.
    noteChatScroll();
    if (navRaf) return;
    navRaf = requestAnimationFrame(() => { navRaf = 0; renderChatNav(); });
  }, { passive: true });
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

  // The two reference tables open from the rail's foot. They are rendered on
  // open rather than only on the 30-second poll, so what the operator sees is
  // what the server said a moment ago.
  $('toolsBtn')?.addEventListener('click', () => openRailModal('toolsModal', renderToolUsage));
  $('probeBtn')?.addEventListener('click', () => openRailModal('probeModal', renderProbe));
  for (const btn of document.querySelectorAll('[data-close-modal]')) {
    btn.addEventListener('click', () => closeRailModal(btn.dataset.closeModal));
  }
  for (const id of ['toolsModal', 'probeModal']) {
    $(id)?.addEventListener('click', (e) => { if (e.target === $(id)) closeRailModal(id); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['toolsModal', 'probeModal']) {
      if ($(id)?.hidden === false) { e.preventDefault(); closeRailModal(id); return; }
    }
  });

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

    const checkTools = e.target.closest('[data-check-toolchain]');
    if (checkTools) { e.preventDefault(); loadToolchain(true); return; }

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
    updatePlanOverflow();
    drawActivePath();
    renderChatNav();
  }));
  // The plan's own scroller: the fade has to go the moment the last row is in view.
  $('planBody')?.addEventListener('scroll', updatePlanOverflow, { passive: true });

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
  // The local-server row answers "is it on", which changes without any event, so
  // it is polled. Fifteen seconds is often enough to see a server come up while
  // the operator is looking at the rail, and rare enough to be free.
  setInterval(() => renderLlmStatus(), 15000);
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
  await restoreOpenSession();
  await checkSkills();
  await loadRuns();
  renderTranscript();
  connectStream();
  refreshPending();
  renderProbe();
}

/** Where the operator was when they last had this page open.
 *
 * Nothing used to be opened on load, and every project was collapsed except
 * General — so a reload in the middle of a run left an empty screen with the
 * work one click away. A session that has a question waiting, or a turn in
 * flight, is the one they left whatever the last page thought; otherwise it is
 * the session they last opened.
 */
const LAST_SESSION_KEY = 'synapse.lastSession';
function rememberSession(id) {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
  } catch { /* full or blocked storage must not break a turn */ }
}
async function restoreOpenSession() {
  if (state.sessionId) return;
  let target = null;
  try {
    const pending = await api('GET', '/api/pending');
    const ids = [...(pending.forms || []).map((f) => f.sessionId), ...(pending.active || [])];
    target = ids.find((id) => id && findSession(id)) || null;
  } catch { /* the pending list is a nicety here, not a requirement */ }
  if (!target) {
    let saved = null;
    try { saved = localStorage.getItem(LAST_SESSION_KEY); } catch { /* blocked storage */ }
    if (saved && findSession(saved)) target = saved;
  }
  if (!target) return;
  // The auto-collapse above put every project away; the one holding this session
  // has to be open or the selection is invisible.
  const project = projectOf(target);
  if (project) state.collapsed.delete(project.id);
  await openSession(target);
}

boot();

