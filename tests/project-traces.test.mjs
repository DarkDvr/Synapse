// What a deleted project leaves in the engine's own store, and its removal.
//
// These trace the shape measured on 16 Nov: a project was created and deleted
// within four minutes, and afterwards its prompts came back from the Recycle Bin
// while its tool output was still readable in the engine's shell folder, under a
// project row that still remembered its path. Deleting the chats works — the
// messages really are gone — so these two are the leftovers that matter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { engineDir, projectIdForDir, purgeProjectTraces } from '../src/engine-project-purge.js';
import { tmpdir } from './tmpdir.mjs';

const ID = '981a91527f8f885401ec8a7c0b096f0bad39a97f';
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DIR = 'F:\\dev\\Synapse.Projects\\abc123_test';

/** An engine data home with the tables this touches and one shell file each. */
function store({ projectDir = DIR, otherDir = 'F:\\dev\\Synapse.Projects\\kept' } = {}) {
  const data = tmpdir('synapse-traces-');
  const opencode = path.join(data, 'opencode');
  fs.mkdirSync(opencode, { recursive: true });
  const db = new DatabaseSync(path.join(opencode, 'opencode.db'));
  db.exec('create table project (id text primary key, worktree text)');
  db.exec('create table worktree (project_id text, directory text)');
  db.exec('create table instruction_blob (hash text primary key, value text)');
  db.prepare('insert into project values (?, ?)').run(ID, projectDir.replace(/\\/g, '/'));
  db.prepare('insert into project values (?, ?)').run(OTHER, otherDir.replace(/\\/g, '/'));
  db.prepare('insert into worktree values (?, ?)').run(ID, projectDir.replace(/\\/g, '/'));
  db.prepare('insert into worktree values (?, ?)').run(OTHER, otherDir.replace(/\\/g, '/'));
  // A brief is stored as a content-addressed blob, in JSON form (doubled backslashes).
  const brief = (dirPath) => JSON.stringify({ text: `Synapse project: ${dirPath}\\nScratch folder: ${dirPath}\\.project\\scratch` });
  db.prepare('insert into instruction_blob values (?, ?)').run('h1', brief(projectDir.replace(/\\/g, '\\\\')));
  db.prepare('insert into instruction_blob values (?, ?)').run('h2', brief(otherDir.replace(/\\/g, '\\\\')));
  db.close();
  for (const id of [ID, OTHER]) {
    const shells = path.join(opencode, 'shell', id);
    fs.mkdirSync(shells, { recursive: true });
    fs.writeFileSync(path.join(shells, 'sh_1.out'), 'ASCII truck');
  }
  return { data, opencode };
}

test('the engine names a folder its own way', () => {
  assert.equal(engineDir('F:\\dev\\Synapse.Projects\\one\\'), 'F:/dev/Synapse.Projects/one');
  assert.equal(engineDir('F:/dev/Synapse.Projects/one//'), 'F:/dev/Synapse.Projects/one');
  assert.equal(engineDir(''), '');
});

test('a project row is found whatever the slashes or the casing', () => {
  const { opencode } = store();
  const db = new DatabaseSync(path.join(opencode, 'opencode.db'));
  assert.equal(projectIdForDir(db, DIR), ID);
  assert.equal(projectIdForDir(db, 'f:/DEV/synapse.projects/ABC123_TEST'), ID);
  assert.equal(projectIdForDir(db, 'F:\\dev\\Synapse.Projects\\never-seen'), '');
  db.close();
});

test('purging removes the row, its worktrees and its shell output — and nothing else', async () => {
  const { data, opencode } = store();
  const result = await purgeProjectTraces({ dataDir: data, dir: DIR });

  assert.equal(result.projectId, ID);
  assert.equal(result.projectRows, 1);
  assert.equal(result.worktreeRows, 1);
  assert.equal(result.shells, 1);
  assert.equal(result.briefs, 1, 'the project\'s brief blob goes, the neighbour\'s stays');

  assert.equal(fs.existsSync(path.join(opencode, 'shell', ID)), false, 'the tool output is gone');

  const db = new DatabaseSync(path.join(opencode, 'opencode.db'));
  assert.equal(db.prepare('select count(*) c from project where id = ?').get(ID).c, 0);
  assert.equal(db.prepare('select count(*) c from worktree where project_id = ?').get(ID).c, 0);
  // The neighbour is untouched: a delete must not take another project's traces.
  assert.equal(db.prepare('select count(*) c from project where id = ?').get(OTHER).c, 1);
  assert.equal(db.prepare('select count(*) c from worktree where project_id = ?').get(OTHER).c, 1);
  db.close();
  assert.equal(fs.existsSync(path.join(opencode, 'shell', OTHER)), true);
  const blobs = new DatabaseSync(path.join(opencode, 'opencode.db'));
  assert.equal(blobs.prepare('select count(*) c from instruction_blob where hash = ?').get('h1').c, 0);
  assert.equal(blobs.prepare('select count(*) c from instruction_blob where hash = ?').get('h2').c, 1);
  blobs.close();
});

test('a folder the engine never saw is not an error', async () => {
  const { data, opencode } = store();
  const result = await purgeProjectTraces({ dataDir: data, dir: 'F:\\dev\\Synapse.Projects\\ghost' });
  assert.deepEqual(result, { projectId: '', projectRows: 0, worktreeRows: 0, shells: 0, briefs: 0 });
  const db = new DatabaseSync(path.join(opencode, 'opencode.db'));
  assert.equal(db.prepare('select count(*) c from project').get().c, 2);
  db.close();
});

test('a missing store, or a missing argument, is a no-op', async () => {
  const data = tmpdir('synapse-traces-empty-');
  assert.deepEqual(await purgeProjectTraces({ dataDir: data, dir: DIR }), {
    projectId: '',
    projectRows: 0,
    worktreeRows: 0,
    shells: 0,
    briefs: 0,
  });
  assert.deepEqual(await purgeProjectTraces({}), {
    projectId: '',
    projectRows: 0,
    worktreeRows: 0,
    shells: 0,
    briefs: 0,
  });
});

test('a store that cannot be opened is reported, not thrown', async () => {
  const data = tmpdir('synapse-traces-bad-');
  const opencode = path.join(data, 'opencode');
  fs.mkdirSync(opencode, { recursive: true });
  fs.writeFileSync(path.join(opencode, 'opencode.db'), 'this is not a database');
  const warned = [];
  const result = await purgeProjectTraces({ dataDir: data, dir: DIR, log: { warn: (m) => warned.push(m) } });
  assert.equal(result.projectRows, 0);
  assert.equal(warned.length, 1, 'the caller is told, rather than a delete failing');
  assert.match(warned[0], /engine store/);
});
