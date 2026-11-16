// The Architect's stopwatch follows its session, not the cards on screen: opening another
// project used to stop it and lose the time spent looking elsewhere (12 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceClock, reconcileClocks, roleIsWorking, roleTime, loadClocks, flushClocks, clockKey } from '../web/clocks.js';
import { state } from '../web/state.js';

const rec = () => ({ ms: 0, since: null, last: 0, sessionId: null });

test('a clock runs from the moment the session became busy', () => {
  const r = rec();
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 1000, now: 5000 });
  assert.equal(r.since, 1000, 'the start is the session turn, not the page noticing');
  assert.equal(r.sessionId, 'a');
});

test('looking at another project does not stop the clock', () => {
  const r = rec();
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 1000, now: 5000 });
  // The operator opens project b, which is idle.
  advanceClock(r, { sessionId: 'b', busy: false, busySince: null, now: 20000 });
  assert.equal(r.since, 1000, 'the running chat keeps its start');
  assert.equal(r.ms, 0, 'and nothing is banked yet');
  // Back to a, still working: the time away counts.
  const elapsed = 31000 - r.since;
  assert.equal(elapsed, 30000);
});

test('the clock banks its time when its own chat stops', () => {
  const r = rec();
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 1000, now: 5000 });
  advanceClock(r, { sessionId: 'a', busy: false, now: 6000 });
  assert.equal(r.since, null);
  assert.equal(r.ms, 5000);
  assert.equal(r.last, 5000);
});

test('a new turn on the same chat starts a new stopwatch', () => {
  const r = rec();
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 1000, now: 5000 });
  advanceClock(r, { sessionId: 'a', busy: false, now: 6000 });
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 7000, now: 8000 });
  assert.equal(r.since, 7000);
  assert.equal(r.ms, 5000, 'the finished turn is kept');
});

test('a clock that outlived the page stops at the transcript\'s end, not at now', () => {
  const r = rec();
  advanceClock(r, { sessionId: 'a', busy: true, busySince: 1000, now: 5000 });
  advanceClock(r, { sessionId: 'a', busy: false, endedAt: 3000, now: 60000 });
  assert.equal(r.ms, 2000, 'only the turn was measured');
  assert.equal(r.last, 2000);
});

test('reconcileClocks closes a running reading at the last completed turn', () => {
  state.clocks = {
    sessionId: 'a',
    at: 5000,
    session: { ms: 10, since: 1000, last: 0 },
    roles: { architect: { ms: 20, since: 1000, last: 0 } },
  };
  reconcileClocks({ busy: false, endedAt: 3000, now: 60000 });
  assert.equal(state.clocks.session.ms, 2010);
  assert.equal(state.clocks.session.since, null);
  assert.equal(state.clocks.roles.architect.ms, 2020);
  assert.equal(state.clocks.roles.architect.since, null);
  // A live turn is not closed by a stale completion behind it.
  state.clocks.session.since = 4000;
  state.clocks.roles.architect.since = 4000;
  reconcileClocks({ busy: true, endedAt: 3000, now: 60000 });
  assert.equal(state.clocks.session.since, 4000);
});

test('a waiting Architect and a waiting worker both stop their clocks', () => {
  state.sessionId = 's';
  state.projects = [{ directory: 'F:/p', sessions: [{ id: 's' }] }];
  state.runs = new Map();
  state.busySessions = new Set(['s']);
  state.forms = [];
  state.permissions = [];
  state.busy = true;
  assert.equal(roleIsWorking('architect'), true);
  state.permissions = [{ sessionId: 's' }];
  assert.equal(roleIsWorking('architect'), false, 'the Architect waits for the card');
  state.permissions = [{ sessionId: 'other' }];
  state.forms = [{ sessionId: 's' }];
  assert.equal(roleIsWorking('architect'), false, 'and for its own question');

  state.runs.set('f:/p', { dir: 'F:/p', role: 'designer', workerId: 'w', task: 't1', startedAt: 1000 });
  state.permissions = [];
  state.forms = [];
  assert.equal(roleIsWorking('designer'), true);
  state.permissions = [{ sessionId: 'w' }];
  assert.equal(roleIsWorking('designer'), false, 'the worker waits for its own card');
  state.permissions = [{ sessionId: 's' }];
  assert.equal(roleIsWorking('designer'), true, 'another session\'s card is not this worker\'s');
});

test('a worker\'s clock does not count the time it waited on a card', () => {
  state.sessionId = 's';
  state.projects = [{ directory: 'F:/p', sessions: [{ id: 's' }] }];
  state.runs = new Map([['f:/p', { dir: 'F:/p', role: 'designer', workerId: 'w', task: 't1', startedAt: 1000 }]]);
  state.planState = { plan: { tasks: [{ id: 't1', role: 'designer' }] }, spent: {} };
  state.clocks = {
    sessionId: 's',
    roles: { designer: { ms: 0, since: null, last: 0, pausedMs: 500, waitSince: 2000, runKey: 't1|1000' } },
  };
  const t = roleTime('designer', 4000);
  assert.equal(t.running, 500, '4000 now − 1000 start − 500 earlier pause − 2000 wait');
  assert.equal(t.total, 500);
});

test('a running `since` is written down, so a page or app restart can count it', () => {
  const box = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => box.get(key) || null,
    setItem: (key, value) => box.set(key, String(value)),
    removeItem: (key) => box.delete(key),
  };
  try {
    state.clocks = loadClocks('sess_clock');
    state.clocks.session = { ms: 100, since: 1000, last: 0 };
    state.clocks.roles.architect = { ms: 200, since: 1500, last: 0 };
    flushClocks();
    const raw = JSON.parse(box.get(clockKey('sess_clock')));
    assert.equal(raw.session.since, 1000, 'the session start is stored, not only the banked total');
    assert.equal(raw.roles.architect.since, 1500, 'and so is the role start');
    const loaded = loadClocks('sess_clock');
    assert.equal(loaded.session.since, 1000);
    assert.equal(loaded.roles.architect.since, 1500);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('a chat that ran entirely unseen gets the transcript\'s turn time', () => {
  state.clocks = {
    sessionId: 's',
    at: 0,
    session: { ms: 0, since: null, last: 0 },
    roles: { architect: { ms: 0, since: null, last: 0 } },
  };
  reconcileClocks({ busy: false, fallbackMs: 5000, now: 10000 });
  assert.equal(state.clocks.session.ms, 5000);
  assert.equal(state.clocks.roles.architect.ms, 5000);
  assert.equal(state.clocks.session.since, null);
});
