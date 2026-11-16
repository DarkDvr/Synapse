// How long since the operator last touched the machine.
//
// Auto-Shutdown used to count only Synapse's own quiet: no turns, no questions,
// no runs. That is not the same as the machine being idle — on 16 Nov it powered
// the PC off at 15:12 while the operator was working in another app, because
// Synapse had had nothing to do for twenty minutes. The system's own last-input
// clock is the honest question, and Windows answers it with GetLastInputInfo.
//
// One small PowerShell process, only when the Auto-Shutdown clock is already at
// its deadline: at most once per idle window, so it costs nothing on a busy day.
// A failure is `null`, and the caller must treat that as "do not power off": not
// knowing is not permission.
import { spawn } from 'node:child_process';

export const IDLE_SCRIPT = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class SynIdle {',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
  '  [DllImport("user32.dll")]',
  '  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  '  public static uint Ms() {',
  '    var lii = new LASTINPUTINFO();',
  '    lii.cbSize = (uint)Marshal.SizeOf(lii);',
  '    if (!GetLastInputInfo(ref lii)) return 0;',
  '    return (uint)Environment.TickCount - lii.dwTime;',
  '  }',
  '}',
  '"@',
  '[SynIdle]::Ms()',
].join('\n');

/**
 * Milliseconds since the last mouse or keyboard input, or null when the answer
 * cannot be had. Windows only; elsewhere `null` is the safe answer.
 */
export function userIdleMs({ spawnFn = spawn, timeoutMs = 4000, platform = process.platform } = {}) {
  if (platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { child?.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    try {
      child = spawnFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', IDLE_SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      // The process could not be started; no answer is the safe answer.
      resolve(null);
      return;
    }
    let out = '';
    timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.once?.('error', () => finish(null));
    child.once?.('close', () => {
      // Add-Type can print warnings before the number; the answer is the last line.
      const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop() || '';
      const ms = Number(line);
      finish(Number.isFinite(ms) ? ms : null);
    });
  });
}
