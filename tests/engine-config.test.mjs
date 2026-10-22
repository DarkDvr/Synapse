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
