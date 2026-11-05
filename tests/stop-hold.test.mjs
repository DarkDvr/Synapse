// Stop means stop for the whole project, not just for the turn on screen.
//
// Measured 5 Nov: a run finished, the Architect's wake turn started, the operator
// pressed Stop. The report loop died as designed (1.24.5) — and two seconds later a
// new Architect turn began anyway, sent by the plan reminder ("t2 is ready and was
// not asked for"), which marked the task done while the operator had asked for
// quiet. The reminder guards on `stoppedByOperator`, and the gentle Stop never set
// it: `interrupt()` held the project, `stop()` did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../src/api.js';

function harness({ active = ['ses_arch'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-stop-hold-'));
  const held = [];
  const calls = [];
  const engine = {
    status: () => ({ ready: true, kind: 'stub' }),
    getSession: async (id) => ({ id, directory: dir, title: 'arch' }),
    // A turn the engine reports as active: the Architect processing a report.
    listActiveSessions: async () => active,
    listSessions: async () => [{ id: 'ses_arch', directory: dir, title: 'arch' }],
    listPendingPermissions: async () => [],
    listForms: async () => [],
    // Already idle, so the graceful poll clears itself on its first tick.
    getMessages: async () => [{ id: 'i1', type: 'idle' }],
    interrupt: async (id) => { calls.push({ at: 'interrupt', id }); },
  };
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
    runs: {
      active: () => [],
      stopWake: () => true,
      hold: (d) => { held.push(d); return true; },
      cancel: () => false,
      resume: () => false,
      requestStop: async () => ({ ok: false }),
    },
    engineUpdate: null,
    synapseUpdate: null,
    restart: null,
    notify: () => {},
    guard: null,
  });
  return { api, held, calls, dir };
}

test('the gentle Stop on the Architect holds the project', async () => {
  const h = harness();
  const out = await h.api.stop('ses_arch');
  assert.equal(out.target, 'architect');
  assert.deepEqual(h.held, [h.dir], 'the project is held until the operator speaks');
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('the abrupt Stop holds it too, so both Stops agree', async () => {
  const h = harness();
  await h.api.interrupt('ses_arch');
  assert.deepEqual(h.held, [h.dir]);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('a Stop with nothing running is refused and holds nothing', async () => {
  const h = harness({ active: [] });
  await assert.rejects(() => h.api.stop('ses_arch'), /Nothing is running/);
  assert.deepEqual(h.held, []);
  fs.rmSync(h.dir, { recursive: true, force: true });
});
