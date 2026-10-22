// Synapse entry point: load config, start the engine, serve the UI.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { DATA_DIR, LOGS_DIR, WORKSPACE_DIR, GENERAL_DIR, ENGINE_HOME, PID_FILE, PROJECTS_FILE, TOOL_STATS_FILE, PROBE_DIR, PROBE_FILE, MODEL_CACHE_FILE, ROOT, VENDOR_ENGINE } from './paths.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { createEngine } from './engines/index.js';
import { createProjectStore } from './projects.js';
import { createTitler } from './titler.js';
import { createToolStats } from './toolstats.js';
import { ensurePlan, readPlan, logPlanState } from './plans.js';
import { createRunner } from './runs.js';
import { createEngineUpdate } from './engine-update.js';
import { createHarnessGuard } from './harness.js';
import { createProbe, discoverToolsetForModel } from './probe.js';
import { createModelCache, MAX_TOOL_ASKS } from './modelcache.js';
import { createApi } from './api.js';
import { createServer } from './server.js';
import { pruneProviderLog } from './provider-errors.js';
import { measureLocalWindows } from './providers.js';
import { sweepOrphans } from './cleanup.js';
import { hasNpm, installNode, npmPlan, ask, runtimePresent } from './npm-check.js';

const bootLog = logger.channel('app');
let bootError = null;
let engine = null;
let http = null;

/**
 * npm, and what its absence means. See src/npm-check.js for the three cases.
 *
 * The console is the output here, not the log: this happens before anything is
 * serving, and the operator is looking at the window start.bat opened.
 */
async function ensureNpm() {
  const log = logger.channel('app');
  if (await hasNpm()) return;
  const runtime = runtimePresent(VENDOR_ENGINE);
  const plan = npmPlan({ npmFound: false, runtimeFound: runtime });
  const say = (line) => {
    console.log(`[Synapse] ${line}`);
    log.warn(line);
  };

  say('npm was not found on PATH.');
  if (plan === 'warn') {
    say('The app runs without it — the runtime here is the copy inside bin\\opencode.');
    say('npm is used for one thing: Settings > Runtime > Check for Updates.');
  } else {
    say('There is no runtime to run either: bin\\opencode is empty and @opencode/cli is not installed.');
    say('Synapse cannot start a single turn without one.');
  }

  if (!process.stdin.isTTY) {
    // Started hidden (restart.ps1, a shortcut, a service): nobody can answer.
    if (plan === 'block') {
      console.error('[Synapse] Install Node.js from https://nodejs.org and run start.bat again.');
      process.exit(1);
    }
    say('Install Node.js when you can; until then runtime updates will not work.');
    return;
  }

  const answer = await ask('Install Node.js (LTS) now with winget? [Y/n] ');
  if (/^n/i.test(answer)) {
    if (plan === 'block') {
      console.error('');
      console.error('[Synapse] No runtime, and npm was declined. Nothing here can run a model turn, so');
      console.error('[Synapse] Synapse is stopping. To fix it, either install Node.js from');
      console.error('[Synapse] https://nodejs.org, or copy bin\\opencode\\opencode.exe in from another machine.');
      process.exit(1);
    }
    say('Starting without npm. Runtime updates will not work until Node.js is installed.');
    return;
  }

  say('Installing Node.js LTS with winget. This can take a few minutes...');
  const installed = await installNode({ log: (line) => say(line) });
  if (!installed.ok) {
    console.error(`[Synapse] ${installed.error}`);
    if (plan === 'block') {
      console.error('[Synapse] Install Node.js from https://nodejs.org and run start.bat again.');
      process.exit(1);
    }
    say('Starting without npm. Runtime updates will not work until Node.js is installed.');
    return;
  }
  const now = await hasNpm();
  if (!now) {
    say('Node.js was installed, but npm still is not on this window\'s PATH — close this window and run start.bat again.');
    if (plan === 'block') process.exit(1);
    return;
  }
  say('npm is available now.');
}

