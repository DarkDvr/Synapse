// The Settings tabs and the panes they draw: one function per tab, returning
// markup only. They hold no state and call nothing that changes anything — the form
// is collected and saved by app.js — so a pane can be read as a list of fields.
//
// The tab ids here are the keys of the pane map at the bottom, and app.js adds the
// one pane that is not here: Providers, which is a real editor with its own state.
import { state } from './state.js';
import { esc } from './format.js';
import { readPath } from './settings-data.js';
import { setField, setSelect, setCheck, setGroup } from './settings-form.js';
import { DONE_SOUNDS, DONE_SOUND_DEFAULT, doneSoundName } from './notify.js';
import { CHAT_TEXT_DEFAULT, CHAT_TEXT_MIN, CHAT_TEXT_MAX, chatTextPx, LANGUAGES } from './ui-prefs.js';

// Three things in this module come from app.js: the two halves of the update page,
// and whether an update check is running. They are wired once at boot rather than
// imported, because each one reads state the app owns (the "checking" flag changes
// under it). Wired before any pane is drawn.
const wired = {
  updateSubText: () => '',
  updateBodyHtml: () => '',
  updateChecking: () => false,
};

export function panesWiring(fns) {
  Object.assign(wired, fns);
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

export const SETTINGS_TABS = [
  { id: 'general', label: 'General', icon: 'general' },
  { id: 'server', label: 'Server', icon: 'sliders' },
  { id: 'engine', label: 'Engine', icon: 'engine' },
  { id: 'providers', label: 'Providers', icon: 'plug' },
  { id: 'workers', label: 'Workers', icon: 'nodes' },
  { id: 'tools', label: 'Tools', icon: 'tools' },
  { id: 'automation', label: 'Automation', icon: 'automation' },
  { id: 'prohibited', label: 'Prohibited', icon: 'shield' },
  { id: 'logging', label: 'Logging', icon: 'lines' },
  { id: 'updates', label: 'Check for Updates', icon: 'refresh' },
  { id: 'about', label: 'About', icon: 'info' },
];

// The four form primitives (setField, setSelect, setCheck, setGroup) come from
// ./settings-form.js: every pane below is a list of them and nothing else.

// ── panes ───────────────────────────────────────────────────────

function settingsServer(c) {
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
      'Engine',
      setSelect(
        c,
        'Engine type',
        'engine.type',
        [{ v: 'opencode', l: 'OpenCode' }],
        { hint: 'Which agent engine Synapse drives. Only OpenCode is implemented.', restart: true },
      ) +
        setField(c, 'Engine port', 'engine.opencode.port', {
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
          hint: "Password for the engine's local API. Leave it blank to keep the password already saved.",
        }) +
        setField(c, 'Start timeout (seconds)', 'engine.opencode.startTimeoutMs', {
          type: 'number',
          scale: 1000,
          restart: true,
          hint: 'How long Synapse waits for the engine to report ready when it starts. Seconds.',
        }) +
        setField(c, 'Engine home (blank = data\\engine\\opencode)', 'engine.opencode.home', {
          wide: true,
          restart: true,
          value: homeValue,
          hint: 'Where the engine keeps its own settings, logs and data. Blank uses the copy inside Synapse; the machine-wide OpenCode install is never touched.',
        }) +
        `<p class="set-note">Running <strong>${esc(detected.version || 'not started')}</strong> from ` +
        `<code>${esc(detected.binary || 'auto-detected')}</code>.</p>` +
        `<div class="set-field wide" title="The model catalog ships inside the engine binary, so a stale model list means a stale copy. A copy inside bin\\opencode wins over a global install; Check for Updates fetches the newest from npm."><span>Engine version</span>` +
        `<button type="button" class="btn btn-secondary btn-sm" data-check-update>Check for Updates</button></div>`,
    ),
    setGroup(
      'Model Checks',
      setField(c, 'Max asks per model (1–20)', 'modelChecks.maxAsks', {
        type: 'number',
        hint: 'How many times Synapse may ask one model which tools it has before it stops asking. Between 1 and 20, counted across chats and restarts.',
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
      }),
      undefined,
      'The engine compacts at its own ceiling and keeps the last N tokens word for word; a smaller number means less to re-read after each compaction.',
    ),
  ].join('');
}

