// The records repository: `<project>\.project\.git`.
//
// The rule this file holds: the project's own repository is the operator's and is never
// committed to; the records get their own, nested and invisible, and the harness commits
// to it around every run. A model never has to remember a commit, and a bad overwrite is
// one `git show` away instead of gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from '../src/git.js';
import { changedInVcs, commitLabel, commitVcs, designMismatch, ensureVcs, hasVcs, pruneVcs, VCS_KEEP } from '../src/project-vcs.js';
import { tmpdir } from './tmpdir.mjs';

const project = () => {
  const dir = tmpdir('synapse-vcs-');
  fs.mkdirSync(path.join(dir, '.project'), { recursive: true });
  return dir;
};
const write = (file, body = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
};
const git = (dir, args) => runGit(args, { cwd: path.join(dir, '.project'), timeoutMs: 30_000 });

test('a project gets a records repository, with the debris ignored', async () => {
  const dir = project();
  write(path.join(dir, '.project', 'plan.json'), '{"version":1}');
  write(path.join(dir, '.project', 'scratch', 'probe.ps1'), 'x');
  write(path.join(dir, '.project', 'shots', 'a.png'), 'x');
  write(path.join(dir, '.project', 'reports', 'diffs', 't1.diff'), 'x');
  write(path.join(dir, '.project', 'runs.jsonl'), '{}\n');
  const made = await ensureVcs(dir);
  assert.equal(made.ok, true, made.error);
  assert.equal(hasVcs(dir), true);
  const committed = await commitVcs(dir, 'first');
  assert.equal(committed.committed, true, committed.error);
  const files = (await git(dir, ['ls-files'])).out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(files, ['.gitignore', 'plan.json'], `tracked the wrong files: ${files.join(', ')}`);
});

test('nothing is committed when nothing changed, and the message is the label', async () => {
  const dir = project();
  await ensureVcs(dir);
  write(path.join(dir, '.project', 'project.md'), '# doc');
  const first = await commitVcs(dir, '2026-11-20 03:12 t3#2 before');
  assert.equal(first.committed, true);
  const again = await commitVcs(dir, '2026-11-20 03:12 t3#2 before');
  assert.equal(again.committed, false, 'an empty commit was made');
  const count = Number((await git(dir, ['rev-list', '--count', 'HEAD'])).out.trim());
  assert.equal(count, 1);
  const subject = (await git(dir, ['log', '-1', '--format=%s'])).out.trim();
  assert.equal(subject, '2026-11-20 03:12 t3#2 before');
});

test('the label reads without a rule: date, task, attempt, event', () => {
  const at = new Date(2026, 10, 20, 3, 12);
  assert.equal(commitLabel({ at, task: 't3', attempt: 1, event: 'before' }), '2026-11-20 03:12 t3 before');
  assert.equal(commitLabel({ at, task: 't3', attempt: 2, event: 'before' }), '2026-11-20 03:12 t3#2 before');
  assert.equal(commitLabel({ at, task: '', event: 'architect turn' }), '2026-11-20 03:12 architect architect turn');
});

test('the old bytes are a commit away, after an overwrite', async () => {
  const dir = project();
  await ensureVcs(dir);
  const mock = path.join(dir, '.project', 'design', 'mock.html');
  write(mock, '<p>old design</p>');
  await commitVcs(dir, 'before');
  write(mock, '<p>new design</p>');
  await commitVcs(dir, 'after');
  const old = (await git(dir, ['show', 'HEAD~1:design/mock.html'])).out;
  assert.match(old, /old design/);
  assert.match(fs.readFileSync(mock, 'utf8'), /new design/);
});

test('history is pruned to the newest commits, and the working tree is untouched', async () => {
  const dir = project();
  await ensureVcs(dir);
  const file = path.join(dir, '.project', 'plan.json');
  for (let i = 0; i < 12; i += 1) {
    write(file, `{"version":1,"i":${i}}`);
    await commitVcs(dir, `c${i}`);
  }
  const before = fs.readFileSync(file, 'utf8');
  const pruned = await pruneVcs(dir, { keep: 5, at: 8 });
  assert.equal(pruned.pruned, true, pruned.error);
  const count = Number((await git(dir, ['rev-list', '--count', 'HEAD'])).out.trim());
  assert.equal(count, 5);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the working tree was rewritten');
  // The newest commit's tree is the one that was there: a prune keeps the present.
  assert.match((await git(dir, ['show', 'HEAD:plan.json'])).out, /"i":11/);
});

test('a pair of commits names what a run changed in the records', async () => {
  const dir = project();
  await ensureVcs(dir);
  write(path.join(dir, '.project', 'design', 'mock.html'), '<p>one</p>');
  const first = await commitVcs(dir, 'before');
  write(path.join(dir, '.project', 'design', 'mock.html'), '<p>two</p>');
  write(path.join(dir, '.project', 'plan.json'), '{"version":1}');
  const second = await commitVcs(dir, 'after');
  assert.equal(first.committed, true);
  assert.equal(second.committed, true);
  const changed = await changedInVcs(dir, first.sha, second.sha);
  assert.deepEqual(changed.sort(), ['design/mock.html', 'plan.json']);
});

test('the design sheet and the run are compared, and only a real mismatch speaks', async () => {
  const dir = project();
  write(
    path.join(dir, '.project', 'design', 'design.md'),
    '# Design\n\nThe settings screen is drawn by `mock-4.html`.\n',
  );
  const nag = designMismatch(dir, ['.project/design/mock-2.html']);
  assert.match(nag, /^Warning: /, 'the report line must start with Warning');
  assert.match(nag, /mock-2\.html/);
  assert.match(nag, /mock-4\.html/);
  // The records' paths (design/...) are the form the commit log gives, and they work too.
  assert.match(designMismatch(dir, ['design/mock-2.html']), /^Warning: /);
  // The sheet naming the file the run wrote is the right shape: no line.
  assert.equal(designMismatch(dir, ['.project/design/mock-4.html']), '');
  // A run that only touched source says nothing.
  assert.equal(designMismatch(dir, ['app/ui/index.html']), '');
});

test('the keep count is the one the docs promise', () => {
  assert.equal(VCS_KEEP, 80);
});