async function main() {
  // ── directories ──────────────────────────────────────────────
  for (const dir of [DATA_DIR, LOGS_DIR, WORKSPACE_DIR, GENERAL_DIR, ENGINE_HOME, PROBE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── config ───────────────────────────────────────────────────
  const { config, created, error } = loadConfig();
  logger.configure(config.logging);
  logger.startCleanupLoop();
  const app = logger.channel('app');

  // npm: offered, explained, and only refused when there is nothing to run.
  await ensureNpm();

  app.info('----------------------------------------------');
  app.info(`Synapse starting (pid ${process.pid})`);
  if (created) app.info('created default config: config/synapse.config.json');
  if (error) app.warn(`config could not be read (${error}); using defaults`);

  const getConfig = () => currentConfig;
  let currentConfig = config;
  const applyConfig = (incoming) => {
    currentConfig = saveConfig(incoming);
    logger.configure(currentConfig.logging);
    return currentConfig;
  };

  // ── pid file (for stop.bat) ──────────────────────────────────
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch { /* ignore */ }

  // ── projects ─────────────────────────────────────────────────
  // General is its own folder, created fresh if it is missing (a new folder has
  // no sessions). It is never the workspace root: that is where project folders
  // live, and sharing it makes "sessions belonging to General" indistinguishable
  // from "sessions in a folder nobody registered".
  const generalExisted = fs.existsSync(GENERAL_DIR);
  fs.mkdirSync(GENERAL_DIR, { recursive: true });
  if (!generalExisted) app.info(`created the General project folder: ${GENERAL_DIR}`);
  const projects = createProjectStore({
    file: PROJECTS_FILE,
    generalDir: GENERAL_DIR,
    logger,
  });
  app.info(`projects: ${projects.list().length} (General + ${projects.list().length - 1})`);
  // Every project owns a plan file. Create the ones that are missing rather than
  // waiting for the first session: an empty, valid file is a better starting
  // point than a missing one, and it makes the file discoverable.
  for (const project of projects.list()) {
    if (!project.exists) continue;
    const made = ensurePlan(project.directory);
    if (made.created) app.info(`plan file created: ${made.path}`);
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
    workspaceDir: config.defaults.directory || WORKSPACE_DIR,
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


  // ── session naming + tool census ─────────────────────────────
  const titler = createTitler({
    engine,
    logger,
    notify: (sessionId, title) => {
      // Let every open UI know the name changed without waiting for a poll.
      http?.broadcast({ kind: 'sessions', type: 'session.named', sessionId, title, ts: Date.now() });
    },
  });

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

  engine.on('event', (ev) => {
    const type = ev?.type;
    if (!ev?.sessionId) return;
    if (type === 'session.execution.succeeded') titler.maybeTitle(ev.sessionId);
    if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(type)) afterTurn(ev.sessionId, type);
  });
  // Anything left unnamed from a previous run gets named shortly after boot.
  {
    const t = setTimeout(() => titler.sweep(), 6000);
    t.unref?.();
  }

  // A delegation is read when its turn ends. If Synapse stopped before that turn
  // did — a question was pending, the engine cancelled it on restart — the request
  // is in the transcript, answered "Queued", and nobody will ever run it. One pass
  // shortly after boot, once the engine is answering, is enough to notice.
  {
    const t = setTimeout(() => {
      const dirs = projects.list().filter((p) => p.exists).map((p) => p.directory);
      runner
        .recoverDelegations(dirs)
        .then((n) => {
          if (n) app.warn(`picked up ${n} delegation${n === 1 ? '' : 's'} no turn had read`);
        })
        .catch((err) => app.warn(`could not check for unread delegations: ${err.message}`));
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
    // relaunch to the script an operator would run by hand — one restart path,
    // one set of pid-file rules. See restartSelf below.
    restart: restartSelf,
    notify: (ev) => http?.broadcast({ ...ev, ts: Date.now() }),
    guard,
  });
  http = createServer({ api, engine, logger, config: getConfig() });
  await http.listen();

  const url = `http://${currentConfig.server.host}:${currentConfig.server.port}`;
  app.info(`UI ready at ${url}`);
  app.info('----------------------------------------------');

  if (currentConfig.server.openBrowser) openBrowser(url);
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
 * The app is a console application: the operator watches the engine in the window
 * `start.bat` opened, so a restart must open that window again rather than leave a
 * hidden process somewhere. `start.bat` is the only launcher, and this spawns it
 * in a *new* console with the `restart` argument, so the batch waits a few seconds
 * for this process to release the port. This process then stops its engine and
 * exits with code 2, which tells the old window's batch not to pause — the new
 * window is the app now. One window, one engine, one process.
 */
function restartSelf() {
  const bat = path.join(ROOT, 'start.bat');
  if (!fs.existsSync(bat)) {
    bootLog.error(`cannot restart: ${bat} is missing`);
    return { ok: false, error: `Restart needs ${bat}, which is missing.` };
  }
  bootLog.info('restart requested from the UI - opening a new console');
  try {
    // `cmd /c start` gives the batch file a console of its own. A *detached* child
    // of this process was measured not to survive here, and a plain child dies
    // with the parent — `start` is the one form that outlives both.
    const child = spawn('cmd.exe', ['/c', 'start', '', '/D', ROOT, bat, 'restart'], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
  } catch (err) {
    bootLog.error(`could not open the new console: ${err.message}`);
    return { ok: false, error: err.message };
  }
  // Let the HTTP response reach the browser before this process goes down.
  setTimeout(() => shutdown('restart', 2), 600);
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
