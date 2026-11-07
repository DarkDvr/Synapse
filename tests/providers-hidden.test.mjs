// What the model menu offers.
//
// Every provider is the operator's now: OC Zen and OC Go are ordinary
// OpenAI-compatible rows, added with Add Provider, moved and removed like any other.
// So a model is offered when — and only when — its provider has a row in the config.
// The engine serving it is not enough; a role that already points at one keeps
// working, because this is the menu, not the permission.
//
// `hiddenProviders` is the older switch from when the engine's two rows could be
// hidden instead of removed. Nothing sets it any more, and a config that still
// carries one is honoured rather than silently ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../src/api.js';
import { normalize, DEFAULTS } from '../src/config.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };

const CATALOG = [
  { provider: 'opencode', id: 'big-pickle', ref: 'opencode/big-pickle', name: 'Big Pickle', free: true },
  { provider: 'opencode-go', id: 'kimi-k2', ref: 'opencode-go/kimi-k2', name: 'Kimi K2', free: false },
  { provider: 'local', id: 'qwen3', ref: 'local/qwen3', name: 'Qwen3', free: true },
];

function harness({ providers = [], hiddenProviders = [] } = {}) {
  const current = normalize({
    engine: {
      opencode: {
        hiddenProviders,
        // A provider with no URL is dropped by normalize, so the fixture has one.
        providers: providers.map((id) => ({ id, name: id, baseURL: `http://127.0.0.1:9/${id}/v1` })),
      },
    },
  });
  const recorded = [];
  const api = createApi({
    getConfig: () => current,
    applyConfig: (next) => next,
    engine: {
      status: () => ({ ready: true, kind: 'stub' }),
      listModels: async () => CATALOG.map((m) => ({ ...m })),
    },
    logger: { channel: () => quiet },
    getBootError: () => null,
    projects: {},
    toolStats: null,
    probe: null,
    modelCache: { record: (list) => recorded.push(list.length), get: () => null },
    inspectModel: null,
    probeDir: null,
    runs: null,
    engineUpdate: null,
    synapseUpdate: null,
    restart: null,
    notify: null,
    permissionLog: null,
    permissionGate: { retime() {} },
  });
  return { api, recorded };
}

test('a provider with no row offers nothing, however loudly the engine serves it', async () => {
  const { api } = harness({ providers: ['local'] });
  const { models } = await api.models();
  assert.deepEqual(models.map((m) => m.ref), ['local/qwen3']);
});

test('adding the row is all it takes, and removing it is all it takes back', async () => {
  const both = harness({ providers: ['local', 'opencode-go'] });
  assert.deepEqual((await both.api.models()).models.map((m) => m.ref), ['opencode-go/kimi-k2', 'local/qwen3']);
  const neither = harness({ providers: [] });
  assert.deepEqual((await neither.api.models()).models, []);
});

test('a config that still carries hiddenProviders is honoured', async () => {
  const { api } = harness({ providers: ['local', 'opencode-go'], hiddenProviders: ['opencode-go'] });
  const { models } = await api.models();
  assert.deepEqual(models.map((m) => m.ref), ['local/qwen3'], 'hidden, not deleted');
});

test('the catalog is recorded before the filter, so an un-offered model keeps its data', async () => {
  const { api, recorded } = harness({ providers: ['local'] });
  await api.models();
  // The cache is written from the engine's full list: a model whose provider has no
  // row still has its context, variants and tools on file for the day it does.
  assert.deepEqual(recorded, [CATALOG.length]);
});

test('the config keeps the list, trimmed and deduped, and defaults to empty', () => {
  assert.deepEqual(DEFAULTS.engine.opencode.hiddenProviders, []);
  assert.deepEqual(normalize({}).engine.opencode.hiddenProviders, []);
  assert.deepEqual(
    normalize({ engine: { opencode: { hiddenProviders: [' opencode ', 'opencode', '', 'opencode-go'] } } })
      .engine.opencode.hiddenProviders,
    ['opencode', 'opencode-go'],
  );
  // A hand-edited file with a string instead of a list must not become an array of
  // one character per letter.
  assert.deepEqual(normalize({ engine: { opencode: { hiddenProviders: 'opencode' } } }).engine.opencode.hiddenProviders, []);
});
