// Git, the harness's own copy of it, and the change a run made.
//
// Two jobs live here:
//
//   - **A private Git.** A machine with no Git would lose the diff and the
//     checkpoint, so on first launch Synapse fetches MinGit (about 40 MB) into
//     `bin\git` and uses that copy. Nothing is installed machine-wide, no PATH
//     outside the app is edited, and deleting `bin\git` undoes it.
//   - **The tree a run started from, and the patch it left.** The harness reads
//     git with a *temporary index* inside the project, so it can compare the tree
//     before and after a delegation without touching HEAD, the real index, or a
//     single file. The patch is written under `.project/reports/diffs/` — inside
//     the project, like every other piece of evidence.
//
// The harness never commits a project and never pushes. A project's history is
// the operator's; this file only reads it and records what changed.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, DATA_DIR } from './paths.js';

/** MinGit: the smallest official Git for Windows, pinned. */
export const MINGIT = {
  version: '2.56.1.windows.1',
  url: 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip',
  bytes: 39849768,
  sha256: '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd',
};

export const GIT_HOME = path.join(ROOT, 'bin', 'git');
const PATCH_MAX = 400_000;

let cached = null;

/**
 * The git this process should use: the vendored copy first, then PATH.
 *
 * Synchronous because callers are deciding, not installing, and a missing git is
 * a normal answer on a fresh machine.
 */
export function findGit() {
  if (cached) return cached;
  const candidates = [
    process.env.SYNAPSE_GIT,
    path.join(GIT_HOME, 'cmd', 'git.exe'),
    path.join(GIT_HOME, 'ucrt64', 'bin', 'git.exe'),
    path.join(GIT_HOME, 'mingw64', 'bin', 'git.exe'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) {
        cached = file;
        return cached;
      }
    } catch { /* not there; try the next */ }
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const clean = dir.replace(/^"|"$/g, '').trim();
    if (!clean) continue;
    const file = path.join(clean, 'git.exe');
    try {
      if (fs.statSync(file).isFile()) {
        cached = file;
        return cached;
      }
    } catch { /* not there; try the next */ }
  }
  cached = null;
  return null;
}

/** Test seam: forget which git was found. */
export function resetGitCache() {
  cached = null;
}

/** Environment for every git call: no user config, no prompts, no pager. */
function gitEnv(extra = {}) {
  const cfg = path.join(DATA_DIR, 'git', 'global.gitconfig');
  try {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, '', 'utf8');
  } catch { /* the config is optional; git treats an absent file as empty */ }
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: cfg,
    GIT_PAGER: 'cat',
    ...extra,
  };
}

/** One git command. Resolves for a failed command too; never throws. */
export function runGit(args, { cwd, timeoutMs = 60_000, env = {} } = {}) {
  const bin = findGit();
  if (!bin) return Promise.resolve({ ok: false, code: null, out: '', err: 'git is not available', missing: true });
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: gitEnv(env),
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({
          ok: !err,
          code,
          out: String(stdout || ''),
          err: String(stderr || (err && err.message) || ''),
        });
      },
    );
  });
}

/** Is this folder inside a git repository? */
export async function isRepo(dir) {
  if (!findGit()) return false;
  const r = await runGit(['rev-parse', '--git-dir'], { cwd: dir, timeoutMs: 10_000 });
  return r.ok;
}

/**
 * Make the folder a repository, once. `main` is the default branch; a git older
 * than 2.28 does not know `-b`, so that is the fallback.
 */
export async function ensureRepo(dir, { log } = {}) {
  if (!findGit()) return { ok: false, created: false, error: 'git is not available' };
  if (await isRepo(dir)) {
    ignoreState(dir);
    return { ok: true, created: false };
  }
  let r = await runGit(['init', '-q', '-b', 'main'], { cwd: dir, timeoutMs: 20_000 });
  if (!r.ok) r = await runGit(['init', '-q'], { cwd: dir, timeoutMs: 20_000 });
  if (!r.ok) return { ok: false, created: false, error: r.err.trim() || 'git init failed' };
  ignoreState(dir);
  log?.info?.(`git: initialized ${dir}`);
  return { ok: true, created: true };
}

