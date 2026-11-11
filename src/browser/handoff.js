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

/**
 * Ask the operator for a moment of their time.
 *
 * Answers what happened, measured: the window's handle, where it was put, whether it is
 * minimized, and whether the foreground window changed (it must not).
 */
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
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop() || '';
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { parsed = null; /* not JSON: a report we cannot read */ }
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