function settingsWorkers(c) {
  return [
    setGroup(
      'Looping',
      `<label class="set-check" title="Interrupts a worker that repeats one phrase or one command, and counts it. At the limit the model is marked and the task moves to the next coder.">` +
        `<input data-path="worker.loopGuard" type="checkbox" ${c.worker?.loopGuard !== false ? 'checked' : ''} />` +
        `<span>Detect looping</span></label>` +
        setField(c, 'Loops before the model is set aside', 'worker.loopLimit', {
          type: 'number',
          // A config saved before this existed has no key; the box shows the
          // default it would get rather than an empty field.
          value: c.worker?.loopLimit ?? 3,
          attr: 'min="1" max="20" step="1"',
          hint: 'How many loops one task may show before the model is marked ISSUES and the next coder takes over. 1 to 20.',
        }),
      undefined,
      'A loop is one phrase or one command repeated. Each rescue is one amber line; the third sends the task to the next coder.',
    ),
    setGroup(
      'Size and time',
      setField(c, 'Most steps per task (0 = no limit)', 'worker.maxTurns', {
        type: 'number',
        value: c.worker?.maxTurns ?? 80,
        attr: 'min="0" max="1000" step="1"',
        hint: 'A task that needs more steps than this is too big for one delegation: the run stops and the Architect is told to split it. Every step re-sends the whole conversation, so this is also the cost of one task. 0 turns the limit off.',
      }) +
        setField(c, 'Lease grace after a worker’s time is up (seconds)', 'worker.leaseGraceSec', {
          type: 'number',
          value: c.worker?.leaseGraceSec ?? 300,
          attr: 'min="5" max="3600" step="5"',
          hint: 'A worker can call lease before a long command. When the lease ends Synapse asks whether it needs more; this is how long it waits for that answer before treating the silence as a stall. One extension is allowed.',
        }),
      undefined,
      'A step is one model turn; a lease is a worker’s own warning that a command will be long.',
    ),
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
        }),
      undefined,
      'Rate limits and dropped connections are retried without spending an attempt. A retired model or a bad key is final, and reported.',
    ),
    setGroup(
      'Escalation',
      setField(c, 'Coder ladder (role ids, in order)', 'worker.ladder', {
        wide: true,
        value: (readPath(c, 'worker.ladder') || []).join(', '),
        hint: 'Roles that can stand in for one another, in escalation order. When a coder cannot do the job, the same task moves down this list.',
      }),
      undefined,
      'When a coder cannot do the job, the same task moves down this list — never to a role that is not on it.',
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
        `<p class="set-note">${esc(skillsSummary())}</p>`,
      undefined,
      "Synapse's own skills ship beside the app and always load; a name in both places loads the shipped copy.",
    ),
  ].join('');
}


/**
 * Settings → General: the interface's own choices, and the first tab because it is
 * where a person goes when they want Synapse to behave differently rather than the
 * engine to work differently. Everything here is read the moment it is saved: none
 * of it needs a restart.
 *
 * Two settings today. The chat's text size is one number, and the transcript is
 * drawn from it (web/synapse.css multiplies every size in the chat by `--chat-fs`);
 * the bounds are enforced here and again in the config, because a number typed into
 * a box is not a promise. The language list holds English alone until a
 * translation exists.
 */
