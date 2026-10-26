/**
 * Is there a newer engine, and how do we get it.
 *
 * The engine is a separate program that updates often, and the model catalog,
 * the tools and the API all live inside it: Synapse reads the catalog from the
 * running binary, so a stale engine looks exactly like a stale model list. That
 * is the whole reason this module exists.
 *
 * Two sources, because they fail differently:
 *
 *  - **OpenCode Desktop** ships its own engine and updates itself. Reading its
 *    version file is local, instant and needs no network; when it is ahead of
 *    the CLI we run, that is the signal. On a machine with the desktop installed
 *    this is the signal that actually arrives, without Synapse phoning anywhere.
 *  - **npm**, asked only when the operator opens the update dialog. Synapse is
 *    offline by rule, and a check they asked for is not the app phoning home at
 *    boot. The answer is cached in `data/` so the chip survives a restart.
 *
 * Updating is: stop the engine, `npm install -g @opencode/cli@latest`, start it.
 * The order is not a preference — on Windows a running .exe cannot be replaced —
 * and it refuses while a turn is in flight, because that turn would be lost.
 *
 * Which npm runs matters: ours, in `bin\node`, when it is usable, because that
 * one's global prefix IS `bin\node` — so `-g` installs into this folder and never
 * into `%APPDATA%`. See `docs/notes/desktop-app.md`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR, ROOT, VENDOR_ENGINE } from './paths.js';
import { hasNpm } from './npm-check.js';

const REGISTRY = 'https://registry.npmjs.org/@opencode/cli';
const CACHE_FILE = path.join(DATA_DIR, 'engine-update.json');
const PACKAGE = '@opencode/cli';

/** 2.1.0, v2.1.0 and 2.1 all mean the same thing here. */
function parts(version) {
  const raw = String(version || '')
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);
  while (raw.length < 3) raw.push(0);
  return raw;
}

/** -1 / 0 / 1, numeric field by field — no semver dependency, no pre-release rules. */
export function compareVersions(a, b) {
  const A = parts(a);
  const B = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if (A[i] !== B[i]) return A[i] > B[i] ? 1 : -1;
  }
  return 0;
}

/** The npm package a binary belongs to, by walking up from it. Null when the
 *  engine came from somewhere else (a hand-built binary, a fork, a zip). */
export function packageRoot(binary) {
  let dir = path.dirname(String(binary || ''));
  for (let i = 0; i < 4 && dir && dir !== path.dirname(dir); i += 1) {
    const file = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pkg.name === PACKAGE) return { root: dir, version: pkg.version || null };
    } catch { /* not here */ }
    dir = path.dirname(dir);
  }
  return null;
}

/** OpenCode Desktop's bundled engine version, if the desktop is installed. */
export function desktopVersion() {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', '@opencodedesktop', 'resources'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, '@opencodedesktop', 'resources'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, '@opencodedesktop', 'resources'),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      const text = fs.readFileSync(path.join(root, 'opencode-cli.version'), 'utf8').trim();
      if (/^\d+\.\d+/.test(text)) return text;
    } catch { /* not installed there */ }
  }
  return null;
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function writeCache(value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(value, null, 2) + '\n', 'utf8');
  } catch { /* a cache that cannot be written is not a failure */ }
}

/** Ask npm. Only ever called from an explicit check. */
async function registryLatest() {
  const res = await fetch(REGISTRY, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`npm answered HTTP ${res.status}`);
  const doc = await res.json();
  const version = doc?.['dist-tags']?.latest;
  if (!version) throw new Error('npm did not name a latest version');
  return {
    version,
    publishedAt: doc?.time?.[version] || null,
    description: doc?.description || null,
  };
}

