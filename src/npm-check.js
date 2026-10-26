// Is npm here, and what does that mean?
//
// Synapse uses npm for exactly one thing: updating the runtime (Settings >
// Runtime > Check for Updates installs `@opencode/cli` and copies it over the
// copy that travels with the app). Nothing else at runtime needs it — the app is
// plain Node, and a vendored runtime runs on a machine with no toolchain at all.
//
// WHICH npm matters, and it is the whole point of this file. Synapse is a good
// tenant (AGENTS.md rule 3): it may not install anything machine-wide. So it
// prefers the npm that sits beside its own `node.exe` in `bin\node`, and when
// that copy is incomplete — which it was: `npm.cmd` without `node_modules\npm` is
// a shortcut to a file that is not there — it fetches the missing package into
// the same folder.
//
// That fetch has a useful side effect: our npm's global prefix IS `bin\node`, so
// `npm install -g` lands inside the folder by definition and never in
// `%APPDATA%\npm`. Running npm ourselves is what makes the global install local.
//
// So the decision is not "no npm, no Synapse":
//
//   local npm usable              -> say nothing.
//   only a machine npm            -> use it for this session; it is the operator's.
//   none, and a node to pair with -> fetch npm into bin\node, silently.
//   none, and no node either      -> nothing to fetch it with. Runtime updates
//                                    wait; every other part of the app runs.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Which of the three situations this boot is in. Pure, so it is testable. */
export function npmPlan({ npmFound, runtimeFound }) {
  if (npmFound) return 'quiet';
  return runtimeFound ? 'warn' : 'block';
}

const run = (file, args, timeout, env) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, env: env ? { ...process.env, ...env } : undefined }, (error, stdout) => {
      resolve({ ok: !error, out: String(stdout || '').trim(), error: error ? error.message : '' });
    });
  });

/** The node that travels with the app, if it is there. */
export function localNode(root) {
  const exe = path.join(String(root || ''), 'bin', 'node', 'node.exe');
  try { return fs.existsSync(exe) ? exe : null; } catch { return null; }
}

/**
 * Our own npm: a node and the CLI script beside it.
 *
 * npm is a `.cmd`, and running a `.cmd` from `execFile` is refused by modern Node
 * (a shell would have to parse it). Running `node npm-cli.js` sidesteps the shell
 * entirely, which also means a path with spaces needs no quoting and no path ever
 * reaches command text.
 */
export function localNpm(root) {
  const node = localNode(root);
  if (!node) return null;
  const dir = path.dirname(node);
  const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    if (!fs.existsSync(cli)) return null;
  } catch { return null; }
  return { node, cli, dir };
}

/** A npm on this machine's PATH, answered through the shell because it is a .cmd. */
async function machineNpm({ comspec = process.env.ComSpec || 'cmd.exe' } = {}) {
  const r = await run(comspec, ['/d', '/s', '/c', 'npm --version'], 15000);
  return r.ok && /^\d+\.\d+/.test(r.out);
}

/**
 * Is there an npm Synapse may use, and which one is it.
 *
 * `pair` is what a caller needs to run it without a shell; `how` says whether it
 * is ours or the operator's, so a message can be honest about which.
 */
export async function hasNpm({ root, comspec } = {}) {
  const pair = localNpm(root);
  if (pair) {
    const r = await run(pair.node, [pair.cli, '--version'], 20000);
    if (r.ok && /^\d+\.\d+/.test(r.out)) return { ok: true, how: 'local', version: r.out, pair };
  }
  if (await machineNpm({ comspec })) return { ok: true, how: 'machine', pair: null };
  return { ok: false, how: '', pair: null };
}

/** Is there a runtime here at all — the vendored copy, or one installed globally? */
export function runtimePresent(vendorPath) {
  try { return fs.existsSync(vendorPath); } catch { return false; }
}

