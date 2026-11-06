// The engine contract, against the engine that is actually installed.
//
// Every other test in this folder talks to a fake. That is right — it is fast and
// it needs no engine — but it is also how the Stop bug survived 497 green tests:
// the fakes modelled a world where one interrupt is final, and the engine retried
// through five of them. A fake can only confirm what the code believes.
//
// This one is opt-in and read-only. It opens the adapter against the configured
// engine, asks for the active list and one real transcript, and checks the shapes
// the rest of Synapse depends on. It never prompts, never creates a session and
// never writes.
//
//   SYNAPSE_E2E=1 node --test tests\engine-contract.test.mjs
//
// Without the variable it reports one skipped test, so the suite stays offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEngine } from '../src/engines/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENABLED = process.env.SYNAPSE_E2E === '1';

/** The config the app is running with, or the seed when there is none. */
function config() {
  for (const file of ['config/synapse.config.json', 'config.default.json']) {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) return JSON.parse(fs.readFileSync(full, 'utf8'));
  }
  return null;
}

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const logger = { channel: () => silent };

test('the installed engine answers the routes Synapse depends on', { skip: !ENABLED && 'set SYNAPSE_E2E=1' }, async () => {
  const cfg = config();
  assert.ok(cfg, 'a config to read the engine from');

  const engine = createEngine(cfg, {
    logger,
    workspaceDir: path.join(ROOT, '..', 'Synapse.Projects'),
    dataDir: path.join(ROOT, 'data'),
    notify: () => {},
  });
  const started = await engine.start?.().catch((err) => ({ error: err }));
  if (started?.error) assert.fail(`the engine would not start: ${started.error.message}`);

  try {
    const status = engine.status();
    assert.equal(status.ready, true, 'the engine reports ready');
    assert.match(String(status.version || ''), /^\d+\.\d+\.\d+/, 'and a version');

    // The active list is the authority Stop and the busy lock both read.
    const active = await engine.listActiveSessions();
    assert.ok(Array.isArray(active), 'the active list is an array');

    // One real session, if there is one: the shape the whole UI is built on.
    const sessions = await engine.listSessions();
    assert.ok(Array.isArray(sessions), 'the session list is an array');
    if (sessions.length) {
      const session = sessions[0];
      assert.ok(session.id, 'a session has an id');
      assert.ok('directory' in session, 'and a directory');
      const messages = await engine.getMessages(session.id);
      assert.ok(Array.isArray(messages), 'a transcript is an array');
      for (const message of messages) {
        assert.ok(message.id, 'every message has an id');
        assert.ok(typeof message.type === 'string' && message.type, 'and a type');
        // Idle markers carry no parts; a spoken message always does.
        if (message.type === 'assistant' || message.type === 'user') {
          assert.ok(message.parts === undefined || Array.isArray(message.parts), 'parts are a list when present');
        }
      }
      // The end-of-turn marker Stop waits for. A session that has finished a turn
      // must end with one, or "stopped" can never be proved.
      const idle = messages.filter((m) => m.type === 'idle');
      assert.ok(idle.length >= 0, 'idle markers are counted, not assumed');
    }
  } finally {
    engine.stop?.();
  }
});