// Compaction: the conversation is discarded, a handover is kept, a fresh chat
// starts. The rules that matter are about what must NOT happen when a compact
// fails — nothing is deleted without a handover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../src/api.js';
import { SINGLE_RULES } from '../src/permissions.js';

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-compact-'));

function harness({
  dir,
  before = [{ id: 'm1', type: 'user', created: 1 }, { id: 'm2', type: 'assistant', created: 2 }],
  summary = '## Objective\n- Finish the thing',
  compactFails = null,
  compactionFails = false,
  neverSummaries = false,
  active = [],
  single = false,
  auto = true,
} = {}) {
  const calls = [];
  const notes = [];
  let compactRequested = false;
  const compaction = {
    id: 'cmp_1',
    type: 'compaction',
    created: Date.now(),
    raw: { status: 'completed', summary, time: { created: Date.now() } },
  };
  const failedCompaction = {
    id: 'cmp_failed',
    type: 'compaction',
    created: Date.now(),
    error: 'Compaction cancelled',
    raw: { status: 'failed', error: { type: 'aborted', message: 'Compaction cancelled' } },
  };
  const engine = {
    status: () => ({ ready: true, kind: 'stub' }),
    getSession: async (id) => ({
      id,
      directory: dir,
      single,
      auto,
      model: 'deepseek/deepseek-flash',
      variant: 'high',
      metadata: { synapse: { auto, role: 'architect' } },
    }),
    getMessages: async () =>
      compactRequested && !neverSummaries ? [...before, compactionFails ? failedCompaction : compaction] : before,
    listActiveSessions: async () => active,
    listSessions: async () => [{ id: 'ses_old', directory: dir, title: 'Old', single, auto }],
    listPendingPermissions: async () => [],
    listForms: async () => [],
    interrupt: async () => {},
    compact: async (sessionId) => {
      calls.push({ at: 'compact', sessionId });
      if (compactFails) throw new Error(compactFails);
      compactRequested = true;
    },
    createSession: async (body) => {
      calls.push({ at: 'create', body });
      return { id: 'ses_new', directory: dir, metadata: body.metadata };
    },
    deleteSession: async (sessionId) => { calls.push({ at: 'delete', sessionId }); },
    setInstruction: async () => true,
    updateSessionPermissions: async () => {},
    prompt: async () => ({}),
  };
  const permissionMemory = { carry: (from, to) => calls.push({ at: 'carry', from, to }) };
  const api = createApi({
    getConfig: () => ({}),
    applyConfig: async () => {},
    engine,
    logger: { channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) },
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
    notify: (ev) => notes.push(ev),
    guard: null,
    permissionMemory,
  });
  return { api, calls, notes, compaction };
}

test('a compact writes the handover, starts a fresh chat and deletes the old one', async () => {
  const dir = project();
  const h = harness({ dir });
  const out = await h.api.compactSession('ses_old', { timeoutMs: 3000 });

  assert.equal(out.ok, true);
  assert.equal(out.sessionId, 'ses_new');
  assert.equal(out.oldSessionId, 'ses_old');
  assert.equal(out.summary.includes('Finish the thing'), true);

  // The handover is in the project document before anything is thrown away.
  const doc = fs.readFileSync(path.join(dir, '.synapse', 'project.md'), 'utf8');
  assert.match(doc, /## Handover[\s\S]*Finish the thing/);
  assert.match(doc, /### compact · /);

  const create = h.calls.find((c) => c.at === 'create');
  assert.equal(create.body.directory, dir);
  assert.deepEqual(create.body.model, { ref: 'deepseek/deepseek-flash', variant: 'high' });
  assert.equal(create.body.metadata.synapse.auto, true);
  assert.match(create.body.metadata.synapse.compacted.summary, /Finish the thing/);
  assert.equal(create.body.metadata.synapse.compacted.messages, 2);

  assert.ok(h.calls.some((c) => c.at === 'delete' && c.sessionId === 'ses_old'));
  assert.ok(h.calls.some((c) => c.at === 'carry' && c.from === 'ses_old' && c.to === 'ses_new'));
  const told = h.notes.filter((n) => n.type === 'project.compacted');
  assert.equal(told.length, 1);
  assert.equal(told[0].oldSessionId, 'ses_old');
  assert.equal(told[0].sessionId, 'ses_new');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the new chat keeps the mode and the permission ruleset', async () => {
  const dir = project();
  const h = harness({ dir, single: true });
  await h.api.compactSession('ses_old', { timeoutMs: 3000 });
  const create = h.calls.find((c) => c.at === 'create');
  assert.deepEqual(create.body.permissions, SINGLE_RULES);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a compact that never gets a handover deletes nothing', async () => {
  const dir = project();
  const h = harness({ dir, neverSummaries: true });
  await assert.rejects(() => h.api.compactSession('ses_old', { timeoutMs: 1200 }), (err) => err.status === 504);
  assert.equal(h.calls.some((c) => c.at === 'create'), false);
  assert.equal(h.calls.some((c) => c.at === 'delete'), false);
  assert.equal(fs.existsSync(path.join(dir, '.synapse', 'project.md')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a compact the engine refuses deletes nothing', async () => {
  const dir = project();
  const h = harness({ dir, compactFails: 'the engine is having a moment' });
  await assert.rejects(() => h.api.compactSession('ses_old', { timeoutMs: 3000 }), (err) => err.status === 502);
  assert.equal(h.calls.some((c) => c.at === 'delete'), false);
  assert.equal(h.calls.some((c) => c.at === 'create'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a compact the engine cancels deletes nothing', async () => {
  const dir = project();
  const h = harness({ dir, compactionFails: true });
  await assert.rejects(() => h.api.compactSession('ses_old', { timeoutMs: 3000 }), (err) => err.status === 409);
  assert.equal(h.calls.some((c) => c.at === 'create'), false);
  assert.equal(h.calls.some((c) => c.at === 'delete'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Stop cancels an in-flight compact instead of waiting out the timeout', async () => {
  const dir = project();
  const h = harness({ dir, neverSummaries: true });
  const pending = h.api.compactSession('ses_old', { timeoutMs: 10000 });
  await new Promise((r) => setTimeout(r, 150));
  await h.api.interrupt('ses_old');
  await assert.rejects(pending, (err) => err.status === 409 && /cancel/i.test(err.message));
  assert.equal(h.calls.some((c) => c.at === 'create'), false);
  assert.equal(h.calls.some((c) => c.at === 'delete'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a working project cannot be compacted', async () => {
  const dir = project();
  const h = harness({ dir, active: ['ses_old'] });
  await assert.rejects(() => h.api.compactSession('ses_old', { timeoutMs: 3000 }), (err) => err.status === 409);
  assert.equal(h.calls.some((c) => c.at === 'compact'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty conversation has nothing to compact', async () => {
  const dir = project();
  const h = harness({ dir, before: [] });
  await assert.rejects(() => h.api.compactSession('ses_old', { timeoutMs: 3000 }), (err) => err.status === 400);
  assert.equal(h.calls.some((c) => c.at === 'compact'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
