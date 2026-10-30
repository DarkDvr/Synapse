// A role's model change must reach the run that is waiting on it.
//
// The operator's words (30 Oct): when I switch a model for a role that is stuck
// waiting on a timeout — a temporary provider limit — stop that timeout and tell
// the role to continue. The runner does the waking (tests/ladder.test.mjs); this
// is the wiring: a saved config whose role reference changed calls wakeRole, and
// a save that changed nothing does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../src/api.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };

function harness(initial) {
  let current = structuredClone(initial);
  const woken = [];
  const api = createApi({
    getConfig: () => current,
    applyConfig: (next) => {
      current = next;
      return next;
    },
    engine: { status: () => ({ ready: true, kind: 'stub' }) },
    logger: { channel: () => quiet },
    getBootError: () => null,
    projects: {},
    toolStats: null,
    probe: null,
    modelCache: null,
    inspectModel: null,
    probeDir: null,
    runs: {
      wakeRole: (role, model) => {
        woken.push({ role, model });
        return 1;
      },
    },
    engineUpdate: null,
    synapseUpdate: null,
    restart: null,
    notify: null,
    permissionLog: null,
    permissionGate: { retime() {} },
  });
  return { api, woken };
}

const CONFIG = {
  roles: { 'coder-1': { ref: 'provider/one' }, designer: { ref: 'provider/design' } },
};

test('a changed role reference wakes that role on the new model', async () => {
  const { api, woken } = harness(CONFIG);
  await api.saveConfig({ roles: { 'coder-1': { ref: 'provider/two' }, designer: { ref: 'provider/design' } } });
  assert.equal(woken.length, 1);
  assert.equal(woken[0].role, 'coder-1');
  assert.equal(woken[0].model.ref, 'provider/two');
});

test('a save that changes no model wakes nobody', async () => {
  const { api, woken } = harness(CONFIG);
  await api.saveConfig(structuredClone(CONFIG));
  assert.deepEqual(woken, []);
});

test('two roles changed in one save are both woken', async () => {
  const { api, woken } = harness(CONFIG);
  await api.saveConfig({ roles: { 'coder-1': { ref: 'provider/two' }, designer: { ref: 'provider/design-2' } } });
  assert.equal(woken.length, 2);
  assert.deepEqual(woken.map((w) => w.role).sort(), ['coder-1', 'designer']);
});
