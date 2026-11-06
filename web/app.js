// Synapse UI. Talks only to the Synapse API; knows nothing about the engine.
//
// LIVE: engine/stream status, projects and their chats (open, switch model,
// delete), the conversation with streamed tool calls, tool permissions,
// per-role model + thinking-effort choices, the Single↔Multi switch, and the
// settings form over config/synapse.config.json.
//
// The role cards are shown in Multi mode but their per-role activity is not
// wired yet — the orchestration layer will drive them (stage 3+).

import { renderMarkdown } from './md.js';
import { EV, turnEnded, shortEvent } from './events.js';
import { state } from './state.js';
import { esc, relTime, hhmm, hhmmss, toolTarget, versionTag, shortSpan, fmtBytes, samePath, ago } from './format.js';
import { loadPlan, renderPlan, updatePlanOverflow, planPaneWiring } from './plan-pane.js';
import {
  loadProjects,
  renderTree,
  openProjectChat,
  openProjectFolder,
  findSession,
  sessionWorking,
  isBusy,
  isStalled,
  newestSession,
  projectsWiring,
} from './projects.js';
import { readPath, writePath, maskSecret, slugify, modelLines, parseModelLines, isLocalServer, providerBadge } from './settings-data.js';
import { providerLabel, providerOrderOf, hiddenProviderIds } from './provider-list.js';
import {
  settingsProviders,
  providersWiring,
  providerAt,
  moveProvider,
  addProvider,
  removeProvider,
  selectProvider,
  refreshProviderModels,
} from './providers.js';
import {
  alarmsHere,
  renderAlarm,
  noteLease,
  leasesHere,
  renderLease,
  addChatError,
  chatErrorsHere,
  renderChatError,
  chatNotesWiring,
} from './chat-notes.js';
import {
  noteDelta,
  resetRate,
  noteArchitectUsage,
  lastPromptOf,
  noteWorkerUsage,
  paintRates,
  rateViewWiring,
} from './rate-view.js';
import {
  noteChatScroll,
  noteUserScrollIntent,
  appendStream,
  endStream,
  chatScroller,
  chatAtBottom,
  scrollChatToBottom,
  renderChatNav,
  animateScroll,
  jumpMessage,
  captureChatSlack,
  restoreChatSlack,
  stopFollowingChat,
  chatScrollWiring,
} from './chat-scroll.js';
import {
  ROLES,
  modelByRef,
  topEfforts,
  selectionFor,
  architectSelection,
  fmtTokens,
  projectOf,
  currentProject,
  dirKey,
  runIn,
  currentRun,
  roleLabel,
  groupTurns,
  currentForm,
} from './run-view.js';
import {
  forgetConversation,
  renderTrace,
  tracesFor,
  traceOf,
  traceFor,
  noteCompaction,
  noteLoop,
  traceForSession,
  noteCompactionEvent,
  traceSig,
  renderSessionStream,
  traceKeyOf,
  steerNotes,
  tracesWiring,
} from './traces.js';
import {
  renderTranscript,
  toggleTool,
  attachmentImage,
  shortName,
  transcriptWiring,
} from './transcript.js';
import { toast } from './toast.js';
import {
  renderComposer,
  send,
  reuseMessage,
  addAttachmentFiles,
  onComposerPaste,
  renderAttachments,
  showAttachPreview,
  hideAttachPreview,
  showChatImagePreview,
  interrupt,
  interruptSession,
  autoGrow,
  composerWiring,
} from './composer.js';
import { fitChatHeight, settleChatBox, watchChatGeometry, wideLayout } from './chat-geometry.js';
import {
  renderAskPanel,
  askHost,
  mountAskPost,
  refreshAskPanel,
  replyForm,
  moveAskPage,
  askPanelWiring,
} from './ask-panel.js';
import {
  setupModelPickers,
  syncPickerInput,
  closeModelMenu,
  pickers,
  menuRole,
  clearModelIssues,
  refreshModels,
  modelPickerWiring,
} from './model-picker.js';
import {
  renderKeep,
  closeRunMenu,
  toggleRunMenu,
  togglePower,
  setAutomationSwitch,
} from './run-menu.js';
import { renderMode, sessionMode, chatBody, answerWaitSec, SINGLE_PERMISSIONS } from './mode.js';
import { compactPostOf, renderCompactChip, compactClick, compactWiring } from './compact.js';
import { renderEffort, fillRoleModels, editRoleSettings, setRoleModel, cycleEffort, roleModelsWiring } from './role-models.js';
import {
  openProjectMenu,
  closeProjectMenu,
  projectMenuAction,
  addProject,
  createChat,
  menuProjectId,
  projectMenuWiring,
} from './project-menu.js';
import {
  initRoleCards,
  renderRoleActivity,
  loadRuns,
  syncRuns,
  loadDesk,
  handleRunEvent,
  drawActivePath,
  liveRunsWiring,
} from './live-runs.js';
import { refreshPending, schedulePendingRefresh, schedulePermissionRender, pendingWiring } from './pending.js';
import { closeRailModal, renderToolUsage, renderProbe } from './tool-panels.js';
import { setIcon } from './icons.js';
import { api, serverNow } from './api.js';
import { $, debounce } from './dom.js';
import { initShellChannel, openConsole, closeConsole, consoleWiring } from './console.js';
import { newStream, pushStream, slideTarget, nextOffset, takePending, freezeStream, STREAM_BUFFER } from './stream-view.js';
import { addSample, rateOf } from './rate.js';
import { doneSoundName, workWillContinue } from './notify.js';
import { askHeadNote, answerTimeline, permissionNote } from './ask-note.js';
import { AUTOMATION_DEFAULTS, AUTOMATION_ROWS, anyAutomationOn } from './automation.js';
import { reconcileRuns } from './runs-sync.js';
import { SETTINGS_TABS, PANES, panesWiring } from './settings-panes.js';
import { applyChatText, applyLanguage } from './ui-prefs.js';


// ── helpers ─────────────────────────────────────────────────────
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

// ── the finished-work chime ─────────────────────────────────────
// The Architect has said its piece and nothing else is running: one quiet sound, so
// the operator can look away while a long turn runs. The files are in web/sounds and
// are ours (scripts/make-sounds.mjs); the names, and the rule for when a *gap* is not a
// finish, live in ./notify.js so they can be tested without a browser.
const doneAudio = new Map();
/** Play the chosen sound once. Any failure is silence: a missing audio device or a
 *  browser that wants a gesture first must never surface as an error in the chat. */
function playDoneSound(value = state.config?.notify?.doneSound) {
  const name = doneSoundName(String(value ?? 'off'));
  if (String(value ?? 'off') === 'off' || name === 'off') return;
  try {
    let el = doneAudio.get(name);
    if (!el) {
      el = new Audio(`/sounds/${name}.wav`);
      el.preload = 'auto';
      doneAudio.set(name, el);
    }
    // Rewind: two turns can end a few seconds apart, and a rewind before play is what
    // makes the second one audible instead of a no-op.
    el.currentTime = 0;
    const played = el.play();
    if (played?.catch) played.catch(() => {});
  } catch {
    /* silence */
  }
}

// One chime per finished piece of work, and none for a stop or a failure: the sound
// means "the Architect is done", so it must not say that when the work was cut short.
let workWasLive = false;
let workEndQuiet = false;

/**
 * Called whenever "is this chat working?" could have changed. The answer comes from
 * `sessionWorking` — the same predicate as the rail's breathing dot — so the sound is
 * exactly the moment the work the operator was waiting on stops, and not one of the
 * idle gaps inside a Multi run (a run in flight keeps it live).
 *
 * A gap between two pieces of work is not a finish: with Keep running on, the Architect
 * reads a worker's report and starts the next task, and that turn takes seconds. In
 * that gap nothing is working, but the job is not over — `workWillContinue` says so, and
 * the page stays armed, so the chime comes when the *last* task is really done (or as
 * soon as the plan catches up and says it is).
 */
function noteWorking() {
  const live = state.view === 'session' && Boolean(state.sessionId) && sessionWorking(state.sessionId);
  if (live) {
    // A *new* piece of work is what clears the last verdict. Clearing it on every
    // evaluation would undo it here: after a failed turn the project lock is still
    // held for a moment, so the page reads "still working" once more and would then
    // chime when the lock goes — for a turn that failed.
    if (!workWasLive) workEndQuiet = false;
    workWasLive = true;
    // Work has resumed, so the Architect is not finished after all: a shutdown
    // waiting on silence is waiting on nothing. (The first evaluation, before any
    // work has run, also lands here — and disarms nothing that was not armed.)
    cancelShutdown();
    return;
  }
  if (!workWasLive) return;
  if (workWillContinue({ mode: state.mode, auto: state.automation?.keepBuilding === true, tasks: state.planState?.plan?.tasks || [] })) return;
  workWasLive = false;
  if (workEndQuiet) {
    workEndQuiet = false;
    return;
  }
  playDoneSound();
}

// ── the timed shutdown ──────────────────────────────────────────────────
// Auto-Shutdown is armed by the *server* (src/auto-shutdown.js): it decides when
// nothing is left to do, waits the idle minutes from Settings → Automation, and
// then starts the same 20-second countdown with a Cancel button. Both clocks live
// there because a hidden window's timers are throttled by the browser, and Synapse
// in the tray is exactly when this feature is wanted. The page only draws the
// countdown the server sends, and asks it to cancel.
let shutdownWarned = false;

/** Stop waiting, in the server and on screen. Quiet when work resumed, spoken when
 *  the operator cancelled. */
function cancelShutdown({ quiet = false } = {}) {
  const wasShown = !$('shutdownModal').hidden;
  $('shutdownModal').hidden = true;
  shutdownWarned = false;
  // Nothing armed and nothing on screen: this is the common case (it runs whenever
  // work starts), and posting a cancel for it would be a request per stream event.
  if (!wasShown) return;
  // The server may have nothing armed, and it answers that honestly, so a failure
  // here is not worth a toast.
  api('POST', '/api/power-off/cancel').catch(() => {});
  if (wasShown && !quiet) toast('Shutdown Cancelled', 'The PC stays on.');
}

/** The server's countdown, painted. `seconds` comes from the event, so the number on
 *  screen and the number in the server cannot drift. */
function showShutdownWarning(seconds) {
  const modal = $('shutdownModal');
  if (!modal) return;
  $('shutdownCount').textContent = String(Math.max(0, Number(seconds) || 0));
  if (!shutdownWarned) {
    shutdownWarned = true;
    $('shutdownLead').textContent =
      'The Architect finished and the timer you set ran out. Nothing is running, so the PC will go off.';
    const cancel = $('cancelShutdown');
    if (cancel) { cancel.disabled = false; cancel.textContent = 'Cancel'; }
    modal.hidden = false;
    cancel?.focus();
  }
}

