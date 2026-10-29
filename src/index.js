// Synapse entry point: load config, start the engine, serve the UI.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { DATA_DIR, LOGS_DIR, WORKSPACE_DIR, GENERAL_DIR, ENGINE_HOME, PID_FILE, PROJECTS_FILE, TOOL_STATS_FILE, PROBE_DIR, PROBE_FILE, MODEL_CACHE_FILE, NPM_ATTEMPT_FILE, PERMISSION_MEMORY_FILE, REMOTE_TOKEN_FILE, ROOT, SCRATCH_ROOT, scratchDir } from './paths.js';
import { loadConfig, saveConfig, repairMachinePaths } from './config.js';
import { logger } from './logger.js';
import { createEngine } from './engines/index.js';
import { createProjectStore } from './projects.js';
import { createToolStats } from './toolstats.js';
import { ensurePlan, readPlan, logPlanState } from './plans.js';
import { createRunner } from './runs.js';
import { createEngineUpdate } from './engine-update.js';
import { createHarnessGuard } from './harness.js';
import { createPermissionGate } from './permission-gate.js';
import { createPermissionMemory } from './permission-memory.js';
import { createRemoteToken, lanAddresses } from './remote.js';
import { createPermissionLog } from './permission-log.js';
import { fullAutoTimeoutMs } from './auto-answer.js';
import { rulesFor, SINGLE_RULES } from './permissions.js';
import { skillRules } from './skills.js';
import { createProbe, discoverToolsetForModel } from './probe.js';
import { createModelCache, MAX_TOOL_ASKS } from './modelcache.js';
import { createApi } from './api.js';
import { createServer } from './server.js';
import { pruneProviderLog } from './provider-errors.js';
import { measureLocalWindows } from './providers.js';
import { sweepOrphans } from './cleanup.js';
import { hasNpm, installLocalNpm } from './npm-check.js';
import { APP_VERSION } from './version.js';

const bootLog = logger.channel('app');
let bootError = null;
let engine = null;
let http = null;

/**
 * npm, and what its absence means. See src/npm-check.js for the four cases.
 *
 * There is no prompt and no installer. A question cannot be asked: the desktop app
 * starts this process hidden, so a prompt would sit unanswered forever. And an
 * installer is not ours to run — Node machine-wide with winget is exactly what
 * AGENTS.md rule 3 forbids.
 *
 * So when the npm beside bin\node is missing or incomplete it is fetched into that
 * folder, silently. The fetch runs in the background: it is a 30 MB download and
 * nothing the app does needs it, so the server must not wait behind it. A failure
 * is remembered, so a machine with no network tries once rather than every launch.
 */
const NPM_RETRY_MS = 6 * 60 * 60 * 1000;

async function ensureNpm() {
  const log = logger.channel('app');
  const say = (line) => {
    console.log(`[Synapse] ${line}`);
    log.info(line);
  };

  const found = await hasNpm({ root: ROOT });
  if (found.ok) {
    if (found.how === 'machine') {
      say('npm: using the copy on this machine\'s PATH - runtime updates will install into it');
    }
    return;
  }

  let last = null;
  try { last = JSON.parse(fs.readFileSync(NPM_ATTEMPT_FILE, 'utf8')); } catch { /* never tried */ }
  if (last?.at && Date.now() - Date.parse(last.at) < NPM_RETRY_MS) {
    log.warn(`npm is not available (${last.error || 'the last attempt did not finish'}); runtime updates will wait`);
    return;
  }

  say('npm is not usable here - fetching our own copy into bin\\node (local: nothing is installed on this machine)');
  const attempt = installLocalNpm({ root: ROOT, log: say }).then((result) => {
    try {
      fs.writeFileSync(NPM_ATTEMPT_FILE, JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2));
    } catch { /* a note that cannot be written is not a failure */ }
    if (!result.ok) log.warn(`npm could not be fetched: ${result.error} - runtime updates will wait`);
  });
  // Deliberately not awaited: the boot does not depend on it, and the operator is
  // looking at a window that is waiting for a server.
  attempt.catch((err) => log.warn(`npm could not be fetched: ${err.message}`));
}