/** Tell git to ignore the project's state folder, without editing a tracked file. */
function ignoreState(dir) {
  const info = path.join(dir, '.git', 'info');
  if (!fs.existsSync(info)) return;
  const file = path.join(info, 'exclude');
  try {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (/^\.project\/?$/m.test(text)) return;
    fs.writeFileSync(file, `${text.replace(/\s*$/, '')}\n.project/\n`, 'utf8');
  } catch { /* a repository without an exclude file still works */ }
}

/**
 * The tree this folder holds now, as git sees it, without touching HEAD or the
 * real index.
 *
 * A temporary index is built from `HEAD` (or empty), the folder is added to it
 * with `.project` excluded, and the resulting tree is returned. Untracked files
 * count; ignored files do not, which is what a project's own `.gitignore` asked
 * for. Returns `null` when there is no repo or git cannot answer.
 */
export async function treeOf(dir) {
  if (!findGit()) return null;
  if (!(await isRepo(dir))) return null;
  const cache = path.join(dir, '.project', 'cache');
  const index = path.join(cache, `index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.mkdirSync(cache, { recursive: true });
  } catch {
    // A cache folder that cannot be made is no tree, not a failed run.
    return null;
  }
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: dir, env, timeoutMs: 10_000 });
    const base = head.ok ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'];
    const read = await runGit(base, { cwd: dir, env, timeoutMs: 20_000 });
    if (!read.ok) return null;
    const add = await runGit(['add', '-A'], {
      cwd: dir,
      env,
      timeoutMs: 60_000,
    });
    if (!add.ok) return null;
    const tree = await runGit(['write-tree'], { cwd: dir, env, timeoutMs: 20_000 });
    return tree.ok ? tree.out.trim() : null;
  } finally {
    for (const file of [index, `${index}.lock`]) {
      try { fs.rmSync(file, { force: true }); } catch { /* a temp index that outlives us is harmless */ }
    }
  }
}

/** The numbers and the patch between two trees. */
export async function diffTrees(dir, from, to) {
  const num = await runGit(['diff', '--numstat', '--no-renames', from, to], { cwd: dir, timeoutMs: 60_000 });
  if (!num.ok) return null;
  const files = [];
  let added = 0;
  let removed = 0;
  let binary = 0;
  for (const line of num.out.split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    const name = rest.join('\t');
    files.push(name);
    if (a === '-' || d === '-') binary += 1;
    else {
      added += Number(a) || 0;
      removed += Number(d) || 0;
    }
  }
  if (!files.length) return null;
  const patch = await runGit(['diff', '--no-color', '--no-ext-diff', from, to], {
    cwd: dir,
    timeoutMs: 60_000,
  });
  const text = patch.ok ? patch.out : '';
  const truncated = text.length > PATCH_MAX;
  return {
    files,
    added,
    removed,
    binary,
    stat: `${files.length} file${files.length === 1 ? '' : 's'}, +${added} −${removed}` +
      (binary ? ` (${binary} binary)` : ''),
    patch: truncated ? `${text.slice(0, PATCH_MAX)}\n# … the patch was cut here; it was longer than 400 KB` : text,
    patchTruncated: truncated,
    from,
    to,
  };
}

/** Write a run's patch inside the project. Returns its relative path, or null. */
function saveDiff(dir, taskId, diff) {
  const folder = path.join(dir, '.project', 'reports', 'diffs');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${String(taskId || 'task')}-${stamp}.diff`;
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, name),
      [
        `# ${taskId || 'task'}: ${diff.stat}`,
        `# from ${diff.from}`,
        `# to   ${diff.to}`,
        '',
        diff.patch || '(no textual change)',
      ].join('\n'),
      'utf8',
    );
    return ['.project', 'reports', 'diffs', name].join('/');
  } catch {
    // A diff that cannot be written is still a run; the report simply has no patch.
    return null;
  }
}

/**
 * Compare a project to the tree a run started from, save the patch and answer
 * what changed. `null` when nothing did, or when git cannot tell.
 */
export async function changeSince(dir, taskId, from) {
  if (!from) return null;
  const to = await treeOf(dir);
  if (!to || to === from) return null;
  const diff = await diffTrees(dir, from, to);
  if (!diff) return null;
  const patchPath = saveDiff(dir, taskId, diff);
  return { ...diff, patchPath };
}

