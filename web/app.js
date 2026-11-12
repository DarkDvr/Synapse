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
import { esc, relTime, hhmm, hhmmss, toolTarget, versionTag, shortSpan, fmtBytes, samePath, ago, shortName } from './format.js';
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
  noteArchitectCompaction,
  lastPromptOf,
  noteWorkerUsage,
  paintRates,
  rateViewWiring,
} from './rate-view.js';
import {
  noteChatScroll,
  noteUserScrollIntent,
  chatFollows,
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
  CHAT_FOLLOW_SLACK,
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
  browserLine,
  endsInProseToolCall,
  transcriptWiring,
} from './transcript.js';
import { toast } from './toast.js';
import { paneWiring, paneToggle } from './thinking-pane.js';
import {
  renderComposer,
  send,
  reuseMessage,
  addAttachmentFiles,
  onComposerPaste,
  renderAttachments,
  showAttachPreview,
  hideAttachPreview,
  installPreviewDismiss,
  showChatImagePreview,
  interrupt,
  interruptSession,
  autoGrow,
  composerWiring,
} from './composer.js';
import {
  renderAskPanel,
  askHost,
  mountAskPost,
  refreshAskPanel,
  replyForm,
  moveAskPage,
  syncAskCustoms,
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
  noteWorkerPermission,
  liveRunsWiring,
} from './live-runs.js';
import { refreshPending, schedulePendingRefresh, schedulePermissionRender, pendingWiring } from './pending.js';
import { openRailModal, closeRailModal, renderToolUsage, renderProbe, replyPermission } from './tool-panels.js';
import {
  renderSettings,
  updateSettingsFoot,
  collectSettings,
  switchSettingsTab,
  onSettingsInput,
  onSettingsClick,
  browserSigninSettled,
  openSettings,
  closeSettings,
  revertSettings,
  saveSettings,
  loadProtection,
  resetModelAsks,
  clearToolCensus,
  settingsWindowWiring,
} from './settings-window.js';
import {
  openError,
  openAlarm,
  closeError,
  openProhibition,
  openDialog,
  readDialog,
  closeDialog,
  dialogDismissable,
  dialogOkResult,
} from './dialog.js';
import { loadClocks, tickClocks, clocksWiring } from './clocks.js';
import {
  refreshRemote,
  renderRemote,
  renderClients,
  showDisconnected,
  clearDisconnected,
  copyRemoteToken,
  toggleRemote,
} from './remote-access.js';
import { renderDesk, takeBackScreen } from './desk.js';
import { renderStatus, renderLastEventAge, renderLlmStatus, refreshStatus } from './status-line.js';
import {
  refreshUpdates,
  renderUpdateChip,
  updateSubText,
  updateBodyHtml,
  renderUpdateViews,
  pushUpdateLog,
  checkUpdates,
  applyEngineUpdate,
  applySynapseUpdate,
  setEventChip,
  settleEventChip,
  updateChecking,
  WORK_EVENT,
  engineUpdatesWiring,
} from './engine-updates.js';
import { setIcon } from './icons.js';
import { api, serverNow } from './api.js';
import { $, debounce } from './dom.js';
import { initShellChannel, openConsole, closeConsole, consoleWiring } from './console.js';
import { addSample, rateOf } from './rate.js';
import { doneSoundName, workWillContinue } from './notify.js';
import { askHeadNote, answerTimeline, permissionNote } from './ask-note.js';
import { AUTOMATION_DEFAULTS, AUTOMATION_ROWS, anyAutomationOn } from './automation.js';
import { reconcileRuns } from './runs-sync.js';
import { SETTINGS_TABS, PANES, panesWiring } from './settings-panes.js';
import { applyChatText, applyLanguage } from './ui-prefs.js';
import { installChatZoom } from './chat-zoom.js';


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
const soundCache = new Map();
/** Play one file from `web/sounds` once. Any failure is silence: a missing audio
 *  device, or a browser that wants a gesture first, must never surface as an error
 *  in the chat. */
