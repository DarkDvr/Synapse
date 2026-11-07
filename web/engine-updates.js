// The update chip, and the dialog behind it.
//
// Two feeds, one control: Synapse's own release (the public GitHub feed) and the
// engine's version (npm). Both are cached, both answer the chip without a network call
// when they can, and neither downloads anything until Update is pressed. This is the
// one place Synapse talks to the network for something that is not a model.
//
// One thing comes from app.js and is wired at boot: the model reload, because the
// engine carries the catalog and a new engine means a new list.
import { state } from './state.js';
import { esc, ago } from './format.js';
import { renderMarkdown } from './md.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { refreshRemote } from './remote-access.js';
import { modelByRef, roleLabel } from './run-view.js';
import { renderSettings } from './settings-window.js';
import { shortEvent } from './events.js';
import { renderLastEventAge, renderStatus, refreshStatus } from './status-line.js';

const missing = (name) => () => {
  throw new Error(`engine-updates.js: ${name} was not wired at boot`);
};
const wired = { loadModels: missing('loadModels') };

/** Hand this module the one thing that lives in app.js. Called once, at boot. */
export function engineUpdatesWiring(fns) {
  Object.assign(wired, fns);
}

// ── engine updates ──────────────────────────────────────────────
// The engine is a separate program that updates often, and the model catalog
// ships inside it — so "our model list is old" is nearly always "our engine is
// old". The offer is a chip beside Settings: noticeable, never in the way, and
// it says nothing at all when there is nothing to do.
export let updateChecking = false;

export async function refreshUpdates() {
  try { state.update = await api('GET', '/api/engine/update'); } catch { state.update = null; }
  try { state.synapseUpdate = await api('GET', '/api/synapse/update'); } catch { state.synapseUpdate = null; }
  renderUpdateChip();
}

export function renderUpdateChip() {
  const chip = $('updateChip');
  if (!chip) return;
  const engine = state.update;
  const synapse = state.synapseUpdate;
  const show = Boolean(engine?.newer || synapse?.newer) && !state.updateBusy;
  chip.hidden = !show;
  if (show) {
    const parts = [];
    if (synapse?.newer) parts.push(`Synapse ${synapse.current || ''} → ${synapse.latest}`);
    if (engine?.newer) parts.push(`engine ${engine.current || '?'} → ${engine.latest}`);
    chip.title = `Update available: ${parts.join('; ')}. Click to review.`;
  }
}

export function openUpdateDialog() {
  $('updateModal').hidden = false;
  state.updateLog = [];
  renderUpdateDialog();
  // Opening the dialog is the operator asking: both feeds may be checked now,
  // the GitHub release and npm. Boot checks only the release, cached.
  checkUpdates();
}

export function closeUpdateDialog() {
  // A click-away must not hide the one operation that restarts the engine, and
  // Escape must not either: an update in flight keeps the dialog.
  if (state.updateBusy) return;
  $('updateModal').hidden = true;
}

/** The sentence above the two update cards. Shared by the chip's popup and the
 *  Settings page so the two cannot describe the same state differently. */
export function updateSubText() {
  const e = state.update || {};
  const s = state.synapseUpdate || {};
  const busy = state.updateBusy;
  if (busy) {
    return busy === 'synapse'
      ? 'Updating Synapse. It will close, replace its program files and reopen. Your projects and settings are not touched.'
      : 'Updating the engine. It is stopped, replaced and started again — about a minute.';
  }
  return e.newer || s.newer
    ? 'The two update separately: Synapse is the harness, the engine carries the model catalog and the tools.'
    : 'Synapse and the engine are both up to date, or nothing could be checked.';
}

/** The two cards and the console. One builder for the popup and the Settings
 *  page: the operator should not have to learn two slightly different screens. */
