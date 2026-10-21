// Is npm here, and what does that mean for this start?
//
// Synapse uses npm for exactly one thing: updating the runtime (Settings >
// Runtime > Check for Updates installs `@opencode/cli` and copies it over the
// copy that travels with the app). Nothing else at runtime needs it — the app is
// plain Node, and a vendored runtime runs on a machine with no toolchain at all.
//
// So the decision is not "no npm, no Synapse":
//
//   npm present                     -> say nothing.
//   npm missing, runtime present    -> offer to install Node.js; if declined,
//                                      start anyway and say what is lost (the
//                                      update button, nothing else).
//   npm missing, no runtime either  -> offer to install Node.js; if declined,
//                                      explain and exit: there is nothing on this
//                                      machine that could run a turn.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** Which of the three situations this boot is in. Pure, so it is testable. */
export function npmPlan({ npmFound, runtimeFound }) {
  if (npmFound) return 'quiet';
  return runtimeFound ? 'warn' : 'block';
}

const run = (file, args, timeout) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, out: String(stdout || '').trim(), error: error ? error.message : '' });
    });
  });

/** Is npm on this machine's PATH? Windows answers through the shell, npm being a .cmd. */
export async function hasNpm({ comspec = process.env.ComSpec || 'cmd.exe' } = {}) {
  const r = await run(comspec, ['/d', '/s', '/c', 'npm --version'], 15000);
  return r.ok && /^\d+\.\d+/.test(r.out);
}

/** Is there a runtime here at all — the vendored copy, or one installed globally? */
export function runtimePresent(vendorPath) {
  try { return fs.existsSync(vendorPath); } catch { return false; }
}

/** Ask a question on the console Synapse was started from. */
export function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

/**
 * Install Node.js LTS with winget. This is the one moment Synapse asks the
 * machine to fetch something (the operator said yes), and it is deliberately not
 * silent: the command is printed first.
 */
export async function installNode({ log = () => {}, comspec = process.env.ComSpec || 'cmd.exe' } = {}) {
  const where = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
  const found = await run(where, ['winget'], 10000);
  if (!found.ok) {
    return { ok: false, error: 'winget is not available on this machine.' };
  }
  const args = [
    'install',
    '-e',
    '--id',
    'OpenJS.NodeJS.LTS',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--silent',
  ];
  log(`node install: winget ${args.join(' ')}`);
  const r = await run('winget', args, 15 * 60 * 1000);
  if (!r.ok) return { ok: false, error: r.error || 'winget could not install Node.js.' };
  // The installer updates the machine PATH, but not this process's copy of it.
  const nodeDir = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs');
  if (fs.existsSync(nodeDir) && !String(process.env.PATH || '').includes(nodeDir)) {
    process.env.PATH = `${nodeDir};${process.env.PATH || ''}`;
  }
  return { ok: true };
}
