// What the page is told a model's window is.
//
// The engine's catalog is what the engine was *told* when it started; the config is
// what Synapse budgets with, and it changes when a run measures the server's real
// window or the operator types one. Between those two moments they disagree, and the
// page used to show the engine's stale number — the Architect's corner read
// "94K/127K ctx" for a 200k model (7 Nov). The catalog now carries the config's
// number, so the corner and the watchdog cannot disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../src/api.js';

const quiet = { channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) };

function apiWith({ catalog, config }) {
  const engine = {
    status: () => ({ ready: true, kind: 'stub' }),
    listModels: async () => catalog,
  };
  return createApi({
    getConfig: () => config,
    applyConfig: async () => {},
    engine,
    logger: quiet,
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
}

const catalog = [
  { ref: 'strata/one-200k', provider: 'strata', id: 'one-200k', name: 'one', context: 126976 },
  { ref: 'strata/two-126k', provider: 'strata', id: 'two-126k', name: 'two', context: 126976 },
  { ref: 'opencode-go/flash', provider: 'opencode-go', id: 'flash', name: 'flash', context: 1000000 },
];

test('the config’s measured window is what the page is told', async () => {
  const api = apiWith({
    catalog,
    config: {
      engine: { opencode: { providers: [{ id: 'strata', models: [{ id: 'one-200k', context: 204800 }] }] } },
    },
  });
  const { models } = await api.models();
  const one = models.find((m) => m.ref === 'strata/one-200k');
  assert.equal(one.context, 204800, 'the measured window, not the catalog’s stale 126976');
  // A model the config says nothing about keeps the catalog's number.
  const two = models.find((m) => m.ref === 'strata/two-126k');
  assert.equal(two.context, 126976);
});

test('the operator’s modelLimits override wins, in either spelling', async () => {
  const api = apiWith({
    catalog,
    config: {
      modelLimits: { flash: { context: 64000 }, 'strata/one-200k': { context: 32768 } },
      engine: { opencode: { providers: [{ id: 'strata', models: [{ id: 'one-200k', context: 204800 }] }] } },
    },
  });
  const { models } = await api.models();
  assert.equal(models.find((m) => m.ref === 'opencode-go/flash').context, 64000, 'a bare id names one model');
  assert.equal(models.find((m) => m.ref === 'strata/one-200k').context, 32768, 'the override beats the provider entry');
});
