// The page's one store.
//
// It was a 160-line object literal at the top of app.js, which is where everything
// that reads it also lived. It is its own module now so the screens that come out of
// app.js next (settings, transcript, composer, rail) can share the same object
// without importing the file that wires the event handlers.
//
// It stays one mutable object on purpose: no framework, no subscriptions, no copy.
// A screen reads what it needs and the render functions are called by name.

export const state = {
  status: null,
  // What we know about the engine's own version: current, latest, where the
  // newer one was seen. `updating` is the one operation in the whole UI that
  // stops the engine, so it is a state of the app, not of a button.
  update: null,
  updating: false,
  // Synapse's own release, and the unified update dialog: which target is busy,
  // and the console lines both updaters append to.
  synapseUpdate: null,
  updateBusy: null, // 'engine' | 'synapse' | null
  updateLog: [],
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
  // The four automation switches for the open project — Keep Building,
  // Auto-Permissions, Auto-Answer, Auto-Shutdown. They live in the session's
  // metadata (src/automation.js); this is the copy the cog draws.
  automation: { keepBuilding: true, autoPermissions: false, autoAnswer: false, autoShutdown: false },
  permissions: [],
  // When this window last gained focus. A click that brings an unfocused window
  // forward lands on the page too, and an answer must be a click on a window the
  // operator was already using — see the permission handler (30 Oct).
  focusAt: 0,
  // When each permission card was first drawn, and which ones the operator has
  // already been told about a wake click. See wakeClick().
  permSeen: new Map(),
  permWakeOk: new Set(),
  busy: false,
  // A stop is in force — the operator pressed Stop, or the server said so. The page
  // draws the notice from this and never decides for itself that a stop is over (see
  // `stop.done`). The first press is graceful: the AI finishes the step, then ends; a
  // second press is the hard interrupt (see interrupt()).
  stopping: false,
  stoppingPhase: null,
  stoppingReason: null,
  // The done-chime's memory: was work live on the last look, and should this end be
  // silent because the operator stopped it. Shared with live-runs.js, which sees
  // `run.stopping` before the working state does.
  workWasLive: false,
  workEndQuiet: false,
  busySessions: new Set(),
  busySince: new Map(),
  toolsInFlight: new Set(),
  // What a tool is doing right now, in words, while it runs. A tool call emits nothing
  // until it finishes, so a 20-second page load in the chat looked like a dead turn — the
  // operator could not tell whether to wait (11 Nov). Set from the call's own input.
  liveTool: null,
  // Whether the engine reports any live session in the open session's project.
  // A hidden worker counts: that is the state where the Architect looks idle and
  // Stop used to be disabled while the run was still working.
  canStop: false,
  activeHere: 0,
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
  // The open session's own live step, in the same shape as a run's trace. The
  // Architect streams its thinking like a worker does, but it has no run record —
  // so without this its panel sat empty and the whole wall arrived when the step's
  // message was rebuilt (seen 2 Nov). `key` is `sess:<sessionId>` and is what the
  // panel is found by, exactly as a run's is.
  sessionTrace: { key: '', stream: null },
  // Signature of what the role cards are showing, so a poll that learned nothing
  // does not re-measure the wrapper and jiggle the chat.
  roleSig: '',
  forms: [],
  // Form ids already announced since this page loaded, so a waiting question is
  // announced once rather than on every poll.
  announcedForms: new Set(),
  // Permission request ids already announced; a hidden worker's request gets a
  // toast because its card is only in a transcript the operator has not opened.
  announcedPermissions: new Set(),
  // Permission decisions by tool-call id, for the chip on a tool card. Filled
  // from the stream while a session is open and fetched once when it is opened.
  permissionDecisions: new Map(),
  decisionsFor: null,
  // Bumped when a decision arrives, so the transcript's render signature notices
  // a chip that changed without any message changing.
  decisionSeq: 0,
  // 'single' (one Architect, all tools, no delegation) or 'multi' (delegation
  // allowed, role cards revealed). New sessions start single; the toggle
  // switches the open session live.
  mode: 'single',
  // A compact in flight: the chip says "Compacting…" and refuses a second click.
  // The chat is about to be replaced, so nothing else may be sent meanwhile.
  compacting: false,
  // Until when a first click on the chip is still a confirmation (three seconds).
  compactUntil: 0,
  streaming: false,
  streamLive: false,
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
  // Worker leases: a worker's own estimate of a long command, with a live clock in
  // the chat. Keyed `${dir}|${task}`.
  leases: new Map(),
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
  // Server clock minus this page's, in ms (see api()): every countdown compares
  // a server timestamp with "now", and a remote PC runs on its own clock.
  clockSkew: 0,
  // Which question of the form is on screen. A five-question form is five pages,
  // because the ones below the fold were being missed entirely.
  askPage: 0,
  // What the countdown beside the question's title is counting to: { here,
  // autoAnswer, wait, dueAt }. `dueAt` is the server's clock, in epoch ms.
  askNote: null,
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
  // The PROHIBITED list as the server sees it (built-ins and added paths). The
  // settings draft edits the *state* of an entry, never this list.
  protection: null,
};
