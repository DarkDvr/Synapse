// Where a provider's key comes from, and that the config keeps the shape the
// engine needs.
//
// Worth a test because both mistakes are silent: a key that never reaches the
// engine is a 401 on the first turn, hours into a project, and a secret left in
// `config/synapse.config.json` is one `git add -A` away from the repository.
// The env form is the one that keeps it out of the file, so it is the one that
// must not fail quietly.
import fs from 'node:fs';
import path from 'node:path';
import { providerApiKey, normalize } from '../src/config.js';
import { fetchProviderModels } from '../src/providers.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

// ── the three forms a key can take ───────────────────────────────
const withEnv = (vars) => new Proxy({}, { get: (_, k) => (typeof k === 'string' ? vars[k] : undefined) });

const explicit = providerApiKey({ id: 'deepseek', apiKey: 'env:DEEPSEEK_API_KEY' }, withEnv({ DEEPSEEK_API_KEY: 'sk-live' }));
check('env: form reads the variable', explicit.key === 'sk-live', explicit.key);
check('env: form is not a literal', !String(explicit.key).includes('env:'), explicit.key);
check('env: form reports where it came from', explicit.source === 'env DEEPSEEK_API_KEY', explicit.source);
check('env: form present is not missing', explicit.missing === false);

const absent = providerApiKey({ id: 'deepseek', apiKey: 'env:DEEPSEEK_API_KEY' }, withEnv({}));
check('env: form with no variable is missing, not empty', absent.missing === true, JSON.stringify(absent));
check('env: form with no variable yields no key', absent.key === '', absent.key);

const literal = providerApiKey({ id: 'vendor', apiKey: 'sk-direct' }, withEnv({}));
check('a literal key passes through', literal.key === 'sk-direct', literal.key);
check('a literal key is never "missing"', literal.missing === false);
check('a literal key says it came from config', literal.source === 'config', literal.source);

// A keyless local server must stay quiet: no warning, no key, no fuss.
const keyless = providerApiKey({ id: 'bionic', apiKey: '' }, withEnv({}));
check('a keyless server is not an error', keyless.missing === false && keyless.key === '', JSON.stringify(keyless));

// …but a blank entry still picks up the conventional variable when one is set,
// which is what every SDK on this machine does.
const conventional = providerApiKey({ id: 'deepseek', apiKey: '' }, withEnv({ DEEPSEEK_API_KEY: 'sk-conv' }));
check('a blank key falls back to <ID>_API_KEY', conventional.key === 'sk-conv', conventional.key);
check('the fallback names the variable it used', conventional.source === 'env DEEPSEEK_API_KEY', conventional.source);

const dashed = providerApiKey({ id: 'open-code-direct', apiKey: '' }, withEnv({ OPEN_CODE_DIRECT_API_KEY: 'k' }));
check('a dashed id makes a valid variable name', dashed.key === 'k', dashed.source);

// ── the config keeps a hosted vendor next to a local server ───────
const sample = normalize({
  engine: {
    opencode: {
      providers: [
        { id: 'bionic', name: 'Bionic', baseURL: 'http://localhost:1235/v1', apiKey: '', models: [{ id: 'qwen3.8-27b-ud' }] },
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseURL: 'https://api.deepseek.com/v1',
          apiKey: 'env:DEEPSEEK_API_KEY',
          models: [
            { id: 'deepseek-flash', name: 'DeepSeek Flash', context: 1048576, output: 65536 },
            { id: 'deepseek-v4-pro', name: 'DeepSeek Pro', context: 1048576, output: 65536 },
          ],
        },
      ],
    },
  },
});
const providers = sample.engine.opencode.providers;
check('both providers survive normalisation', providers.length === 2, String(providers.length));
const ds = providers.find((p) => p.id === 'deepseek');
check('the vendor key form survives as written', ds?.apiKey === 'env:DEEPSEEK_API_KEY', ds?.apiKey);
check('both models are kept', ds?.models.length === 2, JSON.stringify(ds?.models?.map((m) => m.id)));
check(
  'the window is kept for the watchdog',
  ds?.models.every((m) => m.context === 1048576 && m.output === 65536),
  JSON.stringify(ds?.models),
);