async function runNpmInstall(log) {
  const args = ['install', '-g', `${PACKAGE}@latest`, '--no-fund', '--no-audit'];
  const found = await hasNpm({ root: ROOT });
  if (!found.ok) throw new Error('npm is not available, and Synapse could not fetch its own copy into bin\\node.');
  // Our own npm is run as `node npm-cli.js`, never as a .cmd: no shell, so no
  // quoting and no path in command text. A machine npm is a .cmd and needs one.
  const [file, argv] = found.pair
    ? [found.pair.node, [found.pair.cli, ...args]]
    : process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]]
      : ['npm', args];
  log.info(`engine update: npm ${args.join(' ')} (${found.how === 'local' ? 'bin\\node' : 'this machine'})`);
  return new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
      { windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const bad = String(stderr || '').trim();
        if (err) {
          const tail = (bad || out).split(/\r?\n/).filter(Boolean).slice(-2).join(' / ');
          reject(new Error(`${err.message}${tail ? ` — ${tail}` : ''}`));
          return;
        }
        resolve(out);
      },
    );
  });
}

/** Copy a freshly installed runtime over the vendored copy, keeping the old one
 *  as `<name>.bak`. Exported so the copy itself can be tested without npm. */
export function copyRuntimeOver(from, to, log = () => {}) {
  const source = path.resolve(String(from || ''));
  const target = path.resolve(String(to || ''));
  if (!source || !target || source === target) return false;
  if (!fs.existsSync(source)) throw new Error(`nothing to copy at ${source}`);
  try { fs.copyFileSync(target, `${target}.bak`); } catch { /* no previous copy */ }
  fs.copyFileSync(source, target);
  log(`engine update: copied ${source} over ${target}`);
  return true;
}

