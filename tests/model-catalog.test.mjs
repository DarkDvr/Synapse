// What the page is told the model menu holds, and how big each model's window is.
//
// Two rules, both about the config being the authority:
//
//  - Every provider is the operator's. OC Zen and OC Go are ordinary
//    OpenAI-compatible rows now, added with Add Provider, moved and removed like any
//    other — so a model whose provider has no row is not offered, however loudly the
//    engine serves it.
//  - The window the page shows is the config's, because that is the one the watchdog
//    budgets with. The engine's catalog is what it was told at start; after a
//    measurement the two disagree until the engine restarts, and the page used to
//    show the stale one (7 Nov: "94K/127K ctx" for a 200k model).
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
  { ref: 'lonely/one', provider: 'lonely', id: 'one', name: 'one', context: 4096 },
];

const providers = (...ids) => ({ engine: { opencode: { providers: ids.map((id) => ({ id })) } } });

test('a model whose provider has no row is not offered', async () => {
  const api = apiWith({ catalog, config: providers('strata') });
  const { models } = await api.models();
  assert.deepEqual(models.map((m) => m.ref).sort(), ['strata/one-200k', 'strata/two-126k']);
  assert.equal(models.find((m) => m.ref === 'lonely/one'), undefined, 'nobody asked for it');
});

test('adding the row is all it takes to offer a provider’s models', async () => {
  const api = apiWith({ catalog, config: providers('strata', 'opencode-go') });
  const { models } = await api.models();
  assert.ok(models.some((m) => m.ref === 'opencode-go/flash'), 'a configured provider is offered');
  assert.equal(models.find((m) => m.ref === 'lonely/one'), undefined);
});

test('the config’s measured window is what the page is told', async () => {
  const api = apiWith({
    catalog,
    config: { engine: { opencode: { providers: [{ id: 'strata', models: [{ id: 'one-200k', context: 204800 }] }] } } },
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
      engine: {
        opencode: {
          providers: [{ id: 'strata', models: [{ id: 'one-200k', context: 204800 }] }, { id: 'opencode-go' }],
        },
      },
    },
  });
  const { models } = await api.models();
  assert.equal(models.find((m) => m.ref === 'opencode-go/flash').context, 64000, 'a bare id names one model');
  assert.equal(models.find((m) => m.ref === 'strata/one-200k').context, 32768, 'the override beats the provider entry');
});
