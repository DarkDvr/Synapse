// Synapse entry point: load config, start the engine, serve the UI.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, LOGS_DIR, WORKSPACE_DIR, ENGINE_HOME, PID_FILE, PROJECTS_FILE, TOOL_STATS_FILE, PROBE_DIR, PROBE_FILE } from './paths.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { createEngine } from './engines/index.js';
import { createProjectStore } from './projects.js';
import { createTitler } from './titler.js';
import { createToolStats } from './toolstats.js';
import { createProbe } from './probe.js';
import { createApi } from './api.js';
import { createServer } from './server.js';

const bootLog = logger.channel('app');
let bootError = null;
let engine = null;
let http = null;

async function main() {
  // ── directories ──────────────────────────────────────────────
  for (const dir of [DATA_DIR, LOGS_DIR, WORKSPACE_DIR, ENGINE_HOME]) {
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
  const projects = createProjectStore({
    file: PROJECTS_FILE,
    // General is the workspace root: sessions that belong to no project.
    generalDir: config.defaults.directory || WORKSPACE_DIR,
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

  // The probe drives one turn per tool so we can see what these models actually
  // reach for, and how slow or broken each tool is on this machine.
  const probe = createProbe({
    engine,
    logger,
    scratchDir: PROBE_DIR,
    file: PROBE_FILE,
    notify: (ev) => http?.broadcast({ ...ev, ts: Date.now() }),
  });

  // Scan a finished turn once: its tool calls go into the census, and a
  // still-unnamed session gets its name.
  async function afterTurn(sessionId) {
    try {
      const messages = await engine.getMessages(sessionId);
      let session = null;
      try { session = await engine.getSession(sessionId); } catch { /* gone */ }
      const added = toolStats.recordMessages(messages, {
        // A session created without an explicit model reports none until later;
        // fall back to the configured default so the census stays per-model.
        // A non-default thinking variant is part of the identity here: `#max`
        // and `#low` are different configurations of the same model.
        model: session?.model
          ? session.model + (session.variant && session.variant !== 'default' ? `#${session.variant}` : '')
          : getConfig().defaults?.model || '(engine default)',
        agent: session?.agent || getConfig().defaults?.agent || '(default)',
        sessionId,
      });
      if (added) {
        const snap = toolStats.snapshot();
        toolStatsLog.info(
          `census +${added} call(s) in ${sessionId}; running total ${snap.total} (${snap.failed} failed)`,
        );
      }
    } catch (err) {
      toolStatsLog.warn(`census skipped for ${sessionId}: ${err.message}`);
    }
  }

  engine.on('event', (ev) => {
    const type = ev?.type;
    if (!ev?.sessionId) return;
    if (type === 'session.execution.succeeded') titler.maybeTitle(ev.sessionId);
    if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(type)) afterTurn(ev.sessionId);
  });
  // Anything left unnamed from a previous run gets named shortly after boot.
  {
    const t = setTimeout(() => titler.sweep(), 6000);
    t.unref?.();
  }

  // ── http ─────────────────────────────────────────────────────
  const api = createApi({ getConfig, applyConfig, engine, logger, getBootError: () => bootError, projects, toolStats, probe });
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