// A local server's list format is remembered; anything else is the OpenAI one.
const formats = normalize({
  engine: {
    opencode: {
      providers: [
        { name: 'Ollama', baseURL: 'http://localhost:11434/v1', format: 'ollama', models: [{ id: 'qwen3:8b' }] },
        { name: 'Studio', baseURL: 'http://localhost:1234/v1', format: 'nonsense', models: [{ id: 'x' }] },
      ],
    },
  },
});
check('an ollama provider keeps its format', formats.engine.opencode.providers[0]?.format === 'ollama');
check('an unknown format falls back to openai', formats.engine.opencode.providers[1]?.format === 'openai');

// A provider with no models is work in progress, not a typo: it is kept, and the
// engine config leaves it out until it has something to serve (see the writer in
// src/engines/opencode.js). A row with neither a name nor a server is dropped.
const half = normalize({
  engine: { opencode: { providers: [{ id: 'empty', baseURL: 'https://example.com/v1', models: [] }] } },
});
check('a provider with no models is kept', half.engine.opencode.providers.length === 1);
const blank = normalize({
  engine: { opencode: { providers: [{ id: 'blank', baseURL: '', name: '', models: [] }] } },
});
check('a row with no name and no server is dropped', blank.engine.opencode.providers.length === 0);

// ── the type, and the id a provider gets when it was added in Settings ──
const typed = normalize({
  engine: {
    opencode: {
      providers: [
        { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-flash' }] },
        { name: 'Local', baseURL: 'http://localhost:1234/v1', models: [{ id: 'x' }] },
        { name: 'LAN Box', baseURL: 'http://192.168.50.9:1234/v1', type: 'local', models: [{ id: 'y' }] },
      ],
    },
  },
});
const [ds2, local2, lan] = typed.engine.opencode.providers;
check('an https vendor is type openai', ds2?.type === 'openai', ds2?.type);
check('a localhost server is type local', local2?.type === 'local', local2?.type);
check('a declared type wins over the address', lan?.type === 'local', lan?.type);
check('a missing id comes from the name', ds2?.id === 'deepseek', ds2?.id);
check('the second provider keeps its own id', local2?.id === 'local', local2?.id);
const clash2 = normalize({
  engine: {
    opencode: {
      providers: [
        { name: 'DeepSeek', baseURL: 'https://a.example/v1', models: [{ id: 'm1' }] },
        { name: 'DeepSeek', baseURL: 'https://b.example/v1', models: [{ id: 'm2' }] },
      ],
    },
  },
});
check(
  'two providers with one name get different ids',
  clash2.engine.opencode.providers[1]?.id === 'deepseek-2',
  clash2.engine.opencode.providers[1]?.id,
);

// And the repo's own config: DeepSeek is registered, and its key is a variable
// name — never a key.
const repoConfig = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'synapse.config.json'), 'utf8'));
const repoDs = (repoConfig.engine?.opencode?.providers || []).find((p) => p.id === 'deepseek');
check('the shipped config registers DeepSeek', Boolean(repoDs));
check('the shipped config holds no key', repoDs?.apiKey === 'env:DEEPSEEK_API_KEY', repoDs?.apiKey);
check(
  'the shipped config names the two official models',
  JSON.stringify(repoDs?.models?.map((m) => m.id)) === JSON.stringify(['deepseek-flash', 'deepseek-v4-pro']),
  JSON.stringify(repoDs?.models?.map((m) => m.id)),
);

// ── Refresh List: asking a server what it serves ─────────────────
// The one call Synapse makes to a provider outside a turn, so the shape it
// accepts and the sentence it returns when the server is wrong both matter.

const calls = [];
const stub = (body, { ok = true, status = 200 } = {}) => async (url, opts) => {
  calls.push({ url, opts });
  return { ok, status, text: async () => body };
};