/**
 * A rollback point: a commit whose tree is the project as it stood, kept alive by
 * a ref inside the project's own repository. No parent, no HEAD move, no branch.
 */
export async function createCheckpoint(dir, tree, label) {
  if (!tree) return null;
  const safe = String(label || 'checkpoint')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'checkpoint';
  const ref = `refs/synapse/${safe}`;
  const env = {
    GIT_AUTHOR_NAME: 'Synapse',
    GIT_AUTHOR_EMAIL: 'synapse@localhost',
    GIT_COMMITTER_NAME: 'Synapse',
    GIT_COMMITTER_EMAIL: 'synapse@localhost',
  };
  // One rollback point per project: a new run supersedes the older one, and the
  // older one can no longer be restored anyway (the tool only offers the newest
  // run). Dropping it here is what keeps the refs from piling up.
  const existing = await runGit(['for-each-ref', '--format=%(refname)', 'refs/synapse'], {
    cwd: dir,
    timeoutMs: 10_000,
  });
  for (const old of existing.out.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (old !== ref) await runGit(['update-ref', '-d', old], { cwd: dir, timeoutMs: 10_000 });
  }
  const commit = await runGit(['commit-tree', tree, '-m', `Synapse checkpoint: ${safe}`], {
    cwd: dir,
    env,
    timeoutMs: 20_000,
  });
  if (!commit.ok) return null;
  const sha = commit.out.trim();
  const set = await runGit(['update-ref', ref, sha], { cwd: dir, env, timeoutMs: 10_000 });
  return set.ok ? { ref, commit: sha, at: Date.now() } : null;
}

/** Forget a checkpoint ref. Its objects stay until git's own gc decides otherwise. */
export async function dropCheckpoint(dir, ref) {
  if (!String(ref || '').startsWith('refs/synapse/')) return false;
  const r = await runGit(['update-ref', '-d', ref], { cwd: dir, timeoutMs: 10_000 });
  return r.ok;
}

/**
 * Put the working tree back to a checkpoint.
 *
 * Files the checkpoint has are written back, files that arrived after it are
 * removed, and nothing is touched in `.project` (it was never in the tree). The
 * real index is not rewritten: a restore is a change to the worktree, and the
 * operator's `git status` should show it as one.
 */