function playSound(name) {
  if (!name || name === 'off') return;
  try {
    let el = soundCache.get(name);
    if (!el) {
      el = new Audio(`/sounds/${name}.wav`);
      el.preload = 'auto';
      soundCache.set(name, el);
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

/** Play the chosen finished-work sound, if the operator wants one. */
/**
 * The window blinks in the taskbar when the work ends: the page knows, the taskbar
 * belongs to the shell, and the marker line is how it hears (12 Nov).
 */
function blinkTaskbar(what) {
  api('POST', '/api/attention', { what }).catch(() => {});
}

function playDoneSound(value = state.config?.notify?.doneSound) {
  if (String(value ?? 'off') === 'off') return;
  playSound(doneSoundName(String(value ?? 'off')));
}

// One chime per finished piece of work, and none for a stop or a failure: the sound
// means "the Architect is done", so it must not say that when the work was cut short.
// The memory itself is `state.workWasLive` / `state.workEndQuiet`, because the run
// stream in live-runs.js sees `run.stopping` before this file sees the work end.

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
  // Which chat was working when this was last evaluated. Opening another project is not
  // the work finishing — that reading belonged to a different session, and the chime
  // played for a project finished hours earlier (12 Nov).
  if (live) state.workLiveSession = state.sessionId;
  if (live) {
    // A *new* piece of work is what clears the last verdict. Clearing it on every
    // evaluation would undo it here: after a failed turn the project lock is still
    // held for a moment, so the page reads "still working" once more and would then
    // chime when the lock goes — for a turn that failed.
    if (!state.workWasLive) state.workEndQuiet = false;
    state.workWasLive = true;
    // Work has resumed, so the Architect is not finished after all: a shutdown
    // waiting on silence is waiting on nothing. (The first evaluation, before any
    // work has run, also lands here — and disarms nothing that was not armed.)
    cancelShutdown();
    return;
  }
  if (!state.workWasLive) return;
  // A different chat is on screen now: whatever was working is not this. Drop the
  // reading quietly rather than announcing the end of a project we are only visiting.
  if (state.workLiveSession && state.workLiveSession !== state.sessionId) {
    state.workWasLive = false;
    state.workLiveSession = null;
    return;
  }
  if (workWillContinue({ mode: state.mode, auto: state.automation?.keepBuilding === true, tasks: state.planState?.plan?.tasks || [] })) return;
  state.workWasLive = false;
  if (state.workEndQuiet) {
    state.workEndQuiet = false;
    return;
  }
  // The sound and the taskbar blink are the same news: the work ended while the
  // operator was looking elsewhere (12 Nov).
  blinkTaskbar('work finished');
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

// ── models / modes ──────────────────────────────────────────────

/**
 * What the config says each model's window is, as one string.
 *
 * Only used to notice that a window *changed* — a run measuring the server's real
 * one, or the operator typing it. The catalog the corner draws from is built when
 * the engine starts, so a changed window means the catalog has to be read again.
 */
const windowSignature = (c) =>
  (c?.engine?.opencode?.providers || [])
    .map((p) => `${p.id}:${(p.models || []).map((m) => `${m.id}=${m.context}`).join(',')}`)
    .join('|');

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


// The plan's fade needs asking again once a mode switch has settled.
let planFadeTimer = 0;


function topologyTarget() {
  const wrap = $('topologyWrap');
  const topo = $('topology');
  return wrap && topo ? { wrap, topo } : null;
}

/**
 * The cards are no longer sized: the stage's grid gives each part its own cell, so
 * the chat sits under the bar in Single and beside the stack in Multi without
 * anything here measuring a height or animating one.
 *
 * What is left is the two jobs that were never about height — showing the workers
 * at all (Settings > Worker cards), and letting the plan ask for its fade again
 * once a switch has settled.
 */
function applyRoleCardsLayout() {
  if (state.view !== 'session') return;
  if (state.workersOn !== false) document.body.classList.add('workers-on');
  clearTimeout(planFadeTimer);
  planFadeTimer = setTimeout(() => { updatePlanOverflow(); }, 340);
  requestAnimationFrame(drawActivePath);
}

// Which mode the composer is set to. It is a choice about the *next message*,
// not engine state: the toggle used to PATCH the session's ruleset on every
// click, so a click and a send could disagree and a busy check had to guard it.
// Now a click only changes what the send will say, and `sendMessage` applies the
// mode once, before the prompt.
function applyMode(mode) {
  if (mode !== 'single' && mode !== 'multi') return;
  if (state.mode === mode) return;
  // Keep the last line showing. Not the scroll offset: the chat's width and height
  // both change across a switch, so the text re-wraps and the same offset lands on
  // different words. What is remembered is the *element* at the bottom edge and
  // how far its bottom sits above the scroller's bottom — put back after the reflow
  // and that same line is again the last one you can see.
  const scroller = $('transcript');
  const anchor = bottomAnchor(scroller);
  let interfered = false;
  // If the reader scrolls during the quarter second of the switch, their place
  // wins: the restore is cancelled rather than yanking them back.
  const cancel = () => { interfered = true; };
  scroller?.addEventListener('wheel', cancel, { passive: true, once: true });
  scroller?.addEventListener('touchmove', cancel, { passive: true, once: true });
  state.mode = mode;
  renderMode();
  renderPlan();
  setView();
  settleBottomLine(scroller, anchor, () => interfered);
}

/** The last transcript element whose bottom edge is inside the scroller, and the
 *  gap under it. Null when the chat is empty or nothing is fully visible. */
function bottomAnchor(scroller) {
  if (!scroller) return null;
  const box = scroller.getBoundingClientRect();
  for (let i = scroller.children.length - 1; i >= 0; i--) {
    const el = scroller.children[i];
    const r = el.getBoundingClientRect();
    if (r.height && r.bottom <= box.bottom + 1) return { el, gap: box.bottom - r.bottom };
  }
  return null;
}

function settleBottomLine(scroller, anchor, interfered) {
  if (!scroller || !anchor) return;
  let done = false;
  let raf = 0;
  // Hold the line on every frame of the switch, not at the end of it: the text is
  // re-wrapping the whole time (the chat is getting wider or narrower), so a single
  // correction when the columns stop would show the bottom edge drifting for a
  // quarter of a second and then jumping back.
  const hold = () => {
    if (done) return;
    if (interfered() || !anchor.el.isConnected) return finish();
    const r = anchor.el.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    // The element's place in the *content*, which scrolling cannot change. Reading
    // the viewport position and adding a delta to `scrollTop` made the next frame's
    // reading depend on this frame's write — the bottom line then flickered between
    // two elements for the length of the switch, which is worse than the drift.
    const contentTop = r.top - box.top + scroller.scrollTop;
    const target = contentTop + r.height + anchor.gap - scroller.clientHeight;
    if (Math.abs(target - scroller.scrollTop) > 0.5) scroller.scrollTop = target;
    raf = requestAnimationFrame(hold);
  };
  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    stage.removeEventListener('transitionend', onEnd);
    clearTimeout(timer);
    if (interfered() || !anchor.el.isConnected) return;
    // Within two lines of the end is the end — the app's own rule for following a
    // run, and what stops the chat settling a hair short of the newest message.
    const end = scroller.scrollHeight - scroller.clientHeight;
    if (end - scroller.scrollTop <= CHAT_FOLLOW_SLACK) scroller.scrollTop = end;
  };
  const onEnd = (event) => { if (event.propertyName === 'grid-template-columns') finish(); };
  const stage = $('stage');
  stage?.addEventListener('transitionend', onEnd);
  // Fallback for reduced motion and for a switch with no transition running at
  // all: the same settle, once, a little after the click.
  const timer = setTimeout(finish, 400);
  raf = requestAnimationFrame(hold);
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
  state.workWasLive = sessionWorking(id);
  state.workEndQuiet = false;
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

// ── the Architect's post, opened on its first token ─────────────
//
// The engine creates the assistant message on its own schedule, and until it does
// the page had nowhere to put the turn: the card said "Thinking" while the chat sat
// still, and the post appeared when the step ended — the operator's "harness just
// sits there without even opening Architect's post, then it eventually appears"
// (10 Nov). So the page opens the post itself, on the first delta of any kind, and
// the engine's own message replaces it on the next transcript load. It is the same
// promise a steer makes, kept in the same place: a `local-` message that lives
// until the engine echoes it.
function ensureLivePost() {
  if (!state.sessionId) return false;
  const msgs = state.messages || [];
  const last = msgs[msgs.length - 1];
  // A turn that already has its post, or a placeholder from a moment ago, and there
  // is nothing to open. `completed` is the engine's own word for a message it will
  // not add to any more.
  if (last && last.type === 'assistant' && !last.completed) return false;
  msgs.push({
    id: `local-live-${state.sessionId}-${Date.now()}`,
    type: 'assistant',
    created: Date.now(),
    completed: false,
    live: true,
    parts: [],
  });
  return true;
}

/** The placeholder goes when the turn does, so a ghost post cannot outlive it. */
function dropLivePost() {
  const msgs = state.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last || !String(last.id || '').startsWith('local-live-')) return false;
  state.messages = msgs.slice(0, -1);
  return true;
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
    // The post the page opened for a turn the engine has not written yet. It stays
    // until the transcript ends with an assistant message — the engine's own record
    // of that turn — and no longer (see ensureLivePost).
    const tail = loaded[loaded.length - 1];
    const live = tail && tail.type === 'assistant'
      ? []
      : (state.messages || []).filter((m) => String(m?.id || '').startsWith('local-live-'));
    const echoed = new Set(loaded.map((m) => String(m.text || '')));
    state.messages = [...loaded, ...live, ...pending.filter((m) => !echoed.has(String(m.text || '')))];
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
  // A sign-in is a window on the operator's own desktop, so the sentence names the site
  // and says what the window is for (12 Nov).
  if (p.scope === 'browser') {
    const site = String(p.browserHost || p.browserUrl || '').replace(/^https?:\/\//i, '').split('/')[0];
    return `${actor} wants to open a browser window so you can sign in${site ? ` to ${site}` : ''}.`;
  }
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
      const browserAsk = p.scope === 'browser';
      return `<div class="perm-card${screen ? ' is-screen' : ''}">
        <div class="perm-head"><span class="status-dot warn" role="img" aria-label="waiting"></span><span class="perm-head-text">${esc(
          actor,
        )} needs your ${browserAsk ? 'sign-in' : screen ? 'screen' : 'permission'}</span>${
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
              : browserAsk
                ? 'Open a window on the monitor you are looking at. It waits as long as you need; close it without signing in and this counts as a rejection.'
                : 'Do it this time only.'
          }">${screen ? 'Allow Screen' : browserAsk ? 'Allow Sign-In' : 'Allow Once'}</button>
          ${
            screen || browserAsk
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
    if (ev.kind === 'config') {      // A run can save the config too: it measures the server's real window for the
      // model it used. The catalog the corner draws from was built when the engine
      // started, so a window that changed has to be re-read — otherwise the page
      // keeps showing a number nobody budgets for (7 Nov).
      const windowsBefore = windowSignature(state.config);
      state.config = ev.config || state.config;
      if (windowSignature(state.config) !== windowsBefore) loadModels().catch(() => {});
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
        // A save can change how the transcript is drawn — the worker tool cards are
        // one — and a rendering switch that waits for the next event looks broken on
        // a quiet project (8 Nov).
        renderTranscript();
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
      // The lease has its own two sounds — rising when the AI takes the mouse and
      // keyboard, falling when it gives them back — so the finished-work chime keeps
      // its one meaning. Off with one checkbox (Settings → General → Screen sounds);
      // the badge and the toast still say it in words.
      if (state.config?.notify?.screenSounds !== false) {
        if (ev.type === 'desk.taken') playSound('screen-in');
        else if (ev.type === 'desk.released') playSound('screen-out');
      }
      if (ev.type === 'desk.released') {
        // No finished-work chime here: it used to play one as a "you can come back"
        // signal, and the operator heard it mid-run and read it as the job being
        // finished (7 Nov) — the same sound, two meanings. The toast says the screen
        // is free; the falling chime says the machine is theirs again.
        toast('Screen Released', 'The AI is not using your mouse or keyboard any more.');
      }
      return;
    }

    // The session is real and the window is already closed by the watcher, so the operator
    // has nothing left to do. A session that did not take never becomes a row that says it
    // did: the row is written only after the page stopped asking to be signed into.
    if (ev.kind === 'browser-session-kept') {
      browserSigninSettled();
      toast('Session Kept', `${ev.host || 'That site'} — signed in, and the window was closed for you.`);
      const sites = state.config?.browser?.sites;
      if (Array.isArray(sites)) {
        if (!sites.some((site) => site.host === ev.host)) {
          sites.unshift({ host: ev.host, url: ev.url || '', signedInAt: ev.ts || Date.now(), lastUsedAt: ev.ts || Date.now() });
        }
        if (state.setDraft?.browser) state.setDraft.browser.sites = sites;
        if (!$('settingsModal')?.hidden && state.settingsTab === 'browser') renderSettings();
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
      // A worker's answer belongs in its trace, where the work is, and it goes in
      // now — not on the next poll. The Architect's sits on its own tool card.
      noteWorkerPermission(decided);
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
      // The countdown is running: a person has to see it, wherever they are (12 Nov).
      blinkTaskbar('the PC is about to shut down');
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
    // so the picker shows it now rather than after the next reload. A window that
    // was just measured arrives the same way, so the card's corner is repainted
    // from the catalog it has just re-read (8 Nov).
    if (ev.kind === 'model') {
      refreshModels().then(() => paintRates());
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
      // A run the harness stopped is the other moment the work ends while the
      // operator is looking elsewhere: the same news, so the same blink (12 Nov).
      if (/stopped/i.test(String(ev.title || ''))) blinkTaskbar('run stopped');
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
      // The size that caused it, from the run on screen: the compaction's own usage
      // is only readable once the summary is written, and the operator wants the
      // number while it runs (8 Nov).
      const run = currentRun();
      noteCompactionEvent(ev, { used: run?.ctx, limit: run?.ctxLimit });
      // The open session's own compaction: its card stops printing a size that is no
      // longer true, and says what is happening instead (13 Nov).
      if (ev.sessionId === state.sessionId) {
        if (ev.type === EV.compactionStarted) noteArchitectCompaction(ev.sessionId, 'start');
        else if (ev.type === EV.compactionEnded) noteArchitectCompaction(ev.sessionId, 'end');
        else if (ev.type === EV.compactionFailed) noteArchitectCompaction(ev.sessionId, 'end');
      }
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
      // The post is opened here, on the first byte of any kind, so the thinking has
      // somewhere to land the moment it starts arriving (10 Nov).
      if (ev.type === EV.textDelta) {
        ensureLivePost();
        noteDelta(ev);
        appendStream('word', ev.raw?.data?.delta);
      } else if (ev.type === EV.reasoningDelta) {
        ensureLivePost();
        noteDelta(ev);
        appendStream('think', ev.raw?.data?.delta);
      } else if (ev.type === EV.textEnded || ev.type === EV.reasoningEnded) {
        endStream();
      } else if (turnEnded(ev.type)) {
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
        // Say what a running tool is doing while it does it. A page load emits nothing
        // until it ends, and "Thinking…" for twenty seconds reads as a dead turn (11 Nov).
        if (ev.sessionId === state.sessionId) {
          const input = ev.data?.input ?? ev.input ?? null;
          const line = browserLine(input);
          if (line) {
            state.liveTool = line;
            ensureLivePost();
            renderTranscript();
          }
        }
      } else if (
        ev.type === EV.toolSuccess ||
        ev.type === EV.toolFailed ||
        ev.type === 'shell.exited' ||
        turnEnded(ev.type)
      ) {
        state.toolsInFlight.delete(ev.sessionId);
        if (state.liveTool && ev.sessionId === state.sessionId) {
          state.liveTool = null;
          renderTranscript();
        }
      }
    }

    // The turn ended because the model wrote a tool call into its answer instead of
    // making one: nothing ran. A notice, never a message — sending one after a turn is
    // what must not happen on its own (12 Nov).
    if (ev.kind === 'status' && ev.sessionId === state.sessionId && turnEnded(ev.type)) {
      if (endsInProseToolCall(state.messages)) {
        toast('The Model Wrote A Tool Call', 'It was text, so nothing ran. Say continue and it will carry on.');
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
        if (ev.type === EV.executionStarted) {
          state.busy = true;
          // Open the post now, not on the first delta: the model can spend many
          // seconds reading its prompt before it says anything, and the chat used to
          // sit empty for that whole time (11 Nov). The placeholder says "Thinking…"
          // until the first reasoning or tool arrives.
          if (ensureLivePost()) renderTranscript();
        }
        else if (turnEnded(ev.type) || ev.type === EV.idle) {
          state.busy = false;
          // A turn that ended without the engine ever writing its message would
          // leave the page's placeholder as an empty "Architect" post, so it goes
          // with the turn. The reload below puts the real one back when there is one.
          if (dropLivePost()) renderTranscript();
        }
        // A turn that failed or was interrupted is not "done": the chime stays quiet
        // for it, so the sound always means the work finished.
        if (ev.type === EV.executionFailed || ev.type === EV.executionInterrupted) state.workEndQuiet = true;
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
  // Ctrl + wheel and Ctrl + plus/minus move the chat's text size instead of the
  // window's own zoom: one setting, one number, the same bounds as the slider.
  installChatZoom();
  // A picture preview is anchored to a chip, and a scroll moves the chip without moving
  // the pointer — so nothing closes it. Any scroll, wheel or resize does now.
  installPreviewDismiss();
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
    // Pressing "to the end" is a downward intent: without saying so, the follow would
    // stay released after an upward scroll and the chat would stop following its own
    // turn until the next wheel notch (10 Nov).
    noteUserScrollIntent(1);
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
  // The gesture, before the scroll it causes arrives. Ctrl is not a scroll: that wheel
  // is the chat's text size (web/chat-zoom.js). The argument is the *intent*, not the
  // event: positive means "towards the end" (the keys below say +1 for PageDown), and a
  // wheel's deltaY is positive scrolling down — so `-e.deltaY` would call a wheel-up
  // "coming back to the end" and the follow would never let go.
  $('transcript').addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    noteUserScrollIntent(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });
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
  //
  // The box is `askHostBox`, not `askHost`: `askHost` is the accessor this module
  // imports from ask-panel.js, and a local of the same name hid it inside this
  // function. Harmless while nothing here called the accessor — which is exactly
  // the kind of trap that costs an hour the day someone does.
  const askHostBox = $('askHost');
  if (askHostBox) {
    askHostBox.addEventListener('input', (e) => {
      syncAskCustoms(e.target);
      refreshAskPanel();
    });
    askHostBox.addEventListener('change', (e) => {
      syncAskCustoms(e.target);
      refreshAskPanel();
    });
    askHostBox.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-form-reply]');
      if (btn) { replyForm(btn.dataset.formReply); return; }
      if (e.target.closest('[data-ask-next]')) { moveAskPage(1); return; }
      if (e.target.closest('[data-ask-back]')) { moveAskPage(-1); return; }
    });
    // The "Something Else" box is prose, not a one-line field: Enter starts a new
    // line there and Ctrl+Enter sends, the same as the chat composer. Every other
    // field keeps Enter-to-move-on.
    askHostBox.addEventListener('keydown', (e) => {
      if (e.target.closest?.('.ask-other-text')) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const next = askHostBox.querySelector('[data-ask-next]');
          if (next && !next.hidden) {
            if (!next.disabled) moveAskPage(1);
            return;
          }
          const btn = askHostBox.querySelector('[data-form-reply]');
          if (btn && !btn.disabled) replyForm(btn.dataset.formReply);
        }
        return;
      }
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      const next = askHostBox.querySelector('[data-ask-next]');
      if (next && !next.hidden) {
        if (!next.disabled) moveAskPage(1);
        return;
      }
      const btn = askHostBox.querySelector('[data-form-reply]');
      if (btn && !btn.disabled) replyForm(btn.dataset.formReply);
    });
    // A multi-line answer grows instead of hiding its own text.
    askHostBox.addEventListener('input', (e) => {
      if (e.target.classList?.contains('ask-other-text')) autoGrow(e.target);
    });
  }

  // Collapse or open one trace's thinking pane. The flag lives on the trace, so it
  // survives a re-render; a new pane is drawn open, because the operator's choice
  // was about the pane they were reading (9 Nov).
  function toggleThinking(key) {
    const trace = state.sessionTrace?.key === key ? state.sessionTrace : state.traces.get(key);
    if (trace) paneToggle(trace);
  }

  $('transcript').addEventListener('click', (e) => {
    // The ask panel is *inside* the transcript while a question is up, and it has
    // its own handler above: letting the click through here sent the answer twice
    // (6 Nov). The guard in replyForm is the belt to this brace.
    if (e.target.closest('.ask-panel')) return;
    const formBtn = e.target.closest('[data-form-reply]');
    if (formBtn) { replyForm(formBtn.dataset.formReply); return; }
    if (e.target.closest('[data-error]')) return; // the error button is not a toggle
    const think = e.target.closest('[data-think-toggle]');
    if (think) { toggleThinking(think.dataset.thinkToggle); return; }
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
  // Enter in the Sites table's last row means Sign In, which is a key event, not an
  // input one (11 Nov).
  $('settingsBody').addEventListener('keydown', onSettingsInput);
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

  // The engine's own version. The chip opens Settings > Check for Updates, which is
  // the one page that shows both feeds and the console: it used to open a popup with
  // the same two cards, a second surface to keep in step for a screen that already
  // exists (7 Nov).
  $('updateChip').addEventListener('click', () => {
    state.settingsTab = 'updates';
    openSettings();
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
    else if (!$('settingsModal').hidden) closeSettings();
  });

  window.addEventListener('resize', () => requestAnimationFrame(() => {
    fitStageHeight();
    if (state.view === 'session') applyRoleCardsLayout({ animate: false });
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

/**
 * Everything the page does to come up, with no guard of its own.
 *
 * Split from `boot()` for one reason: the guard has to cover the *whole* page, not
 * just the loads at the end. A throw in `wire()` leaves the same dead screen as a
 * throw in a fetch, and that is the one place a try around the loads would not have
 * reached.
 */
async function bootPage() {
  // The stream is the page's identity — a client id, the live feed, and the "this
  // view is connected" answer the Settings button needs. It goes first because
  // everything after it can fail, and a page that failed half way must still be
  // able to say so (7 Nov: a missing import left a rail with no chat and no
  // message, and the only way to find out was a --eval).
  connectStream();
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
  transcriptWiring({ renderRoleActivity, mountAskPost, renderPermissions, compactPostOf });
  // The dock asks the app to reload the conversation, the cards that are waiting, the
  // compact chip and the rail.
  composerWiring({ loadMessages, refreshPending, renderCompactChip, renderTree });
  // The question post asks the app how long an answer waits, and tells it to refresh
  // the waiting cards and the rail.
  askPanelWiring({ answerWaitSec, refreshPending, renderTree });
  // A plan row and a role card are two views of the same worker, so the pane asks for
  // the cards' activity and the chime's "is more work coming?".
  planPaneWiring({ noteWorking, renderRoleActivity });
  paneWiring({
    renderTranscript,
    atBottom: () => chatAtBottom(48) && chatFollows(),
    // `$` takes an id, not a selector. Written as `$('#transcript')` this returned
    // null, so the follow was a no-op from the day it was wired: the thinking pane
    // could grow the trace for minutes while the chat stayed put, and the newest
    // line sat under the composer (operator, 9 Nov).
    follow: () => {
      const el = $('transcript');
      if (el) el.scrollTop = el.scrollHeight;
    },
  });
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
  pendingWiring({ noteWorking, settleEventChip, playSound, blinkTaskbar });
  // The Settings window asks for the update actions, the model reload, the skills read,
  // the dialog, the status line and the preview sound.
  settingsWindowWiring({
    applyEngineUpdate,
    applySynapseUpdate,
    checkSkills,
    checkUpdates,
    loadModels,
    openDialog,
    playDoneSound,
    renderLlmStatus,
  });
  // The stopwatches share their tick with the status line's "last event" age.
  clocksWiring({ renderLastEventAge });
  // A new engine carries a new model catalog, so the update module asks for the reload.
  engineUpdatesWiring({ loadModels });
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
  refreshPending();
  renderProbe();
}

/**
 * The page's one entry point.
 *
 * `bootPage()` is the work; this is the promise that a failure in it is *said*.
 * Before this, a throw anywhere in the chain left a rail, no chat and no message —
 * the operator's only clue was that nothing worked.
 */
async function boot() {
  try {
    await bootPage();
  } catch (err) {
    bootFailed(err);
  } finally {
    // The page started, whatever else happened: this is what tells index.html's
    // ten-second fallback to stay quiet. It is set even when boot failed, because
    // that failure has already been said by then. A boot slower than the fallback
    // takes the warning back rather than leaving it on a page that works.
    window.__booted = true;
    for (const box of document.querySelectorAll('[data-boot-alert]')) box.remove();
    reportBootErrors();
  }
}

/** The page did not finish loading: say it, and keep what did load. */
function bootFailed(err) {
  console.error('boot failed:', err);
  try {
    openError('This page did not finish loading', String((err && (err.stack || err.message)) || err), {
      lead: 'Part of the page is missing or out of date. Reload it; if it comes back, the console has the detail.',
      note: 'Nothing was sent anywhere: this is the page, not the server.',
    });
  } catch { /* a dialog that cannot open is not worth crashing over */ }
}

/**
 * Whatever the trap in index.html caught while this page was coming up, said once.
 *
 * The trap exists so a `--eval` can find a dead page; this is the half that tells
 * the person in front of the screen. It only fires when there is something to say,
 * and it never replaces a dialog that is already open.
 */
function reportBootErrors() {
  const errs = Array.isArray(window.__errs) ? window.__errs : [];
  if (!errs.length) return;
  if (!$('errorModal').hidden) return;
  openError('This page has an error', errs.slice(0, 5).join('\n'), {
    lead: errs.length === 1 ? 'One error was raised while the page loaded.' : `${errs.length} errors were raised while the page loaded.`,
    note: 'Reload the page. If it comes back, Copy this and put it in a note.',
  });
}

// After boot, an uncaught error is a bug in a handler rather than a dead page: one
// toast per message, never a modal over what the operator is doing.
const pageErrorsSeen = new Set();
function notePageError(text) {
  const said = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!said || pageErrorsSeen.has(said) || pageErrorsSeen.size >= 3) return;
  pageErrorsSeen.add(said);
  toast('Page Error', said, 12000);
}
window.addEventListener('error', (e) => notePageError(e.message));
window.addEventListener('unhandledrejection', (e) => notePageError(e.reason && (e.reason.message || e.reason)));

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

