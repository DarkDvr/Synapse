// One error shape, built in one place.
//
// The routes used to build their own: `const err = new Error('…'); err.status =
// 409; throw err;` — thirty-eight of them in api.js alone, each re-inventing what
// the page reads. This pins the shape so a route cannot drift from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, refuseBusy } from '../src/errors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('fail() carries the status and the sentence the page reads', () => {
  const err = fail(409, 'Nothing is running now.');
  assert.equal(err.message, 'Nothing is running now.');
  assert.equal(err.status, 409);
  assert.equal(err.body, undefined);
  assert.equal(err.busy, undefined);
});

test('fail() carries a card body when the page needs one', () => {
  const err = fail(409, 'A question is waiting', { body: { waiting: true } });
  assert.deepEqual(err.body, { waiting: true });
});

test('a status that is not a number falls back to 500 rather than NaN', () => {
  assert.equal(fail(undefined, 'x').status, 500);
  assert.equal(fail('nonsense', 'x').status, 500);
});

test('refuseBusy names the project, the state and who started it', () => {
  const err = refuseBusy({
    busy: true,
    project: 'stop-lab',
    state: 'waiting',
    driver: { name: 'laptop' },
  });
  assert.equal(err.status, 409);
  assert.equal(err.busy.state, 'waiting');
  assert.match(err.message, /stop-lab/);
  assert.match(err.message, /waiting for an answer/);
  assert.match(err.message, /laptop/);
});

test('api.js no longer builds the three-line pattern by hand', () => {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'api.js'), 'utf8');
  const handmade = text.match(/const err = new Error\(/g) || [];
  // The ones left set a body or a busy flag between the message and the throw;
  // they are the hand pass, and this number is the measure of it.
  assert.ok(handmade.length <= 12, `api.js still hand-builds ${handmade.length} error(s)`);
  assert.equal((text.match(/err\.status = /g) || []).length, handmade.length, 'every handmade error sets its own status');
});
