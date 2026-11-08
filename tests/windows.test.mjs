// The context window: one answer, one place.
//
// The bug this replaces was reported five times: a local model loaded at 128k and
// the card saying 60k, because the config still held a number measured when the
// model was loaded smaller. These tests pin the two halves of the fix — the
// precedence, and the measurement that keeps the remembered number true.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveWindow,
  splitRef,
  declaredWindow,
  knownWindow,
  remember,
  forget,
  clearMemory,
  refreshWindow,
  refreshLocalProviders,
  writeIntoConfig,
} from '../src/windows.js';

const config = (models = [], extra = {}) => ({
  engine: {
    opencode: {
      providers: [{ id: 'local', type: 'local', baseURL: 'http://localhost:1235/v1', models }],
    },
  },
  ...extra,
});

const cacheWith = (ref, record) => ({ get: (key) => (key === ref ? record : null) });

/** A fake LM Studio: `/api/v0/models` answers, the other two endpoints do not. */
const lmStudio = (entries) => async (url) => {
  if (String(url).endsWith('/api/v0/models')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: entries }) };
  }
  return { ok: false, status: 404, text: async () => '{}' };
};

test('the precedence: measured, then the operator, then a refusal, then the catalog', () => {
  assert.equal(resolveWindow({ loaded: 128000, override: 60160, catalog: 60000 }), 128000);
  assert.equal(resolveWindow({ override: 1048576, catalog: 200000 }), 1048576);
  // A refusal is an upper bound, not a window: it only beats a larger claim.
  assert.equal(resolveWindow({ refused: 128000, catalog: 200000 }), 128000);
  assert.equal(resolveWindow({ refused: 400000, catalog: 200000 }), 200000);
  // The override is a deliberate test, so a provider's bad minute does not undo it.
  assert.equal(resolveWindow({ override: 1048576, refused: 200000, catalog: 200000 }), 1048576);
  assert.equal(resolveWindow({}), 0);
});

test('a ref splits in two, and one without a slash is all model', () => {
  assert.deepEqual(splitRef('local/qwen3.8-27b-ud'), { providerId: 'local', modelId: 'qwen3.8-27b-ud' });
  assert.deepEqual(splitRef('solo'), { providerId: '', modelId: 'solo' });
});

test('the configured number is the operator\'s, under either spelling', () => {
  const cfg = config([{ id: 'qwen3.8-27b-ud', context: 128000, output: 8192 }]);
  assert.deepEqual(declaredWindow(cfg, 'local/qwen3.8-27b-ud'), { override: 0, context: 128000, output: 8192 });
  const refKeyed = { ...cfg, modelLimits: { 'local/qwen3.8-27b-ud': { context: 200000 } } };
  assert.equal(declaredWindow(refKeyed, 'local/qwen3.8-27b-ud').override, 200000);
  const bareKeyed = { ...cfg, modelLimits: { 'qwen3.8-27b-ud': { context: 200000 } } };
  assert.equal(declaredWindow(bareKeyed, 'local/qwen3.8-27b-ud').override, 200000);
});

test('the window comes from the config first, the catalog last', () => {
  clearMemory();
  assert.equal(knownWindow(config([]), 'local/x', { cache: cacheWith('local/x', { context: 60000 }) }).context, 60000);
  assert.equal(knownWindow(config([{ id: 'x', context: 128000 }]), 'local/x').context, 128000);
  assert.equal(
    knownWindow(config([{ id: 'x', context: 128000 }]), 'local/x', { cache: cacheWith('local/x', { context: 60000 }) }).source,
    'provider',
  );
  const withOverride = config([{ id: 'x', context: 128000 }], { modelLimits: { 'local/x': { context: 200000 } } });
  assert.equal(knownWindow(withOverride, 'local/x').context, 200000);
  assert.equal(knownWindow(withOverride, 'local/x').source, 'override');
});

