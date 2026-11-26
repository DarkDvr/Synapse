// The local live counter, normalised. The page only needs a few fields; the
// server's raw JSON (hardware, queues, history) never crosses this boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchProviderLive, clearProviderLiveCache } from '../src/provider-live.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const provider = { id: 'local-test', baseURL: 'http://127.0.0.1:8080/v1', apiKey: '' };

test('the live block is reduced to the waiting line fields', async () => {
  clearProviderLiveCache();
  const out = await fetchProviderLive(provider, {
    now: 1000,
    fetchImpl: async () => response({
      live: {
        state: 'generating',
        phase: 'thinking',
        prompt_read: 8192,
        prompt_total: 108553,
        generated: 0,
        elapsed_s: 10,
        tok_s: 78,
      },
      hardware: { gpu: 'never returned' },
    }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.state, 'prefill');
  assert.equal(out.read, 8192);
  assert.equal(out.total, 108553);
  assert.equal(out.elapsed, 10);
  assert.equal(out.hardware, undefined);
});

test('prompt_tokens is read as the total, never as the read counter', async () => {
  clearProviderLiveCache();
  const out = await fetchProviderLive({ ...provider, id: 'local-total' }, {
    now: 1500,
    fetchImpl: async () => response({ live: { state: 'generating', prompt_read: 100, prompt_tokens: 1000 } }),
  });
  assert.equal(out.state, 'prefill');
  assert.equal(out.read, 100);
  assert.equal(out.total, 1000);
});

test('a slots answer is understood when metrics is absent', async () => {
  clearProviderLiveCache();
  const calls = [];
  const out = await fetchProviderLive(provider, {
    now: 2000,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/metrics')) return response('not found', { ok: false, status: 404 });
      return response([{ is_processing: true, prompt_n: 10, prompt_total: 100, n_decoded: 0 }]);
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.state, 'prefill');
  assert.equal(out.read, 10);
  assert.equal(out.total, 100);
  assert.deepEqual(calls, ['http://127.0.0.1:8080/metrics', 'http://127.0.0.1:8080/slots']);
});

test('a server without either endpoint is not a claim about the model', async () => {
  clearProviderLiveCache();
  const out = await fetchProviderLive(provider, {
    now: 3000,
    fetchImpl: async () => response('nope', { ok: false, status: 404 }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reachable, false);
});

test('the short cache stops two pollers from asking twice', async () => {
  clearProviderLiveCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response({ live: { state: 'prefill', prompt_read: 1, prompt_total: 2 } });
  };
  await fetchProviderLive(provider, { now: 4000, fetchImpl });
  await fetchProviderLive(provider, { now: 4300, fetchImpl });
  assert.equal(calls, 1);
});

test('the route exists and the API refuses a remote caller', () => {
  const server = read('src/server.js');
  const api = read('src/api.js');
  assert.match(server, /providers' && seg\[1\] === 'live'/);
  assert.match(server, /api\.providerLive\(/);
  assert.match(api, /providerLive: async \(id, \{ remote = false \} = \{\}\)/);
  assert.match(api, /if \(remote\) return \{ ok: false, reachable: false, reason: 'local only' \}/);
  assert.match(api, /!isLocalProvider\(provider\)/);
});
