// Bring SynaBrowse's window to the operator, without taking their screen.
//
// The window belongs to a process of ours; this is the only thing that touches the desktop
// and it never activates: it is moved into the second monitor's place, shown minimized on
// the taskbar, its button blinked and one chime played. The operator restores it when they
// are ready, and the model waits on the tool call until they do what was asked.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'show.ps1');
const SCREEN = path.join(HERE, 'screen.ps1');

/**
 * Ask the operator for a moment of their time.
 *
 * Answers what happened, measured: the window's handle, where it was put, whether it is
 * minimized, and whether the foreground window changed (it must not).
 */

/** Run a PowerShell helper and read its one JSON line. */
function askPowerShell(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCREEN, ...args], { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(String(out).trim().split(/\r?\n/).filter(Boolean).pop() || 'null')); } catch { resolve(null); /* no answer is no state */ }
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

/**
 * The screen state before a launch: the window that has the foreground, and where the
 * monitors are. One PowerShell call, about a fifth of a second.
 */
export function screenState() {
  return askPowerShell(['-Mode', 'state']);
}

/**
 * Give the foreground back to the window that had it. A process that does not own the
 * foreground cannot take it by itself; screen.ps1 attaches to the foreground thread to do
 * it. Answers whether it worked, measured.
 */
export function restoreFocus(hwnd) {
  if (!hwnd) return Promise.resolve(null);
  return askPowerShell(['-Mode', 'restore', '-Hwnd', String(hwnd)]);
}

export function askOperator({ profile, restore = false, sound = null, timeoutMs = 15000 } = {}) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-Marker', profile,
    ...(restore ? ['-Restore'] : []),
    // Sound is passed when the caller decided: a path, or '' for silence. Omitted means
    // the script's own default, which is the chime.
    ...(sound === null || sound === undefined ? [] : ['-Sound', sound]),
  ];
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn('powershell', args, { windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', async (code) => {
      clearTimeout(timer);
      const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop() || '';
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { parsed = null; /* not JSON: a report we cannot read */ }
      // Showing a window can take the foreground — SW_SHOWNOACTIVATE on a minimized window
      // still activated it on this machine (11 Nov). The operator's window gets it back, so
      // the hand-off never interrupts what they were typing in.
      if (parsed?.stoleFocus && parsed.fgBefore) {
        const back = await restoreFocus(parsed.fgBefore).catch(() => null);
        parsed.focusReturned = Boolean(back?.ok);
      }
      resolve({
        ok: Boolean(parsed && !parsed.error),
        code,
        window: parsed,
        error: parsed?.error || (code ? String(err).trim().split(/\r?\n/).pop() || `exit ${code}` : null),
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, window: null, error: error.message });
    });
  });
}
