// Messages waiting for a local server, kept on disk across a restart.
//
// The queue is memory; the ledger is what lets the next boot send what was waiting.
// Confirmed 21 Nov: a restart erased a queued message and the chat said nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadQueued, saveQueued, putQueued, dropQueued, renameQueuedDir } from '../src/queued-sends.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-queue-')), 'queued.json');

test('a queued message survives a write and a read', () => {
  const file = tmp();
  assert.deepEqual(loadQueued(file), [], 'a missing ledger is empty');
  putQueued({ sessionId: 'ses_a', dir: 'F:\\p\\a', text: 'draw a cat', files: [], at: 1 }, file);
  const list = loadQueued(file);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'draw a cat');
  assert.equal(list[0].dir, 'F:\\p\\a');
});

test('one message per chat, and it leaves when it starts', () => {
  const file = tmp();
  putQueued({ sessionId: 'ses_a', text: 'first', at: 1 }, file);
  putQueued({ sessionId: 'ses_b', text: 'second', at: 2 }, file);
  putQueued({ sessionId: 'ses_a', text: 'first again', at: 3 }, file);
  const list = loadQueued(file);
  assert.equal(list.length, 2, 'a second message for one chat replaced the first');
  assert.equal(list.find((e) => e.sessionId === 'ses_a').text, 'first again');
  dropQueued('ses_a', file);
  assert.deepEqual(loadQueued(file).map((e) => e.sessionId), ['ses_b']);
  dropQueued('ses_b', file);
  assert.deepEqual(loadQueued(file), []);
});

test('a broken or empty ledger is empty, not a crash', () => {
  const file = tmp();
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.deepEqual(loadQueued(file), []);
  fs.writeFileSync(file, JSON.stringify([{ text: 'no session' }, { sessionId: 's1', text: 'ok' }]), 'utf8');
  assert.deepEqual(loadQueued(file).map((e) => e.sessionId), ['s1'], 'an entry with no session is dropped');
  saveQueued([], file);
  assert.deepEqual(loadQueued(file), []);
});

test('a rename moves a waiting message on disk too', () => {
  const file = tmp();
  putQueued({ sessionId: 'ses_a', dir: 'F:\\p\\queue-f', text: 'hi', label: 'queue-f - your message', at: 1 }, file);
  assert.equal(renameQueuedDir('F:\\p\\queue-f', 'F:\\p\\queue-f2', file), 1);
  const entry = loadQueued(file)[0];
  assert.equal(entry.dir, 'F:\\p\\queue-f2');
  assert.equal(entry.label, 'queue-f2 - your message');
  assert.equal(renameQueuedDir('F:\\p\\nope', 'F:\\p\\x', file), 0);
});