async function main() {
  // ── directories ──────────────────────────────────────────────
  for (const dir of [DATA_DIR, LOGS_DIR, WORKSPACE_DIR, ENGINE_HOME, PROBE_DIR, SCRATCH_ROOT]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // The models' scratch root is the process temp as well. The engine inherits
  // TEMP/TMP when it is spawned, and every shell it starts inherits them; the
  // permission analyser expands `$env:TEMP` from this same process env, so the
  // child that writes and the judge that approves see one folder. On Windows
  // Node reads TEMP, not TMPDIR — which is why the engine used the machine's
  // %LOCALAPPDATA%\Temp\opencode before this, another app's space.
  process.env.TEMP = SCRATCH_ROOT;
  process.env.TMP = SCRATCH_ROOT;

  // ── config ───────────────────────────────────────────────────
  const { config, created, error } = loadConfig();
  logger.configure(config.logging);
  logger.startCleanupLoop();
  const app = logger.channel('app');

  // npm: offered, explained, and only refused when there is nothing to run.
  await ensureNpm();

  app.info('----------------------------------------------');
  app.info(`Synapse ${APP_VERSION} starting (pid ${process.pid})`);
  if (created) app.info('created default config: config/synapse.config.json');
  if (error) app.warn(`config could not be read (${error}); using defaults`);

  // A copied folder carries a config naming the machine it came from. Cleared before
  // the engine reads it, so the copy that travels is used and nothing is created on a
  // drive this PC does not have.
  if (repairMachinePaths(config)) {
    saveConfig(config);
    app.info('config: runtime paths that are not on this machine were cleared');
  }

  const getConfig = () => currentConfig;
  let currentConfig = config;
  const applyConfig = (incoming) => {
    currentConfig = saveConfig(incoming);
    logger.configure(currentConfig.logging);
    return currentConfig;
  };

  // ── pid file (so the app, and a human, can see what is running) ──
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch { /* ignore */ }

  // ── projects ─────────────────────────────────────────────────
  // There is no built-in project. The projects root is created if it is missing
  // (the store does that), and an old "General" folder — from before there was
  // one chat per project — is adopted as an ordinary project on the first boot,
  // so the work that lives in it is not lost.
  const projects = createProjectStore({
    file: PROJECTS_FILE,
    rootDir: WORKSPACE_DIR,
    legacyGeneralDir: GENERAL_DIR,
    logger,
  });
  // A registry copied from another machine still names that machine's folders. Silent
  // by the operator's rule: a project whose directory is gone is not a project here.
  projects.pruneMissing();
  app.info(`projects: ${projects.list().length}`);
  app.info(`scratch: ${SCRATCH_ROOT}`);
  // Every project owns a plan file. Create the ones that are missing rather than
  // waiting for the first session: an empty, valid file is a better starting
  // point than a missing one, and it makes the file discoverable.
  for (const project of projects.list()) {
    if (!project.exists) continue;
    const made = ensurePlan(project.directory);
    if (made.created) app.info(`plan file created: ${made.path}`);
    // Every project gets its scratch folder, so the brief can name a folder that
    // already exists instead of telling a model to create its own.
    try { fs.mkdirSync(scratchDir(project.directory), { recursive: true }); } catch { /* the model can make it */ }
  }

  // ── what the local runtimes have loaded ──────────────────────
  // A window typed into a form is a claim; what the runtime has actually loaded
  // is the measurement that outranks it. This runs before the engine is handed
  // its config, so both halves of the harness start from the same number — the
  // engine's own compaction rule is a function of the context it was told, and a
  // stale one compacts every few turns without anything saying why.
  const measured = await measureLocalWindows(currentConfig).catch(() => []);
  if (measured.length) {
    for (const m of measured) {
      app.info(`${m.ref}: ${m.to} tokens loaded by the server (was ${m.from || 'nothing'}) - the engine will compact on ${m.to}`);
    }
    currentConfig = applyConfig(currentConfig);
  }

  // ── engine ───────────────────────────────────────────────────
  engine = createEngine(currentConfig, {
    logger,
    workspaceDir: WORKSPACE_DIR,
    dataDir: DATA_DIR,
  });
  app.info(`engine: ${config.engine.type}`);

  try {
    await engine.start();
  } catch (err) {
    bootError = err.message;
    app.error(`engine failed to start: ${err.message}`);
    app.error('Synapse will still serve the UI so the problem is visible.');
  }

  // An engine that was killed outright leaves its MCP helpers running: they are
  // its children, so they have no owner once it is gone, and nothing else will ever
  // notice them. Listed in the log, then stopped — the selection is only this
  // repository's own `src/mcp/` scripts whose parent is dead (src/cleanup.js).
  if (config.cleanup?.onBoot !== false) {
    sweepOrphans(ROOT, { log: app, keep: [process.pid, Number(engine.status?.().pid) || 0] }).catch((err) =>
      app.warn(`orphan sweep failed: ${err.message}`),
    );
  }


  // ── tool census ──────────────────────────────────────────────
  // There is no session naming any more: a project is one chat, the rail shows
  // the project's name, and an engine session's own title is never read. That
  // removed a `generate` call after the first answer of every conversation.
  const toolStats = createToolStats({ file: TOOL_STATS_FILE, logger });
  const toolStatsLog = logger.channel('tools');
  // Automated clearing: the census describes the current environment, so it
  // starts empty on boot unless the operator opts out (Settings → Tools).
  if (config.tools?.resetOnBoot !== false) {
    toolStats.clear();
    toolStatsLog.info('census cleared on boot (tools.resetOnBoot)');
  }

  // The delegation runner: the Architect asks for work with a tool, and this is
  // what actually runs it — a real session on the task's role and model, run to
  // completion, recorded, and reported back. See src/runs.js. It also reports the
  // live state of each run so the role cards and the live path can show it.
  const guard = createHarnessGuard({
    root: ROOT,
    logger,
    notify: (ev) => http?.broadcast({ ...ev, ts: Date.now() }),
  });

  // The policy behind every `ask` the engine raises. It answers in the same
  // second when the request is inside the workspace, is a harness read, or is a
  // harness write (no); anything else is left on screen for the operator.
  //
  // Every decision is also recorded against the tool call it belongs to: that is
  // what puts the chip on the call, green when the policy allowed it, yellow when
  // the operator did, red when it was refused.
  const permissionLog = createPermissionLog();
  // "Always Allow" is the operator's decision, so it outlives the process: the
  // memory is written to data\permission-memory.json and read back at boot.
  const permissionMemory = createPermissionMemory({ file: PERMISSION_MEMORY_FILE, logger });
  const permissionGate = createPermissionGate({
    engine,
    logger,
    root: ROOT,
    scratchRoot: SCRATCH_ROOT,
    memory: permissionMemory,
    getTimeoutMs: () => fullAutoTimeoutMs(currentConfig),
    onDecision: (entry) => {
      permissionLog.record(entry);
      if (entry.decided) {
        http?.broadcast({ kind: 'permission', type: 'permission.decided', decision: entry, ts: Date.now() });
      }
    },
  });
  app.info('permissions: workspace free, harness read-only, everything else asks the operator');

  // Sessions created before this boot carry the previous ruleset — the old guard
  // denied the harness and allowed the rest of the machine. Bring the operator's
  // sessions under the policy now, but leave hidden worker sessions alone: a run
  // sets its own rules when it starts, and nothing is running across a boot.
  {
    const t = setTimeout(async () => {
      try {
        const sessions = await engine.listSessions();
        let n = 0;
        for (const s of sessions) {
          if (!s?.id || s.internal) continue;
          await engine.updateSessionPermissions(s.id, [
            ...rulesFor(),
            ...(s.single ? SINGLE_RULES : []),
            ...skillRules(getConfig(), 'architect'),
          ]);
          n += 1;
        }
        if (n) app.info(`permissions: ${n} existing session(s) brought under the policy`);
      } catch (err) {
        app.warn(`could not bring existing sessions under the policy: ${err.message}`);
      }
    }, 5000);
    t.unref?.();
  }

  // Per-model knowledge. Created before the runner because a run that fails
  // leaves a mark on the model it ran on — that is the picker's badge of shame,
  // and it is also why the cache outlives a model leaving the catalog.
  const modelCache = createModelCache({ logger, file: MODEL_CACHE_FILE });

  const runner = createRunner({
    engine,
    logger,
    getConfig,
    guard,
    modelCache,
    notify: (ev) => http?.broadcast({ ...ev, ts: Date.now() }),
    // A model reloaded in its own app while we run: the measurement is used for
    // this run either way, and this keeps the config file in step so the next
    // boot hands the engine the same number.
    onModelWindow: (ref, loaded) => {
      const [providerId, modelId] = String(ref || '').split('/');
      const provider = (currentConfig.engine?.opencode?.providers || []).find((p) => p.id === providerId);
      const model = (provider?.models || []).find((m) => m.id === modelId);
      if (!model || Number(model.context) === Number(loaded)) return;
      model.context = Number(loaded) || model.context;
      currentConfig = applyConfig(currentConfig);
    },
  });

  // The engine is a separate program and it updates often, and the model catalog
  // ships inside it — so "our model list is old" is usually "our engine is old".
  // This answers that question from what is already on the machine (the desktop's
  // own version file) and only asks npm when the operator asks it to.
  const engineUpdate = createEngineUpdate({
    engine,
    logger,
    runs: runner,
    notify: (ev) => http?.broadcast({ ...ev, ts: Date.now() }),
  });
  engineUpdate
    .check({ online: false })
    .then((u) => {
      if (u?.newer) app.info(`engine update available: ${u.current || '?'} -> ${u.latest} (${u.source})`);
    })
    .catch(() => { /* an unavailable version number is not a boot failure */ });

  // The probe drives one turn per tool so we can see what these models actually
  // reach for, and how slow or broken each tool is on this machine.
  const probe = createProbe({
    engine,
    logger,
    scratchDir: PROBE_DIR,
    file: PROBE_FILE,
    modelCache,
    // Which model to test: the operator's own choice, so the answer describes the
    // thing they will actually run.
    getConfig: () => currentConfig,
    notify: (ev) => http?.broadcast({ ...ev, ts: Date.now() }),
  });
  // Clear any probe/model-check session a killed process left behind; they are
  // scaffolding, never user work.
  probe.sweep().catch(() => {});

  // The provider-error diary: keep a month, regardless of the log retention in
  // Settings. Pruning at boot is what makes that true on a machine that never
  // restarts for weeks, and every write re-checks (throttled to six hours).
  pruneProviderLog(true);

  // ── per-model knowledge ──────────────────────────────────────
  // The engine catalog refreshes every boot, but models come and go. Record
  // what we see, and discover a model's toolset once, on first selection.
  // Runs are serialised: burst-selecting several models should not fire several
  // turns at the provider at once.
  const inspectLog = logger.channel('tools');
  const inspecting = new Set();
  let inspectChain = Promise.resolve();

  function inspectModel(ref) {
    const key = String(ref || '').trim();
    if (!key.includes('/')) return { started: false, reason: 'a provider/model ref is required' };
    const known = modelCache.get(key);
    if (modelCache.isChecked(key)) return { started: false, cached: true, tools: known.tools || [] };
    if (inspecting.has(key)) return { started: false, running: true };
    const asked = modelCache.attempts(key);
    const maxAsks = getConfig().modelChecks?.maxAsks ?? MAX_TOOL_ASKS;
    if (asked >= maxAsks) return { started: false, exhausted: true, timesAsked: asked, maxAsks };

    inspecting.add(key);
    inspectChain = inspectChain
      .catch(() => {})
      .then(() => discoverToolsetForModel(engine, inspectLog, key, PROBE_DIR))
      .then((tools) => {
        modelCache.setTools(key, tools);
        inspectLog.info(
          `model check ${key}: ${tools.length ? `${tools.length} tools` : 'no list'} ` +
            `(ask ${modelCache.attempts(key)}/${maxAsks})`,
        );
        http?.broadcast({ kind: 'model', type: 'model.probed', ref: key, tools, ts: Date.now() });
      })
      .catch((err) => inspectLog.warn(`model check ${key} failed: ${err.message}`))
      .finally(() => inspecting.delete(key));
    return { started: true };
  }

  // A restart is one of the three chances: ask again for any role's model whose
  // toolset is still missing, up to the shared cap. Runs are serialised.
  for (const sel of Object.values(getConfig().roles || {})) {
    if (sel?.ref) inspectModel(sel.ref);
  }

  // ── first-response git check ─────────────────────────────────
  // A session's project folder should be a git repository before the agent
  // starts editing files. When the first turn succeeds, check for one and
  // `git init` if there is none. `rev-parse` succeeds inside any parent repo,
  // so a folder under an existing repository is left alone — never a nested
  // repo. Once per directory per run; resets on restart, where the check is
  // cheap and idempotent.
  const gitChecked = new Set();
  const pathKey = (d) => String(d || '').replace(/[\\/]+$/, '').toLowerCase();
  function git(args, dir) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: dir, windowsHide: true, timeout: 20000 }, (err, stdout) =>
        (err ? reject(err) : resolve(String(stdout || '').trim())),
      );
    });
  }
  async function ensureGitRepo(dir) {
    // The probe scratch directory is not a project; never repository it.
    if (!dir || pathKey(dir) === pathKey(PROBE_DIR) || gitChecked.has(dir)) return;
    gitChecked.add(dir);
    try {
      await git(['rev-parse', '--git-dir'], dir);
      return; // already a repository, or inside one
    } catch { /* not under git — initialize it below */ }
    try {
      await git(['init'], dir);
      app.info(`git: initialized ${dir}`);
    } catch (err) {
      app.warn(`git init skipped for ${dir}: ${err.message}`);
    }
  }

  // Scan a finished turn once: its tool calls go into the census, a
  // still-unnamed session gets its name, and a project folder without git gets
  // a repository.
  async function afterTurn(sessionId, type) {
    try {
      const messages = await engine.getMessages(sessionId);
      let session = null;
      try { session = await engine.getSession(sessionId); } catch { /* gone */ }
      if (type === 'session.execution.succeeded' && session?.directory) {
        ensureGitRepo(session.directory).catch(() => {});
      }
      const added = toolStats.recordMessages(messages, {
        // A session created without an explicit model reports none until later;
        // fall back to the Architect's stored choice so the census stays
        // per-model. A non-default thinking variant is part of the identity
        // here: `#max` and `#low` are different configurations of one model.
        model: session?.model
          ? session.model + (session.variant && session.variant !== 'default' ? `#${session.variant}` : '')
          : getConfig().roles?.architect?.ref || '(engine default)',
        agent: session?.agent || '(default)',
        sessionId,
      });
      if (added) {
        const snap = toolStats.snapshot();
        toolStatsLog.info(
          `census +${added} call(s) in ${sessionId}; running total ${snap.total} (${snap.failed} failed)`,
        );
      }
      // The plan is written during the turn, so a finished turn is when it
      // changed — and this is the only place that notices with no UI open.
      if (session?.directory) logPlanState(readPlan(session.directory), app);
      // And every turn's tool calls are checked against the harness: a write or an
      // edit that names a file inside it is reported here, with the session that
      // made it. The messages are already in hand, so this costs nothing.
      guard.checkTurn({ sessionId, messages, label: `turn finished (${type})` });
      // A finished turn is where the Architect's requests for work are
      // picked up. Nothing is awaited: the worker reports back on its own.
      runner.handleTurn(sessionId, messages);
    } catch (err) {
      toolStatsLog.warn(`census skipped for ${sessionId}: ${err.message}`);
    }
  }

  // How long a step waits for its first token, per session.
  //
  // This is the number that answers "is the provider slow, or are we?" — and
  // until now nothing measured it, which is why two five-minute silences on 23 Oct
  // had to be reconstructed from timestamps hours later. A step that opens and then
  // produces nothing is the provider holding the request: the engine logs no retry,
  // no error, and no other traffic in between, so there is nothing else it can be.
  // Logged only when it is slow enough to matter, so the console stays readable.
  const stepClock = new Map();
  const FIRST_TOKEN_WARN_MS = 20000;
  function watchFirstToken(ev) {
    const sid = ev.sessionId;
    if (ev.type === 'session.step.started') {
      stepClock.set(sid, { at: Date.now(), told: false });
      return;
    }
    if (/\.(text|reasoning)\.delta$/.test(ev.type)) {
      const clock = stepClock.get(sid);
      if (!clock || clock.told) return;
      clock.told = true;
      const waited = Date.now() - clock.at;
      if (waited >= FIRST_TOKEN_WARN_MS) {
        app.warn(
          `${sid}: the model took ${Math.round(waited / 1000)}s to say anything. ` +
            `That is the provider holding the request, not this harness - nothing is retried or waited on in between.`,
        );
      }
      return;
    }
    if (/^session\.(step\.ended|execution\.(succeeded|failed|interrupted))$/.test(ev.type)) {
      stepClock.delete(sid);
    }
  }

  engine.on('event', (ev) => {
    const type = ev?.type;
    if (!ev?.sessionId) return;
    // A blocking permission request is judged before anything else: the engine
    // is holding a tool until someone answers. The gate also sees the tool
    // events, because a shell ask carries no `source.id` and needs the call it
    // blocks to name the chip.
    permissionGate.observe(ev);
    permissionGate.handle(ev);
    watchFirstToken(ev);
    if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(type)) afterTurn(ev.sessionId, type);
  });

  // Two kinds of unfinished delegation survive a restart, and they need opposite
  // treatment. A request no turn ever read is still in the transcript, answered
  // "Queued": read it and run it. A request that *was* read started a worker, and
  // the process died before its result was written: nothing is running now, so
  // close it, put the task back to todo, and tell the Architect — otherwise it
  // waits for a worker that no longer exists. Close first, so the transcript pass
  // cannot mistake an interrupted run for a queued one.
  {
    const t = setTimeout(async () => {
      const dirs = projects.list().filter((p) => p.exists).map((p) => p.directory);
      try {
        const closed = await runner.recoverInterrupted(dirs);
        if (closed) app.warn(`closed ${closed} run${closed === 1 ? '' : 's'} interrupted by a restart`);
      } catch (err) {
        app.warn(`could not close interrupted runs: ${err.message}`);
      }
      try {
        const n = await runner.recoverDelegations(dirs);
        if (n) app.warn(`picked up ${n} delegation${n === 1 ? '' : 's'} no turn had read`);
      } catch (err) {
        app.warn(`could not check for unread delegations: ${err.message}`);
      }
      try {
        const n = await runner.recoverLostReports(dirs);
        if (n) app.warn(`replayed ${n} report${n === 1 ? '' : 's'} whose wake was lost`);
      } catch (err) {
        app.warn(`could not replay unread reports: ${err.message}`);
      }
    }, 5000);
    t.unref?.();
  }

  // Record the live catalog once the engine is up. Metadata is free; the
  // toolset discovery is the part that costs a turn, and that only happens when
  // the operator selects a model.
  if (engine.status().ready) {
    engine
      .listModels()
      .then((list) => {
        const changed = modelCache.record(list);
        // One line on the console every launch: which catalog this engine is
        // serving, so a stale model list is visible without opening a log.
        app.info(`catalog: ${list.length} model(s) from engine ${engine.status().version || '?'}`);
        if (changed) app.info(`model cache: ${changed} model(s) recorded or updated`);
      })
      .catch((err) => app.warn(`model cache refresh failed: ${err.message}`));
  }

  // ── remote access (LAN) ──────────────────────────────────────
  // Off at every start, whatever the file said. It used to be restored from the
  // config: the listener came up bound to 0.0.0.0, the switch showed on, and the
  // LAN still could not reach it — toggling off and on was what actually opened
  // the door (29 Oct). A token-protected door should not open itself either, so
  // the operator switches it on after the server is up.
  if (currentConfig.server.remote) {
    try {
      currentConfig = applyConfig({ ...currentConfig, server: { ...currentConfig.server, remote: false } });
      app.info('remote access reset to off at start — switch it on when the LAN needs it');
    } catch (err) {
      // A read-only config still starts: the listener stays on loopback, which is
      // the safe half of this, and the operator is told the file did not change.
      currentConfig = { ...currentConfig, server: { ...currentConfig.server, remote: false } };
      app.warn(`remote access reset in memory; the config could not be written: ${err.message}`);
    }
  }
  // The token is a password for this PC, so it lives in data\, not the config.
  // The listener stays on loopback until STATUS > Remote Access is switched on.
  const remoteToken = createRemoteToken({ file: REMOTE_TOKEN_FILE, logger });
  const remote = {
    token: remoteToken,
    enabled: () => Boolean(currentConfig.server.remote),
    bindHost: () => (currentConfig.server.remote ? '0.0.0.0' : currentConfig.server.host),
    status: (local = false) => {
      const port = currentConfig.server.port;
      const addresses = lanAddresses().map((entry) => entry.address);
      const url = addresses.length ? `http://${addresses[0]}:${port}` : null;
      return {
        enabled: Boolean(currentConfig.server.remote),
        port,
        url,
        addresses,
        // The token is a password. Only the PC itself may be given it; a LAN
        // client gets null and types it into the login page.
        token: local ? remoteToken : null,
      };
    },
  };
  const onRemote = async (enabled) => {
    currentConfig = applyConfig({ ...currentConfig, server: { ...currentConfig.server, remote: Boolean(enabled) } });
    const state = remote.status(true);
    app.info(`remote access ${state.enabled ? 'on' : 'off'}${state.enabled && state.url ? ` — ${state.url}` : ''}`);
    if (state.enabled && !state.url) app.warn('remote access is on, but no private LAN address was found');
    return state;
  };

  // ── http ─────────────────────────────────────────────────────
  const api = createApi({
    getConfig,
    applyConfig,
    engine,
    logger,
    getBootError: () => bootError,
    projects,
    toolStats,
    probe,
    modelCache,
    inspectModel,
    probeDir: PROBE_DIR,
    runs: runner,
    engineUpdate,
    // Settings > Save Changes offers a restart, so the server can hand its own
    // relaunch to the app that supervises it — one restart path, one set of exit
    // codes. See restartSelf above and docs/notes/desktop-app.md.
    restart: restartSelf,
    // Tray > Stop Server. Graceful: the engine is stopped by shutdown(), never
    // left behind for a kill to orphan.
    stopSelf: requestShutdown,
    notify: (ev) => http?.broadcast({ ...ev, ts: Date.now() }),
    permissionLog,
    permissionGate,
    permissionMemory,
  });

  // Full auto's questions half. Forms have no event Synapse sees, so one sweep
  // every five seconds asks the engine what is waiting; a closed browser cannot
  // stop it. The timer is unref'd so it never keeps the process alive, and the
  // tick is cheap when nothing is pending (one local list call).
  const fullAutoTimer = setInterval(() => {
    Promise.resolve(api.autoAnswerTick?.()).catch((err) => {
      bootLog.warn(`full auto tick failed: ${err.message}`);
    });
  }, 5000);
  fullAutoTimer.unref?.();

  http = createServer({
    api,
    engine,
    logger,
    config: getConfig(),
    remote,
    onRemote,
  });
  await http.listen(remote.bindHost());

  const url = `http://${currentConfig.server.host}:${currentConfig.server.port}`;
  app.info(`UI ready at ${url}`);
  if (currentConfig.server.remote) {
    const state = remote.status(true);
    app.info(`remote access: on${state.url ? ` — ${state.url}` : ' (no private LAN address found)'}`);
  }
  app.info('----------------------------------------------');

  if (currentConfig.server.openBrowser && process.env.SYNAPSE_SUPERVISED !== '1') openBrowser(url);
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (err) {
    bootLog.warn(`could not open browser: ${err.message}`);
  }
}