export function updateBodyHtml() {
  const e = state.update || {};
  const s = state.synapseUpdate || {};
  const busy = state.updateBusy;

  const synVersion = s.newer
    ? `<b>${esc(s.current || '?')}</b> → <b>${esc(s.latest || '?')}</b>`
    : s.latest
      ? `<b>${esc(s.current || '?')}</b> — up to date`
      : `<b>${esc(s.current || '?')}</b>`;
  const synNote = s.error
    ? `<p class="upd-note is-warn">${esc(s.error)}</p>`
    : s.checkedAt
      ? `<p class="upd-note">Checked ${esc(ago(Date.parse(s.checkedAt)))}${s.url ? ` · <a href="${esc(s.url)}" target="_blank" rel="noreferrer">release page</a>` : ''}</p>`
      : '<p class="upd-note">Not checked yet.</p>';
  const synNotes = s.notes
    ? `<details class="upd-notes" open><summary>What is new</summary><div class="upd-md">${renderMarkdown(s.notes)}</div></details>`
    : '';
  const synCan = Boolean(s.newer && s.asset && !s.private && !busy && !updateChecking);

  const engVersion = e.newer
    ? `<b>opencode ${esc(e.current || '?')}</b> → <b>${esc(e.latest || '?')}</b>`
    : e.latest
      ? `<b>opencode ${esc(e.current || '?')}</b> — up to date`
      : `<b>opencode ${esc(e.current || '?')}</b>`;
  const engNote = e.onlineError
    ? `<p class="upd-note is-warn">npm could not be asked: ${esc(e.onlineError)}</p>`
    : !e.managedByNpm && !e.vendored
      ? '<p class="upd-note is-warn">This engine was not installed with npm, so Synapse will not replace it.</p>'
      : e.blocked
        ? `<p class="upd-note is-warn">${esc(e.blocked)}</p>`
        : '<p class="upd-note">The engine carries the model catalog, tools and API. npm publishes no release notes — the version number is all it tells us.</p>';
  const engCan = Boolean(e.newer && e.canUpdate && !busy && !updateChecking);

  return (
    '<div class="upd-list">' +
    `<section class="upd-card">` +
    `<div class="upd-card-head"><span class="upd-name">Synapse</span><span class="upd-vers">${synVersion}</span></div>` +
    synNote +
    synNotes +
    `<div class="upd-card-foot"><button class="btn btn-primary btn-sm" type="button" data-update="synapse" ${synCan ? '' : 'disabled'}>` +
    `${busy === 'synapse' ? 'Updating…' : s.newer && s.asset ? 'Update Synapse' : s.error ? 'Unavailable' : 'Up to Date'}</button></div>` +
    `</section>` +
    `<section class="upd-card">` +
    `<div class="upd-card-head"><span class="upd-name">Engine</span><span class="upd-vers">${engVersion}</span></div>` +
    engNote +
    `<div class="upd-card-foot"><button class="btn btn-primary btn-sm" type="button" data-update="engine" ${engCan ? '' : 'disabled'}>` +
    `${busy === 'engine' ? 'Updating…' : e.newer ? 'Update Engine' : 'Up to Date'}</button></div>` +
    `</section>` +
    '</div>' +
    '<div class="upd-console-wrap"><div class="upd-console-head">Update console</div>' +
    `<pre class="upd-console">${esc(state.updateLog.join('\n') || 'Nothing yet.')}</pre></div>`
  );
}

/** The chip's popup. The Settings page reuses updateBodyHtml and adds its own
 *  Check Again; only this surface has a footer. */
export function renderUpdateDialog() {
  const body = $('updateBody');
  if (!body) return;
  const sub = $('updateSub');
  if (sub) sub.textContent = updateSubText();
  body.innerHTML = updateBodyHtml();

  const check = $('checkUpdate');
  if (check) {
    check.disabled = Boolean(state.updateBusy) || updateChecking;
    check.textContent = updateChecking ? 'Checking…' : 'Check Again';
  }
  const close = $('closeUpdate');
  const closeFoot = $('closeUpdateFoot');
  for (const el of [close, closeFoot]) if (el) el.disabled = Boolean(state.updateBusy);
  renderUpdateConsole();
}

/** Repaint every surface that shows update state: the popup when it is open,
 *  and the Settings Updates page when that is the visible tab. */
export function renderUpdateViews() {
  if (!$('updateModal').hidden) renderUpdateDialog();
  if (!$('settingsModal').hidden && state.settingsTab === 'updates') {
    renderSettings({ scrollTop: $('settingsBody')?.scrollTop || 0 });
  }
}

export function renderUpdateConsole() {
  // The popup and the Settings page can both be in the DOM, and only one is
  // visible at a time; writing all of them keeps whichever is open current.
  const text = state.updateLog.join('\n') || 'Nothing yet.';
  for (const el of document.querySelectorAll('.upd-console')) {
    el.textContent = text;
    el.scrollTop = el.scrollHeight;
  }
}

