// Keep the PC awake while Synapse says so.
//
// Windows' idle timer is held off with `SetThreadExecutionState`: one PowerShell
// child asks the kernel for `ES_SYSTEM_REQUIRED` every twenty seconds, and the
// system does not sleep or hibernate while it is alive. `ES_DISPLAY_REQUIRED` is
// added only when Settings also wants the monitor kept on — without it the screen
// follows the operator's own "turn off after" setting, and the machine stays awake
// behind it.
//
// The request belongs to the process that makes it: the child exits after twenty
// seconds if Synapse is gone, and Windows drops the request with it. That is why
// this is a child process rather than a loop in the server: if the server dies,
// the lock must die with it.
//
// Not a kernel driver and not a power-plan edit: it is the same API PowerToys
// Awake uses. The disk heartbeat keeps the app's own drive busy; a disk that spins
// down on its own timer is the drive's setting, not something a wake lock overrides.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TICK_SECONDS = 20;

/**
 * The PowerShell that holds the lock.
 *
 * Exported because the flags are the whole feature, and a test that reads them is
 * cheaper than a machine that will not sleep.
 */
export function wakeScript({ display = false, ownerPid = 0, heartbeat = null } = {}) {
  // 0x80000000 | ES_SYSTEM_REQUIRED | (display ? ES_DISPLAY_REQUIRED : 0), as a
  // positive decimal. PowerShell reads the literal `0x80000000` as a negative
  // Int32, and a negative Int32 cannot be passed to a UInt32 parameter — the
  // first version held the lock for exactly zero seconds because of it (4 Nov).
  const flags = 0x80000000 + 0x1 + (display ? 0x2 : 0);
  const beat = heartbeat
    ? `[System.IO.File]::WriteAllText('${String(heartbeat).replace(/'/g, "''")}', [DateTime]::UtcNow.ToString('o'))`
    : '';
  return [
    "Add-Type -Name Power -Namespace Syn -MemberDefinition '[DllImport(\"kernel32.dll\", SetLastError = true)] public static extern uint SetThreadExecutionState(uint esFlags);'",
    `$ES_FLAGS = ${flags}`,
    `$owner = ${Number(ownerPid) || 0}`,
    'try {',
    `  while (($owner -eq 0) -or (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {`,
    '    [Syn.Power]::SetThreadExecutionState([uint32]$ES_FLAGS) | Out-Null',
    beat ? `    ${beat}` : '',
    `    Start-Sleep -Seconds ${TICK_SECONDS}`,
    '  }',
    '} finally {',
    '  [Syn.Power]::SetThreadExecutionState([uint32]0) | Out-Null',
    '}',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function createPowerKeeper({
  logger,
  file = null,
  spawnFn = spawn,
  ownerPid = process.pid,
} = {}) {
  const log = logger?.channel?.('app') || { info() {}, warn() {} };
  let child = null;
  let mode = null; // { display }
  let lastError = null;

  const state = () => ({
    awake: Boolean(child),
    display: Boolean(child && mode?.display),
    error: lastError,
  });

  function stop() {
    if (!child) {
      mode = null;
      return state();
    }
    try {
      child.kill();
    } catch { /* already gone */ }
    child = null;
    mode = null;
    log.info('power: wake lock released');
    return state();
  }

  /** Start, stop, or change the lock. Idempotent: an unchanged ask does nothing. */
  function apply({ keepAwake = false, keepDisplay = false } = {}) {
    const awake = keepAwake === true;
    const display = awake && keepDisplay === true;
    if (!awake) return stop();
    if (child && mode?.display === display) return state();

    // A changed display flag is one new request: the old process is holding the
    // older flags, and two children would each hold their own.
    stop();
    lastError = null;
    try {
      const script = wakeScript({ display, ownerPid, heartbeat: file });
      child = spawnFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        { windowsHide: true, stdio: 'ignore' },
      );
      mode = { display };
      child.once?.('error', (err) => {
        lastError = err.message;
        child = null;
        mode = null;
        log.warn(`power: could not hold the wake lock: ${err.message}`);
      });
      child.once?.('exit', (code) => {
        if (child) {
          child = null;
          mode = null;
          lastError = code ? `the wake lock exited (${code})` : lastError;
          log.warn(`power: the wake lock exited (${code})`);
        }
      });
      log.info(`power: wake lock held${display ? ', monitor kept on' : ''}`);
    } catch (err) {
      lastError = err.message;
      log.warn(`power: could not hold the wake lock: ${err.message}`);
    }
    return state();
  }

  /** Keep the app's own drive busy while the lock is held; the file is tiny. */
  function heartbeat() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, new Date().toISOString(), 'utf8');
    } catch { /* a disk that refuses a byte is not the wake lock's problem */ }
  }

  return { apply, stop, state, heartbeat };
}
