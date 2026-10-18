// Synapse entry point: load config, start the engine, serve the UI.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { DATA_DIR, LOGS_DIR, WORKSPACE_DIR, GENERAL_DIR, ENGINE_HOME, PID_FILE, PROJECTS_FILE, TOOL_STATS_FILE, PROBE_DIR, PROBE_FILE, MODEL_CACHE_FILE, PLANS_FILE } from './paths.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { createEngine } from './engines/index.js';
import { createProjectStore } from './projects.js';
import { createTitler } from './titler.js';
import { createToolStats } from './toolstats.js';
import { createPlans } from './plans.js';
import { createProbe, discoverToolsetForModel } from './probe.js';
import { createModelCache, MAX_TOOL_ASKS } from './modelcache.js';
import { createApi } from './api.js';
import { createServer } from './server.js';

const bootLog = logger.channel('app');
let bootError = null;
let engine = null;
let http = null;

async function main() {
  // ── directories ──────────────────────────────────────────────
  for (const dir of [DATA_DIR, LOGS_DIR, WORKSPACE_DIR, GENERAL_DIR, ENGINE_HOME]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── config ───────────────────────────────────────────────────
  const { config, created, error } = loadConfig();
  logger.configure(config.logging);
  logger.startCleanupLoop();
  const app = logger.channel('app');

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

  // ── engine ───────────────────────────────────────────────────
  engine = createEngine(config, {
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

  // What each session is working towards. Derived from the plan tool calls in
  // its transcript — see src/plans.js for why there is no IPC here.
  const plans = createPlans({ file: PLANS_FILE, logger });

  // The probe drives one turn per tool so we can see what these models actually
  // reach for, and how slow or broken each tool is on this machine.
  const probe = createProbe({
    engine,
    logger,
    scratchDir: PROBE_DIR,
    file: PROBE_FILE,
    notify: (ev) => http?.broadcast({ ...ev, ts: Date.now() }),
  });
  // Clear any probe/model-check session a killed process left behind; they are
  // scaffolding, never user work.
  probe.sweep().catch(() => {});

  // ── per-model knowledge ──────────────────────────────────────
  // The engine catalog refreshes every boot, but models come and go. Record
  // what we see, and discover a model's toolset once, on first selection.
  // Runs are serialised: burst-selecting several models should not fire several
  // turns at the provider at once.
  const modelCache = createModelCache({ logger, file: MODEL_CACHE_FILE });
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
      // The plan travels the same way. The Architect publishes it by calling the
      // synapse-plan tool, and that call — with its full input — is already in
      // the messages we just fetched, so there is nothing to transport.
      if (plans.applyMessages(sessionId, messages)) {
        http?.broadcast({ kind: 'plan', type: 'plan.updated', sessionId, ts: Date.now() });
      }
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

  // Record the live catalog once the engine is up. Metadata is free; the
  // toolset discovery is the part that costs a turn, and that only happens when
  // the operator selects a model.
  if (engine.status().ready) {
    engine
      .listModels()
      .then((list) => {
        const changed = modelCache.record(list);
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
    plans,
    probe,
    modelCache,
    inspectModel,
    probeDir: PROBE_DIR,
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

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const app = logger.channel('app');
  app.info(`${signal} received, shutting down...`);
  try { await http?.close(); } catch { /* ignore */ }
  try { await engine?.stop(); } catch { /* ignore */ }
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
  app.info('Synapse stopped.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => logger.channel('app').error(`uncaught exception: ${err.stack || err.message}`));
process.on('unhandledRejection', (reason) => logger.channel('app').error(`unhandled rejection: ${reason}`));

main().catch((err) => {
  logger.channel('app').error(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
