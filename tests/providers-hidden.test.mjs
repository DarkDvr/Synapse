// An engine provider can be removed from the list, and put back.
//
// The engine registers its own catalog and always will — OC Zen and OC Go are not
// Synapse's to unregister. What the operator asked for (6 Nov) is that they stop
// being read-only rows: removing one takes its models out of the model menu, and
// Add Provider puts the row back. Nothing is deleted and a role that already
// points at one of those models keeps working, because this is the menu, not the
// permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../src/api.js';
import { normalize, DEFAULTS } from '../src/config.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };

const CATALOG = [
  { provider: 'opencode', id: 'big-pickle', ref: 'opencode/big-pickle', name: 'Big Pickle', free: true },
  { provider: 'opencode', id: 'grok-code', ref: 'opencode/grok-code', name: 'Grok Code', free: true },
  { provider: 'opencode-go', id: 'kimi-k2', ref: 'opencode-go/kimi-k2', name: 'Kimi K2', free: false },
  { provider: 'local', id: 'qwen3', ref: 'local/qwen3', name: 'Qwen3', free: true },
];

function harness(hiddenProviders = []) {
  let current = normalize({ engine: { opencode: { hiddenProviders } } });
  const recorded = [];
  const api = createApi({
    getConfig: () => current,
    applyConfig: (next) => {
      current = next;
      return next;
    },
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
  return { api, recorded, set: (c) => { current = c; } };
}

test('nothing is hidden until the operator removes a provider', async () => {
  const { api } = harness([]);
  const { models } = await api.models();
  assert.equal(models.length, CATALOG.length, 'every model the engine serves is offered');
});

test('a removed engine provider takes its models out of the menu, and only its own', async () => {
  const { api } = harness(['opencode']);
  const { models } = await api.models();
  assert.deepEqual(
    models.map((m) => m.ref),
    ['opencode-go/kimi-k2', 'local/qwen3'],
    'the two Zen models are gone, the Go and local ones are not',
  );
});

test('removing both engine providers leaves the operator’s own servers alone', async () => {
  const { api } = harness(['opencode', 'opencode-go']);
  const { models } = await api.models();
  assert.deepEqual(models.map((m) => m.ref), ['local/qwen3']);
});

test('the catalog is still recorded while a provider is hidden, so it can come back', async () => {
  const { api, recorded } = harness(['opencode']);
  await api.models();
  // The cache is written before the filter: a hidden model keeps its context,
  // variants and tools, which is what makes putting the provider back free.
  assert.deepEqual(recorded, [CATALOG.length]);
});

test('a hidden id that names nothing hides nothing', async () => {
  const { api } = harness(['opencode', 'not-a-provider']);
  const { models } = await api.models();
  assert.equal(models.length, CATALOG.length - 2);
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
