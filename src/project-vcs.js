// The project's own version control: a git repository inside `.project/`.
//
// Why a second repository: the project's repo belongs to the operator, and the harness
// has a rule older than this file — it never commits a project, never moves HEAD, never
// touches `.git/config`. That rule stays. But the records under `.project/` (the plan,
// the design sheet, the mocks, the reports) are not source, are not in the project's
// history (it excludes `.project/`), and are exactly what a bad overwrite destroys:
// a worker "updated" a mock, the sheet still pointed at the old one, and the old bytes
// were gone. So the records get their own repository, nested and invisible to the
// parent, and the harness commits to it around every run.
//
// Three consequences worth stating:
//
//   * **No model has to remember a commit.** The harness commits before and after each
//     run and before an Architect turn; forgetting is what models do with chores.
//   * **No copies of files.** One name per deliverable, updated in place; the previous
//     bytes are a commit away (`git -C .project log -- <file>`), which the brief says.
//   * **The operator's history is untouched.** This repo is never pushed, never
//     referenced from the parent (the harness already excludes `.project/`), and its
//     identity is the harness's own.
//
// Retention is the one place a history can be edited: it is our repository, so the
// newest commits are kept and older ones are dropped by rewriting *this* branch — a
// move that would be forbidden in the operator's.
import fs from 'node:fs';
import path from 'node:path';

import { findGit, runGit } from './git.js';

/** Mirrors PLAN_DIR in plans.js — this module imports no plan code. */
const PLAN_DIR = '.project';
const REPO = path.join(PLAN_DIR, '.git');

/** How many commits survive a prune, and when a prune is worth running. */
export const VCS_KEEP = 80;
export const VCS_PRUNE_AT = 100;

// The harness's identity, per command: no `git config` write, no dependency on the
// operator's `~/.gitconfig` (runGit already isolates it).
const IDENTITY = ['-c', 'user.name=Synapse', '-c', 'user.email=synapse@local'];

/** What the records repository does not version. */
export function vcsIgnore() {
  return [
    '# Synapse records: version the documents, never the debris.',
    'scratch/',
    'shots/',
    'attachments/',
    'reports/diffs/',
    'cache/',
    'runs.jsonl',
    '*.log',
    '',
  ].join('\n');
}

const repoDir = (projectDir) => path.join(String(projectDir || ''), PLAN_DIR);
const gitDir = (projectDir) => path.join(repoDir(projectDir), '.git');

/** Is there a records repository here? (A plain existence check: `rev-parse` in
 *  `.project` would climb into the parent repository and answer yes.) */
export function hasVcs(projectDir) {
  try {
    return fs.existsSync(gitDir(projectDir));
  } catch {
    // A folder that cannot be stat'ed has no repository the harness can see; commits
    // are simply off, which is how a read-only project behaves.
    return false;
  }
}

/**
 * Make sure the project's records have a repository, with its ignore file.
 *
 * Called at boot for every project, on Add Project, and before the first commit of a
 * run — so a project the operator has had for weeks gets one without any migration.
 * Never throws: no git, or a read-only folder, means commits are simply off, which is
 * how diffs behave already.
 */
export async function ensureVcs(projectDir, { log = null } = {}) {
  const dir = repoDir(projectDir);
  try {
    if (!dir || !fs.existsSync(dir)) return { ok: false, created: false, error: 'no .project folder' };
    fs.mkdirSync(dir, { recursive: true });
    const ignoreFile = path.join(dir, '.gitignore');
    const body = vcsIgnore();
    let current = '';
    try {
      current = fs.readFileSync(ignoreFile, 'utf8');
    } catch {
      // A project without the ignore file gets one below.
      current = '';
    }
    if (current !== body) fs.writeFileSync(ignoreFile, body, 'utf8');
    if (hasVcs(projectDir)) return { ok: true, created: false };
    if (!findGit()) return { ok: false, created: false, error: 'git is not available' };
    let r = await runGit(['init', '-q', '-b', 'main'], { cwd: dir, timeoutMs: 20_000 });
    if (!r.ok) r = await runGit(['init', '-q'], { cwd: dir, timeoutMs: 20_000 });
    if (!r.ok) return { ok: false, created: false, error: r.err.trim() || 'git init failed' };
    log?.info?.(`records: initialized the version history in ${dir}`);
    return { ok: true, created: true };
  } catch (err) {
    return { ok: false, created: false, error: err.message };
  }
}

/**
 * Commit the records if anything changed. A no-op when nothing did — the run paths call
 * this several times per task, and an empty commit on every boundary would bury the
 * history in noise.
 *
 * `message` is built by the caller; the shape is `2026-11-20 03:12 t3#2 before`.
 */
export async function commitVcs(projectDir, message, { log = null } = {}) {
  const dir = repoDir(projectDir);
  if (!hasVcs(projectDir)) {
    const made = await ensureVcs(projectDir, { log });
    if (!made.ok) return { committed: false, error: made.error };
  }
  const add = await runGit(['add', '-A'], { cwd: dir, timeoutMs: 60_000 });
  if (!add.ok) return { committed: false, error: add.err.trim() || 'git add failed' };
  // `diff --cached --quiet` is the cheapest "is there anything to commit": 0 = clean,
  // 1 = staged changes, and runGit reports both as a resolved command.
  const staged = await runGit(['diff', '--cached', '--quiet'], { cwd: dir, timeoutMs: 30_000 });
  if (staged.ok) return { committed: false };
  if (staged.code !== 1) return { committed: false, error: staged.err.trim() || 'git diff failed' };
  const commit = await runGit([...IDENTITY, 'commit', '-q', '-m', String(message || 'snapshot')], {
    cwd: dir,
    timeoutMs: 60_000,
  });
  if (!commit.ok) return { committed: false, error: commit.err.trim() || 'git commit failed' };
  const sha = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: dir, timeoutMs: 10_000 })).out.trim();
  log?.info?.(`records: committed ${sha} — ${String(message || '').slice(0, 80)}`);
  return { committed: true, sha };
}

