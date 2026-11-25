// A restart is the server's to refuse.
//
// The old guard was a script outside the process, and it was skipped twice. These
// pin the one answer the restart route now consults: the engine's active list, a
// waiting card or question, a live run, and — the backstop that matters — an
// assistant message the engine never completed. A restart with work live returns
// `ok: false` and never calls the restart hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';

const project = 'F:\\dev\\Synapse.Projects\\restart-guard';

function makeApi({
  active = [],
  forms = [],
  permissions = [],
  sessions = [],
  messages = () => [],
  liveRuns = [],
  restartCalls = [],
  stopCalls = [],
} = {}) {
  const engine = {
    status: () => ({ ready: true, kind: 'stub' }),
    listActiveSessions: async () => active,
    listForms: async (id) => (id ? [] : forms),
    listSessionForms: async () => [],
    listPendingPermissions: async () => permissions,
    listSessionPermissions: async () => [],
    listSessions: async () => sessions,
    getMessages: async (id) => messages(id),
    getSession: async (id) => ({ id, directory: project, title: id }),
  };
  const api = createApi({
    getConfig: () => ({}),
    applyConfig: async () => {},
    power: null,
    engine,
    logger: { channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) },
    getBootError: () => null,
    projects: {},
    toolStats: null,
    probe: null,
    modelCache: null,
    inspectModel: null,
    probeDir: null,
    runs: { active: () => liveRuns },
    desk: null,
    localLease: null,
    engineUpdate: null,
    synapseUpdate: null,
    restart: async () => { restartCalls.push(true); return { ok: true }; },
    stopSelf: async () => { stopCalls.push(true); return { ok: true }; },
    pcShutdown: null,
    notify: () => {},
    providerSync: () => ({}),
  });
  return { api, restartCalls, stopCalls };
}

test('an active engine session blocks a restart, with a reason', async () => {
  const h = makeApi({ active: ['ses_live'] });
  const work = await h.api.work();
  assert.equal(work.busy, true);
  assert.match(work.reasons.join(' | '), /ses_live/);
  const out = await h.api.restart();
  assert.equal(out.ok, false);
  assert.equal(out.blocked, true);
  assert.match(out.error, /Nothing was restarted/);
  assert.equal(h.restartCalls.length, 0, 'the restart hook must not run');
});

test('the transcript is the backstop: an unfinished assistant message blocks even with no active list', async () => {
  const h = makeApi({
    sessions: [{ id: 'ses_turn', title: 'Planning', updated: Date.now() }],
    messages: () => [{ type: 'assistant', completed: false }],
  });
  const work = await h.api.work();
  assert.equal(work.busy, true);
  assert.match(work.reasons.join(' | '), /unfinished assistant/);
  const out = await h.api.restart();
  assert.equal(out.ok, false);
  assert.equal(h.restartCalls.length, 0);
});

test('a half-written message from an old crash is history, not a permanent refusal', async () => {
  const h = makeApi({
    sessions: [{ id: 'ses_old', title: 'Old', updated: Date.now() - 60 * 60 * 1000 }],
    messages: () => [{ type: 'assistant', completed: false }],
  });
  const work = await h.api.work();
  assert.equal(work.busy, false);
  assert.equal((await h.api.restart()).ok, true);
});

test('a waiting question or permission card blocks a restart', async () => {
  const forms = makeApi({ forms: [{ id: 'form_1' }] });
  assert.equal((await forms.api.work()).busy, true);
  const cards = makeApi({ permissions: [{ id: 'perm_1' }] });
  assert.equal((await cards.api.work()).busy, true);
});

test('a live delegation blocks a restart', async () => {
  const h = makeApi({ liveRuns: [{ task: 't3', role: 'coder-1' }] });
  const work = await h.api.work();
  assert.equal(work.busy, true);
  assert.match(work.reasons.join(' | '), /t3/);
});

test('nothing live lets the restart through', async () => {
  const h = makeApi({
    sessions: [{ id: 'ses_done', title: 'Done' }],
    messages: () => [{ type: 'assistant', completed: true }],
  });
  const work = await h.api.work();
  assert.deepEqual(work, { busy: false, reasons: [] });
  const out = await h.api.restart();
  assert.equal(out.ok, true);
  assert.equal(h.restartCalls.length, 1);
});

test('the same answer guards a stop', async () => {
  const h = makeApi({ active: ['ses_live'] });
  const out = await h.api.shutdown();
  assert.equal(out.ok, false);
  assert.equal(out.blocked, true);
  assert.equal(h.stopCalls.length, 0);
});
