// The engine's revert is a boundary, staged and committed; removing the exchange
// must never ask it to restore files.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenCodeEngine } from '../src/engines/opencode.js';

const silent = () => ({ channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) });

test('stage, commit and clear use the revert routes with files off', async () => {
  const calls = [];
  const engine = new OpenCodeEngine({}, { logger: silent() });
  engine.request = async (method, path, body) => {
    calls.push({ method, path, body });
    return method === 'POST' && path.endsWith('/revert/stage') ? { data: { messageID: 'u1' } } : null;
  };
  await engine.stageRevert('ses_x', 'u1');
  await engine.commitRevert('ses_x');
  await engine.clearRevert('ses_x');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /api/session/ses_x/revert/stage',
    'POST /api/session/ses_x/revert/commit',
    'DELETE /api/session/ses_x/revert',
  ]);
  assert.deepEqual(calls[0].body, { messageID: 'u1', files: false });
  assert.equal(calls[1].body, undefined);
});