/** The commit label: a date a model reads without a rule, the task, the attempt, the event. */
export function commitLabel({ at = new Date(), task = '', attempt = 0, event = 'snapshot' } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const id = String(task || '').trim();
  const who = id ? `${id}${attempt > 1 ? `#${attempt}` : ''}` : 'architect';
  return `${stamp} ${who} ${event}`;
}

/**
 * Drop the oldest commits once there are too many.
 *
 * The kept commits are re-created one by one with `commit-tree` (same tree, message and
 * date, parent chain cut at the oldest kept), then the branch is moved in one
 * `update-ref`. The working tree and the index are never touched, so this is safe while
 * the app is running — unlike a checkout-based rewrite, which would rewrite files under
 * a live turn. Old objects are then unreachable and `gc` drops them.
 */
export async function pruneVcs(projectDir, { keep = VCS_KEEP, at = VCS_PRUNE_AT, log = null } = {}) {
  const dir = repoDir(projectDir);
  if (!hasVcs(projectDir)) return { pruned: false };
  const count = await runGit(['rev-list', '--count', 'HEAD'], { cwd: dir, timeoutMs: 20_000 });
  if (!count.ok) return { pruned: false, skipped: 'no commits yet' };
  const total = Number(count.out.trim()) || 0;
  if (total <= at) return { pruned: false, total };
  const list = (await runGit(['rev-list', '--reverse', 'HEAD'], { cwd: dir, timeoutMs: 30_000 }))
    .out.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = list.slice(-Math.max(1, keep));
  const branch = (await runGit(['symbolic-ref', '--short', 'HEAD'], { cwd: dir, timeoutMs: 10_000 })).out.trim();
  if (!kept.length || !branch) return { pruned: false, skipped: 'no branch' };
  let parent = null;
  for (const sha of kept) {
    const tree = (await runGit(['rev-parse', `${sha}^{tree}`], { cwd: dir, timeoutMs: 10_000 })).out.trim();
    const info = await runGit(['log', '-1', '--format=%ct%n%B', sha], { cwd: dir, timeoutMs: 10_000 });
    if (!tree || !info.ok) return { pruned: false, error: 'could not read a commit' };
    const [stampLine, ...body] = info.out.split('\n');
    const message = body.join('\n').trim() || 'snapshot';
    const args = [...IDENTITY, 'commit-tree', tree];
    if (parent) args.push('-p', parent);
    args.push('-m', message);
    const made = await runGit(args, {
      cwd: dir,
      timeoutMs: 30_000,
      env: { GIT_AUTHOR_DATE: `@${stampLine.trim()} +0000`, GIT_COMMITTER_DATE: `@${stampLine.trim()} +0000` },
    });
    if (!made.ok) return { pruned: false, error: made.err.trim() || 'commit-tree failed' };
    parent = made.out.trim();
  }
  const moved = await runGit(['update-ref', `refs/heads/${branch}`, parent], { cwd: dir, timeoutMs: 10_000 });
  if (!moved.ok) return { pruned: false, error: moved.err.trim() || 'update-ref failed' };
  await runGit(['gc', '--quiet', '--prune=now'], { cwd: dir, timeoutMs: 120_000 });
  log?.info?.(`records: history pruned to the newest ${kept.length} of ${total} commit(s)`);
  return { pruned: true, kept: kept.length, dropped: total - kept.length };
}

/**
 * The line the report says when a run's design files and the design sheet disagree.
 *
 * This is the incident the repository exists for: a designer added `mock-2.html`, the
 * sheet still named `mock-4.html`, the coder wired the older picture, and the review
 * saw a file with the right name. The harness knows both lists, so it says so — and
 * only when it is true, with `Warning:` first because it is the one line in the report
 * that asks the Architect to look.
 */
export function designMismatch(projectDir, files = []) {
  const design = (Array.isArray(files) ? files : [])
    .map((f) => String(f || '').replace(/\\/g, '/'))
    .filter((f) => f.startsWith(`${PLAN_DIR}/design/`) && /\.(?:html?|png|svg)$/i.test(f));
  if (!design.length) return '';
  let sheet = '';
  try {
    sheet = fs.readFileSync(path.join(String(projectDir || ''), PLAN_DIR, 'design', 'design.md'), 'utf8');
  } catch {
    // No sheet is the designer's task, not this line's business.
    return '';
  }
  const nameOf = (f) => path.basename(f);
  const unnamed = design.filter((f) => !sheet.includes(nameOf(f)));
  if (!unnamed.length) return '';
  const named = [...sheet.matchAll(/([\w.-]+\.(?:html?|svg|png))/gi)]
    .map((m) => m[1])
    .filter((name, i, all) => all.indexOf(name) === i && name.toLowerCase() !== 'design.md');
  const hasNamed = named.filter((name) => !unnamed.some((f) => nameOf(f) === name));
  return (
    `Warning: this run changed ${unnamed.map(nameOf).join(', ')} but the design sheet names ` +
    (hasNamed.length ? `${hasNamed.join(', ')}.` : 'no mock at all.') +
    ' If this was another version of a file, update the file the sheet names instead of adding one — the ' +
    'harness commits the old bytes, so nothing is lost.'
  );
}
