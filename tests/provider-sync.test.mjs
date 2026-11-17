// The provider model lists, asked once at boot.
//
// Two rules are worth a test each, because both protect the operator from a silent
// failure: a list that answers is authoritative for ids (a model the provider has
// dropped must disappear, or a role sits on something that cannot run), and a list
// that does not answer is never replaced by nothing (a local server that was not
// launched yet is the common case, not an error).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncProviderModels } from '../src/providers.js';

const configOf = (...providers) => ({ engine: { opencode: { providers } } });
const answer = (models) => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ data: models }),
});

test('an answered list replaces the ids and keeps the operator’s own numbers', async () => {
  const config = configOf({
    id: 'oc-go',
    name: 'OpenCode Go',
    baseURL: 'https://x.test/v1',
    models: [
      { id: 'gone', name: 'Gone' },
      { id: 'stay', name: 'Stay', context: 1234, output: 99 },
    ],
  });
  const out = await syncProviderModels(config, {
    fetchImpl: answer([{ id: 'stay', name: 'Stay' }, { id: 'new', name: 'New' }]),
  });
  assert.equal(out.changed, true);
  assert.equal(out.added, 1);
  assert.equal(out.removed, 1);
  assert.deepEqual(out.removedIds, ['oc-go/gone']);
  const models = config.engine.opencode.providers[0].models;
  // The list is normalised in id order, so the new model comes first by name.
  assert.deepEqual(models.map((m) => m.id), ['new', 'stay'], 'the provider decides which ids exist');
  // What the operator set is not the provider's to change.
  const stay = models.find((m) => m.id === 'stay');
  assert.equal(stay.context, 1234);
  assert.equal(stay.output, 99);
});

test('a provider that does not answer keeps its list and is named', async () => {
  const config = configOf({
    id: 'local',
    name: 'Local LLM',
    baseURL: 'http://127.0.0.1:9/v1',
    type: 'local',
    models: [{ id: 'lm', name: 'LM' }],
  });
  const out = await syncProviderModels(config, {
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  assert.equal(out.changed, false);
  assert.deepEqual(out.failed.map((f) => f.name), ['Local LLM']);
  assert.deepEqual(config.engine.opencode.providers[0].models, [{ id: 'lm', name: 'LM' }]);
});

test('an empty listing is not read as “no models here”', async () => {
  const config = configOf({
    id: 'p',
    name: 'P',
    baseURL: 'https://p.test/v1',
    models: [{ id: 'a', name: 'A' }],
  });
  const out = await syncProviderModels(config, { fetchImpl: answer([]) });
  assert.equal(out.changed, false);
  assert.equal(out.failed.length, 1);
  assert.equal(config.engine.opencode.providers[0].models.length, 1, 'the saved list survived');
});

test('a slow provider cannot hold the boot past the shared deadline', async () => {
  const config = configOf({
    id: 'slow',
    name: 'Slow',
    baseURL: 'https://slow.test/v1',
    models: [{ id: 'a', name: 'A' }],
  });
  const started = Date.now();
  const out = await syncProviderModels(config, {
    // Never resolves: the only thing that can end this is the deadline.
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 300,
  });
  assert.ok(Date.now() - started < 2000, 'the call outlived its deadline');
  assert.equal(out.changed, false);
  assert.equal(config.engine.opencode.providers[0].models.length, 1);
});