export function createEngineUpdate({ engine, logger, runs, notify }) {
  const log = logger.channel('app');
  /** What the running engine is; the package on disk is the fallback when it is
   *  down, and the package is what npm would replace. */
  function installed() {
    let status = {};
    try { status = engine.status() || {}; } catch { status = {}; }
    const pkg = packageRoot(status.binary);
    const version = (status.ready && status.version) || pkg?.version || null;
    // A copy that travels with Synapse has no package.json above it, so npm has
    // nothing to replace — but ours is ours to replace, by copying the freshly
    // installed binary over it.
    const vendored = Boolean(status.binary) && path.resolve(String(status.binary)) === path.resolve(VENDOR_ENGINE);
    return { version, binary: status.binary || null, packageRoot: pkg?.root || null, managedByNpm: Boolean(pkg), vendored };
  }

  /**
   * Where npm puts the binary, if it is there.
   *
   * Both prefixes, in order: a standalone Node's global prefix is its own folder,
   * so our npm installs to `bin\node\node_modules`; a machine npm installs to
   * `%APPDATA%\npm`. The old code knew only the second, so an update run with the
   * copy that travels with the app would have installed correctly and then
   * reported "no binary was found to copy".
   */
  function npmBinary() {
    const candidates = [path.join(ROOT, 'bin', 'node', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')];
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
    }
    for (const candidate of candidates) {
      try { if (fs.existsSync(candidate)) return candidate; } catch { /* unreadable is absent */ }
    }
    return null;
  }

  /** Copy the npm-installed binary over the vendored copy, keeping the old one. */
  function copyOverVendored() {
    const from = npmBinary();
    if (!from) throw new Error('npm installed the engine, but no binary was found to copy (looked in bin\\node and %APPDATA%\\npm).');
    return copyRuntimeOver(from, VENDOR_ENGINE, (line) => log.info(line));
  }

  /** Why an update cannot run right now, in the operator's words; null when it can. */
  function blocked() {
    const live = runs?.active?.() || [];
    if (live.length) {
      const first = live[0];
      return `A delegation is running (${first.task} in ${path.basename(String(first.dir || ''))}). Stop it or wait for it to finish — restarting the engine would lose that turn.`;
    }
    return null;
  }

  async function activeSessions() {
    try {
      return await engine.listActiveSessions();
    } catch (err) {
      // An engine we cannot ask is not an engine we may restart blindly: if it
      // says it is ready, the failure is ours and the honest answer is "unknown".
      if (engine.status().ready) throw err;
      return [];
    }
  }

  /**
   * The current picture. `online: true` asks npm; anything else answers from
   * what is already known — the engine, the desktop, the cached registry answer.
   */
  async function check({ online = false } = {}) {
    const here = installed();
    let latest = here.version;
    let source = 'the running engine';
    let checkedAt = null;
    let publishedAt = null;
    let onlineError = null;

    const desktop = desktopVersion();
    if (desktop && compareVersions(desktop, latest) > 0) {
      latest = desktop;
      source = 'OpenCode Desktop';
    }

    const cached = readCache();
    if (cached?.latest && compareVersions(cached.latest, latest) >= 0) {
      latest = cached.latest;
      source = cached.source || 'npm';
      checkedAt = cached.checkedAt || null;
      publishedAt = cached.publishedAt || null;
    }

    if (online) {
      try {
        const reg = await registryLatest();
        // The registry is authoritative for what npm publishes, so its answer
        // *replaces* the cached one rather than merely raising it: a stale or
        // wrong cache would otherwise be sticky for ever. The desktop can still
        // be ahead of it, so it is compared rather than trusted outright.
        const desktopAhead = Boolean(desktop) && compareVersions(desktop, reg.version) > 0;
        latest = desktopAhead ? desktop : reg.version;
        source = desktopAhead ? 'OpenCode Desktop' : 'npm';
        publishedAt = reg.publishedAt;
        checkedAt = new Date().toISOString();
        writeCache({ latest, source, checkedAt, publishedAt });
      } catch (err) {
        onlineError = err.message;
        log.warn(`engine update check failed: ${err.message}`);
      }
    }

    const busy = blocked();
    return {
      current: here.version,
      latest,
      newer: compareVersions(latest, here.version) > 0,
      source,
      checkedAt,
      publishedAt,
      desktop,
      onlineError,
      binary: here.binary,
      packageRoot: here.packageRoot,
      managedByNpm: here.managedByNpm,
      vendored: here.vendored,
      canUpdate: (here.managedByNpm || here.vendored) && !busy,
      blocked: busy,
    };
  }

  /** Stop, install, start. Always restarts, even when npm fails: an engine that
   *  is down because an update went wrong is a worse state than an old engine. */
  async function update() {
    const before = installed();
    if (!before.managedByNpm && !before.vendored) {
      return {
        ok: false,
        error: `This runtime (${before.binary || 'auto-detected'}) was not installed with npm and is not the copy that travels with Synapse, so Synapse will not replace it. Update it where it came from, or point Settings → Runtime at an npm install.`,
      };
    }
    const busy = blocked();
    if (busy) return { ok: false, error: busy };

    let active;
    try {
      active = await activeSessions();
    } catch (err) {
      return {
        ok: false,
        error: `The engine did not report what is running (${err.message}), so Synapse will not restart it. Try again in a moment.`,
      };
    }
    if (active.length) {
      return {
        ok: false,
        error: `A session is mid-turn (${active.length} active). Stop it first — restarting the engine would lose that turn.`,
      };
    }

    log.info(`engine update: ${before.version || 'unknown'} -> npm latest`);
    let installError = null;
    let startError = null;
    try {
      await engine.stop();
      await runNpmInstall(log);
      if (before.vendored) copyOverVendored(log);
    } catch (err) {
      installError = err.message;
      log.error(`engine update failed: ${err.message}`);
    }
    try {
      await engine.start();
    } catch (err) {
      startError = err.message;
      log.error(`engine did not restart after the update: ${err.message}`);
    }

    const after = installed();
    const state = await check({ online: false }).catch(() => null);
    const result = {
      ok: !installError && !startError,
      from: before.version || null,
      to: after.version || null,
      installed: !installError,
      restarted: !startError,
      error: installError || startError || null,
    };
    if (result.ok) {
      log.info(`engine updated: ${result.from || '?'} -> ${result.to || '?'}`);
    }
    notify?.({ kind: 'engine-update', update: state || result });
    return result;
  }

  return { check, update, installed };
}
