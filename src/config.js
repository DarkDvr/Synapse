// Configuration: a single JSON file that IS the app's settings.
// The in-app Settings screen is only a GUI over this file.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, CONFIG_DIR } from './paths.js';

export const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 8700,
    openBrowser: true,
  },
  engine: {
    type: 'opencode',
    opencode: {
      binary: '',
      port: 8720,
      host: '127.0.0.1',
      password: '',
      home: '',
      startTimeoutMs: 60000,
      args: [],
      // Per-model limit overrides written into the engine's own config. The
      // engine's catalog is conservative for some free models: DeepSeek V4.1
      // Flash Free advertises 200k context but the backend serves 1,048,576
      // (boundary-tested — see AGENTS.md). This raises only the engine's local
      // budgeting ceiling. Add another entry only after testing that model.
      modelLimits: {
        'deepseek-v4.1-flash-free': { context: 1048576 },
      },
      // Folders of agent skills to hand to the engine. Empty by default: this
      // is the operator's choice, not something Synapse should assume.
      skillPaths: [],
    },
  },
  defaults: {
    // The only global default left: where a new session runs when no project
    // is picked. Model and thinking effort belong to roles — the Architect
    // included — not to the app.
    directory: '',
  },
  // Per-role selections made on the role cards, the Architect included:
  // { ref, variant }. There is no "default model" concept: if a role has no
  // entry, nothing was chosen yet. Persisted so choices survive a restart.
  roles: {},
  // How many times a model may be asked about its toolset before we give up,
  // per model (1–20). The cache counts attempts across sessions and restarts.
  modelChecks: {
    maxAsks: 3,
  },
  tools: {
    // The tool census answers "what are the models doing *here, now*" — it is
    // not a historical archive. Left alone it accumulates across every test run
    // and stops describing the current environment, so it starts fresh on each
    // boot unless the operator turns that off. Settings also clears it by hand.
    resetOnBoot: true,
  },
  worker: {
    // How long one delegated task may run before the harness interrupts it and
    // reports a timeout. A timeout is a report, not a failed task: whatever the
    // worker produced up to that point is still evidence and is handed over.
    // A role that genuinely needs longer overrides it on its own entry
    // (`roles.<id>.timeoutSec`) — the auditor, which reads and runs things, is
    // the one that hit this ceiling in practice.
    timeoutSec: 300,
  },
  logging: {
    level: 'info',
    retentionDays: 7,
    maxFileMb: 5,
    channels: { app: true, engine: true, session: true, tools: true },
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge user config over defaults (arrays are replaced, not merged). */
export function merge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = merge(out[key], value);
    else out[key] = value;
  }
  return out;
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/** Coerce/validate a config object into a safe shape. */
export function normalize(raw) {
  const cfg = merge(DEFAULTS, raw || {});
  cfg.server.host = String(cfg.server.host || '127.0.0.1');
  cfg.server.port = clampInt(cfg.server.port, 1, 65535, 8700);
  cfg.server.openBrowser = cfg.server.openBrowser !== false;
  cfg.tools = cfg.tools || {};
  cfg.tools.resetOnBoot = cfg.tools.resetOnBoot !== false;
  // Panel colours were an experiment and are gone: every speaker now gets the
  // same block with only a colour difference, so there is nothing to configure.
  // Any `ui` left in a config file is dropped rather than carried around.
  delete cfg.ui;

  cfg.worker = cfg.worker || {};
  cfg.worker.timeoutSec = clampInt(cfg.worker.timeoutSec, 30, 3600, DEFAULTS.worker.timeoutSec);

  cfg.engine.type = String(cfg.engine.type || 'opencode');
  const oc = cfg.engine.opencode;
  oc.binary = String(oc.binary || '');
  oc.port = clampInt(oc.port, 1, 65535, 8720);
  oc.host = String(oc.host || '127.0.0.1');
  oc.password = String(oc.password || '');
  oc.home = String(oc.home || '');
  oc.startTimeoutMs = clampInt(oc.startTimeoutMs, 5000, 600000, 60000);
  if (!Array.isArray(oc.args)) oc.args = [];
  // Model limit overrides: { modelID: { context?, input?, output? } }.
  const limits = {};
  if (isPlainObject(oc.modelLimits)) {
    for (const [id, spec] of Object.entries(oc.modelLimits)) {
      if (!isPlainObject(spec)) continue;
      const entry = {};
      for (const key of ['context', 'input', 'output']) {
        const n = Number.parseInt(spec[key], 10);
        if (Number.isFinite(n) && n > 0) entry[key] = n;
      }
      if (Object.keys(entry).length) limits[String(id)] = entry;
    }
  }
  oc.modelLimits = limits;
  oc.skillPaths = Array.isArray(oc.skillPaths)
    ? oc.skillPaths.map((p) => String(p || '').trim()).filter(Boolean)
    : [];

  cfg.defaults.directory = String(cfg.defaults.directory || '');
  // The mode is per session now (Single at creation, switched live), so the old
  // defaults.mode key is dropped rather than left to mislead.
  delete cfg.defaults.mode;

  // Role selections are objects ({ ref, variant }); accept the older bare
  // "provider/id" strings so existing config files keep working. The Architect
  // is no longer special: it owns a role entry like everyone else, so there is
  // no "default model" to disagree with the card.
  const roles = {};
  if (isPlainObject(cfg.roles)) {
    for (const [id, spec] of Object.entries(cfg.roles)) {
      const ref = typeof spec === 'string' ? spec : isPlainObject(spec) ? spec.ref : '';
      if (typeof ref !== 'string' || !ref.trim()) continue;
      const variant = isPlainObject(spec) && typeof spec.variant === 'string' ? spec.variant.trim() : '';
      const entry = { ref: ref.trim() };
      if (variant) entry.variant = variant;
      // A role may need longer than the default worker timeout (the auditor
      // reads and runs things). Only a real number is kept.
      const timeoutSec = isPlainObject(spec) ? Number(spec.timeoutSec) : NaN;
      if (Number.isFinite(timeoutSec)) entry.timeoutSec = clampInt(timeoutSec, 30, 3600, DEFAULTS.worker.timeoutSec);
      roles[String(id)] = entry;
    }
  }
  // Fold a pre-roles defaults.model into the Architect role once, then drop the
  // old keys entirely (the Settings field that wrote them is gone).
  if (typeof cfg.defaults.model === 'string' && cfg.defaults.model.trim() && !roles.architect) {
    const entry = { ref: cfg.defaults.model.trim() };
    const variant = String(cfg.defaults.variant || '').trim();
    if (variant) entry.variant = variant;
    roles.architect = entry;
  }
  delete cfg.defaults.model;
  delete cfg.defaults.variant;
  delete cfg.defaults.agent;
  cfg.roles = roles;

  cfg.modelChecks = cfg.modelChecks || {};
  cfg.modelChecks.maxAsks = clampInt(cfg.modelChecks.maxAsks, 1, 20, 3);

  const lg = cfg.logging;
  lg.level = ['error', 'warn', 'info', 'debug'].includes(lg.level) ? lg.level : 'info';
  lg.retentionDays = clampInt(lg.retentionDays, 1, 365, 7);
  lg.maxFileMb = clampInt(lg.maxFileMb, 1, 200, 5);
  lg.channels = merge(DEFAULTS.logging.channels, lg.channels || {});

  return cfg;
}

/** Read the config file, creating it from defaults if missing. Never throws. */
export function loadConfig() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
      return { config: normalize(DEFAULTS), created: true, error: null };
    }
    const text = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = text.trim() ? JSON.parse(text) : {};
    return { config: normalize(parsed), created: false, error: null };
  } catch (err) {
    return { config: normalize(DEFAULTS), created: false, error: err.message };
  }
}

/** Persist config (normalized) back to the file atomically. */
export function saveConfig(cfg) {
  const normalized = normalize(cfg);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = path.join(CONFIG_DIR, `.synapse.config.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return normalized;
}
