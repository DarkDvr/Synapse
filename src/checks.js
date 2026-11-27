// A task's acceptance checks, run by the harness.
//
// A worker's "done" is a claim. The plan can name the command that proves it,
// and this module runs it in the project when the worker says it is finished.
// A failure goes back to the worker once; a second failure is reported to the
// Architect rather than retried for ever.
//
// Two rules keep it honest:
//   - the command is judged by the same policy as any shell call before it runs
//     (src/permissions.js), so a check cannot widen what a worker may do;
//   - the output is capped and the full log is written inside the project, so a
//     failing build costs a tail, not the whole log in the Architect's context.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from './paths.js';
import { decide } from './permissions.js';
import { protectionFor } from './protection.js';

/** At most three commands, and each one short enough to read in a plan row. */
export const CHECK_MAX = 3;
export const CHECK_TIMEOUT_MS = 120_000;
const COMMAND_MAX = 300;
const OUTPUT_MAX = 8000;

/**
 * Split a command line into the program and its arguments.
 *
 * A check is written the way a person writes a command, and on this machine that
 * means POSIX-style single quotes around an argument — the shipped visual-review
 * skill's own documented command is `--expect '#result|^0$'`. cmd.exe does not know
 * that quoting: it read the `|` as a pipe and executed `^0$' --audit` as a program, so
 * a check that passed in the worker's own shell failed in the harness with `'0$'' is
 * not recognized ...` (28 Nov, t2). Splitting the line here and spawning without a
 * shell means no shell can reinterpret an argument.
 *
 * Returns null when the line cannot be split (an unclosed quote); the caller then
 * falls back to a shell rather than guessing at the operator's intent.
 */
export function splitCommand(command) {
  const text = String(command || '');
  const argv = [];
  let current = '';
  let started = false;
  const push = () => {
    if (!started) return;
    argv.push(current);
    current = '';
    started = false;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      push();
      i += 1;
      continue;
    }
    if (ch === "'") {
      started = true;
      i += 1;
      const end = text.indexOf("'", i);
      if (end === -1) return null;
      current += text.slice(i, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      started = true;
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\' && text[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          closed = true;
          i += 1;
          break;
        }
        current += text[i];
        i += 1;
      }
      if (!closed) return null;
      continue;
    }
    // A backslash is a path separator here, never an escape: `C:\dev\x.js` is one
    // argument, which is how the command was written.
    started = true;
    current += ch;
    i += 1;
  }
  push();
  return argv.length ? argv : null;
}

/**
 * Does this command line use the shell itself — a pipe, a redirect, `&&`, or a
 * `%VAR%`?
 *
 * Only those need cmd.exe, and only those pay its quoting rules. A line with none of
 * them is spawned as the program and arguments it names, so a quoted argument arrives
 * exactly as written.
 */
export function hasShellSyntax(command) {
  const text = String(command || '');
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '|' || ch === '&' || ch === '>' || ch === '<') return true;
    if (ch === '%' && /^%[^%\s]+%/.test(text.slice(i))) return true;
  }
  return false;
}

/** The checks a plan row may carry, or [] when it carries none. */
export function parseChecks(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const command = item.replace(/\s+/g, ' ').trim();
    if (!command || command.length > COMMAND_MAX) continue;
    if (out.includes(command)) continue;
    out.push(command);
    if (out.length >= CHECK_MAX) break;
  }
  return out;
}

/**
 * Could this command run as a check?
 *
 * The same answer a shell call would get: inside the project it is allowed,
 * outside it asks, a protected path is refused. A check that asks is not run —
 * there is no operator in the middle of a run to answer it, and quietly granting
 * it would make the check a way around the policy.
 */
export function checkDecision(command, { dir, config }) {
  return decide({
    action: 'shell',
    resources: [command],
    cwd: dir,
    projectRoot: dir,
    harnessRoot: ROOT,
    home: os.homedir(),
    protection: protectionFor(config),
  });
}

/**
 * Run one command in the project. Resolves to `{ ok, code, output, ms, timedOut,
 * truncated }`; never rejects for a command that merely failed.
 */
export function runCheck(command, { cwd, timeoutMs = CHECK_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let truncated = false;
    let settled = false;
    let timer = null;
    let child = null;

    const killTree = () => {
      if (!child?.pid) return;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // The tree kill is best effort: the check is already over, and a leftover
        // child is the OS's to reap.
        try { child.kill(); } catch { /* already gone */ }
      }
    };

    const finish = (code, extra = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        ok: code === 0,
        code,
        output,
        ms: Date.now() - started,
        timedOut: false,
        truncated,
        ...extra,
      });
    };

    const onAbort = () => {
      killTree();
      finish(130, { aborted: true });
    };

    // A command with no shell syntax is run as the program and arguments it names;
    // one that uses the shell keeps cmd.exe, because a pipe or a redirect has to be
    // interpreted by one. A command that will not spawn without a shell — `npm`,
    // which is `npm.cmd`, or a `.cmd` in the project — is retried through it once, so
    // the one case that needs cmd.exe still works.
    const argv = splitCommand(command);
    let viaShell = !argv || hasShellSyntax(command);

    const take = (chunk) => {
      const text = String(chunk);
      output += text;
      if (output.length > OUTPUT_MAX) {
        output = output.slice(-OUTPUT_MAX);
        truncated = true;
      }
    };

    const attempt = (useShell) => {
      viaShell = useShell;
      try {
        child = useShell
          ? spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env } })
          : spawn(argv[0], argv.slice(1), { cwd, windowsHide: true, env: { ...process.env } });
      } catch (err) {
        // Node refuses a `.cmd`/`.bat` synchronously on Windows: only a shell can
        // start one, which is the same case an ENOENT reports on other versions.
        if (!useShell && (err?.code === 'ENOENT' || err?.code === 'EINVAL')) {
          attempt(true);
          return;
        }
        finish(1, { output: `could not start the check: ${err.message}` });
        return;
      }
      const started = child;
      const mine = () => started === child;
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.on('close', (code) => {
        if (!mine()) return;
        finish(typeof code === 'number' ? code : 1);
      });
      child.on('error', (err) => {
        if (!mine()) return;
        if (!useShell && (err.code === 'ENOENT' || err.code === 'EINVAL')) {
          attempt(true);
          return;
        }
        finish(1, { output: `could not run the check: ${err.message}` });
      });
    };

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      killTree();
      finish(124, { timedOut: true });
    }, Math.max(500, timeoutMs));

    attempt(viaShell);
  });
}