calls.length = 0;
const oa = await fetchProviderModels(
  { baseURL: 'https://api.example.com/v1/', apiKey: 'sk-secret-123456' },
  { fetchImpl: stub(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model', context_length: 65536, name: 'A Model' }] })) },
);
check('the list is read from an OpenAI-style answer', oa.ok && oa.models.length === 2, JSON.stringify(oa.error));
check('models are sorted by id', oa.models[0].id === 'a-model' && oa.models[1].id === 'b-model', JSON.stringify(oa.models.map((m) => m.id)));
check('a context length is carried over', oa.models[0].context === 65536, String(oa.models[0].context));
check('a missing name falls back to the id', oa.models[1].name === 'b-model', oa.models[1].name);
check('the URL is trimmed and /models appended', calls[0].url === 'https://api.example.com/v1/models', calls[0].url);
check('the key is sent as a bearer token', calls[0].opts.headers.authorization === 'Bearer sk-secret-123456');
check('the key never appears in the result', !JSON.stringify(oa).includes('sk-secret'), 'leaked');

calls.length = 0;
const lm = await fetchProviderModels(
  { baseURL: 'http://localhost:1235/v1', apiKey: '' },
  { fetchImpl: stub(JSON.stringify({ models: [{ id: 'qwen', max_context_length: 262144 }] })) },
);
check('a {models:[]} answer is accepted too', lm.ok && lm.models[0].id === 'qwen', JSON.stringify(lm));
check('a keyless server sends no Authorization', !calls[0].opts.headers.authorization);
check('max_context_length is read as the window', lm.models[0].context === 262144, String(lm.models[0].context));

const refused = await fetchProviderModels(
  { baseURL: 'https://api.example.com/v1', apiKey: 'sk-secret-123456' },
  { fetchImpl: stub(JSON.stringify({ error: { message: 'Authentication Fails (no such user)' } }), { ok: false, status: 401 }) },
);
check('a 401 is reported, not thrown', refused.ok === false);
check('the status is in the sentence', refused.error.includes('401'), refused.error);
check('the provider sentence is kept', refused.error.includes('Authentication'), refused.error);
check('a failure never echoes the key', !refused.error.includes('sk-secret'), refused.error);

const html = await fetchProviderModels({ baseURL: 'https://x.example/v1' }, { fetchImpl: stub('<html>nope</html>') });
check('a non-JSON answer is a sentence, not a crash', html.ok === false && /not JSON/.test(html.error), html.error);

const empty = await fetchProviderModels({ baseURL: 'https://x.example/v1' }, { fetchImpl: stub(JSON.stringify({ data: [] })) });
check(
  'an empty list is a failure naming both endpoints',
  empty.ok === false && /no models/.test(empty.error) && /\/api\/tags/.test(empty.error),
  empty.error,
);

// ── the two list formats ─────────────────────────────────────────
// Ollama answers /api/tags, everything else answers /models. The setting only
// chooses which is asked first; a server that speaks the other one still works.
calls.length = 0;
const ollamaFirst = await fetchProviderModels(
  { baseURL: 'http://localhost:11434/v1', format: 'ollama' },
  { fetchImpl: stub(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'gemma4:12b' }] })) },
);
check('the Ollama format asks /api/tags first', calls[0].url === 'http://localhost:11434/api/tags', calls[0].url);
check('Ollama tags are read from `name`', ollamaFirst.ok && ollamaFirst.models[0].id === 'gemma4:12b', JSON.stringify(ollamaFirst.models));

calls.length = 0;
let first = true;
const fallback = await fetchProviderModels(
  { baseURL: 'http://localhost:11434/v1', format: 'openai' },
  {
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      if (first) { first = false; return { ok: false, status: 404, text: async () => 'not found' }; }
      return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ name: 'qwen3:8b' }] }) };
    },
  },
);
check('a 404 at /models falls back to /api/tags', calls.length === 2 && /\/api\/tags$/.test(calls[1].url), JSON.stringify(calls.map((c) => c.url)));
check('the fallback answer is used', fallback.ok && fallback.models[0].id === 'qwen3:8b', JSON.stringify(fallback));

const refusedBoth = await fetchProviderModels(
  { baseURL: 'http://localhost:9/v1' },
  {
    fetchImpl: async () => {
      const err = new Error('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    },
  },
);
check(
  'a refused connection is one sentence, not two attempts',
  refusedBoth.ok === false && /refused the connection/.test(refusedBoth.error) && !/api\/tags/.test(refusedBoth.error),
  refusedBoth.error,
);

calls.length = 0;
const noScheme = await fetchProviderModels({ baseURL: 'localhost:1234' }, { fetchImpl: stub('{}') });
check('a URL without a scheme never leaves the app', noScheme.ok === false && calls.length === 0, noScheme.error);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);