/** The version of the node we are pairing npm with, from the file vendor-node.ps1 wrote. */
export function localNodeVersion(nodeDir) {
  try {
    const text = fs.readFileSync(path.join(nodeDir, 'VERSION.txt'), 'utf8');
    const m = /^node\s+v?(\d+\.\d+\.\d+)/m.exec(text);
    if (m) return m[1];
  } catch { /* fall through to asking the binary */ }
  return '';
}

/**
 * Fetch npm into the copy of Node that travels with the app.
 *
 * Silent, local and reversible: nothing is installed on the machine, nothing is
 * added to PATH, and deleting `bin\node\node_modules` undoes it. The Node archive
 * is the one `vendor-node.ps1` already downloads, because the npm inside it is
 * exactly the version that matches this node — and only `node_modules\npm` is
 * copied out, so a running `node.exe` is never replaced.
 *
 * PowerShell does the unzip and nothing else: Node has no archive reader and
 * Synapse has no dependencies. The paths travel in the environment, never in the
 * command.
 */
export async function installLocalNpm({ root, log = () => {}, fetchImpl = fetch } = {}) {
  const node = localNode(root);
  if (!node) return { ok: false, error: 'There is no copy of Node in bin\\node to pair npm with.' };

  const dir = path.dirname(node);
  const version = localNodeVersion(dir) || (await run(node, ['--version'], 15000)).out.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    return { ok: false, error: 'Could not work out which Node version bin\\node holds.' };
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const name = `node-v${version}-win-${arch}`;
  const url = `https://nodejs.org/dist/v${version}/${name}.zip`;
  const temp = path.join(process.env.TEMP || process.env.TMP || '.', `synapse-npm-${Date.now()}`);

  log(`npm not usable locally: fetching ${name}.zip into bin\\node`);

  try {
    fs.mkdirSync(temp, { recursive: true });
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) return { ok: false, error: `nodejs.org answered HTTP ${res.status} for ${name}.zip` };
    const zip = path.join(temp, `${name}.zip`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Expand-Archive -LiteralPath $env:SYNAPSE_ZIP -DestinationPath $env:SYNAPSE_WORK -Force',
      'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $env:SYNAPSE_DEST) | Out-Null',
      'if (Test-Path $env:SYNAPSE_DEST) { Remove-Item $env:SYNAPSE_DEST -Recurse -Force }',
      'Copy-Item -LiteralPath $env:SYNAPSE_SOURCE -Destination $env:SYNAPSE_DEST -Recurse -Force',
    ].join('\n');

    const unzip = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      300000,
      {
        SYNAPSE_ZIP: zip,
        SYNAPSE_WORK: path.join(temp, 'out'),
        SYNAPSE_SOURCE: path.join(temp, 'out', name, 'node_modules', 'npm'),
        SYNAPSE_DEST: path.join(dir, 'node_modules', 'npm'),
      },
    );
    if (!unzip.ok) return { ok: false, error: `could not unpack npm: ${unzip.error}` };

    const pair = localNpm(root);
    if (!pair) return { ok: false, error: 'npm was unpacked but bin\\node still has no npm-cli.js.' };
    const check = await run(pair.node, [pair.cli, '--version'], 30000);
    if (!check.ok) return { ok: false, error: `the new npm does not run: ${check.error}` };
    log(`npm ${check.out} is now in bin\\node — runtime updates work, nothing was installed on the machine`);
    return { ok: true, version: check.out };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* a leftover temp dir is harmless */ }
  }
}

/**
 * Where this npm puts globally installed packages.
 *
 * Asked of npm rather than assumed: our own npm's prefix is `bin\node`, and a
 * machine npm's is `%APPDATA%\npm`. The old code hardcoded the second and would
 * not have found a binary installed by the first.
 */
export async function npmGlobalRoot(pair) {
  if (!pair) return '';
  const r = await run(pair.node, [pair.cli, 'prefix', '-g'], 30000);
  return r.ok ? r.out : '';
}