/** The last second has passed: the machine is going. No button can stop it now. */
function noteShutdownDone() {
  $('shutdownCount').textContent = '0';
  $('shutdownLead').textContent = 'Turning the PC off now.';
  const cancel = $('cancelShutdown');
  if (cancel) { cancel.disabled = true; cancel.textContent = 'Shutting Down'; }
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

/**
 * A tool tried to change a prohibited path. This is the chat's red line: the
 * worker that asked may be a hidden session, so the alarm is carried on the
 * decision broadcast and shown in the project's own chat (4 Nov).
 */
function openProhibition(entry) {
  if (!entry) return;
  const run = entry.sessionId ? [...state.runs.values()].find((r) => r.workerId === entry.sessionId) : null;
  const paths = (Array.isArray(entry.resolved) && entry.resolved.length ? entry.resolved : entry.resources || []).map(String);
  state.alarms.push({
    at: Number(entry.at) || Date.now(),
    sessionId: entry.sessionId || null,
    dir: run?.dir || entry.directory || null,
    prohibited: true,
    action: String(entry.action || 'change'),
    paths,
    note: entry.role ? `by ${entry.role}${entry.task ? ` (${entry.task})` : ''}` : '',
  });
  if (state.alarms.length > 20) state.alarms.splice(0, state.alarms.length - 20);
  renderTranscript();
}

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
    // A dialog may gate its own confirm (the deliverables in `bin\` have to be
    // ticked first), so the button is re-armed on every open instead of inheriting
    // the state the last dialog left it in.
    $('dialogOk').disabled = false;
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

// ── remote access (LAN) ─────────────────────────────────────────
// The switch is the whole feature from here: GET says whether the listener is on
// the LAN, POST moves it. The link is only handed to the host itself.
async function refreshRemote() {
  try {
    state.remote = await api('GET', '/api/remote');
    renderRemote();
  } catch { /* the status row keeps its last state */ }
}

function renderRemote() {
  const info = state.remote || {};
  const on = Boolean(info.enabled);
  const toggle = $('remoteToggle');
  if (!toggle) return;
  toggle.setAttribute('aria-checked', String(on));
  toggle.title = on
    ? 'On — other devices on this LAN can open Synapse; click to stop sharing'
    : 'Off — this PC only; click to allow other devices on this LAN';
  const dot = $('remoteDot');
  if (dot) dot.className = 'status-dot ' + (on ? 'ok' : 'idle');
  const url = $('remoteUrl');
  if (url) {
    // The machine's name is what the operator reads out. The bare address used to
    // sit under it as "or http://192.168.1.38:8700/" - a second line with a
    // number in it that nobody reads out and that goes stale when DHCP moves the
    // PC. The name is the address; the number was noise (4 Nov).
    const named = String(info.namedUrl || '').trim();
    const address = String(info.url || '').trim();
    url.textContent = on ? (named ? `${named}/` : address ? `${address}/` : 'no LAN address') : '';
    url.title = named && address ? `This PC is ${info.host || 'named'}` : '';
  }
  const box = $('remoteInfo');
  if (box) box.hidden = !on;
  const token = $('remoteToken');
  if (token) token.hidden = !on || !info.token;
  // The clients line lives inside the box: off hides it with the address, on
  // shows it with the number it has right now.
  renderClients();
}

// Who is on the LAN. The address is what the other PC opens; the count sits
// under it in one line, because the rail has no room for a second row and a view
// on this PC is not a client of the address it already has. The names are the
// hover: a rail line that lists machines wraps or ellipses, and the operator
// asked for the count there and the list in the tooltip (4 Nov). When the network
// has not named a machine yet, its address is shown — that is more use than an
// absent name, and the lookup keeps trying (presence.js).
function renderClients() {
  const el = $('remoteClients');
  if (!el) return;
  const names = [...new Set((state.views || []).filter((v) => !v.local).map((v) => v.name).filter(Boolean))];
  el.textContent = names.length ? `clients: ${names.length}` : 'clients: 0';
  el.title = names.length ? `Connected clients: ${names.join(', ')}` : 'No other device is connected.';
}

// The page was cut off. Everything behind the panel is stale, so it is covered
// and made inert, and only Close ends it: by closing the tab, or by replacing
// this document where the browser refuses window.close() for a tab the operator
// opened. There is deliberately no Escape and no backdrop click.
let disconnectTimer = null;
function showDisconnected(delay = 4000) {
  if (disconnectTimer) return;
  disconnectTimer = setTimeout(() => {
    disconnectTimer = null;
    const overlay = $('disconnect');
    if (!overlay || !overlay.hidden) return;
    overlay.hidden = false;
    document.querySelector('.app-shell')?.setAttribute('inert', '');
    document.body.classList.add('is-disconnected');
    $('disconnectClose')?.focus();
  }, delay);
}

function clearDisconnected() {
  if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
  const overlay = $('disconnect');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.querySelector('.app-shell')?.removeAttribute('inert');
  document.body.classList.remove('is-disconnected');
}

async function copyRemoteToken() {
  const value = state.remote?.token;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast('Token Copied', 'Paste it when Synapse asks for the token on the other PC.');
  } catch {
    toast('Could Not Copy', 'The clipboard was refused; the token is in data\\remote-token on this PC.');
  }
}

async function toggleRemote() {
  const next = !state.remote?.enabled;
  const toggle = $('remoteToggle');
  if (toggle) toggle.disabled = true;
  try {
    state.remote = await api('POST', '/api/remote', { enabled: next });
    renderRemote();
    toast(
      next ? 'Remote Access On' : 'Remote Access Off',
      next
        ? 'Open the address on the other PC, then paste the TOKEN when it asks.'
        : 'Only this PC can open Synapse again.',
    );
    // The listener moves just after the response; read the settled state so the
    // address comes from the interface the switch is actually serving.
    setTimeout(refreshRemote, 900);
  } catch (err) {
    toast('Remote Access Failed', err.message);
    await refreshRemote();
  } finally {
    if (toggle) toggle.disabled = false;
  }
}

/**
 * The screen lease badge: who has the operator's mouse, keyboard and focus.
 *
 * Shown from the server's answer, not from an event, so a page opened mid-lease
 * or a stream that dropped still tells the truth. Take Back is the one control:
 * the work keeps running, it just cannot take the screen again without asking.
 */
