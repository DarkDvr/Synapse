// A wiped folder is made again under the same name in the same breath, so the rail's
// usual prune — "a folder that is no longer a project" — never fires. What the page
// kept for that path has to be dropped on purpose, or the new conversation draws the
// old project's runs, timers and role readings above itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installPage } from './fake-page.mjs';

installPage();
const { state } = await import('../web/state.js');
const { forgetProjectState } = await import('../web/projects.js');
const { getRoleRate, rememberRoleRate } = await import('../web/role-rate-store.js');

const WIPED = 'F:\\dev\\Synapse.Projects\\Same';
const KEPT = 'F:\\dev\\Synapse.Projects\\Other';

function seed() {
  state.traces = new Map([
    [`${WIPED.toLowerCase()}|t1|100`, { key: 'x', dir: WIPED, task: 't1' }],
    [`${KEPT.toLowerCase()}|t1|100`, { key: 'y', dir: KEPT, task: 't1' }],
  ]);
  state.runs = new Map([
    [WIPED.toLowerCase(), { task: 't1', dir: WIPED, role: 'designer', startedAt: 100 }],
    [KEPT.toLowerCase(), { task: 't1', dir: KEPT, role: 'designer', startedAt: 100 }],
  ]);
  state.rates = new Map([
    [WIPED.toLowerCase(), { tokens: 10, ms: 4000 }],
    [KEPT.toLowerCase(), { tokens: 20, ms: 5000 }],
  ]);
  state.leases = new Map([
    [`${WIPED}|t1`, { dir: WIPED, task: 't1' }],
    [`${KEPT}|t1`, { dir: KEPT, task: 't1' }],
  ]);
  state.alarms = [
    { id: 'a1', dir: WIPED, text: 'old' },
    { id: 'a2', dir: KEPT, text: 'kept' },
  ];
  state.roleErrors = new Map([
    [`${WIPED.toLowerCase()}|designer`, 'refused'],
    [`${KEPT.toLowerCase()}|designer`, 'refused'],
  ]);
  state.roleRates = new Map();
  rememberRoleRate(WIPED, 'designer', 'polystrata/ornith', { tokens: 100, ms: 2000, at: 5 });
  rememberRoleRate(KEPT, 'designer', 'polystrata/ornith', { tokens: 200, ms: 3000, at: 5 });
}

test('forgetting a wiped folder leaves its neighbour alone', () => {
  seed();
  assert.ok(getRoleRate(WIPED, 'designer', 'polystrata/ornith'), 'the wiped folder has a reading to forget');

  forgetProjectState(WIPED);

  assert.equal(state.runs.has(WIPED.toLowerCase()), false, 'no live run card for the old project');
  assert.equal(state.rates.has(WIPED.toLowerCase()), false, 'no token rate');
  assert.equal(state.traces.size, 1, 'only the neighbour trace remains');
  assert.equal(state.traces.has(`${WIPED.toLowerCase()}|t1|100`), false);
  assert.equal(state.traces.has(`${KEPT.toLowerCase()}|t1|100`), true);
  assert.equal(state.leases.has(`${WIPED}|t1`), false, 'no old lease clock');
  assert.equal(state.leases.has(`${KEPT}|t1`), true);
  assert.deepEqual(state.alarms.map((a) => a.id), ['a2'], 'the old alarm line goes, the neighbour stays');
  assert.equal(state.roleErrors.has(`${WIPED.toLowerCase()}|designer`), false);
  assert.equal(getRoleRate(WIPED, 'designer', 'polystrata/ornith'), null, 'no old role reading');
  assert.ok(getRoleRate(KEPT, 'designer', 'polystrata/ornith'), 'the neighbour keeps its reading');
});

test('forgetting a folder with nothing kept changes nothing else', () => {
  seed();
  forgetProjectState('F:\\dev\\Synapse.Projects\\Never Seen');
  assert.equal(state.runs.size, 2);
  assert.equal(state.alarms.length, 2);
  assert.ok(getRoleRate(KEPT, 'designer', 'polystrata/ornith'));
});
