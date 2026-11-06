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
    prompt: async (id, text) => { calls.push({ at: 'prompt', id, text }); },
    // A compaction starts at once and then has nothing to write: the wait is the
    // part a Stop has to end.
    compact: async (id) => { calls.push({ at: 'compact', id }); },
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
  return { api, held, calls, dir, engine };
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

// Measured 6 Nov: Stop, then a message sent a second later. The message became a
// steer to the very worker the stop was about to cut, the stop went ahead at its
// next step, and the operator's words were never read.
// Measured 6 Nov: a compact is a request plus a wait, and its own timeout is three
// minutes. The immediate Stop cancelled the wait; the gentle one did not, so the
// page sat on "Compacting…" behind the 45-second grace and then whatever the
// engine did next. A compact is not a step — there is nothing to finish.
test('a Stop during a compaction ends the wait at once', async () => {
  const active = [];
  const h = harness({ active });
  const compacting = h.api.compactSession('ses_arch').catch((err) => err);
  await new Promise((resolve) => setTimeout(resolve, 80));
  active.push('ses_arch'); // the engine reports the session busy while it summarises
  await h.api.stop('ses_arch');
  const err = await compacting;
  assert.match(String(err?.message || ''), /cancelled/i);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

// Measured 6 Nov, while doing the catch audit: `busyFor` swallowed a dead engine and
// answered "Nothing is running now" — a lie the operator would act on. The engine
// being down is its own answer.
test('a Stop against a dead engine says so, instead of "nothing is running"', async () => {
  const h = harness();
  h.engine.getSession = async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:8720');
  };
  await assert.rejects(
    () => h.api.stop('ses_arch'),
    (err) => err.status === 503 && /engine is not answering/i.test(err.message),
  );
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('the operator speaking calls a stop off, even when the words travel as a steer', async () => {
  const h = harness();
  await h.api.stop('ses_arch');
  assert.ok(h.api.stopState(h.dir), 'a stop is in force');
  const out = await h.api.steer('ses_arch', { text: 'keep going, I changed my mind' });
  assert.equal(out.ok, true);
  assert.equal(h.api.stopState(h.dir), null, 'the stop is gone, so their next turn is not cut');
  fs.rmSync(h.dir, { recursive: true, force: true });
});
