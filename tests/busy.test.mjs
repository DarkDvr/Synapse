// Is this project busy, and why — the answer the composer, Stop and the refusal
// sentence all read.
//
// The order of the checks is the whole point. A session blocked on a card is
// *active*: the engine holds the turn open until someone answers. Checking the
// active list first therefore answered "running" for work that was doing nothing
// but wait, so Stop chose its gentle path and waited out a grace for a step only
// an answer could finish (measured 6 Nov: 45 s of "Stopping…" with the card still
// up, and the log saying "finishing the step first").
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { busyInfo } from '../src/busy.js';

const DIR = 'F:\\projects\\one';
const sessions = [{ id: 'ses_a', directory: DIR, title: 'arch' }];

test('a session blocked on a question is waiting, not running', () => {
  const out = busyInfo({
    directory: DIR,
    active: ['ses_a'],
    sessions,
    forms: [{ id: 'frm_1', sessionId: 'ses_a', title: 'Questions' }],
  });
  assert.equal(out.state, 'waiting');
  assert.equal(out.kind, 'form');
});

test('a session blocked on a permission card is waiting too', () => {
  const out = busyInfo({
    directory: DIR,
    active: ['ses_a'],
    sessions,
    permissions: [{ id: 'per_1', sessionId: 'ses_a', directory: DIR }],
  });
  assert.equal(out.state, 'waiting');
  assert.equal(out.kind, 'permission');
});

test('a worker running is running, even if a card is up in the same project', () => {
  const out = busyInfo({
    directory: DIR,
    active: ['ses_a'],
    sessions,
    runs: [{ dir: DIR, task: 't1', role: 'coder-1', architect: 'ses_a' }],
    forms: [{ id: 'frm_1', sessionId: 'ses_a' }],
  });
  assert.equal(out.state, 'running');
  assert.equal(out.kind, 'run');
});

test('a plain working turn is still running', () => {
  const out = busyInfo({ directory: DIR, active: ['ses_a'], sessions });
  assert.equal(out.state, 'running');
  assert.equal(out.kind, 'turn');
});

test('nothing happening is not busy', () => {
  const out = busyInfo({ directory: DIR, active: [], sessions });
  assert.equal(out.busy, false);
});

test('another project never makes this one busy', () => {
  const out = busyInfo({
    directory: DIR,
    active: ['ses_b'],
    sessions: [{ id: 'ses_b', directory: 'F:\\projects\\two' }],
    forms: [{ id: 'frm_1', sessionId: 'ses_b', directory: 'F:\\projects\\two' }],
  });
  assert.equal(out.busy, false);
});

// The route, not the arithmetic: `GET /api/busy` with no `?session=` used to ask the
// engine about the string "null", get a 400, and answer `engineDown: true` — telling
// a caller the engine had stopped while it was answering everything else (7 Nov).
test('the route with no session does not ask the engine, and does not call it down', async () => {
  const { createApi } = await import('../src/api.js');
  let asked = 0;
  const engine = {
    status: () => ({ ready: true, kind: 'stub' }),
    getSession: async () => {
      asked += 1;
      throw new Error('GET /api/session/null -> 400');
    },
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
    runs: null,
    engineUpdate: null,
    restart: null,
    notify: () => {},
    guard: null,
  });
  const out = await api.busy(null);
  assert.deepEqual(out, { busy: false });
  assert.equal(asked, 0, 'the engine is never asked about a session that does not exist');
  // A real session that the engine cannot answer is still a dead engine.
  const down = await api.busy('ses_a');
  assert.equal(down.engineDown, true);
});
