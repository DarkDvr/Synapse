// The four automation switches and the shutdown watcher.
//
// They replaced "Keep running" and "Full auto", which had to be moved together: an
// operator who wanted questions answered also got every permission allowed. The
// rules that matter here are the ones a live run depends on — a chat saved under
// the old names keeps its behaviour, and Auto-Shutdown only counts when the whole
// machine is quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOMATION_DEFAULTS,
  AUTOMATION_KEYS,
  cleanAutomation,
  nextSynapse,
  readAutomation,
} from '../src/automation.js';
import { createAutoShutdown } from '../src/auto-shutdown.js';
import { automationMs, keepBuildingDelayMs, answerTimeoutMs, permissionsTimeoutMs, shutdownIdleMs } from '../src/auto-answer.js';

const session = (synapse) => ({ metadata: { synapse } });

test('a project starts with Keep Building on and the other three off', () => {
  assert.deepEqual({ ...AUTOMATION_DEFAULTS }, {
    keepBuilding: true,
    autoPermissions: false,
    autoAnswer: false,
    autoShutdown: false,
  });
  assert.deepEqual(cleanAutomation({}), { ...AUTOMATION_DEFAULTS });
  // Unknown keys are dropped, and a non-boolean is not a switch.
  assert.deepEqual(cleanAutomation({ keepBuilding: 'yes', autoAnswer: 1, nope: true }), {
    ...AUTOMATION_DEFAULTS,
  });
});

test('a chat saved before the four switches keeps what it had', () => {
  // Nothing recorded: the old "Keep running" was off unless turned on, so it stays
  // off. The on-by-default belongs to new projects, which are seeded at creation.
  assert.equal(readAutomation(session({})).keepBuilding, false);
  // Keep running on.
  assert.equal(readAutomation(session({ auto: true })).keepBuilding, true);
  // Full auto answered both kinds of request; both inherit it.
  const full = readAutomation(session({ fullAuto: true }));
  assert.equal(full.autoPermissions, true);
  assert.equal(full.autoAnswer, true);
  // The oldest name still counts, and an explicit `fullAuto: false` outranks it.
  assert.equal(readAutomation(session({ permissionTimeout: true })).autoPermissions, true);
  assert.equal(readAutomation(session({ fullAuto: false, permissionTimeout: true })).autoAnswer, false);
  // The old global shutdown switch is the fallback for Auto-Shutdown.
  assert.equal(readAutomation(session({}), { shutdownWhenDone: true }).autoShutdown, true);
});

test('an explicit set wins over every old name', () => {
  const a = readAutomation(
    session({ auto: true, fullAuto: true, automation: { keepBuilding: false, autoAnswer: false } }),
  );
  assert.equal(a.keepBuilding, false, 'the operator turned it off after the migration');
  assert.equal(a.autoAnswer, false);
  assert.equal(a.autoPermissions, true, 'the one not set falls back to the old name');
});

test('a write keeps the old mirrors in step and drops the oldest name', () => {
  // The chat had `permissionTimeout: true` and no Keep Building: flipping one
  // switch must not turn the other on, so the write starts from the *resolved*
  // values, not from the defaults.
  const next = nextSynapse({ permissionTimeout: true, role: 'architect' }, { autoPermissions: true });
  assert.equal(next.role, 'architect', 'other metadata survives');
  assert.equal(next.automation.autoPermissions, true);
  assert.equal(next.automation.keepBuilding, false, 'the old off is kept');
  assert.equal(next.auto, false, 'Keep Building mirrors the resolved value');
  assert.equal(next.fullAuto, true, 'both old halves are on, so the old single switch reads on');
  assert.equal('permissionTimeout' in next, false, 'nothing may read a stale value');
  // Keep Building alone still mirrors `auto`, which is what the brief and the run read.
  assert.equal(nextSynapse({}, { keepBuilding: true }).auto, true);
});