function renderDesk() {
  const badge = $('deskBadge');
  if (!badge) return;
  const desk = state.desk;
  if (!desk) {
    badge.hidden = true;
    return;
  }
  const who = [desk.role ? roleLabel(desk.role) : '', desk.task || ''].filter(Boolean).join(' · ');
  const project = String(desk.dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
  $('deskBadgeTitle').textContent = 'Screen in use';
  $('deskBadgeWho').textContent = `${who || 'A worker'} may use your mouse and keyboard${project ? ` (${project})` : ''}.`;
  badge.hidden = false;
}

async function takeBackScreen() {
  try {
    await api('POST', '/api/desk/release', { why: 'the operator took it back' });
  } catch (err) {
    toast('Could Not Take the Screen Back', err.message);
    return;
  }
  state.desk = null;
  renderDesk();
  toast('Screen Taken Back', 'The AI cannot take your mouse or keyboard again without asking.');
}

function renderStatus() {
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

function renderLastEventAge() {
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
  // The worker's lease clock: a plain text update, no rebuild.
  for (const el of document.querySelectorAll('[data-lease-until]')) {
    const until = Number(el.dataset.leaseUntil) || 0;
    const text = hhmmss(Math.max(0, until - now));
    if (el.textContent !== text) el.textContent = text;
  }
  // The plan's per-step stopwatches, before the early return below: they are
  // driven by the harness's run records (data-ms) plus this run's start, so they
  // do not depend on the card clocks existing yet.
  for (const el of document.querySelectorAll('.plan-spent')) {
    // A settled step has no stopwatch: "not run" is the fact, and ticking it back
    // to 00:00:00 (and re-hiding it) undid the sentence a second after it appeared.
    if (el.dataset.settled) continue;
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

async function refreshUpdates() {
  try { state.update = await api('GET', '/api/engine/update'); } catch { state.update = null; }
  try { state.synapseUpdate = await api('GET', '/api/synapse/update'); } catch { state.synapseUpdate = null; }
  renderUpdateChip();
}

function renderUpdateChip() {
  const chip = $('updateChip');
  if (!chip) return;
  const engine = state.update;
  const synapse = state.synapseUpdate;
  const show = Boolean(engine?.newer || synapse?.newer) && !state.updateBusy;
  chip.hidden = !show;
  if (show) {
    const parts = [];
    if (synapse?.newer) parts.push(`Synapse ${synapse.current || ''} → ${synapse.latest}`);
    if (engine?.newer) parts.push(`runtime ${engine.current || '?'} → ${engine.latest}`);
    chip.title = `Update available: ${parts.join('; ')}. Click to review.`;
  }
}

function openUpdateDialog() {
  $('updateModal').hidden = false;
  state.updateLog = [];
  renderUpdateDialog();
  // Opening the dialog is the operator asking: both feeds may be checked now,
  // the GitHub release and npm. Boot checks only the release, cached.
  checkUpdates();
}

function closeUpdateDialog() {
  // A click-away must not hide the one operation that restarts the engine, and
  // Escape must not either: an update in flight keeps the dialog.
  if (state.updateBusy) return;
  $('updateModal').hidden = true;
}

/** The sentence above the two update cards. Shared by the chip's popup and the
 *  Settings page so the two cannot describe the same state differently. */
function updateSubText() {
  const e = state.update || {};
  const s = state.synapseUpdate || {};
  const busy = state.updateBusy;
  if (busy) {
    return busy === 'synapse'
      ? 'Updating Synapse. It will close, replace its program files and reopen. Your projects and settings are not touched.'
      : 'Updating the runtime. It is stopped, replaced and started again — about a minute.';
  }
  return e.newer || s.newer
    ? 'The two update separately: Synapse is the harness, the runtime is the engine and its model catalog.'
    : 'Synapse and the runtime are both up to date, or nothing could be checked.';
}

/** The two cards and the console. One builder for the popup and the Settings
 *  page: the operator should not have to learn two slightly different screens. */
function updateBodyHtml() {
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
      ? '<p class="upd-note is-warn">This runtime was not installed with npm, so Synapse will not replace it.</p>'
      : e.blocked
        ? `<p class="upd-note is-warn">${esc(e.blocked)}</p>`
        : '<p class="upd-note">The runtime carries the model catalog, tools and API. npm publishes no release notes — the version number is all it tells us.</p>';
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
    `<div class="upd-card-head"><span class="upd-name">Runtime</span><span class="upd-vers">${engVersion}</span></div>` +
    engNote +
    `<div class="upd-card-foot"><button class="btn btn-primary btn-sm" type="button" data-update="engine" ${engCan ? '' : 'disabled'}>` +
    `${busy === 'engine' ? 'Updating…' : e.newer ? 'Update Runtime' : 'Up to Date'}</button></div>` +
    `</section>` +
    '</div>' +
    '<div class="upd-console-wrap"><div class="upd-console-head">Update console</div>' +
    `<pre class="upd-console">${esc(state.updateLog.join('\n') || 'Nothing yet.')}</pre></div>`
  );
}

/** The chip's popup. The Settings page reuses updateBodyHtml and adds its own
 *  Check Again; only this surface has a footer. */
function renderUpdateDialog() {
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
function renderUpdateViews() {
  if (!$('updateModal').hidden) renderUpdateDialog();
  if (!$('settingsModal').hidden && state.settingsTab === 'updates') {
    renderSettings({ scrollTop: $('settingsBody')?.scrollTop || 0 });
  }
}

function renderUpdateConsole() {
  // The popup and the Settings page can both be in the DOM, and only one is
  // visible at a time; writing all of them keeps whichever is open current.
  const text = state.updateLog.join('\n') || 'Nothing yet.';
  for (const el of document.querySelectorAll('.upd-console')) {
    el.textContent = text;
    el.scrollTop = el.scrollHeight;
  }
}

function pushUpdateLog(line) {
  if (!line) return;
  state.updateLog.push(String(line));
  if (state.updateLog.length > 400) state.updateLog.splice(0, state.updateLog.length - 400);
  renderUpdateConsole();
}

async function checkUpdates() {
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

async function applyEngineUpdate() {
  const u = state.update || {};
  if (state.updateBusy || !u.newer) return;
  state.updateBusy = 'engine';
  state.updateLog = [];
  renderUpdateChip();
  renderUpdateViews();
  pushUpdateLog(`Updating the runtime ${u.current || ''} → ${u.latest || ''}…`);
  let r;
  try {
    r = await api('POST', '/api/engine/update');
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  state.updateBusy = null;
  pushUpdateLog(r.ok ? `Runtime updated to ${r.to || 'the new version'}.` : `Update failed: ${r.error || 'unknown error'}`);
  if (r.ok) {
    toast('Runtime Updated', `${r.from || 'previous'} → ${r.to || 'new'}. The model list has been re-read.`);
  } else {
    toast('Update Failed', r.error || 'The runtime was not updated.');
  }
  await refreshStatus();
  await refreshRemote();
  await refreshUpdates();
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
  renderUpdateViews();
}

async function applySynapseUpdate() {
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
function setEventChip(type, sessionId) {
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
// ── role cards: the Architect is always there ───────────────────
// The cards sit in a wrapper whose max-height animates. The Architect card is
// visible in both modes — you need its model and thinking-effort controls even
// in Single — and Multi reveals the workers around it. Height is measured, not
// guessed, so the cards are never cut off mid-card.
let revealTimer = 0;
let workersPendingOff = false;
// While a card transition is in flight, re-measures wait (see applyRoleCardsLayout).
// The chat needs nothing from this: its height follows the cards through the
// ResizeObserver in watchChatGeometry.
let revealUntil = 0;
// The plan's fade needs asking again once a mode switch has settled. This is not a
// chat fit: the chat follows the cards every frame (see watchChatGeometry).
let planFadeTimer = 0;


function topologyTarget() {
  const wrap = $('topologyWrap');
  const topo = $('topology');
  return wrap && topo ? { wrap, topo } : null;
}

/**
 * How much vertical room the role-card wrapper may take. In the wide layout the
 * stage has a definite height (viewport minus the frame); below the breakpoint it
 * is content-sized and the page scrolls. There, using the stage's own height would
 * collapse the reveal to the Architect alone, so the breakpoint itself is the test
 * — `getComputedStyle().height` reports the used height, never `auto`. The chat
 * visibly slides down as the workers reveal.
 */
function stageBudget(stage) {
  const composerH = $('composer')?.getBoundingClientRect().height || 58;
  const basis = wideLayout() && stage ? stage.getBoundingClientRect().height : window.innerHeight - 40;
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
  clearTimeout(planFadeTimer);
  workersPendingOff = false;
  wrap.classList.add('is-open');
  // The chat's height is no longer fitted here: the wrapper is observed (see
  // watchChatGeometry), so every frame of this animation fits it from the height
  // the cards actually have. Only the plan's fade needs asking again once
  // everything has settled.
  planFadeTimer = setTimeout(() => { updatePlanOverflow(); }, 340);

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

// Which mode the composer is set to. It is a choice about the *next message*,
// not engine state: the toggle used to PATCH the session's ruleset on every
// click, so a click and a send could disagree and a busy check had to guard it.
// Now a click only changes what the send will say, and `sendMessage` applies the
// mode once, before the prompt.
function applyMode(mode) {
  if (mode !== 'single' && mode !== 'multi') return;
  if (state.mode === mode) return;
  // The reader's place, settled once before anything moves: a chat that was a
  // line short of the end is put at the end here, where it is a small nudge,
  // instead of being held a line short through the switch.
  captureChatSlack();
  restoreChatSlack();
  state.mode = mode;
  renderMode();
  renderPlan();
  setView();
}

function switchMode() {
  if (state.view !== 'session' || !state.sessionId) return;
  // Disabled while a run is live (renderMode); the click is a no-op if it slips
  // through, because the pending choice cannot apply to a turn already running.
  if (state.busyInfo?.busy) return;
  applyMode(state.mode === 'single' ? 'multi' : 'single');
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
  // `innerHeight` is the page's viewport, which starts under the shell's title bar.
  // The bar used to be part of this page and had to be subtracted here; it is not,
  // so the only chrome left to account for is a classic scrollbar.
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
  state.automation = { ...AUTOMATION_DEFAULTS, ...(findSession(id)?.automation || {}) };
  // Arriving mid-run is not "it just finished": arm the chime from where the chat
  // actually is, or switching to a busy chat and back would chirp for old work.
  workWasLive = sessionWorking(id);
  workEndQuiet = false;
  renderMode();
  renderKeep();
  $('sidebar').classList.remove('open');
  setView();
  renderTree();
  renderCompactChip();
  await loadMessages();
  // A session is opened to read where it got to, not where it started: put the
  // transcript at its end once, without touching the page (the role cards above it
  // are where the operator's eye goes next anyway).
  const el = chatScroller();
  if (el) el.scrollTop = el.scrollHeight;
  // The place to keep is the end of the conversation just opened.
  captureChatSlack();
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
  state.automation = { ...AUTOMATION_DEFAULTS };
  state.mode = 'single';
  renderMode();
  setView();
  renderTree();
  renderTranscript();
  renderPlan();
}

// ── messages ────────────────────────────────────────────────────
async function loadMessages() {
  // The chat this request is for. It can be replaced while the request is in
  // flight — a compact deletes the old chat as the new one opens — and a late
  // answer must not land in the chat that is open now. The poll did exactly
  // that: its 404 for the chat a compact had just deleted closed the new one,
  // leaving the landing page a second after a successful compact.
  const id = state.sessionId;
  if (!id) return;
  try {
    const loaded = (await api('GET', `/api/sessions/${encodeURIComponent(id)}/messages`)).messages;
    if (state.sessionId !== id) return;
    // A steer this page painted the moment it was sent is not in the engine's
    // transcript until the model has read it. Dropping it here made the operator's
    // own sentence vanish for minutes - the "no confirmation" they reported
    // (4 Nov). One that is still wanted is kept beside the loaded transcript until
    // the engine echoes the same text, or for ten minutes.
    const pending = (state.messages || []).filter(
      (m) => String(m?.id || '').startsWith('local-steer-') && Date.now() - Number(m.created || 0) < 10 * 60 * 1000,
    );
    const echoed = new Set(loaded.map((m) => String(m.text || '')));
    state.messages = [...loaded, ...pending.filter((m) => !echoed.has(String(m.text || '')))];
    // The chips on tool calls are a record that outlives the request, so a
    // transcript opened after the fact asks once. While the session is open they
    // arrive on the stream; this is only the catch-up.
    if (state.decisionsFor !== id) {
      try {
        const d = await api('GET', `/api/permissions?session=${encodeURIComponent(id)}`);
        if (state.sessionId !== id) return;
        state.permissionDecisions = new Map(
          (d.decisions || []).filter((x) => x.toolCallId).map((x) => [x.toolCallId, x]),
        );
        state.decisionSeq += 1;
        state.decisionsFor = state.sessionId;
      } catch { /* a missing chip must not stop the transcript from loading */ }
    }
    // The Architect's card reads its window from the usage event, which a page
    // opened later never saw. The transcript carries the same number, so seed it
    // here rather than showing an empty corner until the next turn.
    state.archCtx = lastPromptOf(state.messages) || state.archCtx;
    updateBusyFromMessages();
  } catch (err) {
    if (/not found|404/i.test(err.message)) {
      // Only this chat's death closes the view. A 404 for a chat that is no
      // longer open is the old one being deleted, not news about this one.
      if (state.sessionId !== id) return;
      // The session is gone — deleted here, or by another client. Stop polling.
      state.busySessions.delete(state.sessionId);
      showNothing();
      await loadProjects();
      return;
    }
    setEventChip('message load failed');
  }
  if (state.sessionId !== id) return;
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


// The engine blocks the session until every permission request is answered. A
// worker's request is as real as the open session's — and a worker session is
// hidden from the rail, so if its request were filtered to the open session the
// worker would sit blocked until its timeout with nothing on screen. Every
// pending request is shown, with the name of who is asking.
/** What this role is asking to do, in one sentence. Scope comes from the policy,
 *  so the sentence never claims the operator is the one outside their project. */
function permissionLead(p) {
  const actor = p.role ? roleLabel(p.role) : 'The Architect';
  // The screen is not a file, and the sentence has to say so: this card is the
  // "may I use your PC" question, and it is the only one that takes the mouse.
  if (p.scope === 'desk') return `${actor} wants to use your screen.`;
  const action = String(p.action || '').toLowerCase();
  const verb =
    action === 'read'
      ? 'read a file'
      : action === 'shell' || action === 'bash'
        ? 'run a command'
        : action === 'execute'
          ? 'run code'
          : /^(edit|write|patch|create)$/.test(action)
            ? (p.files?.[0]?.status === 'added' ? 'create a file' : 'change a file')
            : 'use a tool';
  const where =
    p.scope === 'harness'
      ? ' inside Synapse'
      : p.scope === 'secret'
        ? ' in a saved-password folder'
        : p.scope === 'outside'
          ? ' outside this project'
          : p.scope === 'project'
            ? ' in this project'
            : '';
  return where
    ? `${actor} wants to ${verb}${where}.`
    : `${actor} wants to ${verb}, and the harness cannot tell where it lands.`;
}

function renderPermissions() {
  // A wake click is only dangerous on a card that appeared as the window came
  // forward; one that has been on screen has been read. Remember when each card
  // was first drawn so the next click can tell the two apart.
  const now = Date.now();
  const seen = state.permSeen || (state.permSeen = new Map());
  const live = new Set((state.permissions || []).map((p) => p.requestId).filter(Boolean));
  for (const id of live) if (!seen.has(id)) seen.set(id, now);
  for (const id of [...seen.keys()]) if (!live.has(id)) { seen.delete(id); state.permWakeOk?.delete(id); }
  const html = (state.permissions || [])
    .map((p) => {
      const actor = p.role ? roleLabel(p.role) : 'The Architect';
      const task = p.task || '';
      const paths = p.resolved && p.resolved.length ? p.resolved : p.resources || [];
      const files = p.files || [];
      const adds = files.reduce((n, f) => n + (f.additions || 0), 0);
      const dels = files.reduce((n, f) => n + (f.deletions || 0), 0);
      const diff = files.length
        ? `<details class="perm-diff"><summary>${files.length} file${files.length === 1 ? '' : 's'} · +${adds} −${dels}</summary><pre class="perm-res">${esc(
            files.map((f) => f.patch || f.file).join('\n'),
          )}</pre></details>`
        : '';
      const due = Number(p.autoPermissionsAt) || null;
      // The screen is a different question from a file: it is the operator's mouse,
      // keyboard and focus, and the answer lasts for the run rather than for one
      // command — so it has its own two buttons and no "Always Allow".
      const screen = p.scope === 'desk';
      return `<div class="perm-card${screen ? ' is-screen' : ''}">
        <div class="perm-head"><span class="status-dot warn" role="img" aria-label="waiting"></span><span class="perm-head-text">${esc(
          actor,
        )} needs your ${screen ? 'screen' : 'permission'}</span>${
          // The switch is on for the asking project: count down to the moment it is
          // allowed, in the head's right corner like the question's own note (3 Nov).
          due ? `<span class="perm-head-note" data-perm-due="${due}">${esc(permissionNote(due, serverNow()))}</span>` : ''
        }${task ? `<span class="perm-who">${esc(task)}</span>` : ''}</div>
        <p class="perm-lead">${esc(permissionLead(p))}</p>
        ${paths.length ? `<pre class="perm-res">${esc(paths.join('\n'))}</pre>` : ''}
        ${p.reason ? `<p class="perm-why">${esc(p.reason)}</p>` : ''}
        ${diff}
        <div class="perm-actions">
          <button class="btn btn-allow btn-sm" data-perm="once" data-perm-id="${esc(
            p.requestId,
          )}" title="${
            screen
              ? 'Let it use your mouse, keyboard and focus for the rest of this run. You can take the screen back from the badge at any time.'
              : 'Do it this time only.'
          }">${screen ? 'Allow Screen' : 'Allow Once'}</button>
          ${
            screen
              ? ''
              : `<button class="btn btn-warn btn-sm" data-perm="always" data-perm-id="${esc(
                  p.requestId,
                )}" title="${
                  p.action === 'shell' || p.action === 'bash'
                    ? 'Do it, and stop asking for this command and the files it names in this chat — extra arguments do not ask again.'
                    : 'Do it, and stop asking for this exact request in this chat.'
                }">Always Allow</button>`
          }
          <button class="btn btn-warn btn-sm" data-perm="reject" data-perm-id="${esc(
            p.requestId,
          )}" title="Say no. The role is told and carries on.">Reject</button>
          <button class="btn btn-warn btn-sm" data-perm-reason-open="${esc(
            p.requestId,
          )}" title="Say no, and tell the role why in your own words.">Reject With Reason</button>
          <button class="btn btn-stop btn-sm" data-perm-stop="${esc(
            p.requestId,
          )}" title="Stop the whole task.">Stop Run</button>
        </div>
      </div>`;
    })
    .join('');
  // A card that is going to be allowed by itself carries a countdown; the ticker
  // runs only while one is on screen.
  if (/data-perm-due="/.test(html)) startPermCountdown();
  else stopPermCountdown();
  return html;
}

// ── the permission countdown ────────────────────────────────────
// "Auto-Permission: Allow Once will be picked in 7 seconds…", the same idea as the
// question's head: a number that moves is a claim the operator can check. Started
// when such a card is drawn, stopped when none is.
let permTick = 0;

function paintPermissionNotes() {
  const notes = document.querySelectorAll('[data-perm-due]');
  if (!notes.length) {
    stopPermCountdown();
    return;
  }
  for (const el of notes) el.textContent = permissionNote(el.dataset.permDue, serverNow());
}

function startPermCountdown() {
  if (!permTick) permTick = setInterval(paintPermissionNotes, 1000);
}

function stopPermCountdown() {
  if (permTick) {
    clearInterval(permTick);
    permTick = 0;
  }
}

// ── reject with reason ─────────────────────────────────────────
// The refusal's sentence, typed in a small dialog rather than in the card. The
// card stays pending until Submit; Cancel (or a click outside, or Escape) leaves
// it exactly as it was.
let permReasonFor = null;

function openPermReason(requestId) {
  const modal = $('permReasonModal');
  const input = $('permReasonInput');
  if (!modal || !input || !requestId) return;
  permReasonFor = requestId;
  input.value = '';
  const send = $('permReasonSend');
  if (send) send.disabled = true; // nothing to send until a word is typed
  modal.hidden = false;
  input.focus();
}

function closePermReason() {
  const modal = $('permReasonModal');
  if (modal) modal.hidden = true;
  permReasonFor = null;
  const send = $('permReasonSend');
  if (send) send.disabled = false;
}

/** Submit is a one-shot: a second click while the answer is in flight must not
 *  send the same refusal twice. */
async function submitPermReason() {
  const requestId = permReasonFor;
  const send = $('permReasonSend');
  if (!requestId || send?.disabled) return;
  const reason = String($('permReasonInput')?.value || '').trim();
  if (!reason) return;
  if (send) send.disabled = true;
  closePermReason();
  await replyPermission(requestId, 'reject', reason);
}

/** Stop the work that asked, not just the request: a worker refused a write
 *  would otherwise rephrase and ask again. Falls back to an interrupt when no
 *  run owns the directory (the Architect thinking on its own). */
async function stopFromPermission(requestId) {
  const permission = (state.permissions || []).find((p) => p.requestId === requestId);
  if (!permission) return;
  state.permissions = state.permissions.filter((p) => p.requestId !== requestId);
  renderTranscript();
  try {
    if (permission.directory) {
      const { ok } = await api('POST', '/api/runs/cancel', { dir: permission.directory });
      if (ok) {
        toast('Stopping', 'The run is being stopped.');
        return;
      }
    }
    await api('POST', `/api/sessions/${encodeURIComponent(permission.sessionId)}/interrupt`);
    toast('Stopping', 'The chat was interrupted.');
  } catch (err) {
    toast('Could not stop', err.message);
  }
}

// ── live event stream ───────────────────────────────────────────
const reloadMessages = debounce(() => loadMessages(), 250);
const reloadProjects = debounce(() => loadProjects(), 600);

function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    state.streamLive = true;
    clearDisconnected();
    renderStatus();
  };
  // The stream dropped. Give it a few seconds to come back (a listener move and
  // a server restart both do this), then cover the page: it is a snapshot now.
  es.onerror = () => {
    state.streamLive = false;
    renderStatus();
    showDisconnected();
  };
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.kind === 'hello') {
      state.streamLive = true;
      // Our own identity, and who else is looking. The id travels on every
      // request from here on, which is how the Settings lock knows who holds it.
      if (ev.clientId) state.clientId = ev.clientId;
      if (ev.you) state.you = ev.you;
      if (ev.presence) {
        state.views = ev.presence.views || [];
        state.settingsLock = ev.presence.lock || null;
      }
      clearDisconnected();
      renderClients();
      renderStatus();
      // A reconnect is exactly when a `run.finished` was missed: the stream that
      // would have carried it died first. Ask what is actually running.
      syncRuns().catch(() => {});
      loadDesk().catch(() => {});
      // The same is true of the version: a reconnect usually means the server was
      // restarted onto a new build, and the About page would otherwise keep the
      // number it read when the tab was opened.
      refreshStatus().catch(() => {});
      return;
    }

    // A view joined or left, or the Settings lock moved. Every view gets the same
    // frame, so the only way to tell "someone else has it" is the holder's id —
    // `yours` cannot be in a broadcast, and reading it as false meant this page
    // closed its own panel the moment any view joined, saying the settings were
    // being edited on this very PC (measured 31 Oct, on a page with the lock).
    if (ev.kind === 'presence') {
      state.views = ev.views || [];
      state.settingsLock = ev.lock || null;
      renderClients();
      if (ev.lock && ev.lock.id && ev.lock.id !== state.clientId && !$('settingsModal').hidden) {
        closeSettings({ force: true });
        toast('Settings Closed', `The settings are now being edited on ${ev.lock.name}.`);
      }
      return;
    }

    if (ev.kind === 'settings-lock') {
      state.settingsLock = ev.holder || null;
      // The clients line does not depend on who holds Settings; leave it alone.
      // Same rule as the presence frame: the holder's id decides, not a name (two
      // windows on this PC share the host's name, so a name test is a guess).
      if (ev.holder && ev.holder.id !== state.clientId && !$('settingsModal').hidden) {
        closeSettings({ force: true });
        toast('Settings Closed', `The settings are now being edited on ${ev.holder.name}.`);
      }
      return;
    }

    // The LAN switch moved. The view that moved it already said so in its own words
    // (the switch's own toast), so it is told again only if somebody else did it —
    // otherwise one click produced two notifications, the second claiming a change
    // "on another computer" that never happened.
    if (ev.kind === 'remote') {
      state.remote = ev.remote || state.remote;
      renderRemote();
      // A remote page whose access was just switched off is about to be cut off.
      // Say so before the socket dies, not after a failed reconnect.
      if (state.you?.local === false && ev.remote?.enabled === false) showDisconnected(0);
      else if (ev.byId !== state.clientId) toast(
        ev.remote?.enabled ? 'Remote Access On' : 'Remote Access Off',
        ev.by ? `Changed on ${ev.by}.` : 'Changed on another computer.',
      );
      return;
    }

    // Settings were saved on another view. The open form is a draft and is not
    // rebuilt under the operator's hands; they are told, and a reopen loads it. A
    // view that saved them itself is not told anything: it has the saved copy in
    // hand, and "Saved on another computer" for your own click is a lie the page
    // told itself (measured 31 Oct, from the role pickers).
    if (ev.kind === 'config') {
      state.config = ev.config || state.config;
      const mine = Boolean(ev.byId) && ev.byId === state.clientId;
      if (!$('settingsModal').hidden && !mine) {
        toast('Settings Changed', 'Saved on another computer. Close and reopen Settings to load it.');
      } else if (state.status) {
        // A role's model lives in the config, so saving it on one view must
        // repaint the other view's pickers — otherwise the two windows disagree
        // about which model the Architect is using. fillRoleModels is the one
        // that rebuilds the options, the hidden select and its visible search
        // input from selectionFor(); renderRoleActivity repaints the cards.
        fillRoleModels();
        renderRoleActivity();
        renderStatus();
        renderKeep();
        schedulePermissionRender();
      }
      return;
    }

    // A card was answered somewhere else: the panel is rebuilt from pending, and
    // A tool asked to change a prohibited path: the operator sees the red line even
    // when the asker was a hidden worker session.
    if (ev.kind === 'prohibition') {
      openProhibition(ev.entry);
      return;
    }

    // The screen lease, from the server: taken, or given back. The badge is the
    // answer to "is the AI using my PC right now", so it is drawn from the lease
    // and never from a guess.
    if (ev.kind === 'desk') {
      state.desk = ev.desk || null;
      renderDesk();
      if (ev.type === 'desk.released') {
        toast('Screen Released', 'The AI is not using your mouse or keyboard any more.');
        // A chime is the "you can come back" signal — unless they took it back
        // themselves, which needs no announcement: they were right there.
        if (String(ev.why || '') !== 'the operator took it back') playDoneSound();
      }
      return;
    }

    // Stop, from the server that owns it. The page does not decide when a stop is
    // over any more: it hears `stop.done` when the project is really quiet, and
    // `stop.stuck` when the engine will not let go — which is the state that used
    // to look like a frozen event list and a Stop button that did nothing.
    if (ev.kind === 'stop') {
      if (ev.type === 'stop.started') {
        state.stopping = true;
        state.stoppingReason = null;
        renderComposer();
        return;
      }
      if (ev.type === 'stop.done') {
        state.stopping = false;
        state.stoppingReason = null;
        renderComposer();
        refreshPending();
        // The confirmation the operator asked for: they can use the machine again.
        toast('Stopped', 'The work has stopped.');
        return;
      }
      if (ev.type === 'stop.cleared') {
        // The operator spoke before the stop took effect. Nothing was stopped, so
        // there is nothing to announce — the notice just goes.
        state.stopping = false;
        state.stoppingReason = null;
        renderComposer();
        return;
      }
      if (ev.type === 'stop.stuck') {
        state.stopping = true;
        state.stoppingReason = ev.reason || null;
        renderComposer();
        toast(
          'Still Running',
          ev.reason
            ? `The engine will not stop — ${ev.reason}`
            : 'The engine will not stop. Press Stop again to cut it now.',
        );
        return;
      }
      if (ev.type === 'stop.failed') {
        state.stopping = false;
        renderComposer();
        toast('Could Not Stop', ev.reason || 'The engine kept the session running.');
        return;
      }
    }

    // the chip on the tool call it belonged to is keyed by that call's id — not
    // by the request id, or the tool card would never find it.
    if (ev.kind === 'permission' && ev.type === 'permission.decided') {
      const decided = ev.decision || {};
      if (decided.toolCallId) {
        state.permissionDecisions?.set(decided.toolCallId, decided);
        state.decisionSeq += 1;
        if (state.view === 'session' && decided.sessionId === state.sessionId) schedulePermissionRender();
      }
      refreshPending();
      return;
    }

    if (ev.kind === 'form' && ev.type === 'form.answered') {
      refreshPending();
      return;
    }

    // The timed shutdown, as the server counts it. The numbers come from the server
    // so the page never decides when the machine goes — it only shows the count and
    // offers the way out.
    if (ev.kind === 'shutdown-warning') {
      showShutdownWarning(ev.seconds);
      return;
    }
    if (ev.kind === 'shutdown-tick') {
      showShutdownWarning(ev.seconds);
      return;
    }
    if (ev.kind === 'shutdown-done') {
      noteShutdownDone();
      return;
    }
    if (ev.kind === 'shutdown-cancelled') {
      const shown = !$('shutdownModal').hidden;
      shutdownWarned = false;
      $('shutdownModal').hidden = true;
      if (shown) toast('PC Left On', ev.reason || 'The timed shutdown was cancelled.');
      return;
    }

    // Synapse's own notification: the session was just auto-named, or a send
    // applied a mode. The mode is the applied one, so another window's toggle
    // and plan pane follow it — a pending choice on this page is not overwritten
    // if it is the one that sent, because the event carries the same value.
    if (ev.kind === 'sessions') {
      if (ev.type === EV.mode && ev.sessionId === state.sessionId && !state.busy) {
        applyMode(ev.mode);
      }
      // The four switches are per project: another view flipping one must move
      // this one's cog and the note on any open card.
      if (ev.type === EV.automation && ev.sessionId === state.sessionId) {
        state.automation = { ...AUTOMATION_DEFAULTS, ...(ev.automation || {}) };
        const session = findSession(state.sessionId);
        if (session) session.automation = state.automation;
        renderKeep();
        renderTranscript();
      }
      reloadProjects();
      return;
    }

    // A model earned itself a mark while a run was failing: re-read the catalog
    // so the picker shows it now rather than after the next reload.
    if (ev.kind === 'model') {
      refreshModels();
      return;
    }

    // A conversation was compacted: its chat is gone and a fresh one exists. The
    // window that was looking at the old one follows without a reload; every
    // other window just refreshes the rail (the old session has left it).
    if (ev.kind === 'project' && ev.type === 'project.compacted') {
      // The discarded chat's folds and alarms go with it, before the new chat is
      // opened: a compact leaves one post, not a list of the old runs.
      forgetConversation(ev.directory || currentProject()?.directory || '', ev.oldSessionId);
      if (ev.oldSessionId === state.sessionId) {
        // The old chat is gone because its replacement exists: keep the view open
        // while the list catches up, then follow the new chat.
        loadProjects({ keepOpen: true })
          .then(() => {
            if (state.sessionId === ev.oldSessionId) return openSession(ev.sessionId);
            return null;
          })
          .catch(() => {});
      } else {
        reloadProjects();
      }
      return;
    }

    // Synapse's release check finished at boot (or after a click): the chip and
    // the dialog both read from this.
    if (ev.kind === 'synapse-update') {
      if (ev.update) state.synapseUpdate = ev.update;
      renderUpdateChip();
      renderUpdateViews();
      return;
    }

    // A line from either updater. The console is shared; the target is in the
    // line only for the log, not for routing.
    if (ev.kind === 'update' && ev.type === 'update.log') {
      pushUpdateLog(ev.line);
      return;
    }

    // The engine's version moved (an update finished): the chip and the dialog
    // both read from this, and the catalog may have changed with it.
    if (ev.kind === 'engine-update') {
      if (ev.update) state.update = ev.update;
      renderUpdateChip();
      renderUpdateViews();
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
      // A run ending can leave the chat idle without a session event (the Architect's
      // turn was already over), so the answer to "is anything still happening?" is
      // asked again after every run event, not only after the engine's.
      noteWorking();
      return;
    }

    // Only work moves the clock. A `session.deleted` or `session.named` is about
    // the rail, and the chip is about what a model is doing.
    if (WORK_EVENT.test(shortEvent(ev.type))) setEventChip(ev.type, ev.sessionId);
    // A compaction is the engine's own decision, and the chip has always said so
    // (`session.compaction.started`) while the chat said nothing at all. Taking it
    // from here is the honest source: whatever asked for it — the engine's rule or
    // our watchdog — this is the one event that proves one is happening.
    if (ev.sessionId && [EV.compactionStarted, EV.compactionEnded, EV.compactionFailed].includes(ev.type)) {
      noteCompactionEvent(ev);
    }
    const mine = !ev.sessionId || ev.sessionId === state.sessionId;
    // A worker's session is not the open one, so nothing of it renders through
    // `mine`. Its words and its thinking stream in here instead, and its steps
    // become the one-line notes in the trace.
    const liveRun = currentRun();
    if (liveRun && ev.sessionId && ev.sessionId === liveRun.workerId) {
      if (ev.type === EV.textDelta) { noteDelta(ev); appendStream('word', ev.raw?.data?.delta); }
      else if (ev.type === EV.reasoningDelta) { noteDelta(ev); appendStream('think', ev.raw?.data?.delta); }
      else if (ev.type === EV.usageUpdated) noteWorkerUsage(ev);
      else if (ev.type === EV.textEnded || ev.type === EV.reasoningEnded) endStream();
    } else if (ev.sessionId && ev.sessionId === state.sessionId) {
      // The Architect's own step. Its deltas used to be dropped — only a delegated
      // run had a trace to put them in — so the panel sat empty and the whole wall
      // appeared when the step's message was rebuilt. Same panel, same code.
      if (ev.type === EV.textDelta) { noteDelta(ev); appendStream('word', ev.raw?.data?.delta); }
      else if (ev.type === EV.reasoningDelta) { noteDelta(ev); appendStream('think', ev.raw?.data?.delta); }
      else if (ev.type === EV.textEnded || ev.type === EV.reasoningEnded) endStream();
      else if (turnEnded(ev.type)) {
        // The turn is over: nothing may stream into it any more.
        state.sessionTrace.stream = null;
        state.sessionTrace.key = '';
      }
    }
    // The Architect's own card gets the same number from the same event. Its
    // session is never a worker's, so the two cannot both claim it.
    if (ev.sessionId && ev.sessionId === state.sessionId && ev.type === EV.usageUpdated) noteArchitectUsage(ev);
    // any traffic from a session counts as progress against the stall timer
    if (ev.sessionId) state.busySince.set(ev.sessionId, Date.now());

    // A tool that is still executing is progress, even though it emits nothing.
    if (ev.sessionId) {
      if (ev.type === EV.toolCalled || ev.type === EV.toolInputEnded) {
        state.toolsInFlight.add(ev.sessionId);
      } else if (
        ev.type === EV.toolSuccess ||
        ev.type === EV.toolFailed ||
        ev.type === 'shell.exited' ||
        turnEnded(ev.type)
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
        if (ev.type === EV.executionStarted && !busy) { state.busySessions.add(ev.sessionId); changed = true; }
        else if (turnEnded(ev.type) && busy) {
          state.busySessions.delete(ev.sessionId);
          changed = true;
        }
      }
      if (mine) {
        // The Architect is working: whatever red line its card carried about a
        // provider failure is no longer the news. `role-error` clears this at the
        // end of a successful wake, but the card sat red through the whole turn
        // that proved the retry had worked.
        if (ev.type === EV.executionStarted && ev.sessionId === state.sessionId) {
          const archKey = `${dirKey(currentProject()?.directory)}|architect`;
          if (state.roleErrors.delete(archKey)) {
            state.roleSig = '';
            renderRoleActivity();
          }
        }
        if (ev.type === EV.executionStarted) state.busy = true;
        else if (turnEnded(ev.type) || ev.type === EV.idle) state.busy = false;
        // A turn that failed or was interrupted is not "done": the chime stays quiet
        // for it, so the sound always means the work finished.
        if (ev.type === EV.executionFailed || ev.type === EV.executionInterrupted) workEndQuiet = true;
        renderComposer();
      }
      if (changed) {
        renderTree();
        // A worker starting or ending changes what Stop can reach. Ask now rather
        // than waiting out the poll, or the button appears up to eight seconds late.
        schedulePendingRefresh();
      }
      reloadProjects();
      if (mine) reloadMessages();
      noteWorking();
      return;
    }

    if (ev.kind === 'permission') {
      if (ev.type === 'permission.asked') {
        // Any session: a hidden worker blocks exactly like the open one.
        schedulePendingRefresh();
      } else if (ev.type === 'permission.replied') {
        const d = ev.raw?.data || ev.raw || {};
        const id = d.requestID || d.requestId || d.id;
        if (id && (state.permissions || []).some((p) => p.requestId === id)) {
          state.permissions = state.permissions.filter((p) => p.requestId !== id);
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
}

// ── settings (live) ─────────────────────────────────────────────

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

// ── Prohibited: the list's four handlers ────────────────────────
// The pane is in ./settings-panes.js; these edit the draft and re-render the window,
// which is this file's state machine. The PROHIBITED tier itself is the server's
// (src/protection.js): a built-in can be switched off but never deleted.

async function loadProtection() {
  try {
    state.protection = await api('GET', '/api/protection');
  } catch { /* the pane shows what it already knows */ }
  return state.protection;
}

function toggleProtection(input) {
  const c = collectSettings();
  if (!c) return;
  c.protection = c.protection || {};
  const kind = input.dataset.protKind;
  const target = input.dataset.protWrite || input.dataset.protRead;
  const isWrite = input.hasAttribute('data-prot-write');
  if (kind === 'builtin') {
    // The two id lists store the *refusals*: a built-in id sits in builtinsOff when
    // its Write is cleared, and in builtinsSealed when its Read is cleared.
    const key = isWrite ? 'builtinsOff' : 'builtinsSealed';
    const set = new Set((c.protection[key] || []).map(String));
    if (isWrite) {
      // Ticked = changes allowed = the id is listed in builtinsOff.
      if (input.checked) set.add(target);
      else set.delete(target);
    } else if (input.checked) set.delete(target);
    else set.add(target);
    c.protection[key] = [...set];
  } else {
    const entry = (c.protection.paths || []).find((p) => samePath(p.path, target));
    if (entry) {
      if (isWrite) entry.write = input.checked;
      else entry.read = input.checked;
    }
  }
  renderSettings();
}

function removeProtectionPath(target) {
  if (!target) return;
  const c = collectSettings();
  if (!c) return;
  c.protection = c.protection || {};
  c.protection.paths = (c.protection.paths || []).filter((p) => !samePath(p.path, target));
  // Remembered, so the boot seed for a browser folder does not put it back.
  c.protection.removed = [...new Set([...(c.protection.removed || []), target])];
  renderSettings();
}

async function addProtectionPath(kind) {
  try {
    const picked = await api('POST', '/api/protection/pick', { kind: kind === 'file' ? 'file' : 'folder' });
    const chosen = String(picked?.path || '').trim();
    if (!chosen) return;
    const c = collectSettings();
    if (!c) return;
    c.protection = c.protection || {};
    const paths = Array.isArray(c.protection.paths) ? c.protection.paths : (c.protection.paths = []);
    if (!paths.some((p) => samePath(p.path, chosen))) {
      // A new path starts protected for writes and readable, the same default the
      // built-ins have; the operator clears Read only when touching it is dangerous.
      paths.push({ path: chosen, label: '', write: false, read: true });
    }
    c.protection.removed = (c.protection.removed || []).filter((p) => !samePath(p, chosen));
    renderSettings();
  } catch (err) {
    toast('Could Not Add A Path', err.message);
  }
}

// The nine panes come from ./settings-panes.js; Providers is the one editor that
// needs this file's own state machine, so it is added here.
const SETTINGS_PANES = { ...PANES, providers: settingsProviders };

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
  updateSettingsFoot();
}

/**
 * The footer's one truth: does the form differ from the saved config, and does
 * what differs only take effect on a restart?
 *
 * Left: Cancel and Revert, the two ways to throw the draft away. Right: Apply —
 * green, and disabled when there is nothing to apply or when only a restart can
 * apply it — and one primary whose label says what pressing it does: Close, Save
 * & Close, or Save & Restart. The colours are the meaning: green adds, red
 * discards.
 */
function updateSettingsFoot() {
  const foot = document.querySelector('.set-foot');
  if (!foot) return;
  // About is the one page that keeps its own Close button inside the card: it is a
  // credits page, not a form. Every other tab — Updates included — wears the same
  // footer, because a page that is missing the buttons the window always has reads
  // as a different window. On a page with nothing to save they sit in their resting
  // state: Cancel and Revert are grey-red and disabled, Apply is disabled, Close is
  // Close.
  foot.hidden = state.settingsTab === 'about';
  if (foot.hidden || !state.setDraft || !state.config) return;
  collectSettings();
  const dirty = JSON.stringify(state.setDraft) !== JSON.stringify(state.config);
  const needsRestart = dirty && restartNeeded(state.config, state.setDraft);
  const busy = Boolean(state.updateBusy);
  const apply = $('applySettings');
  if (apply) apply.disabled = !dirty || needsRestart || busy;
  // Cancel has nothing to throw away until the form differs from the file; a red
  // button that only closes is a promise the window cannot keep.
  const cancel = $('cancelSettings');
  if (cancel) cancel.disabled = !dirty || busy;
  // Revert is the same promise: with nothing typed there is nothing to put back.
  const revert = $('revertSettings');
  if (revert) revert.disabled = !dirty || busy;
  const primary = $('settingsPrimary');
  if (!primary) return;
  primary.disabled = busy;
  primary.textContent = dirty ? (needsRestart ? 'Save & Restart' : 'Save & Close') : 'Close';
  primary.dataset.action = dirty ? (needsRestart ? 'save-restart' : 'save-close') : 'close';
  primary.className =
    'btn btn-sm' +
    (dirty ? (needsRestart ? ' btn-outline-red' : ' btn-green-solid') : ' btn-secondary');
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
  if (id === state.settingsTab) {
    if (id === 'updates') checkUpdates();
    return;
  }
  collectSettings();
  state.settingsTab = id;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings({ scrollTop: 0 });
  // Opening the Updates page is the operator asking, like opening the chip's
  // popup: check both feeds now rather than showing a stale answer.
  if (id === 'updates') checkUpdates();
  // The prohibited list is the server's (built-ins live in code), so the tab
  // reads it once. The draft's ticks survive the re-render.
  if (id === 'prohibited' && !state.protection) {
    loadProtection().then(() => {
      if (state.settingsTab === 'prohibited') renderSettings();
    });
  }
}

// The editor's fields write straight into the selected draft provider: there is
// no data-path for them because a provider is an object in a list, not a path.
function onSettingsInput(e) {
  // The chat's size is the one setting whose effect is worth seeing while it is
  // being chosen: a number in a box says nothing about whether a full answer still
  // fits above the composer. The draft is not touched — Save is still the write.
  if (e.target?.dataset?.path === 'ui.chatTextPx') {
    applyChatText(e.target.value);
    return;
  }
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
  if (e.target.closest('[data-close-about]')) { closeSettings(); return; }
  if (e.target.closest('[data-check-updates]')) { checkUpdates(); return; }
  if (e.target.closest('[data-test-sound]')) {
    // The pane renders from a draft; the select itself is the live choice.
    const sel = $('settingsBody')?.querySelector('select[data-path="notify.doneSound"]');
    playDoneSound(sel ? sel.value : state.config?.notify?.doneSound);
    return;
  }
  const upd = e.target.closest('[data-update]');
  if (upd) {
    if (upd.disabled || state.updateBusy) return;
    if (upd.dataset.update === 'engine') applyEngineUpdate();
    if (upd.dataset.update === 'synapse') applySynapseUpdate();
    return;
  }
  // The Runtime pane's own button now lands on the Updates page instead of
  // opening the chip's popup over the settings window.
  if (e.target.closest('[data-check-update]')) { switchSettingsTab('updates'); return; }
  // Prohibited: the tick and the two add buttons. A tick is a draft change, saved
  // with the rest of the settings; nothing is enforced until Save.
  if (e.target.closest('[data-prot-add]')) {
    const menu = $('protAddMenu');
    if (menu) menu.hidden = !menu.hidden;
    return;
  }
  const protNew = e.target.closest('[data-prot-new]');
  if (protNew) { addProtectionPath(protNew.dataset.protNew); return; }
  const protDel = e.target.closest('[data-prot-del]');
  if (protDel) { removeProtectionPath(protDel.dataset.protDel); return; }
  const protToggle = e.target.closest('[data-prot-write],[data-prot-read]');
  if (protToggle) { toggleProtection(protToggle); return; }
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
  // An engine provider removed from the list, put back. Nothing is registered: the
  // engine never stopped serving it, so this only takes its id off the hidden list
  // and the models return to the menu on the next load.
  const restore = e.target.closest('[data-prov-show]');
  if (restore) {
    const menu = $('provAddMenu');
    if (menu) menu.hidden = true;
    const c = collectSettings();
    if (!c) return;
    c.engine.opencode = c.engine.opencode || {};
    c.engine.opencode.hiddenProviders = (c.engine.opencode.hiddenProviders || []).filter(
      (id) => String(id) !== String(restore.dataset.provShow),
    );
    renderSettings();
    return;
  }
  const hide = e.target.closest('[data-prov-hide]');
  if (hide) {
    const c = collectSettings();
    if (!c) return;
    c.engine.opencode = c.engine.opencode || {};
    const gone = new Set((c.engine.opencode.hiddenProviders || []).map(String));
    gone.add(String(hide.dataset.provHide));
    c.engine.opencode.hiddenProviders = [...gone];
    // The row is about to disappear, so an editor open on it would point at nothing.
    state.setProvSelected = null;
    renderSettings();
    return;
  }
  // The order arrows come before the row handler: a click on one is a move, not
  // a request to open the provider for editing.
  const move = e.target.closest('[data-prov-up],[data-prov-down]');
  if (move) {
    const up = move.hasAttribute('data-prov-up');
    moveProvider(up ? move.dataset.provUp : move.dataset.provDown, up ? -1 : 1);
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

async function saveSettings({ close = false, restart = false } = {}) {
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
    const needsRestart = restartNeeded(state.config, draft);
    state.config = await api('PUT', '/api/config', draft);
    // The chat's size is read from the config here, once, rather than by watching
    // for changes: this is the one place the file becomes the page's truth.
    applyChatText();
    applyLanguage();
    // The Auto-Shutdown delays are read by the server on its next sweep, so a
    // saved change needs nothing here. A save is also the moment to re-draw the
    // cog: the waits it names may have moved.
    state.setDraft = JSON.parse(JSON.stringify(state.config));
    state.setProvSelected = null;
    renderLlmStatus();
    renderKeep();
    schedulePermissionRender();
    await loadModels();
    // A new skills folder is worth reading before the operator closes the panel.
    await checkSkills({ quiet: true });
    renderSettings();
    // The footer named the ending before it was pressed: a restart-required save
    // restarts here, an ordinary one is already live, and Close just closes.
    if (needsRestart) {
      if (restart) { await restartSynapse(); return; }
      await askRestart();
      return;
    }
    if (close) {
      closeSettings();
      toast('Settings Saved', 'The changes are in effect.');
      return;
    }
    toast('Settings Saved', 'These take effect straight away.');
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
      'Synapse did not come back by itself. Start the server from the Synapse tray icon, then reload this page.';
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
    applyChatText();
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

async function openSettings() {
  if (!state.config) { toast('Config Unavailable', 'Synapse could not read its own config file.'); return; }
  // One editor at a time. The server owns the lock; this is only its face.
  try {
    await api('POST', '/api/settings/lock', { action: 'acquire' });
    state.settingsLock = { yours: true };
  } catch (err) {
    toast('Settings Are Open Elsewhere', err.message);
    return;
  }
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
  // The tab is remembered across openings; if it is Updates, opening the window
  // is also a request for a fresh answer.
  if (state.settingsTab === 'updates') checkUpdates();
}
function closeSettings({ force = false } = {}) {
  // An update started from this window is visible only here; the chip's popup
  // has the same rule. Locking the window is the safe half of "in flight".
  if (state.updateBusy && !force) return;
  $('settingsModal').hidden = true;
  state.setDraft = null;
  // An unsaved chat size was a preview; closing the window puts back the saved one.
  applyChatText();
  api('POST', '/api/settings/lock', { action: 'release' }).catch(() => {});
  state.settingsLock = null;
}
/** Throw the draft away and read the file again, without closing the window. */
function revertSettings() {
  if (!state.config) return;
  state.setDraft = JSON.parse(JSON.stringify(state.config));
  state.setProvSelected = null;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings();
  // A size that was typed but not saved must go back too: the preview is the only
  // part of this form that changes the page before Save.
  applyChatText();
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
    await addAttachmentFiles(picked);
  });
  // Paste is a second door to the same place: files and images from the clipboard,
  // and long text as a .txt attachment rather than a wall in the box.
  $('promptInput').addEventListener('paste', onComposerPaste);
  $('attachStrip').addEventListener('click', (e) => {
    const x = e.target.closest('[data-detach]');
    if (!x) return;
    state.attachments = state.attachments.filter((f) => f.id !== x.dataset.detach);
    hideAttachPreview();
    renderAttachments();
  });
  // Keep is a per-attachment choice, not a mode. It is read at send; unchecking
  // before sending leaves nothing behind.
  $('attachStrip').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-keep]');
    if (!box) return;
    const file = (state.attachments || []).find((f) => f.id === box.dataset.keep);
    if (!file) return;
    file.keep = box.checked;
    const label = box.closest('.attach-keep');
    if (label) {
      label.title = file.keep
        ? 'Kept — a copy will be saved in .synapse/attachments when you send. It survives compaction and workers can read it. Click to stop keeping it.'
        : 'Keep a copy in this project when you send. It survives compaction and workers can read it.';
    }
  });
  $('attachStrip').addEventListener('mouseover', (e) => {
    const chip = e.target.closest('.attach-chip[data-image]');
    if (chip) showAttachPreview(chip.dataset.attach);
  });
  $('attachStrip').addEventListener('mouseout', (e) => {
    const chip = e.target.closest('.attach-chip');
    if (chip && !chip.contains(e.relatedTarget)) hideAttachPreview();
  });
  // A picture a model put in its answer: the chip is the sentence, the picture
  // is what hovering it shows. Delegated, because the transcript re-renders.
  $('transcript')?.addEventListener('mouseover', (e) => {
    const chip = e.target.closest('.chat-image');
    if (chip) showChatImagePreview(chip);
  });
  $('transcript')?.addEventListener('mouseout', (e) => {
    const chip = e.target.closest('.chat-image');
    if (chip && !chip.contains(e.relatedTarget)) hideAttachPreview();
  });
  $('stopBtn').addEventListener('click', interrupt);
  $('deskTakeBack')?.addEventListener('click', takeBackScreen);
  $('modeToggle').addEventListener('click', switchMode);
  $('compactChip').addEventListener('click', compactClick);
  // The compact post is a <details>; its open state is kept like a reasoning
  // block's, so a stream that re-renders the chat does not snap it shut.
  $('transcript')?.addEventListener(
    'toggle',
    (e) => {
      const post = e.target.closest?.('.chat-post');
      if (!post) return;
      // The compact post is the one with no key of its own; a loaded-instructions
      // post carries its message id, so opening one does not open the other.
      const key = post.dataset.k || 'compact-post';
      if (post.open) state.open.add(key);
      else state.open.delete(key);
    },
    true,
  );
  $('remoteToggle').addEventListener('click', toggleRemote);

// The disconnected panel: Close ends the page. A browser refuses window.close()
// for a tab the operator opened, so the fallback replaces the document — the
// point is that nothing of the stale app stays clickable.
$('disconnectClose').addEventListener('click', () => {
  try { window.close(); } catch { /* refused for a tab we did not open */ }
  setTimeout(() => {
    try { location.replace('about:blank'); } catch { /* last resort */ }
  }, 250);
});
// No Escape, no shortcuts while the page is a snapshot. Tab and Enter still work,
// so the one button can be reached and pressed from the keyboard.
document.addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('is-disconnected')) return;
  if (e.key === 'Tab' || e.key === 'Enter') return;
  e.preventDefault();
  e.stopPropagation();
}, true);
  $('remoteToken').addEventListener('click', copyRemoteToken);
  $('runBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRunMenu();
  });
  $('runMenu').addEventListener('click', (e) => {
    // Keep PC Awake is the one row here that is not a per-project switch.
    if (e.target.closest?.('[data-power]')) { togglePower(); return; }
    const row = e.target.closest?.('[data-automation]');
    if (!row) return;
    const key = row.dataset.automation;
    setAutomationSwitch(key, state.automation?.[key] !== true);
  });
  // A click anywhere outside the cog or its menu closes it; Escape too.
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('.run-control')) closeRunMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeRunMenu();
  });
  // A fixed menu does not travel with the button: close it when the *page* moves.
  window.addEventListener('resize', () => closeRunMenu());
  // Not the transcript, though. It is a capture listener here that closed the menu
  // the instant it opened during a run: the chat scrolls on every streamed line,
  // and a capture-phase scroll handler on window hears that too (measured 3 Nov —
  // the four switches could not be read while a turn was live). The cog sits in the
  // composer, which does not scroll with the conversation, so only the page's own
  // scroll should dismiss it — and scroll does not bubble to window without capture.
  window.addEventListener('scroll', () => closeRunMenu());
  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('emptyNewProject').addEventListener('click', addProject);
  $('addProjectBtn').addEventListener('click', addProject);
  // A click anywhere but the menu (or the ⋯ that opened it) closes it.
  document.addEventListener(
    'click',
    (e) => {
      if (!menuProjectId) return;
      if (e.target.closest('#projectMenu') || e.target.closest('[data-menu-project]')) return;
      closeProjectMenu();
    },
    true,
  );

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
  $('transcript').addEventListener('click', async (e) => {
    const reuse = e.target.closest('[data-reuse-msg]');
    if (reuse) {
      reuseMessage(reuse.dataset.reuseMsg);
      return;
    }
    const btn = e.target.closest('[data-copy-error]');
    if (!btn) return;
    const at = Number(btn.dataset.copyError);
    const hit = chatErrorsHere().find((x) => Number(x.at) === at);
    if (!hit) return;
    try {
      await navigator.clipboard.writeText(`${hit.title}\n${hit.detail}`);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy Error'; }, 1600);
    } catch {
      toast('Could Not Copy', 'The clipboard is not available in this window.');
    }
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
    // The "Something Else" box is prose, not a one-line field: Enter starts a new
    // line there and Ctrl+Enter sends, the same as the chat composer. Every other
    // field keeps Enter-to-move-on.
    askHost.addEventListener('keydown', (e) => {
      if (e.target.closest?.('.ask-other-text')) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const next = askHost.querySelector('[data-ask-next]');
          if (next && !next.hidden) {
            if (!next.disabled) moveAskPage(1);
            return;
          }
          const btn = askHost.querySelector('[data-form-reply]');
          if (btn && !btn.disabled) replyForm(btn.dataset.formReply);
        }
        return;
      }
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
    // A multi-line answer grows instead of hiding its own text.
    askHost.addEventListener('input', (e) => {
      if (e.target.classList?.contains('ask-other-text')) autoGrow(e.target);
    });
  }

  $('transcript').addEventListener('click', (e) => {
    // The ask panel is *inside* the transcript while a question is up, and it has
    // its own handler above: letting the click through here sent the answer twice
    // (6 Nov). The guard in replyForm is the belt to this brace.
    if (e.target.closest('.ask-panel')) return;
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
  // Reasoning blocks and which compact post the operator opened. The post is a
  // single block with a fixed key; without this branch a poll re-render shut it
  // again a few seconds after it was opened.
  $('transcript').addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || d.tagName !== 'DETAILS') return;
    const k = d.dataset.k || (d.classList.contains('chat-post') ? 'compact-post' : '');
    if (!k) return;
    if (d.open) state.open.add(k); else state.open.delete(k);
  }, true);
  $('settingsBtn').addEventListener('click', openSettings);
  $('cancelSettings').addEventListener('click', closeSettings);
  $('revertSettings').addEventListener('click', revertSettings);
  $('applySettings').addEventListener('click', () => saveSettings());
  // One primary, three jobs. Its label and colour are set by updateSettingsFoot()
  // so the sentence the operator reads is the thing the press will do.
  $('settingsPrimary').addEventListener('click', () => {
    const action = $('settingsPrimary').dataset.action;
    if (action === 'save-restart') saveSettings({ close: true, restart: true });
    else if (action === 'save-close') saveSettings({ close: true });
    else closeSettings();
  });
  $('settingsTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-set-tab]');
    if (tab) switchSettingsTab(tab.dataset.setTab);
  });
  // One delegated pair for the whole pane: the Providers editor rebuilds its own
  // markup on every change (a new row, a revealed key, a refreshed list), so
  // per-element listeners would have to be re-attached each time.
  $('settingsBody').addEventListener('click', onSettingsClick);
  $('settingsBody').addEventListener('input', onSettingsInput);
  // Every edit moves the footer: Apply and the primary are only honest while
  // they know whether the form differs from the file.
  $('settingsBody').addEventListener('input', () => updateSettingsFoot());
  // Hearing it is the whole point of a sound setting: choose one and it plays.
  $('settingsBody').addEventListener('change', (e) => {
    if (e.target instanceof HTMLSelectElement && e.target.dataset.path === 'notify.doneSound') {
      playDoneSound(e.target.value);
    }
    updateSettingsFoot();
  });
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
  $('checkUpdate').addEventListener('click', checkUpdates);
  $('updateBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-update]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.update === 'engine') applyEngineUpdate();
    if (btn.dataset.update === 'synapse') applySynapseUpdate();
  });

  // The two reference tables open from the rail's foot. They are rendered on
  // open rather than only on the 30-second poll, so what the operator sees is
  // what the server said a moment ago.
  $('toolsBtn')?.addEventListener('click', () => openRailModal('toolsModal', renderToolUsage));
  $('probeBtn')?.addEventListener('click', () => openRailModal('probeModal', renderProbe));
  // The console: one button to open, one to close, and Escape or the backdrop as
  // the same second way out every other popup here has.
  $('consoleBtn')?.addEventListener('click', openConsole);
  $('consoleClose')?.addEventListener('click', closeConsole);
  // The same three actions the tray offers. Stopping asks first — the shell owns
  // that question, so both routes ask it in the same place, once.
  for (const [id, action] of [['consoleStart', 'start'], ['consoleRestart', 'restart'], ['consoleStop', 'stop']]) {
    $(id)?.addEventListener('click', () => window.chrome?.webview?.postMessage({ kind: 'server', action }));
  }
  for (const btn of document.querySelectorAll('[data-close-modal]')) {
    btn.addEventListener('click', () => closeRailModal(btn.dataset.closeModal));
  }
  for (const id of ['toolsModal', 'probeModal']) {
    $(id)?.addEventListener('click', (e) => { if (e.target === $(id)) closeRailModal(id); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menuProjectId) { e.preventDefault(); closeProjectMenu(); return; }
    if ($('consoleModal')?.hidden === false) { e.preventDefault(); closeConsole(); return; }
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
    const menu = e.target.closest('[data-menu-project]');
    if (menu) {
      e.preventDefault();
      e.stopPropagation();
      const box = menu.getBoundingClientRect();
      openProjectMenu(menu.dataset.menuProject, box.left, box.bottom + 4);
      return;
    }
    const stop = e.target.closest('[data-interrupt]');
    if (stop) { interruptSession(stop.dataset.interrupt); return; }
    const project = e.target.closest('[data-project]');
    if (project) { openProjectChat(project.dataset.project); return; }
  });

  // Right-click and Shift+F10 open the same menu; the ⋯ is the visible door.
  $('projectTree').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tree-row.project');
    if (!row) return;
    e.preventDefault();
    openProjectMenu(row.dataset.projectRow, e.clientX, e.clientY);
  });
  $('projectTree').addEventListener('keydown', (e) => {
    if (e.key !== 'F10' || !e.shiftKey) return;
    const row = e.target.closest('.tree-row.project');
    if (!row) return;
    e.preventDefault();
    const btn = row.querySelector('[data-menu-project]');
    const box = btn?.getBoundingClientRect();
    openProjectMenu(row.dataset.projectRow, box?.left || 8, (box?.bottom || 8) + 4);
  });
  // A menu item, then the click that follows it, then anything outside.
  $('projectMenu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-menu-action]');
    if (!item) return;
    const id = menuProjectId;
    closeProjectMenu();
    projectMenuAction(id, item.dataset.menuAction);
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

  // A click on an unfocused window is two things at once on Windows: it brings
  // the window forward *and* it arrives at the page under the pointer. If a card
  // is where the operator clicked to get back to Synapse, that one press must not
  // be read as an answer — the card stays, and the click after it decides.
  window.addEventListener('focus', () => { state.focusAt = Date.now(); });
  /**
   * Was this click only the wake-up for a card that appeared under the pointer?
   *
   * A click within 400ms of the window gaining focus is suspicious, but that is
   * not enough to refuse it: coming back to a card that has been waiting for a
   * minute and clicking Allow is an answer. Only a card drawn in the last two
   * seconds can have flashed under the pointer unseen, and only that one is held
   * for a second click. Keyboard activations are never a wake click (there is no
   * pointer to land on), and the first refused click leaves an inline note on the
   * card — the next click on the same card is taken.
   */
  function wakeClick(e, requestId) {
    if (state.permWakeOk?.delete(requestId)) return false;
    if (!e || e.detail === 0) return false;
    if (Date.now() - (state.focusAt || 0) >= 400) return false;
    const seen = state.permSeen?.get(requestId) || 0;
    if (Date.now() - seen >= 2000) return false;
    state.permWakeOk?.add(requestId);
    return true;
  }

  /** Say, on the card itself, that the window came forward with the press. A toast
   *  for this was a second interruption on top of the one it described. */
  function showPermWake(el) {
    const card = el?.closest?.('.perm-card');
    if (!card) return;
    let note = card.querySelector('.perm-waking');
    if (!note) {
      note = document.createElement('p');
      note.className = 'perm-waking';
      note.textContent = 'Click again to answer — the first click only brought the window forward.';
      card.querySelector('.perm-actions')?.before(note);
    }
    setTimeout(() => { try { note.remove(); } catch { /* card already gone */ } }, 3000);
  }

  // mockup affordances: clearly announce what is not wired yet
  document.addEventListener('click', (e) => {
    // a click anywhere outside the open model menu closes it
    if (menuRole && !e.target.closest('.model-search') && !e.target.closest('#modelMenu')) closeModelMenu();

    const resetAsks = e.target.closest('[data-reset-asks]');
    if (resetAsks) { e.preventDefault(); resetModelAsks(); return; }

    const clearTools = e.target.closest('[data-clear-tools]');
    if (clearTools) { e.preventDefault(); clearToolCensus(); return; }

    const perm = e.target.closest('[data-perm]');
    if (perm) {
      e.preventDefault();
      if (wakeClick(e, perm.dataset.permId)) { showPermWake(perm); return; }
      replyPermission(perm.dataset.permId, perm.dataset.perm);
      return;
    }

    const permStop = e.target.closest('[data-perm-stop]');
    if (permStop) {
      e.preventDefault();
      if (wakeClick(e, permStop.dataset.permStop)) { showPermWake(permStop); return; }
      stopFromPermission(permStop.dataset.permStop);
      return;
    }

    // Reject With Reason: the dialog takes the sentence, the card stays until it
    // is submitted or cancelled.
    const permReason = e.target.closest('[data-perm-reason-open]');
    if (permReason) {
      e.preventDefault();
      if (wakeClick(e, permReason.dataset.permReasonOpen)) { showPermWake(permReason); return; }
      openPermReason(permReason.dataset.permReasonOpen);
      return;
    }

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

  // The shutdown warning has one meaning for every way out of it: stay on. The
  // button, a click on the backdrop, and Escape all cancel; nothing else closes it,
  // because a dialog that dismisses itself is a shutdown nobody agreed to.
  $('cancelShutdown').addEventListener('click', () => cancelShutdown());
  $('shutdownModal').addEventListener('click', (e) => {
    if (e.target === $('shutdownModal')) cancelShutdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('shutdownModal').hidden) {
      e.preventDefault();
      cancelShutdown();
    }
  });
  $('dialogClose').addEventListener('click', () => closeDialog(null));
  // Reject With Reason: Cancel and a click outside both return to the pending
  // card without answering it; Escape does the same; Enter submits.
  $('permReasonCancel').addEventListener('click', closePermReason);
  $('permReasonSend').addEventListener('click', submitPermReason);
  $('permReasonModal').addEventListener('click', (e) => {
    if (e.target === $('permReasonModal')) closePermReason();
  });
  $('permReasonInput').addEventListener('input', () => {
    const send = $('permReasonSend');
    if (send) send.disabled = !String($('permReasonInput').value || '').trim();
  });
  $('permReasonInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitPermReason();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('permReasonModal').hidden) {
      e.preventDefault();
      closePermReason();
    }
  });
  $('dialogModal').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); $('dialogOk').click(); } });

  $('closeError').addEventListener('click', closeError);
  $('closeErrorTop').addEventListener('click', closeError);
  $('copyError').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('errorText').textContent);
      toast('Copied', 'Error text is on the clipboard.');
    } catch {
      toast('Copy failed', 'Clipboard access was blocked.');
    }
  });
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
  // The composer grows as the operator types or attaches a file, and the dock's
  // height is measured from the composer's (see fitChatHeight: on a narrow window
  // the chat is given whatever room is left under the cards). Measured 27 Oct at
  // 1076px wide: with the note gone and the eight-second poll no longer repainting,
  // a long draft left the transcript's bottom 112px behind the composer — the dock
  // kept the height it had before the box grew. Watching the composer is the event
  // that actually means "the floor moved"; a poll was only ever an approximation
  // of it, eight seconds late and once per run for no reason.
  if (window.ResizeObserver) {
    let composerRaf = 0;
    new ResizeObserver(() => {
      if (composerRaf) return;
      composerRaf = requestAnimationFrame(() => {
        composerRaf = 0;
        if (state.view === 'session') fitChatHeight();
      });
    }).observe($('composer'));
  }
  // Fonts settle a tick after first paint; measure once more when they do.
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (state.view === 'session') applyRoleCardsLayout({ animate: false, remeasure: true });
    }).catch(() => {});
  }

  // The chat's geometry is watched by reading it every frame (see
  // watchChatGeometry), which is what keeps the conversation still while the box
  // around it moves — in either layout, for any reason the box moves.
  watchChatGeometry();

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
  // The console panel draws the rail's status dots, and they are drawn in this
  // file: the module asks for the function rather than importing it.
  consoleWiring({ onStatusChange: renderStatus });
  // The Settings panes need the update page's two halves and its "checking" flag,
  // which live in this file: the module asks for them rather than importing them.
  panesWiring({
    updateSubText,
    updateBodyHtml,
    updateChecking: () => updateChecking,
  });
  // The Providers pane flushes its fields into the draft and re-renders the window,
  // and asks before removing a provider a role is using: all four live here.
  providersWiring({ collectSettings, renderSettings, openDialog, toast });
  // The chat's non-message lines need the project on screen, the folder key, a
  // role's name and the lease clock.
  chatNotesWiring({ currentProject, dirKey, roleLabel });
  // The card's rate corner needs the run on screen, the model behind a ref and the
  // token formatter.
  rateViewWiring({ dirKey, currentRun, modelByRef, selectionFor, fmtTokens });
  // The chat's scrolling and its streaming panel redraw the transcript, find the
  // trace a piece of writing belongs to, and need the question post as a jump target.
  chatScrollWiring({ renderTranscript, traceOf, currentRun, askHost });
  // A trace that ends has to be redrawn where it stands.
  tracesWiring({ renderTranscript });
  // The transcript asks the app for its height, the cards' activity, the question
  // post, the permission cards and the compact post's metadata.
  transcriptWiring({ fitChatHeight, renderRoleActivity, mountAskPost, renderPermissions, compactPostOf });
  // The dock asks the app to reload the conversation, the cards that are waiting, the
  // compact chip and the rail.
  composerWiring({ loadMessages, refreshPending, renderCompactChip, renderTree });
  // The question post asks the app how long an answer waits, and tells it to refresh
  // the waiting cards and the rail.
  askPanelWiring({ answerWaitSec, refreshPending, renderTree });
  // A plan row and a role card are two views of the same worker, so the pane asks for
  // the cards' activity and the chime's "is more work coming?".
  planPaneWiring({ noteWorking, renderRoleActivity });
  // The rail asks the app to make a chat, open one, set the status chip and show the
  // empty view.
  projectsWiring({ createChat, openSession, setEventChip, showNothing });
  // The model menu asks for the labels, the issues title and the select fill.
  modelPickerWiring({ fillRoleModels, modelLabel, modelMeta, modelTitle, issuesTitle });
  // The compact chip opens the new chat; the role cards ask for their labels, the
  // settings dialog and the cards' activity.
  compactWiring({ openSession });
  roleModelsWiring({ modelLabel, modelTitle, openDialog, renderRoleActivity });
  // The project menu asks for the dialog, opening a chat, the empty view and the slug.
  projectMenuWiring({ openDialog, openSession, showNothing, slug });
  // The run's cards need their layout (they move with the stage) and the desk badge.
  liveRunsWiring({ applyRoleCardsLayout, renderDesk });
  // The poll for waiting cards needs the chime's answer and the status chip.
  pendingWiring({ noteWorking, settleEventChip });
  initShellChannel();
  // Before anything is measured: the cards need their role id and their
  // subtitle slot, and a card's height is what the wrapper is measured against.
  initRoleCards();
  fitStageHeight();
  // The stage is a window measurement, so it has to follow the window: without
  // this a resize left the old height in place and the page grew a scrollbar.
  window.addEventListener('resize', fitStageHeight);
  state.config = await api('GET', '/api/config').catch(() => null);
  applyChatText();
  applyLanguage();
  renderLlmStatus();
  // every new session starts Single; an opened session sets its own mode
  state.mode = 'single';
  renderMode();
  setView();
  await refreshStatus();
  await refreshRemote();
  await refreshUpdates();
  await loadModels();
  await loadProjects();
  // The Prohibited pane needs the built-in list from the server; one read here
  // means the tab opens instantly and the rows are never guessed at.
  await loadProtection();
  await restoreOpenSession();
  await checkSkills();
  await loadRuns();
  await loadDesk();
  renderTranscript();
  connectStream();
  refreshPending();
  renderProbe();
}

/** Where the operator was when they last had this page open.
 *
 * A question waiting or a turn in flight is the session they left whatever the
 * last page thought; otherwise it is the session they last opened. With one chat
 * per project, a session that a compact replaced is gone — so the last *project*
 * is remembered too, and its current chat is opened instead.
 */
const LAST_SESSION_KEY = 'synapse.lastSession';
const LAST_PROJECT_KEY = 'synapse.lastProject';
function rememberSession(id) {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
    const project = projectOf(id);
    if (project) localStorage.setItem(LAST_PROJECT_KEY, project.id);
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
  if (!target) {
    // The session was replaced by a compact, or deleted: open the project's
    // current chat rather than an empty screen.
    let savedProject = null;
    try { savedProject = localStorage.getItem(LAST_PROJECT_KEY); } catch { /* blocked storage */ }
    const project = savedProject ? state.projects.find((p) => p.id === savedProject) : null;
    const chat = project ? newestSession(project) : null;
    if (chat) target = chat.id;
  }
  if (!target) return;
  await openSession(target);
}

boot();

