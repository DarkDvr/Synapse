// The server's half of "remove last exchange": one boundary, staged without file
// restoration, and refused while the chat is busy, waiting or not in Single mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../src/api.js';

const silent = () => ({ channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) });

function harness({
  single = true,
  active = [],
  forms = [],
  permissions = [],
  inbox = [],
  messages = [
    { id: 'u1', type: 'user', text: 'Do the thing' },
    { id: 'a1', type: 'assistant', completed: 10 },
    { id: 'i1', type: 'idle' },
  ],
  revert = null,
  commitFails = false,
} = {}) {
  const calls = [];
  const engine = {
    status: () => ({ ready: true, kind: 'stub' }),
    getSession: async (id) => ({ id, single, raw: { revert } }),
    listActiveSessions: async () => active,
    listForms: async () => forms,
    listSessionPermissions: async () => permissions,
    listInbox: async () => inbox,
    getMessages: async () => messages.map((m) => ({ ...m })),
    stageRevert: async (sessionId, messageID) => { calls.push({ at: 'stage', sessionId, messageID }); },
    commitRevert: async (sessionId) => {
      calls.push({ at: 'commit', sessionId });
      if (commitFails) throw new Error('commit refused');
    },
    clearRevert: async (sessionId) => { calls.push({ at: 'clear', sessionId }); },
  };
  const api = createApi({
    getConfig: () => ({}),
    applyConfig: async () => {},
    engine,
    logger: silent(),
    getBootError: () => null,
    projects: {},
    toolStats: null,
    probe: null,
    modelCache: null,
    inspectModel: null,
    probeDir: null,
    runs: null,
    engineUpdate: null,
    restart: null,
    notify: () => {},
  });
  return { api, calls };
}

test('the last prompt is staged with files off, then committed', async () => {
  const h = harness();
  const out = await h.api.removeLastExchange('ses_x');
  assert.deepEqual(out, { ok: true, messageID: 'u1', removed: 3 });
  assert.deepEqual(h.calls, [
    { at: 'stage', sessionId: 'ses_x', messageID: 'u1' },
    { at: 'commit', sessionId: 'ses_x' },
  ]);
});

test('the transcript preview names the same boundary the removal uses', async () => {
  const h = harness();
  const out = await h.api.messages('ses_x');
  assert.equal(out.remove.available, true);
  assert.equal(out.remove.messageID, 'u1');
  assert.equal(out.remove.count, 3);
});

test('a busy chat is refused before anything is staged', async () => {
  const h = harness({ active: ['ses_x'] });
  await assert.rejects(() => h.api.removeLastExchange('ses_x'), /still working/);
  assert.equal(h.calls.length, 0);
});

test('a queued message, form or permission is refused before staging', async () => {
  for (const options of [{ inbox: [{ id: 'q1' }] }, { forms: [{ id: 'f1' }] }, { permissions: [{ id: 'p1' }] }]) {
    const h = harness(options);
    await assert.rejects(() => h.api.removeLastExchange('ses_x'));
    assert.equal(h.calls.length, 0);
  }
});

test('Multi mode has no remove action', async () => {
  const h = harness({ single: false });
  await assert.rejects(() => h.api.removeLastExchange('ses_x'), /Single mode/);
  assert.equal(h.calls.length, 0);
});

test('a turn with a harness message is refused before staging', async () => {
  const h = harness({
    messages: [
      { id: 'u1', type: 'user', text: 'Do the thing' },
      { id: 'h1', type: 'synthetic', text: 'report', description: 'report' },
    ],
  });
  await assert.rejects(() => h.api.removeLastExchange('ses_x'), /harness message/);
  assert.equal(h.calls.length, 0);
});

test('a staged removal is cleared when the commit fails', async () => {
  const h = harness({ commitFails: true });
  await assert.rejects(() => h.api.removeLastExchange('ses_x'), /commit refused/);
  assert.deepEqual(h.calls.map((c) => c.at), ['stage', 'commit', 'clear']);
});

test('an existing staged revert is not overwritten', async () => {
  const h = harness({ revert: { messageID: 'old' } });
  await assert.rejects(() => h.api.removeLastExchange('ses_x'), /already staged/);
  assert.equal(h.calls.length, 0);
});
