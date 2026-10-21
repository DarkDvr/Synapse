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

// A provider with no models is dropped rather than half-registered: the engine
// would list a provider with nothing in it and the menu would show an empty one.
const half = normalize({
  engine: { opencode: { providers: [{ id: 'empty', baseURL: 'https://example.com/v1', models: [] }] } },
});
check('a provider with no models is dropped', half.engine.opencode.providers.length === 0);

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

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