/**
 * Relaunch Synapse — the button in Settings > Save Changes.
 *
 * Under the desktop app (`SYNAPSE_SUPERVISED=1`) this process does not relaunch
 * itself: it exits with **code 2**, which is the app's signal to start a new one.
 * The app is what holds the window and the tray icon across the restart, and it is
 * the only launcher — there is no script to fall back to. Started by hand instead,
 * the honest answer is that a second start is the operator's to do.
 */
function restartSelf() {
  if (process.env.SYNAPSE_SUPERVISED !== '1') {
    bootLog.warn('restart refused: this process was not started by Synapse.exe');
    return { ok: false, error: 'Restarting is the app\'s job. Close this and start Synapse.exe again.' };
  }
  bootLog.info('restart requested from the UI - exiting so the app can start a new one');
  // Let the HTTP response reach the browser before this process goes down.
  setTimeout(() => shutdown('restart', 2), 600);
  return { ok: true };
}

/**
 * Stop because the app asked (tray > Stop Server). Exit code 0 is read as
 * "stopped on purpose", so the app does not treat it as a crash.
 */
function requestShutdown() {
  bootLog.info('stop requested from the app');
  setTimeout(() => shutdown('app stop', 0), 400);
  return { ok: true };
}

let shuttingDown = false;
async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const app = logger.channel('app');
  app.info(`${signal} received, shutting down...`);
  try { await http?.close(); } catch { /* ignore */ }
  try { await engine?.stop(); } catch { /* ignore */ }
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
  app.info('Synapse stopped.');
  process.exit(code);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => logger.channel('app').error(`uncaught exception: ${err.stack || err.message}`));
process.on('unhandledRejection', (reason) => logger.channel('app').error(`unhandled rejection: ${reason}`));

main().catch((err) => {
  logger.channel('app').error(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
