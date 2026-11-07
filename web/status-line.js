// The bottom-left status block: the engine, the last event, the local model.
//
// Three lines that answer "is anything wrong?" without opening a log. Each says a fact
// and a time, and the time is the point: an engine that is ready and an event four
// minutes old is a different situation from both being current.
import { state } from './state.js';
import { esc, relTime, ago, versionTag, shortSpan } from './format.js';
import { $ } from './dom.js';
import { api, serverNow } from './api.js';
import { providerLabel } from './provider-list.js';
import { modelByRef, architectSelection, currentRun } from './run-view.js';
import { isBusy } from './projects.js';
import { isLocalServer } from './settings-data.js';
import { renderKeep } from './run-menu.js';

// ── status ──────────────────────────────────────────────────────
export async function refreshStatus() {
  try {
    state.status = await api('GET', '/api/status');
    state.power = state.status?.power || null;
    state.workspace = state.status?.engine?.workspace || '';
    // The page got an answer, so the server is running; the app overrides this the
    // moment it says otherwise, and a failed fetch below leaves it alone.
    state.server = { state: 'running', reason: '' };
  } catch (err) {
    state.status = { engine: { ready: false, kind: 'engine' }, bootError: err.message };
    state.power = null;
  }
  renderStatus();
  renderKeep();
}

export function renderStatus() {
  const engine = state.status?.engine || {};
  const ready = Boolean(engine.ready);
  const failed = Boolean(state.status?.bootError);
  // The app knows one thing the server cannot tell it: that it is not running.
  // That answer wins — a stopped server is not "starting", and saying so is the
  // whole point of the red dot.
  const server = state.server?.state;
  const down = server === 'stopped' || server === 'failed';

  $('engineDot').className = 'status-dot ' + (down || failed ? 'err' : ready ? 'ok' : 'warn');
  // `opencode v2.1.0`: the v is the version's own, not a word.
  $('engineState').textContent = down
    ? server
    : ready
      ? `${engine.kind} ${versionTag(engine.version)}`.trim()
      : failed ? 'failed' : 'starting';

  // The version this page is actually talking to. It is set from the server's
  // answer, not from anything the window read at launch, so a restart moves it
  // without closing the window.
  const version = String(state.status?.version || '').trim();
  const note = $('statusVersion');
  if (note) note.textContent = version ? `v${version}` : '';

  // There is no separate "Event stream" row any more: this dot is the stream's
  // state, and the age on its label is the evidence. A row that said "connected"
  // next to a clock that keeps resetting said the same thing twice.
  $('eventDot').className = 'status-dot ' + (state.streamLive ? 'ok' : 'idle');
  renderLastEventAge();
}

/** 10s, 2m, 3h: a unit that never makes you do arithmetic, rounded down. */

export function renderLastEventAge() {
  const label = $('lastEventLabel');
  if (!label) return;
  label.textContent = state.lastEventAt
    ? `Last event (${shortSpan(Date.now() - state.lastEventAt)})`
    : 'Last event';
}

/** Is this provider a server on this machine? True for `local` and for
 *  `llamacpp`, which is the same kind of thing speaking a slightly different
 *  dialect about itself — and for any address that points at this machine,
 *  whatever type the row was given. A custom runtime added as "openai" with a
 *  localhost URL answers here like any other; before this the type won and the
 *  sidebar said nothing was running while it served every turn (4 Nov).
 *  Mirrors providerType() in src/providers.js — the UI has no imports from the
 *  server, so the rule is written once here too. */

/** The badge beside this provider's models.
 *
 * There is one badge for every server on this machine, whichever dialect it speaks.
 * A `llamacpp` server is a local LLM exactly as an LM Studio one is — the difference
 * is which endpoint answers "what is your window", not what kind of thing it is —
 * so labelling it separately split the model picker into a second LOCAL-looking
 * section for no reason the operator cares about. */

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
export async function renderLlmStatus() {
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
    paint('idle', 'unknown', 'Cannot ask Synapse which local servers are answering right now. The Engine row says whether the engine is answering right now.');
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