test('the four waits come from Settings, and a broken value falls back', () => {
  const cfg = { automation: { keepBuildingSec: 5, permissionsSec: 10, answerSec: 30, shutdownMin: 5 } };
  assert.equal(keepBuildingDelayMs(cfg), 5000);
  assert.equal(permissionsTimeoutMs(cfg), 10_000);
  assert.equal(answerTimeoutMs(cfg), 30_000);
  assert.equal(shutdownIdleMs(cfg), 5 * 60_000);
  // 0 is a real answer for the three second-based waits: act at once.
  assert.equal(automationMs({ automation: { answerSec: 0 } }, 'answerSec', 30_000), 0);
  assert.equal(automationMs({ automation: { answerSec: 'soon' } }, 'answerSec', 30_000), 30_000);
  // The shutdown cannot be zero: the countdown it starts is 20 seconds long already.
  assert.equal(shutdownIdleMs({ automation: { shutdownMin: 0 } }), 5 * 60_000);
});

// ── Auto-Shutdown ─────────────────────────────────────────────────────

function harness({ sessions, quiet = true, minutes = 5 } = {}) {
  const calls = { armed: 0, cancelled: 0 };
  let clock = 0;
  let powerArmed = false;
  const engine = {
    listSessions: async () => sessions,
    listActiveSessions: async () => (quiet ? [] : [{ id: 'ses_live' }]),
    listForms: async () => [],
    listPendingPermissions: async () => [],
  };
  const api = {
    runs: async () => ({ runs: [] }),
    powerOffState: async () => ({ armed: powerArmed, countdown: powerArmed }),
    armPowerCountdown: async () => {
      calls.armed += 1;
      powerArmed = true;
      return { ok: true, seconds: 20 };
    },
    cancelPowerOff: async () => {
      calls.cancelled += 1;
      const was = powerArmed;
      powerArmed = false;
      return { ok: true, cancelled: was };
    },
  };
  const config = { automation: { shutdownMin: minutes } };
  const tick = createAutoShutdown({ engine, api, getConfig: () => config, now: () => clock }).tick;
  return {
    calls,
    tick,
    advance: (ms) => {
      clock += ms;
    },
    // The operator answers the countdown's Cancel, or a run starts.
    cancel: () => {
      powerArmed = false;
    },
  };
}

const on = [{ id: 'ses_a', raw: { metadata: { synapse: { automation: { autoShutdown: true } } } } }];

test('nothing is armed while a project has Auto-Shutdown off', async () => {
  const h = harness({ sessions: [{ id: 'ses_a', raw: { metadata: { synapse: {} } } }] });
  h.advance(60 * 60_000);
  await h.tick();
  assert.equal(h.calls.armed, 0);
});

test('the idle minutes must pass before the countdown', async () => {
  const h = harness({ sessions: on, minutes: 5 });
  await h.tick();
  h.advance(4 * 60_000);
  await h.tick();
  assert.equal(h.calls.armed, 0, 'four minutes is not five');
  h.advance(2 * 60_000);
  await h.tick();
  assert.equal(h.calls.armed, 1);
});

test('a live turn resets the wait and cancels what was armed', async () => {
  const h = harness({ sessions: on, quiet: false, minutes: 5 });
  h.advance(60 * 60_000);
  await h.tick();
  assert.equal(h.calls.armed, 0, 'never count down with a turn running');
});

test('a cancel starts the whole wait again, rather than re-arming on the next tick', async () => {
  const h = harness({ sessions: on, minutes: 5 });
  await h.tick(); // the machine goes quiet: the idle clock starts here
  h.advance(5 * 60_000);
  await h.tick();
  assert.equal(h.calls.armed, 1);
  h.cancel(); // the operator pressed Cancel
  await h.tick(); // notices the cancel, restarts the clock
  await h.tick();
  assert.equal(h.calls.armed, 1, 'not immediately re-armed');
  h.advance(4 * 60_000);
  await h.tick();
  assert.equal(h.calls.armed, 1, 'still inside the new wait');
  h.advance(2 * 60_000);
  await h.tick();
  assert.equal(h.calls.armed, 2, 'arms again only after a full idle window');
});
