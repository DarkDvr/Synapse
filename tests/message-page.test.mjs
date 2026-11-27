// The engine's message endpoint is a cursor-paged timeline. The chat asks for the
// newest page first, then the page before it when the operator clicks Load Earlier.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenCodeEngine } from '../src/engines/opencode.js';

const silent = () => ({ channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) });

test('the first page asks for newest first and keeps the previous cursor', async () => {
  const calls = [];
  const engine = new OpenCodeEngine({}, { logger: silent() });
  engine.request = async (method, path) => {
    calls.push({ method, path });
    return {
      data: [
        { id: 'm2', type: 'assistant', time: { created: 2 } },
        { id: 'm1', type: 'user', time: { created: 1 } },
      ],
      cursor: { previous: null, next: 'older-than-m1' },
    };
  };
  const page = await engine.getMessagesPage('ses_x');
  assert.match(calls[0].path, /limit=200&order=desc$/);
  assert.deepEqual(page.messages.map((m) => m.id), ['m1', 'm2']);
  assert.equal(page.cursor.next, 'older-than-m1');
  assert.equal(page.cursor.older, 'older-than-m1');
});

test('an older page uses only the cursor, not order', async () => {
  const calls = [];
  const engine = new OpenCodeEngine({}, { logger: silent() });
  engine.request = async (method, path) => {
    calls.push(path);
    return { data: [], cursor: { previous: null, next: 'newer' } };
  };
  const page = await engine.getMessagesPage('ses_x', { cursor: 'before-m1' });
  assert.match(calls[0], /cursor=before-m1/);
  assert.doesNotMatch(calls[0], /[?&]order=/);
  assert.equal(page.cursor.previous, null);
  assert.equal(page.cursor.next, 'newer');
});
