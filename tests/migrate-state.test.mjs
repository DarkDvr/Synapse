// The one-time move from `.synapse` to `.project`.
//
// The folder holds the plan, the document, the run log and a private marker, so
// the migration has to happen before anything reads them. It renames the folder,
// rewrites the paths inside, and tells git to ignore the new name.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { migrateProjectState, ignoreProjectState } from '../src/projects.js';
import { ensureRepo } from '../src/git.js';
import { tmpdir } from './tmpdir.mjs';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

test('the state folder moves, its paths are rewritten, and git stops seeing it', async () => {
  const dir = tmpdir('synapse-migrate-test-');
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.synapse', 'plan.json'),
    JSON.stringify({ version: 1, tasks: [{ id: 't1', title: 'see .synapse/reports', status: 'todo' }] }),
  );
  fs.writeFileSync(path.join(dir, '.synapse', 'private'), '');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.synapse/\nbin/\n');
  await ensureRepo(dir, { log: quiet });

  const result = migrateProjectState(dir, { log: quiet });
  assert.equal(result.migrated, true);
  assert.equal(fs.existsSync(path.join(dir, '.synapse')), false);
  assert.ok(fs.existsSync(path.join(dir, '.project', 'plan.json')));
  assert.ok(fs.existsSync(path.join(dir, '.project', 'private')));
  assert.match(fs.readFileSync(path.join(dir, '.project', 'plan.json'), 'utf8'), /\.project\/reports/);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.project\/$/m);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.synapse\/$/m);
  assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\.project\/$/m);
  // The second boot is a no-op.
  assert.equal(migrateProjectState(dir, { log: quiet }).migrated, false);
});

test('both folders keep .project and move in what is missing', () => {
  const dir = tmpdir('synapse-migrate-both-');
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.project'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.synapse', 'old.md'), 'from .synapse\n');
  fs.writeFileSync(path.join(dir, '.project', 'new.md'), 'already here\n');
  const result = migrateProjectState(dir, { log: quiet });
  assert.equal(result.migrated, true);
  assert.ok(fs.existsSync(path.join(dir, '.project', 'old.md')));
  assert.equal(fs.readFileSync(path.join(dir, '.project', 'new.md'), 'utf8'), 'already here\n');
  assert.equal(fs.existsSync(path.join(dir, '.synapse', 'old.md')), false);
});

test('a new repository is told to ignore the state folder', async () => {
  const dir = tmpdir('synapse-migrate-new-');
  await ensureRepo(dir, { log: quiet });
  ignoreProjectState(dir);
  ignoreProjectState(dir);
  const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.equal((exclude.match(/^\.project\/$/gm) || []).length, 1);
});

test('a .project file is reported, not written over', () => {
  const dir = tmpdir('synapse-migrate-file-');
  fs.writeFileSync(path.join(dir, '.project'), 'eclipse project\n');
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.synapse', 'plan.json'), '{}');
  const result = migrateProjectState(dir, { log: quiet });
  assert.match(result.error, /\.project file/);
  assert.equal(fs.readFileSync(path.join(dir, '.project'), 'utf8'), 'eclipse project\n');
  assert.ok(fs.existsSync(path.join(dir, '.synapse', 'plan.json')));
});
