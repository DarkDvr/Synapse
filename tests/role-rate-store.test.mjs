// A role's last speed outlives the run, the project switch and the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  clearRoleRate,
  getRoleRate,
  loadRoleRates,
  pruneRoleRates,
  rememberRoleRate,
  roleRateKey,
} from '../web/role-rate-store.js';
import { state } from '../web/state.js';

const storage = (seed = null) => {
  const data = new Map(seed === null ? [] : [[STORAGE_KEY, JSON.stringify(seed)]]);
  return {
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => data.set(key, value),
    data,
  };
};

const reset = () => { state.roleRates = new Map(); };

test('a reading is keyed by project and role, and names its model', () => {
  reset();
  rememberRoleRate('F:\\dev\\Synapse.Projects\\one', 'designer', 'polystrata/ornith', { tokens: 100, ms: 2000, at: 5 });
  const rec = getRoleRate('F:/dev/Synapse.Projects/one', 'designer', 'polystrata/ornith');
  assert.equal(rec.tokens, 100);
  assert.equal(rec.ms, 2000);
  assert.equal(getRoleRate('F:/dev/Synapse.Projects/two', 'designer', 'polystrata/ornith'), null, 'another project has its own');
  assert.equal(getRoleRate('F:/dev/Synapse.Projects/one', 'designer', 'other/model'), null, 'a new model is a new reading');
});

test('the map loads the shape a page reload writes', () => {
  reset();
  loadRoleRates(storage({ [roleRateKey('F:/p', 'coder-1')]: { role: 'coder-1', model: 'm1', tokens: 40, ms: 1000, at: 7 } }));
  assert.equal(getRoleRate('F:/p', 'coder-1', 'm1').tokens, 40);
  // A missing or empty record leaves the map empty rather than inventing a default.
  loadRoleRates(storage());
  assert.equal(getRoleRate('F:/p', 'coder-1', 'm1'), null);
});

test('a model change clears the role everywhere, and a deleted project takes its rows', () => {
  reset();
  rememberRoleRate('F:/p', 'designer', 'm1', { tokens: 10, ms: 1000, at: 1 });
  rememberRoleRate('F:/q', 'designer', 'm1', { tokens: 20, ms: 1000, at: 2 });
  rememberRoleRate('F:/p', 'coder-1', 'm1', { tokens: 30, ms: 1000, at: 3 });
  clearRoleRate('designer');
  assert.equal(getRoleRate('F:/p', 'designer', 'm1'), null);
  assert.equal(getRoleRate('F:/q', 'designer', 'm1'), null);
  assert.ok(getRoleRate('F:/p', 'coder-1', 'm1'), 'another role is untouched');
  pruneRoleRates(new Set(['f:/p']));
  assert.ok(getRoleRate('F:/p', 'coder-1', 'm1'));
  assert.equal(getRoleRate('F:/q', 'coder-1', 'm1'), null, 'only the kept project remains');
});