/** Where a failed check's full output is kept: inside the project, never outside. */
function saveLog(dir, taskId, command, result) {
  const folder = path.join(dir, '.project', 'reports', 'checks');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${String(taskId || 'task')}-${stamp}.log`;
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, name),
      [
        `command: ${command}`,
        `exit: ${result.code}${result.timedOut ? ' (timed out)' : ''}`,
        `ran: ${result.ms} ms`,
        '',
        result.output || '(no output)',
      ].join('\n'),
      'utf8',
    );
    return `${['.project', 'reports', 'checks', name].join('/')}`;
  } catch {
    // A log that cannot be written is not a reason to fail the run; the report
    // still carries the tail.
    return null;
  }
}

/**
 * Did the check fail because the harness could not run it, rather than because the
 * project is wrong? A missing cmdlet or executable is a defect in the check itself:
 * the worker cannot install it, and asking it to try walks it into protected system
 * folders. That is what happened on 16 Nov with a `Get-FileHash` check that worked in
 * the worker's shell but not in the harness's check process (17 Nov).
 *
 * The harness names the two ways a check can be unrunnable apart: a program that is
 * not there, and a command line the shell split at a quoted argument. cmd.exe prints
 * the name it could not run in single quotes either way, so the name itself decides:
 * a token that could not be a program (it carries a shell character) is a fragment of
 * a split line, and `'0$''` on 28 Nov was exactly that — a correct check reported as
 * a missing program.
 */
export function checkInfrastructureFailure(result) {
  if (!result || result.ok !== false || result.skipped || result.aborted) return '';
  const text = String(result.output || '');
  if (/could not (?:start|run) the check/i.test(text)) return 'the check process could not start';
  const unknown =
    /(?:^|[\r\n])\s*'([^'\r\n]*)'[^\r\n]*?is not recognized as an internal or external command/i.exec(text);
  if (unknown) {
    if (/[^\w.\-:\\/]/.test(unknown[1])) {
      return (
        'the shell split the command line at a quoted argument — a check that uses a shell ' +
        'operator (|, &&, >) is run by cmd.exe, so quote its arguments with double quotes'
      );
    }
    return 'a command the check names is not available to the harness';
  }
  if (
    /is not recognized as the name of a cmdlet|CommandNotFoundException|\bcommand not found\b|^\S[^\r\n]*: not found\b/im.test(
      text,
    )
  ) {
    return 'a command the check names is not available to the harness';
  }
  if (Number(result.code) === 127 || Number(result.code) === 9009) {
    return 'the shell could not find a command the check names';
  }
  return '';
}

/**
 * Run a task's checks in order, stopping at the first real failure.
 *
 * Returns `{ results, failed, skipped, ran, logPath, invalid }`. A check the policy
 * will not allow is `skipped` with its reason, never silently passed. A check whose
 * own command is unavailable is marked `invalid`; the worker is not asked to fix it.
 */
export async function runTaskChecks(checks, { dir, config, signal, taskId } = {}) {
  const results = [];
  for (const command of checks || []) {
    if (signal?.aborted) {
      results.push({ command, aborted: true, ok: false, output: '', code: 130, ms: 0 });
      break;
    }
    const decision = checkDecision(command, { dir, config });
    if (decision.effect !== 'allow') {
      results.push({
        command,
        skipped: true,
        effect: decision.effect,
        reason: decision.reason || 'the policy did not allow it',
      });
      continue;
    }
    const result = await runCheck(command, { cwd: dir, signal });
    results.push({ command, ...result });
    if (!result.ok) break;
  }
  const failed = results.find((r) => r.ok === false && !r.aborted) || null;
  const invalid = failed ? checkInfrastructureFailure(failed) : '';
  if (failed && invalid) failed.invalid = invalid;
  const skipped = results.filter((r) => r.skipped);
  const ran = results.filter((r) => !r.skipped && !r.aborted).length;
  const logPath = failed ? saveLog(dir, taskId, failed.command, failed) : null;
  return { results, failed, skipped, ran, logPath, invalid };
}

/** The one repair turn a failed check gets. Short: the session has the rest. */
export function checkNudge(result, logPath) {
  const r = result?.failed;
  if (!r) return '';
  const tail = String(r.output || '').trim().slice(-2000);
  return (
    `The harness ran your task's check and it failed:\n` +
    `$ ${r.command}\n` +
    `exit ${r.code}${r.timedOut ? ' (timed out)' : ''} after ${Math.round((r.ms || 0) / 1000)}s\n` +
    (tail ? `${tail}\n` : '') +
    (logPath ? `The full output is in ${logPath}.\n` : '') +
    `Fix the cause, run the check yourself until it passes, and finish with your usual report. ` +
    `The harness will run it once more.`
  );
}
