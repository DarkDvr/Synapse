// A program-only update cannot replace the engine: every installed updater in the
// wild copies only Synapse.exe/src/web/skills, never bin\. When an old install had
// already updated its engine to a version this Synapse was not built for, the model
// catalog and the skill list come back empty. This module repairs that one runtime
// from the full release, once, before the UI is served.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, ROOT } from './paths.js';
import { APP_VERSION, ENGINE_VERSION } from './version.js';

const FULL_ASSET = 'Synapse-full-win-x64.zip';
const FULL_URL = (version) =>
  `https://github.com/DarkDvr/Synapse/releases/download/v${version}/${FULL_ASSET}`;

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(command, timeout = 900_000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr || stdout || err.message).trim().split(/\r?\n/).slice(-2).join(' / ')));
          return;
        }
        resolve(String(stdout || '').trim());
      },
    );
  });
}

async function downloadFull(version, file, log) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  log.info(`runtime repair: downloading ${FULL_ASSET} for ${version}`);
  const res = await fetch(FULL_URL(version), {
    headers: { 'user-agent': 'Synapse', accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(900_000),
  });
  if (!res.ok || !res.body) throw new Error(`the full runtime download answered ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  const bytes = fs.statSync(file).size;
  if (bytes < 100 * 1024 * 1024) throw new Error(`the full runtime download is incomplete (${bytes} bytes)`);
  log.info(`runtime repair: downloaded ${Math.round(bytes / 1024 / 1024)} MB`);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, force: true });
}

/**
 * If the installed engine is not the one this Synapse was built with, replace
 * `bin\opencode` (and the browser host/action layer) from the full release. The
 * engine's data is left alone: 2.2.6 opens the same database.
 *
 * Returns whether a repair happened. A missing network is reported, not fatal:
 * the UI still opens and says what is wrong.
 */
export async function repairRuntime({ engine, log } = {}) {
  const want = String(ENGINE_VERSION || '').trim();
  if (!want) return false;
  let got = '';
  try { got = String(engine?.status?.().version || '').trim(); } catch {
    // An engine that cannot report its version is not a runtime we can judge;
    // leaving it alone is safer than replacing a working binary.
    got = '';
  }
  if (!got || got === want) return false;

  log?.warn?.(`runtime repair: engine ${got} is not the ${want} this Synapse was built for`);
  const updateDir = path.join(DATA_DIR, 'update');
  const zip = path.join(updateDir, FULL_ASSET);
  const stage = path.join(updateDir, `runtime-${APP_VERSION}`);
  if (!fs.existsSync(zip) || fs.statSync(zip).size < 100 * 1024 * 1024) {
    await downloadFull(APP_VERSION, zip, log);
  } else {
    log?.info?.(`runtime repair: using ${zip}`);
  }

  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  log?.info?.('runtime repair: unpacking the full runtime');
  await runPowerShell(
    `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(stage)} -Force`,
  );
  const srcBin = path.join(stage, 'bin');
  const srcEngine = path.join(srcBin, 'opencode', 'opencode.exe');
  if (!fs.existsSync(srcEngine) || fs.statSync(srcEngine).size < 100 * 1024 * 1024) {
    throw new Error('the full release has no usable bin\\opencode');
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const backup = path.join(DATA_DIR, 'backups', `runtime-${stamp}`);
  const dirs = ['opencode', 'browser-host', 'agent-browser'];
  for (const dir of dirs) copyDir(path.join(ROOT, 'bin', dir), path.join(backup, dir));

  log?.info?.(`runtime repair: backing up bin to ${backup}`);
  try { await engine.stop(); } catch { /* not running */ }
  try {
    for (const dir of dirs) copyDir(path.join(srcBin, dir), path.join(ROOT, 'bin', dir));
    await engine.start();
    const after = String(engine.status?.().version || '').trim();
    if (after && after !== want) throw new Error(`the repaired engine reports ${after}, not ${want}`);
    log?.info?.(`runtime repair: engine is now ${after || want}`);
    fs.rmSync(stage, { recursive: true, force: true });
    return true;
  } catch (err) {
    log?.warn?.(`runtime repair failed: ${err.message}; restoring the previous runtime`);
    try { await engine.stop(); } catch { /* not running */ }
    for (const dir of dirs) copyDir(path.join(backup, dir), path.join(ROOT, 'bin', dir));
    try { await engine.start(); } catch { /* leave the UI to report it */ }
    throw err;
  }
}
