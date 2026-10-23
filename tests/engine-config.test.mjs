// What Synapse tells the engine about itself, asserted on the file it writes.
//
// Two things here are silent when they are wrong. A limit override that never
// reaches `providers.opencode.models.<id>.limit` is a model that compacts on the
// catalog's conservative number; a compaction keep budget that never reaches
// `compaction.keep.tokens` is a setting the operator believes is on and is not.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeEngine } from '../src/engines/opencode.js';
import { normalize } from '../src/config.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

// A throwaway engine home, so nothing here can touch data\engine.
const home = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-engine-'));
  const dirs = { base, config: path.join(base, 'config'), data: path.join(base, 'data'), state: path.join(base, 'state'), tmp: path.join(base, 'tmp'), passwordFile: path.join(base, 'password.txt') };
  fs.mkdirSync(path.join(dirs.config, 'opencode'), { recursive: true });
  return dirs;
};
const silentLogger = () => ({ channel: () => ({ info() {}, warn() {}, error() {}, debug() {} }) });
const written = (dirs) => JSON.parse(fs.readFileSync(path.join(dirs.config, 'opencode', 'opencode.json'), 'utf8'));

// ── the keep budget ─────────────────────────────────────────────
{
  const dirs = home();
  const engine = new OpenCodeEngine({ compactionKeepTokens: 4000 }, { logger: silentLogger() });
  engine.ensureEngineConfig(dirs);
  const cfg = written(dirs);
  check('a keep budget reaches the engine config', cfg.compaction?.keep?.tokens === 4000, JSON.stringify(cfg.compaction));
}

{
  const dirs = home();
  const engine = new OpenCodeEngine({ compactionKeepTokens: 0 }, { logger: silentLogger() });
  engine.ensureEngineConfig(dirs);
  const cfg = written(dirs);
  check('0 writes nothing at all, so the engine keeps its own default', !('compaction' in cfg), JSON.stringify(cfg.compaction));
}

// A provider limit is still written, and the two do not fight over the same keys.
{
  const dirs = home();
  const engine = new OpenCodeEngine(
    {
      compactionKeepTokens: 6000,
      providers: [{ id: 'local', type: 'local', baseURL: 'http://localhost:1235/v1', models: [{ id: 'qwen', context: 60160, output: 8192 }] }],
    },
    { logger: silentLogger() },
  );
  engine.ensureEngineConfig(dirs);
  const cfg = written(dirs);
  check('the window is declared where the engine reads it', cfg.provider?.local?.models?.qwen?.limit?.context === 60160, JSON.stringify(cfg.provider?.local));
  check('the keep budget survives beside it', cfg.compaction?.keep?.tokens === 6000, JSON.stringify(cfg.compaction));
  check('mcp servers are still registered', Boolean(cfg.mcp?.servers?.['synapse-search']), JSON.stringify(Object.keys(cfg.mcp?.servers || {})));
}

// A provider model's limit must carry BOTH numbers.
// Measured on engine 2.1.2 with a scratch instance: `limit: { context }` alone made
// the engine answer "skipped malformed recognized value" at `$.provider.<id>` and
// drop the whole provider — so the model never reached the catalog and never
// appeared on a role card. `{ context, output }` was accepted; so was no limit at
// all, which is why a local server with a measured window and no chosen output is
// the exact case that broke.
{
  const dirs = home();
  const engine = new OpenCodeEngine(
    {
      providers: [
        { id: 'strata', type: 'local', baseURL: 'http://127.0.0.1:8080/v1', models: [{ id: 'big-model', context: 131072 }] },
        { id: 'local', type: 'local', baseURL: 'http://localhost:1235/v1', models: [{ id: 'small', context: 60160, output: 8192 }] },
      ],
    },
    { logger: silentLogger() },
  );
  engine.ensureEngineConfig(dirs);
  const cfg = written(dirs);
  const big = cfg.provider?.strata?.models?.['big-model'];
  check('a measured context is never left on its own', big?.limit?.context === 131072 && Number.isFinite(big?.limit?.output), JSON.stringify(big));
  check(
    'the output it gets is the engine\'s own default, so nothing changes',
    big?.limit?.output === 32000,
    String(big?.limit?.output),
  );
  check(
    'a chosen output is left exactly as chosen',
    cfg.provider?.local?.models?.small?.limit?.output === 8192,
    JSON.stringify(cfg.provider?.local?.models?.small),
  );
  check('a model with no window gets no limit at all', (() => {
    const d2 = home();
    const e2 = new OpenCodeEngine({ providers: [{ id: 'p', type: 'local', baseURL: 'http://localhost:1/v1', models: [{ id: 'x' }] }] }, { logger: silentLogger() });
    e2.ensureEngineConfig(d2);
    return !('limit' in (written(d2).provider?.p?.models?.x || {}));
  })(), 'limit written without a window');
}

// Anything already in the file that is not ours is left alone.
{
  const dirs = home();
  fs.writeFileSync(path.join(dirs.config, 'opencode', 'opencode.json'), JSON.stringify({ theme: 'dark', compaction: { auto: false } }), 'utf8');
  const engine = new OpenCodeEngine({ compactionKeepTokens: 3000 }, { logger: silentLogger() });
  engine.ensureEngineConfig(dirs);
  const cfg = written(dirs);
  check('an existing compaction setting is kept', cfg.compaction?.auto === false, JSON.stringify(cfg.compaction));
  check('and our budget joins it', cfg.compaction?.keep?.tokens === 3000, JSON.stringify(cfg.compaction));
  check('unknown keys survive', cfg.theme === 'dark', String(cfg.theme));
}

// ── which page of the transcript we ask for ─────────────────────
// The engine applies `limit` before it sorts, so `order=asc` returns the OLDEST
// 200 messages. An Architect session past 200 messages then looks frozen: the UI
// renders nothing new and the runner cannot see a turn end. This is the assertion
// that would have caught three hours of an apparently idle session.
{
  const engine = new OpenCodeEngine({}, { logger: silentLogger() });
  let asked = '';
  engine.request = async (method, apiPath) => {
    asked = apiPath;
    // A desc page comes back newest first, as the engine sends it.
    return {
      data: [
        { id: 'msg_b', type: 'assistant', time: { created: 2000 } },
        { id: 'msg_a', type: 'assistant', time: { created: 1000 } },
      ],
    };
  };
  const messages = await engine.getMessages('ses_x');
  check('the newest page is requested, not the oldest', /order=desc/.test(asked), asked);
  check('and it is put back into reading order', messages[0].id === 'msg_a' && messages[1].id === 'msg_b', JSON.stringify(messages.map((m) => m.id)));
}

// ── the setting's shape in the config file ──────────────────────
{
  const c1 = normalize({ engine: { opencode: { compactionKeepTokens: 4000 } } });
  check('a number stays a number', c1.engine.opencode.compactionKeepTokens === 4000, String(c1.engine.opencode.compactionKeepTokens));
  const c2 = normalize({ engine: { opencode: { compactionKeepTokens: 'lots' } } });
  check('nonsense becomes 0, not NaN', c2.engine.opencode.compactionKeepTokens === 0, String(c2.engine.opencode.compactionKeepTokens));
  const c3 = normalize({});
  check('a config that never mentions it defaults to 0', c3.engine.opencode.compactionKeepTokens === 0, String(c3.engine.opencode.compactionKeepTokens));
  const c4 = normalize({ engine: { opencode: { compactionKeepTokens: -5 } } });
  check('a negative number is refused', c4.engine.opencode.compactionKeepTokens === 0, String(c4.engine.opencode.compactionKeepTokens));
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
