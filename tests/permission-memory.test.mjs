// "Always Allow" memory, on disk. The failure this prevents: a restart made the
// operator answer the same exact request again, while the session it belonged to
// survived.
//
// Run: node tests\permission-memory.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPermissionMemory } from '../src/permission-memory.js';

const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-perm-'));
  return path.join(dir, 'permission-memory.json');
};

test('a remembered request survives a new instance, i.e. a restart', () => {
  const file = tempFile();
  createPermissionMemory({ file }).remember('ses_1', 'edit', ['D:/x.txt']);
  const after = createPermissionMemory({ file });
  assert.equal(after.has('ses_1', 'edit', ['D:/x.txt']), true);
});

test('only the exact session, action and resource match', () => {
  const file = tempFile();
  const memory = createPermissionMemory({ file });
  memory.remember('ses_1', 'Edit', ['D:/x.txt']);
  assert.equal(memory.has('ses_1', 'edit', ['D:/x.txt']), true, 'action is case-insensitive');
  assert.equal(memory.has('ses_2', 'edit', ['D:/x.txt']), false, 'another session');
  assert.equal(memory.has('ses_1', 'read', ['D:/x.txt']), false, 'another action');
  assert.equal(memory.has('ses_1', 'edit', ['D:/y.txt']), false, 'another path');
});

test('a corrupt file starts empty instead of failing the boot', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{not json', 'utf8');
  const memory = createPermissionMemory({ file });
  assert.deepEqual(memory.list(), []);
});

test('the store is capped, oldest first out', () => {
  const file = tempFile();
  const memory = createPermissionMemory({ file, limit: 2 });
  memory.remember('s', 'edit', ['a']);
  memory.remember('s', 'edit', ['b']);
  memory.remember('s', 'edit', ['c']);
  assert.equal(memory.has('s', 'edit', ['a']), false);
  assert.equal(memory.has('s', 'edit', ['b']), true);
  assert.equal(memory.has('s', 'edit', ['c']), true);
});

test('deleting a session forgets only its grants', () => {
  const file = tempFile();
  const memory = createPermissionMemory({ file });
  memory.remember('ses_1', 'edit', ['D:/x.txt']);
  memory.remember('ses_2', 'edit', ['D:/x.txt']);
  assert.equal(memory.forgetSession('ses_1'), 1);
  assert.equal(memory.has('ses_1', 'edit', ['D:/x.txt']), false);
  assert.equal(memory.has('ses_2', 'edit', ['D:/x.txt']), true);
});