export function pushUpdateLog(line) {
  if (!line) return;
  state.updateLog.push(String(line));
  if (state.updateLog.length > 400) state.updateLog.splice(0, state.updateLog.length - 400);
  renderUpdateConsole();
}

export async function checkUpdates() {
  if (updateChecking || state.updateBusy) return;
  updateChecking = true;
  renderUpdateViews();
  const [eng, syn] = await Promise.allSettled([
    api('POST', '/api/engine/update/check'),
    api('POST', '/api/synapse/update/check'),
  ]);
  if (eng.status === 'fulfilled') state.update = eng.value;
  if (syn.status === 'fulfilled') state.synapseUpdate = syn.value;
  updateChecking = false;
  renderUpdateChip();
  renderUpdateViews();
  if (eng.status === 'rejected' && syn.status === 'rejected') {
    toast('Could Not Check for Updates', eng.reason?.message || syn.reason?.message || 'Both feeds refused.');
  }
}

export async function applyEngineUpdate() {
  const u = state.update || {};
  if (state.updateBusy || !u.newer) return;
  state.updateBusy = 'engine';
  state.updateLog = [];
  renderUpdateChip();
  renderUpdateViews();
  pushUpdateLog(`Updating the engine ${u.current || ''} → ${u.latest || ''}…`);
  let r;
  try {
    r = await api('POST', '/api/engine/update');
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  state.updateBusy = null;
  pushUpdateLog(r.ok ? `Engine updated to ${r.to || 'the new version'}.` : `Update failed: ${r.error || 'unknown error'}`);
  if (r.ok) {
    toast('Engine Updated', `${r.from || 'previous'} → ${r.to || 'new'}. The model list has been re-read.`);
  } else {
    toast('Update Failed', r.error || 'The engine was not updated.');
  }
  await refreshStatus();
  await refreshRemote();
  await refreshUpdates();
  await wired.loadModels();
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
  renderUpdateViews();
}

export async function applySynapseUpdate() {
  const s = state.synapseUpdate || {};
  if (state.updateBusy || !s.newer) return;
  state.updateBusy = 'synapse';
  state.updateLog = [];
  renderUpdateChip();
  renderUpdateViews();
  pushUpdateLog(`Updating Synapse ${s.current || ''} → ${s.latest || ''}…`);
  let r;
  try {
    r = await api('POST', '/api/synapse/update');
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  if (r.ok && r.closing) {
    pushUpdateLog(`Synapse ${r.version || s.latest} is ready. Closing to replace its files; it will reopen by itself.`);
    return;
  }
  state.updateBusy = null;
  pushUpdateLog(`Update failed: ${r.error || 'unknown error'}`);
  renderUpdateChip();
  renderUpdateViews();
  toast('Update Failed', r.error || 'Synapse could not be updated.');
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
export function setEventChip(type, sessionId) {
  const clear = !type;
  if (!clear && !sessionId) return;
  const el = $('lastEvent');
  if (el) el.textContent = clear ? 'idle' : shortEvent(type);
  state.lastEventAt = clear ? 0 : Date.now();
  state.lastEventSessionId = clear ? null : sessionId;
  renderLastEventAge();
}

/** The engine events that are a *model doing something*. Everything else is news
 *  about the rail — a session being deleted, renamed, or its instructions being
 *  rewritten — and used to leave this clock reading "deleted" for hours after a
 *  project was finished, gently counting up at a session that no longer existed. */
export const WORK_EVENT = /^(step|text|reasoning|tool|usage|idle|execution|compaction|inbox|instructions|retry|permission|question)\b/;

/** How long the last event stays on the clock after the work stops, so the final
 *  one can be read before the row goes quiet. */
export const CHIP_QUIET_MS = 30000;

/**
 * Nothing is working: stop counting.
 *
 * An age that climbs for ever is worse than no age — after a while it says
 * "something is still going on" about a project that finished this morning, and
 * there is no way to tell it apart from a run that is genuinely stuck. So when no
 * session is active and no run is live, the row returns to idle instead of
 * timing the silence.
 */
export function settleEventChip(active) {
  if (!state.lastEventAt) return;
  if ((active && active.size) || state.runs.size) return;
  if (Date.now() - state.lastEventAt < CHIP_QUIET_MS) return;
  setEventChip(null, null);
}