function settingsGeneral(c) {
  const px = chatTextPx(readPath(c, 'ui.chatTextPx'));
  return [
    setGroup(
      'Interface',
      setField(c, 'Chat Text Size', 'ui.chatTextPx', {
        type: 'number',
        value: px,
        attr: `min="${CHAT_TEXT_MIN}" max="${CHAT_TEXT_MAX}" step="0.5"`,
        hint:
          'The size of the conversation — nothing else, not the rail, the cards or the composer. ' +
          `${CHAT_TEXT_MIN} to ${CHAT_TEXT_MAX} px, in half steps; ${CHAT_TEXT_DEFAULT} is the size the interface was designed around.`,
      }) +
        setSelect(
          c,
          'Language',
          'ui.language',
          LANGUAGES,
          {
            value: String(readPath(c, 'ui.language') || 'en'),
            hint: 'English for now; Russian is planned. Model output is never translated — it answers in the language you write to it.',
          },
        ) +
        setCheck(
          c,
          'Worker tool cards',
          'ui.workerCards',
          "Draw a worker's tool calls as the same one-line cards the Architect uses, instead of a plain grey sentence. Off restores the old notes; the switch takes effect on the next render.",
          readPath(c, 'ui.workerCards') !== false,
        ),
      undefined,
      'Scales the whole conversation, headings and code included. The smallest that still reads is ' +
        `${CHAT_TEXT_MIN}px; the largest that keeps an answer above the composer is ${CHAT_TEXT_MAX}px.`,
    ),
    // Notices lived in their own tab until 2 Nov. One setting does not need a
    // tab, and a tab that holds one setting is a place the operator forgets to
    // look. Same fields, same words.
    setGroup(
      'Finished Work',
      setSelect(c, 'Sound', 'notify.doneSound', DONE_SOUNDS, {
        value: doneSoundName(String(readPath(c, 'notify.doneSound') ?? DONE_SOUND_DEFAULT)),
        hint: 'Played when the chat you are looking at goes quiet after the Architect worked — its last words already on screen and nothing else running. Not on Stop, and not when the turn failed.',
      }) +
        `<div class="set-field" title="Hear the sound before you save it."><span>Preview</span>` +
        `<button type="button" class="btn btn-secondary btn-sm" data-test-sound>Play It</button></div>` +
        setCheck(
          c,
          'AI screen usage alerts',
          'notify.screenSounds',
          'A rising chime when the AI takes your mouse and keyboard, a falling one when it gives them back. Off leaves the badge and the toast, which say the same thing in words.',
        ),
      undefined,
      "Six short sounds, built into the app — four for finished work and two for the screen lease. Only the chat you are looking at chimes; a run elsewhere shows its dot in the rail.",
    ),
  ].join('');
}

/**
 * Settings → Automation: how patient the harness is.
 *
 * Four waits, one per switch, global — they describe the harness's patience, not
 * a project, so changing one applies to every project past and future. Which
 * switches are ON is per project: the cog in the chat, and the note here says so.
 * A new project starts with Keep Building on and the other three off.
 */
function settingsAutomation(c) {
  const num = (key, fallback) => {
    const n = Number(readPath(c, `automation.${key}`));
    return Number.isFinite(n) ? n : fallback;
  };
  return [
    setGroup(
      'Delays',
      setField(c, 'Keep Building — Wait Before the Next Task (seconds)', 'automation.keepBuildingSec', {
        type: 'number',
        value: num('keepBuildingSec', 5),
        attr: 'min="0" max="600" step="1"',
        hint: 'The pause between a worker’s report and the Architect starting the next task. Seconds, 0 to 600. Long enough to read the report if you are watching.',
      }) +
        setField(c, 'Auto-Permissions — Wait Before Allowing (seconds)', 'automation.permissionsSec', {
          type: 'number',
          value: num('permissionsSec', 10),
          attr: 'min="0" max="3600" step="1"',
          hint: 'How long a permission card waits before Auto-Permissions allows it once. Seconds, 0 to 3600. 0 allows at once, without drawing a card.',
        }) +
        setField(c, 'Auto-Answer — Wait Before Answering (seconds)', 'automation.answerSec', {
          type: 'number',
          value: num('answerSec', 30),
          attr: 'min="0" max="3600" step="1"',
          hint: 'How long a question waits before Auto-Answer takes the Recommended option (or the top one). Seconds, 0 to 3600.',
        }) +
        setField(c, 'Auto-Shutdown — Idle Time Before Turning Off (minutes)', 'automation.shutdownMin', {
          type: 'number',
          value: num('shutdownMin', 5),
          attr: 'min="1" max="180" step="1"',
          hint: 'How long Synapse waits with nothing running and nothing left to start before it shows the 20-second shutdown countdown. Minutes, 1 to 180.',
        }),
      undefined,
      'The waits all four switches obey. Which switches are on belongs to each project — the cog between Stop and Send.',
    ),
    setGroup(
      'Power',
      setCheck(
        c,
        'Keep PC Awake',
        'automation.keepAwake',
        'Hold a Windows wake lock so this PC does not sleep or hibernate while Synapse is running. Global: it applies to the machine, and the cog in the chat toggles the same switch.',
      ) +
        setCheck(
          c,
          'Also Keep The Monitor On',
          'automation.keepDisplay',
          'The amplified half: while Keep PC Awake is on, the screen is kept on too, instead of following Windows’ own turn-off time. Has no effect on its own.',
        ),
      undefined,
      'Keep PC Awake holds the system awake; Also Keep The Monitor On adds the display to the same request.',
    ),
  ].join('');
}

