// The WebView2 host: a small native-WPF process that owns the window and the download
// events. This module only launches it, waits for its state, and turns its JSONL download
// log into the records the browser provider exposes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SYNAPSE_HARNESS || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The host exe: the shipped bin first, then the dev build. */
export function hostBinary({ root = ROOT } = {}) {
  const candidates = [
    process.env.SYNAPSE_BROWSER_HOST,
    path.join(root, 'bin', 'browser-host', 'SynaBrowseHost.exe'),
    path.join(root, 'shell', 'SynaBrowseHost', 'bin', 'Release', 'net10.0-windows', 'SynaBrowseHost.exe'),
  ].filter(Boolean);
  for (const file of candidates) {
    try { if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
  }
  return null;
}

/** The state/downloads files live beside the profile, not inside the WebView2 user data. */
export function hostFiles({ profile }) {
  const dir = path.dirname(profile);
  return {
    profile,
    stateFile: path.join(dir, 'webview2-state.json'),
    downloadsFile: path.join(dir, 'webview2-downloads.jsonl'),
  };
}

export function readHostState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // No state file yet, or the host is between writes; "not ready" is the answer.
    return null;
  }
}

export async function hostAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    // The port is gone: that is exactly the question being asked, not an error.
    return false;
  }
}

/** The host writes ready/error/exited; this waits for the first two. */
export async function waitForHostState(file, { timeoutMs = 30000, child = null, log = null } = {}) {
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    const state = readHostState(file);
    if (state?.state === 'ready' || state?.state === 'error') return state;
    if (child && child.exitCode !== null) {
      throw new Error(`the browser host exited (${child.exitCode}) before it was ready${log?.() ? `: ${log().slice(-300)}` : ''}`);
    }
    await sleep(200);
  }
  throw new Error('the browser host did not become ready');
}

/**
 * Start the host. A ready state from a previous run is discarded: the host truncates its
 * own downloads log and rewrites the state when it starts.
 */
export async function launchHost({
  exe,
  profile,
  downloadDir,
  stateFile,
  downloadsFile,
  visible = false,
  parentPid = process.pid,
  width = 1280,
  height = 800,
  log = null,
}) {
  if (!exe) throw new Error('the browser host is not built — run shell\\build.ps1');
  const download = downloadDir || path.join(path.dirname(profile), 'downloads');
  try { fs.rmSync(stateFile, { force: true }); } catch { /* fine */ }
  fs.mkdirSync(download, { recursive: true });
  const args = [
    '--url', 'about:blank',
    '--profile', profile,
    '--download-dir', download,
    '--state', stateFile,
    '--downloads', downloadsFile,
    '--port', '0',
    '--parent-pid', String(parentPid),
    '--width', String(width),
    '--height', String(height),
    '--title', 'SynaBrowse',
  ];
  if (visible) args.push('--visible');
  const child = spawn(exe, args, { cwd: path.dirname(profile), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let text = '';
  const keep = (chunk) => {
    text += chunk;
    if (text.length > 20000) text = text.slice(-10000);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    keep(chunk);
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        log?.info?.(`browser host: ${event.event || 'event'}${event.path ? ` ${event.path}` : ''}`);
      } catch {
        // A non-JSON line (a stray progress message) is logged, not an answer.
        log?.debug?.(`browser host: ${line.slice(0, 300)}`);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    keep(chunk);
    log?.warn?.(`browser host: ${String(chunk).trim().slice(0, 300)}`);
  });
  const state = await waitForHostState(stateFile, { child, log: () => text });
  if (state.state === 'error') {
    try { child.kill(); } catch { /* gone */ }
    throw new Error(`the browser host failed: ${state.error || 'no reason given'}`);
  }
  return { child, state, port: Number(state.port), stateFile, downloadsFile };
}

/** One JSONL line from the host to the provider's download record. */
export function downloadRecord(event) {
  if (!event || !event.id) return null;
  const state = event.event === 'completed'
    ? 'completed'
    : event.event === 'interrupted'
      ? 'interrupted'
      : 'inProgress';
  return {
    id: String(event.id),
    name: String(event.name || 'download'),
    path: event.path ? String(event.path) : null,
    received: Number(event.received) || 0,
    total: Number(event.total) || 0,
    state,
    startedAt: Number(event.startedAt) || Date.now(),
    endedAt: event.event === 'completed' || event.event === 'interrupted'
      ? (Number(event.endedAt) || Date.now())
      : null,
    error: event.error ? String(event.error) : null,
  };
}

/**
 * Stop the host. A window close is tried first so the WPF Closed handler disposes WebView2
 * and releases the profile; a killed tree is the fallback, by the pid the state named.
 */
export async function stopHostProcess({ pid, hwnd = 0, stateFile, log = null, timeoutMs = 6000 }) {
  if (!pid) return;
  try {
    // The off-screen WPF window has no taskbar button, and Process.CloseMainWindow can
    // miss it. The host publishes its HWND, so WM_CLOSE is the reliable graceful close
    // that lets the Closed handler dispose WebView2 and release the profile.
    const command = hwnd
      ? `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class SynaClose { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'; [void][SynaClose]::PostMessage([IntPtr]${Number(hwnd)},0x0010,[IntPtr]::Zero,[IntPtr]::Zero)`
      : `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if($p){$p.CloseMainWindow()|Out-Null}`;
    await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, () => resolve());
    });
  } catch { /* no window / already gone */ }
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    const state = readHostState(stateFile);
    if (state?.state === 'exited') return;
    const alive = await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `if(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue){'yes'}else{'no'}`,
      ], { windowsHide: true }, (err, stdout) => resolve(String(stdout || '').includes('yes')));
    });
    if (!alive) return;
    await sleep(250);
  }
  try {
    execFile('taskkill', ['/PID', String(Number(pid)), '/T', '/F'], { windowsHide: true }, () => {});
    log?.warn?.(`browser host ${pid} did not close its window; ended its tree`);
  } catch { /* gone */ }
}

export { ROOT };
