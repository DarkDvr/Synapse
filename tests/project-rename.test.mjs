// Renaming a project's folder.
//
// The folder is the project's identity, so the name rules are strict and the move is a
// real move: the plan, the document and the chats go with it (12 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderNameProblem } from '../src/api.js';
import { createProjectStore } from '../src/projects.js';

test('a folder name Windows can hold is accepted', () => {
  assert.equal(folderNameProblem('sys-monitor'), null);
  assert.equal(folderNameProblem('Sys Monitor 2'), null);
  assert.equal(folderNameProblem('a.b_c-1'), null);
});

test('a name that cannot be a folder is refused with a reason', () => {
  assert.match(folderNameProblem(''), /needs a name/);
  assert.match(folderNameProblem('..'), /not a folder name/);
  assert.match(folderNameProblem('a/b'), /cannot contain/);
  assert.match(folderNameProblem('a:b'), /cannot contain/);
  assert.match(folderNameProblem('trailing.'), /dot or a space/);
  // A trailing space is trimmed before the check: the folder is created under the
  // trimmed name, so it can never end with one.
  assert.equal(folderNameProblem('trailing '), null);
  assert.match(folderNameProblem('CON'), /reserves/);
  assert.match(folderNameProblem('com3.txt'), /reserves/);
});

test('the registry follows a renamed folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-rename-'));
  const file = path.join(root, 'projects.json');
  const store = createProjectStore({ file, rootDir: path.join(root, 'projects'), logger: { channel: () => ({ info() {}, warn() {} }) } });
  const made = store.create({ name: 'Old Name', directory: path.join(root, 'projects', 'old-folder') });
  const moved = store.update(made.id, { name: 'New Name', directory: path.join(root, 'projects', 'new-folder') });
  assert.equal(moved.name, 'New Name');
  assert.match(moved.directory.replace(/\\/g, '/'), /new-folder$/);
  // Nothing else moved: the id is the project's, not the path's.
  assert.equal(moved.id, made.id);
  fs.rmSync(root, { recursive: true, force: true });
});