// ── Prohibited ──────────────────────────────────────────────────
// The PROHIBITED tier: paths Synapse may read and must never change. The list
// belongs to the server (src/protection.js); this pane edits only each entry's
// tick, so a built-in can be switched off but never deleted out of the file.
// The four handlers (load, tick, remove, add) stay in app.js: they edit the draft
// and re-render the window, which is the app's own state machine, not a pane's job.

function settingsProhibited(c) {
  const entries = state.protection?.entries || [];
  const builtins = entries.filter((entry) => entry.builtin);
  // Both lists store the refusals: an id in builtinsOff means its Write is cleared,
  // an id in builtinsSealed means its Read is cleared. The boxes are the permissions.
  const writeOff = new Set((c.protection?.builtinsOff || []).map(String));
  const readOff = new Set((c.protection?.builtinsSealed || []).map(String));
  const added = Array.isArray(c.protection?.paths) ? c.protection.paths : [];
  const boxes = (kind, key, write, read) => `
      <input type="checkbox" class="prot-check" data-prot-write="${esc(key)}" data-prot-kind="${kind}"${write ? ' checked' : ''}
             title="${write ? 'Changes allowed: untick to refuse every change to this path' : 'Changes refused before any permission card'}"
             aria-label="Allow changes to ${esc(key)}" />
      <input type="checkbox" class="prot-check" data-prot-read="${esc(key)}" data-prot-kind="${kind}"${read ? ' checked' : ''}
             title="${read ? 'Reads allowed: untick to refuse reads as well' : 'Reads refused: tick to allow reading this path'}"
             aria-label="Allow reads of ${esc(key)}" />`;
  const row = ({ kind, key, target, builtin, write, read }) => `
    <div class="prot-row">
      <span class="prot-path" title="${esc(target)}"><span class="prot-name">${esc(target)}</span>${builtin ? '<span class="prot-tag is-builtin">Built-in</span>' : ''}</span>
      ${boxes(kind, key, write, read)}
      ${builtin
        ? '<button type="button" class="prot-x" disabled title="Built-in paths can be switched off but not removed" aria-label="Built-in path, cannot be removed">✕</button>'
        : `<button type="button" class="prot-x" data-prot-del="${esc(target)}" title="Remove this path from the list" aria-label="Remove ${esc(target)}">✕</button>`}
    </div>`;
  const rows = [
    ...builtins.map((entry) =>
      row({
        kind: 'builtin',
        key: entry.id,
        target: entry.path,
        builtin: true,
        write: writeOff.has(entry.id),
        read: !readOff.has(entry.id),
      }),
    ),
    ...added.map((entry) =>
      row({
        kind: 'added',
        key: entry.path,
        target: entry.path,
        builtin: false,
        write: entry.write === true,
        read: entry.read === true,
      }),
    ),
  ].join('');
  return `
    <section class="set-group prot-pane">
      <h4 title="Built-in entries can be switched off but not removed; paths you add can be deleted. Each box is a permission: a cleared Write refuses every change to that path; a cleared Read refuses reading it too.">Prohibited</h4>
      <div class="prot-top">
        <p class="set-note">Tick the checkboxes to allow that action.</p>
        <div class="prov-add">
          <button type="button" class="btn btn-provider btn-sm" data-prot-add>+ Add Path</button>
          <div class="prov-add-menu" id="protAddMenu" hidden>
            <button type="button" data-prot-new="folder">Add Folder…</button>
            <button type="button" data-prot-new="file">Add File…</button>
          </div>
        </div>
      </div>
      <div class="prot-table">
        <div class="prot-row is-head" aria-hidden="true">
          <span class="prot-path">Path</span>
          <span class="prot-head">Write</span>
          <span class="prot-head">Read</span>
          <span class="prot-head"></span>
        </div>
        ${rows || '<div class="prot-empty">Loading the list…</div>'}
      </div>
    </section>`;
}

