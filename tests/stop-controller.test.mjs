// Stop has to survive the engine's own retry loop.
//
// Measured 6 Nov, on the operator's machine: the provider answered 429, the
// engine scheduled a retry for itself, and five Stops in a row were each answered
// "1 session interrupted" while the engine retried at 11:52:05, 11:52:36,
// 11:53:07, 11:53:38 and 11:54:08. An interrupt during the engine's thirty-second
// backoff has no generation to abort, so it does nothing. The sixth Stop landed
// 1.6 s after a step had started and worked.
//
// Then the engine wedged: after the eighth failure it scheduled a retry it never
// fired and kept the session on the active list with nothing running. The Stop
// button was enabled, the log said "interrupted", and the event list froze on
// `retry.scheduled`.
//
// These tests pin both, plus the promises the rebuild makes: one owner, the gentle
// press waits for the step boundary, a retry is a boundary too, and the operator
// speaking clears a stop in force.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStopper } from '../src/stop.js';

const DIR = 'F:\\projects\\one';
const SID = 'ses_arch';

function world({ active = () => [SID], messages = () => [{ id: 'a1', type: 'assistant' }] } = {}) {
  const state = { interrupts: 0, calls: [] };
  const engine = {
    getSession: async (id) => ({ id, directory: DIR, title: 'arch' }),
    listActiveSessions: async () => active(state),
    getMessages: async () => messages(state),
    interrupt: async (id) => {
      state.interrupts += 1;
      state.calls.push({ at: 'interrupt', id });
    },
  };
  const events = [];
  const stopper = createStopper({
    engine,
    log: { info() {}, warn() {} },
    notify: (ev) => events.push(ev),
    tickMs: 1,
  });
  return { engine, stopper, state, events };
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the watcher to reach a state, rather than guessing a delay: the suite
 *  runs files in parallel, and a fixed 40 ms is not a promise under load. */
async function waitFor(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Boolean(check());
}

test('an interrupt during the engine retry wait is repeated until the session is quiet', async () => {
  // The engine keeps the session active, and keeps failing, for the first three
  // cuts; after that the interrupt has landed and the turn is over.
  const h = world({
    active: (s) => (s.interrupts >= 3 ? [] : [SID]),
    messages: (s) => (s.interrupts >= 3 ? [{ id: 'i1', type: 'idle' }] : [{ id: 'a1', type: 'assistant' }]),
  });
  const out = await h.stopper.stop({ sessionId: SID, hard: true });
  assert.equal(out.stopping, true);
  assert.ok(await waitFor(() => h.stopper.stopping(DIR) === false), 'and then called it stopped');
  assert.ok(h.state.interrupts >= 3, `kept cutting: ${h.state.interrupts}`);
  assert.ok(h.events.some((e) => e.type === 'stop.done'), 'the page is told');
  h.stopper.dispose();
});

test('a gentle Stop waits for the step to end before it cuts', async () => {
  const h = world();
  await h.stopper.stop({ sessionId: SID, hard: false });
  await settle();
  assert.equal(h.state.interrupts, 0, 'nothing is cut while the step is still running');
  h.stopper.handleEvent({ type: 'session.step.started', sessionId: SID });
  await settle();
  assert.ok(h.state.interrupts >= 1, 'the next step is the boundary, and it is cut there');
  h.stopper.dispose();
});

test('a retry the engine scheduled is a boundary too, not a reason to wait', async () => {
  // This is the exact failure: the step failed, the engine will retry in 30 s,
  // and the old gentle stop sat waiting for a step that would never arrive.
  const h = world();
  await h.stopper.stop({ sessionId: SID, hard: false });
  await settle();
  assert.equal(h.state.interrupts, 0);
  h.stopper.handleEvent({
    type: 'session.retry.scheduled',
    sessionId: SID,
    raw: { properties: { error: { message: 'the cell is at capacity; retry shortly' } } },
  });
  await settle();
  assert.ok(h.state.interrupts >= 1, 'cut at once');
  const stuck = h.events.find((e) => e.type === 'stop.stuck');
  assert.equal(stuck, undefined, 'and it is not reported as stuck');
  h.stopper.dispose();
});

test('a session that is off the active list but has no idle marker is wedged, and is cleared', async () => {
  // The engine after its eighth failure: not active, last message a failed
  // assistant turn, retry never fired. Nothing running, nothing stopped.
  const h = world({
    active: () => [],
    messages: (s) => (s.interrupts >= 2 ? [{ id: 'i1', type: 'idle' }] : [{ id: 'a1', type: 'assistant' }]),
  });
  await h.stopper.stop({ sessionId: SID, hard: false });
  assert.ok(await waitFor(() => h.state.interrupts >= 2), 'the wedged session is interrupted until it is really idle');
  assert.ok(await waitFor(() => h.stopper.stopping(DIR) === false));
  h.stopper.dispose();
});

test('the second press cuts now, and does not start a second watcher', async () => {
  const h = world();
  await h.stopper.stop({ sessionId: SID, hard: false });
  const again = await h.stopper.stop({ sessionId: SID, hard: false });
  assert.equal(again.already, true);
  await settle();
  assert.ok(h.state.interrupts >= 1, 'the second press cuts immediately');
  h.stopper.dispose();
});

test('the operator speaking clears a stop, so their next turn is not cut', async () => {
  const h = world();
  await h.stopper.stop({ sessionId: SID, hard: true });
  await settle();
  assert.equal(h.stopper.clear(DIR), true);
  const before = h.state.interrupts;
  h.stopper.handleEvent({ type: 'session.step.started', sessionId: SID });
  await settle();
  assert.equal(h.state.interrupts, before, 'nothing is cut after they spoke');
  assert.equal(h.stopper.stopping(DIR), false);
  h.stopper.dispose();
});

test('a stop that will not take says so instead of pretending', async () => {
  const h = world({ active: () => [SID], messages: () => [{ id: 'a1', type: 'assistant' }] });
  const stopper = createStopper({
    engine: h.engine,
    log: { info() {}, warn() {} },
    notify: (ev) => h.events.push(ev),
    tickMs: 1,
    stuckMs: 0,
  });
  await stopper.stop({ sessionId: SID, hard: true });
  await settle();
  const stuck = h.events.find((e) => e.type === 'stop.stuck');
  assert.ok(stuck, 'the page is told it is stuck');
  assert.equal(stuck.reason, null);
  stopper.dispose();
});

test('the harness side of a stop happens once, in one place', async () => {
  const seen = [];
  const engine = {
    getSession: async (id) => ({ id, directory: DIR }),
    listActiveSessions: async () => [SID],
    getMessages: async () => [{ id: 'a1', type: 'assistant' }],
    interrupt: async () => {},
  };
  const runs = {
    active: () => [],
    requestStop: (dir) => seen.push(['requestStop', dir]),
    stopWake: (dir) => seen.push(['stopWake', dir]),
    hold: (dir) => seen.push(['hold', dir]),
    cancel: (dir) => seen.push(['cancel', dir]),
  };
  const desk = { release: (why, dir) => seen.push(['release', why, dir]) };
  const stopper = createStopper({
    engine,
    runs,
    desk,
    log: { info() {}, warn() {} },
    tickMs: 1,
  });

  await stopper.stop({ sessionId: SID, hard: false });
  assert.deepEqual(seen, [
    ['requestStop', DIR],
    ['stopWake', DIR],
    ['hold', DIR],
    ['release', 'the operator stopped the work', DIR],
  ]);
  stopper.dispose();
});

test('a hard stop cancels the run as well, so a backoff sleep is cut short', async () => {
  const seen = [];
  const engine = {
    getSession: async (id) => ({ id, directory: DIR }),
    listActiveSessions: async () => [SID],
    getMessages: async () => [{ id: 'a1', type: 'assistant' }],
    interrupt: async () => {},
  };
  const runs = {
    active: () => [],
    cancel: (dir) => seen.push(['cancel', dir]),
    requestStop: (dir) => seen.push(['requestStop', dir]),
    stopWake: () => {},
    hold: () => {},
  };
  const stopper = createStopper({ engine, runs, log: { info() {}, warn() {} }, tickMs: 1 });
  await stopper.stop({ sessionId: SID, hard: true });
  assert.deepEqual(seen, [['cancel', DIR], ['requestStop', DIR]]);
  stopper.dispose();
});