test('a measurement outranks the config, in both directions', () => {
  clearMemory();
  const cfg = config([{ id: 'x', context: 60160, output: 8192 }]);
  remember('local/x', { context: 128000, source: 'loaded' });
  const known = knownWindow(cfg, 'local/x');
  assert.equal(known.context, 128000);
  assert.equal(known.source, 'loaded');
  assert.equal(known.output, 8192, 'the output ceiling is not the measurement');
  // Forgetting it is the operator editing the model: the config is the truth again.
  forget('local/x');
  assert.equal(knownWindow(cfg, 'local/x').context, 60160);
});

test('selecting a model asks its server, and the card follows', async () => {
  clearMemory();
  const cfg = config([{ id: 'x', context: 60160 }]);
  const fetchImpl = lmStudio([{ id: 'x', state: 'loaded', loaded_context_length: 128000, max_context_length: 262144 }]);
  const measured = await refreshWindow(cfg, 'local/x', { fetchImpl });
  assert.equal(measured.changed, true);
  assert.equal(measured.previous, 60160);
  assert.equal(measured.context, 128000);
  assert.equal(measured.source, 'loaded');
  // And it is what every later reader sees.
  assert.equal(knownWindow(cfg, 'local/x').context, 128000);
  // Asking again changes nothing, so no save and no broadcast.
  assert.equal((await refreshWindow(cfg, 'local/x', { fetchImpl })).changed, false);
});

test('the server naming a different model does not lend that window to ours', async () => {
  clearMemory();
  const cfg = config([
    { id: 'x', context: 204800 },
    { id: 'y', context: 131072 },
  ]);
  const fetchImpl = lmStudio([{ id: 'y', state: 'loaded', loaded_context_length: 40960 }]);
  const measured = await refreshWindow(cfg, 'local/x', { fetchImpl });
  assert.equal(measured.changed, false);
  assert.equal(knownWindow(cfg, 'local/x').context, 204800, 'x keeps its own declared number');
});

test('a remote provider is never asked, and a dead one changes nothing', async () => {
  clearMemory();
  const remote = { engine: { opencode: { providers: [{ id: 'cloud', type: 'openai', baseURL: 'https://api.example/v1', models: [{ id: 'm', context: 200000 }] }] } } };
  const never = async () => { throw new Error('a remote provider must not be probed'); };
  assert.equal((await refreshWindow(remote, 'cloud/m', { fetchImpl: never })).changed, false);
  assert.equal(knownWindow(remote, 'cloud/m').context, 200000);
  const dead = async () => { throw new Error('refused'); };
  const cfg = config([{ id: 'x', context: 128000 }]);
  assert.equal((await refreshWindow(cfg, 'local/x', { fetchImpl: dead })).changed, false);
  assert.equal(knownWindow(cfg, 'local/x').context, 128000, 'the last known number stands');
});

test('at boot, only what the server reports loaded is taken', async () => {
  clearMemory();
  const cfg = config([
    { id: 'x', context: 60160 },
    { id: 'y', context: 100000 },
  ]);
  const fetchImpl = lmStudio([{ id: 'x', state: 'loaded', loaded_context_length: 128000 }]);
  const changes = await refreshLocalProviders(cfg, { fetchImpl });
  assert.deepEqual(changes, [{ ref: 'local/x', from: 60160, to: 128000 }]);
  assert.equal(knownWindow(cfg, 'local/x').context, 128000);
  assert.equal(knownWindow(cfg, 'local/y').context, 100000);
});

test('a measured window is written into the config, so the engine is told it too', async () => {
  clearMemory();
  const cfg = config([{ id: 'x', context: 60160, output: 0 }]);
  const fetchImpl = lmStudio([{ id: 'x', state: 'loaded', loaded_context_length: 128000 }]);
  const measured = await refreshWindow(cfg, 'local/x', { fetchImpl });
  assert.equal(writeIntoConfig(cfg, 'local/x', measured), true);
  assert.equal(cfg.engine.opencode.providers[0].models[0].context, 128000);
  // Nothing new to write the second time.
  assert.equal(writeIntoConfig(cfg, 'local/x', measured), false);
  // A model the config does not hold cannot be written; the caller still shows it.
  assert.equal(writeIntoConfig(cfg, 'local/absent', { context: 1 }), false);
});