function settingsLogging(c) {
  const debugOn = readPath(c, 'logging.debug.enabled');
  return [
    setGroup(
      'Logging',
      `<p class="set-sub">App, engine, session &amp; tool logs:</p>` +
        setField(c, 'Retention (days)', 'logging.retentionDays', {
          type: 'number',
          hint: 'How many days the app, engine, session and tool logs are kept. Days.',
        }) +
        setField(c, 'Max file size (MB)', 'logging.maxFileMb', {
          type: 'number',
          hint: 'When a log file reaches this size it is rotated to a .1 file and a fresh one is started. Megabytes.',
        }) +
        setCheck(
          c,
          'Also enable Debug log (verbose):',
          'logging.debug.enabled',
          'Write everything, from every channel, into logs\debug.log. It is what to turn on to catch a tricky bug; it is bounded by the two numbers below.',
        ) +
        setField(c, 'Retention (days)', 'logging.debug.retentionDays', {
          type: 'number',
          hint: 'How many days debug.log is kept. Two is the default: the detail matters while the bug is fresh.',
        }) +
        setField(c, 'Max file size (MB)', 'logging.debug.maxFileMb', {
          type: 'number',
          hint: 'When debug.log reaches this size it is rotated to debug.1.log. Twenty megabytes is the default, because the chatter is enormous.',
        }),
      undefined,
      `One file per channel in logs\\. ${debugOn ? '' : 'The debug file is off, so only the channel files are written. '}The console mirrors warnings and errors from every channel; the provider diary keeps its own 30 days.`,
    ),
  ].join('');
}

// ── about ───────────────────────────────────────────────────────

/** A short, standard about page: mark, name, version, two empty lines, credits. */
function settingsAbout() {
  const version = String(state.status?.version || '').trim() || 'unknown';
  return `
    <div class="about">
      <img class="about-mark" src="/icon-64.png" alt="" width="56" height="56" />
      <h2>Synapse</h2>
      <p class="about-version">Version ${esc(version)}</p>
      <div class="about-gap" aria-hidden="true"></div>
      <dl class="about-facts">
        <dt>Created by</dt><dd>DarkDvr</dd>
        <dt>Contact</dt><dd><a href="mailto:darkdvr1@yandex.ru">darkdvr1@yandex.ru</a></dd>
        <dt>Source</dt><dd><a href="https://github.com/DarkDvr/Synapse" target="_blank" rel="noreferrer">github.com/DarkDvr/Synapse</a></dd>
        <dt>Licence</dt><dd>AGPL-3.0-only</dd>
      </dl>
      <p class="about-free">Free software: use it, share it, change it. Keep the copyright notices; a modified version must say so. No account, no subscription, no telemetry.</p>
      <div class="about-actions">
        <button class="btn btn-secondary btn-sm" type="button" data-close-about>Close</button>
      </div>
    </div>`;
}

/** Updates as a Settings page: the chip's two cards and console, with a Check
 *  Again button because the Settings footer has nothing to save here. */
function settingsUpdates() {
  const busy = state.updateBusy;
  return `
    <section class="set-group upd-pane">
      <h4>Updates</h4>
      <p class="set-note">${esc(wired.updateSubText())}</p>
      <div class="upd-pane-bar">
        <button class="btn btn-secondary btn-sm" type="button" data-check-updates ${busy || wired.updateChecking() ? 'disabled' : ''}>${wired.updateChecking() ? 'Checking…' : 'Check Again'}</button>
        ${busy ? '<span class="upd-note">An update is running. Settings stays open until it finishes.</span>' : ''}
      </div>
      ${wired.updateBodyHtml()}
    </section>`;
}

// The pane map: the tab id is the key, so a tab with no pane is impossible and a
// pane with no tab is unused. app.js adds `providers` to this object.
export const PANES = {
  general: settingsGeneral,
  server: settingsServer,
  engine: settingsEngine,
  workers: settingsWorkers,
  tools: settingsTools,
  automation: settingsAutomation,
  prohibited: settingsProhibited,
  logging: settingsLogging,
  updates: settingsUpdates,
  about: settingsAbout,
};