export async function restoreCheckpoint(dir, ref) {
  if (!String(ref || '').startsWith('refs/synapse/')) {
    return { ok: false, error: 'that is not one of Synapse\'s checkpoint refs' };
  }
  const commit = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: dir, timeoutMs: 10_000 });
  if (!commit.ok) return { ok: false, error: 'the checkpoint no longer exists' };
  const sha = commit.out.trim();
  const current = await treeOf(dir);
  if (!current) return { ok: false, error: 'the project has no git tree to compare' };

  const status = await runGit(['diff', '--name-status', '--no-renames', current, sha], {
    cwd: dir,
    timeoutMs: 60_000,
  });
  if (!status.ok) return { ok: false, error: status.err.trim() || 'could not compare the trees' };
  const removals = [];
  for (const line of status.out.split('\n')) {
    if (!line.trim()) continue;
    const [kind, ...rest] = line.split('\t');
    if (kind === 'D') removals.push(rest.join('\t'));
  }

  const tree = await runGit(['ls-tree', '-r', '--name-only', sha], { cwd: dir, timeoutMs: 30_000 });
  if (!tree.ok) return { ok: false, error: 'could not read the checkpoint tree' };
  const files = tree.out.split('\n').filter(Boolean);

  const cache = path.join(dir, '.project', 'cache');
  const index = path.join(cache, `restore-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(cache, { recursive: true });
    const env = { GIT_INDEX_FILE: index };
    const read = await runGit(['read-tree', sha], { cwd: dir, env, timeoutMs: 30_000 });
    if (!read.ok) return { ok: false, error: read.err.trim() || 'could not stage the checkpoint tree' };
    const prefix = `${dir.replace(/\\/g, '/')}/`;
    const write = await runGit(['checkout-index', '-a', '-f', `--prefix=${prefix}`], {
      cwd: dir,
      env,
      timeoutMs: 60_000,
    });
    if (!write.ok) return { ok: false, error: write.err.trim() || 'could not write the checkpoint files' };
  } finally {
    for (const file of [index, `${index}.lock`]) {
      try { fs.rmSync(file, { force: true }); } catch { /* a temporary index */ }
    }
  }

  let deleted = 0;
  for (const rel of removals) {
    const target = path.resolve(dir, rel);
    if (!target.startsWith(path.resolve(dir) + path.sep)) continue;
    if (target.split(path.sep).includes('.project')) continue;
    try {
      fs.rmSync(target, { force: true });
      deleted += 1;
    } catch { /* a file that is already gone is the same result */ }
  }
  return { ok: true, restored: files.length, deleted, commit: sha };
}

/**
 * Make sure a git exists, installing the private MinGit on a machine that has
 * none. Silent on success beyond one info line; a failure is a warning, never a
 * boot failure: the app runs without diffs and checkpoints.
 */
export async function ensureGit({ log, fetchImpl = fetch } = {}) {
  const found = findGit();
  if (found) return { ok: true, how: 'found', path: found };
  const what = `MinGit ${MINGIT.version}`;
  log?.info?.(`git: not on this machine — installing ${what} (${Math.round(MINGIT.bytes / 1048576)} MB) into bin\\git`);
  const zip = path.join(DATA_DIR, 'git', `mingit-${MINGIT.version}.zip`);
  const stage = path.join(DATA_DIR, 'git', 'stage');
  try {
    fs.mkdirSync(path.dirname(zip), { recursive: true });
    // A quick reachability check first: an offline machine must not sit on a
    // five-minute download timeout before the window opens. Eight seconds is
    // enough to know the host answers; the download itself gets two minutes.
    const probe = await fetchImpl(MINGIT.url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Synapse' },
      redirect: 'follow',
    }).catch(() => null);
    if (!probe || !probe.ok) {
      log?.warn?.('git: not installed, and the download host did not answer — diffs and checkpoints are off for now');
      return { ok: false, error: 'the download host did not answer' };
    }
    const res = await fetchImpl(MINGIT.url, {
      signal: AbortSignal.timeout(120000),
      headers: { 'user-agent': 'Synapse' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, error: `the download answered HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== MINGIT.bytes) return { ok: false, error: `the download is ${buf.length} bytes, expected ${MINGIT.bytes}` };
    const hash = createHash('sha256').update(buf).digest('hex');
    if (hash !== MINGIT.sha256) return { ok: false, error: 'the download does not match its pinned checksum' };
    fs.writeFileSync(zip, buf);

    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Expand-Archive -LiteralPath $env:SYNAPSE_GIT_ZIP -DestinationPath $env:SYNAPSE_GIT_STAGE -Force',
    ].join('\n');
    const unzip = await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        {
          windowsHide: true,
          timeout: 300000,
          env: { ...process.env, SYNAPSE_GIT_ZIP: zip, SYNAPSE_GIT_STAGE: stage },
        },
        (err, stdout, stderr) => resolve({ ok: !err, error: String(stderr || (err && err.message) || '') }),
      );
    });
    if (!unzip.ok) return { ok: false, error: `could not unpack it: ${unzip.error.trim()}` };
    const stagedGit = path.join(stage, 'cmd', 'git.exe');
    if (!fs.existsSync(stagedGit)) return { ok: false, error: 'the archive did not contain cmd\\git.exe' };

    fs.rmSync(GIT_HOME, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(GIT_HOME), { recursive: true });
    fs.renameSync(stage, GIT_HOME);
    resetGitCache();
    const check = await runGit(['--version'], { cwd: ROOT, timeoutMs: 20_000 });
    if (!check.ok) return { ok: false, error: `the installed git does not run: ${check.err.trim()}` };
    log?.info?.(`git: ${check.out.trim()} is in bin\\git — private to this folder, nothing installed on the machine`);
    return { ok: true, how: 'installed', path: findGit(), version: check.out.trim() };
  } catch (err) {
    log?.warn?.(`git: could not be installed (${err.message}) — diffs and checkpoints are off until it is`);
    return { ok: false, error: err.message };
  } finally {
    for (const file of [zip, path.join(`${zip}.download`), stage]) {
      try { fs.rmSync(file, { recursive: true, force: true }); } catch { /* a leftover download is harmless */ }
    }
  }
}
