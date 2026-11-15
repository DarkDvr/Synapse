// The engine store and the note that survives a delete.
//
// The engine's own DELETE removes the chat rows; SQLite still keeps the pages.
// A forced, secure VACUUM before the next engine start is what removes them, and
// the note is what makes that happen without the operator doing anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { noteDeletedProject, readPending, clearPending } from '../src/engine-purge.js';
import { vacuumStore } from '../src/engine-store.js';
import { tmpdir } from './tmpdir.mjs';

test('a deleted project leaves a count, not a name', () => {
  const file = path.join(tmpdir('synapse-purge-note-'), 'engine-purge.json');
  assert.equal(noteDeletedProject(file), 1);
  assert.equal(noteDeletedProject(file), 2);
  assert.deepEqual(readPending(file), { deletes: 2 });
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /changes-test|F:\\\\/i, 'the note carries no project identity');
  clearPending(file);
  assert.deepEqual(readPending(file), { deletes: 0 });
});

test('a malformed note means nothing is pending, not a failed boot', () => {
  const file = path.join(tmpdir('synapse-purge-bad-'), 'engine-purge.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.deepEqual(readPending(file), { deletes: 0 });
});

test('a forced secure vacuum leaves no deleted text in the file', () => {
  const dir = tmpdir('synapse-purge-db-');
  const file = path.join(dir, 'store.db');
  const db = new DatabaseSync(file);
  db.exec('create table t(value text)');
  const insert = db.prepare('insert into t(value) values (?)');
  for (let i = 0; i < 200; i += 1) insert.run(`ordinary row ${i}`);
  insert.run('private chat text: a flower for the operator');
  db.exec('delete from t where value like \'private chat text%\'');
  db.close();

  const out = vacuumStore(file, { force: true, secure: true });
  assert.equal(out.vacuumed, true, 'it ran even with no large freelist');
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.includes(Buffer.from('private chat text')), false, 'the deleted text is gone');
  assert.equal(bytes.includes(Buffer.from('ordinary row 10')), true, 'the live rows are kept');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a store that is not there is a skipped clean, not an error', () => {
  const out = vacuumStore(path.join(tmpdir('synapse-purge-none-'), 'store.db'), { force: true, secure: true });
  assert.equal(out.skipped, 'no database yet');
});
