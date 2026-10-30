// Sync the staged program files into place after the app has closed.
//
// This runs on the copy of Node that travels with Synapse, not on PowerShell:
// execution policy, script blocking and antivirus rules around .ps1 files were
// reasons the first updater could close the app and then do nothing (29 Oct).
// It waits for the server and the shell by pid, keeps a backup, copies only the
// program paths, and starts Synapse again.
//
//   node update-apply.mjs --root <dir> --stage <dir> --server <pid> \
//        --shell <pid> --version <version>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};

const root = path.resolve(arg('root'));
const stage = path.resolve(arg('stage'));
const serverPid = Number(arg('server', '0')) || 0;
const shellPid = Number(arg('shell', '0')) || 0;
const version = arg('version', '');
const updateDir = path.join(root, 'data', 'update');
const logFile = path.join(updateDir, 'apply.log');

fs.mkdirSync(updateDir, { recursive: true });
const say = (line) => {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\r\n`, 'utf8');
  } catch { /* the copy is more important than the log */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const files = ['Synapse.exe', 'package.json', 'update-apply.ps1', 'update-apply.mjs', 'config.default.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY.md'];
const dirs = ['src', 'web', 'skills', 'templates'];

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid, ms, what) {
  if (!pid) return true;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await sleep(300);
  }
  say(`${what} (pid ${pid}) did not exit in time`);
  return false;
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, { recursive: true, force: true });
}

function backup(to) {
  fs.mkdirSync(to, { recursive: true });
  for (const rel of [...files, ...dirs]) copyTree(path.join(root, rel), path.join(to, rel));
}

function restore(from) {
  if (!fs.existsSync(from)) return;
  const exe = path.join(from, 'Synapse.exe');
  if (fs.existsSync(exe)) moveIntoPlace(exe, path.join(root, 'Synapse.exe'));
  for (const rel of files.filter((f) => f !== 'Synapse.exe')) copyTree(path.join(from, rel), path.join(root, rel));
  for (const rel of dirs) copyTree(path.join(from, rel), path.join(root, rel));
}

/**
 * Put the exe in place without inheriting the destination folder's integrity
 * label. A plain copy into the root of a sandboxed workspace creates a Low
 * file, and the next launch then fails to create data\webview2; a move from
 * data\ keeps the Medium label the temp copy already has.
 */
function moveIntoPlace(from, to) {
  const tmp = path.join(root, 'data', `stage-${process.pid}-${path.basename(to)}`);
  fs.copyFileSync(from, tmp);
  try { if (fs.existsSync(to)) fs.rmSync(to, { force: true }); } catch { /* locked by the old app */ }
  fs.renameSync(tmp, to);
}

function apply() {
  const exe = path.join(stage, 'Synapse.exe');
  if (fs.existsSync(exe)) moveIntoPlace(exe, path.join(root, 'Synapse.exe'));
  for (const rel of files.filter((f) => f !== 'Synapse.exe')) copyTree(path.join(stage, rel), path.join(root, rel));
  for (const rel of dirs) copyTree(path.join(stage, rel), path.join(root, rel));
}

function start() {
  try {
    const child = spawn(path.join(root, 'Synapse.exe'), [], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    say('started Synapse');
  } catch (err) {
    say(`could not start Synapse: ${err.message}`);
  }
}

// The server waits for this file before it closes the app: if the helper cannot
// even start, the update is aborted rather than leaving a closed Synapse behind.
fs.writeFileSync(path.join(updateDir, 'started'), new Date().toISOString(), 'utf8');
say(`update to ${version || '(unknown)'} requested; waiting for the app to close`);

if (!(await waitGone(serverPid, 60_000, 'the server'))) {
  say('aborted: the server is still running');
  process.exit(1);
}
if (!(await waitGone(shellPid, 60_000, 'the app window'))) {
  say('aborted: the app window is still running; close it and run the update again');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const backupDir = path.join(root, 'data', 'backups', `${version || 'update'}-${stamp}`);
let ok = false;
try {
  say(`backing up the current program files to ${backupDir}`);
  backup(backupDir);
  say('copying the new program files');
  apply();
  if (!fs.existsSync(path.join(root, 'Synapse.exe'))) throw new Error('Synapse.exe is missing after the copy');
  ok = true;
  say('update applied');
} catch (err) {
  say(`update failed: ${err.message}`);
  try {
    say('restoring the previous program files');
    restore(backupDir);
  } catch (restoreErr) {
    say(`restore failed: ${restoreErr.message}`);
  }
}

try {
  fs.writeFileSync(
    path.join(updateDir, 'last.json'),
    JSON.stringify({ version, ok, at: new Date().toISOString(), backup: backupDir, log: logFile }, null, 2),
    'utf8',
  );
} catch { /* the log carries the same */ }

start();
