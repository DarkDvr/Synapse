// The action layer's thin, testable edge: argument order, ref normalization, and the
// one-line JSON the CLI answers. The live browser is not started here; the socket and the
// binary are environment, and a unit test must not need either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentArgs, normalizeRef, parseAgentJSON, agentBinary, agentSocketDir } from '../src/browser/agent.js';

test('agent-browser gets its globals before the command', () => {
  const args = agentArgs({ port: 19222, session: 'synapse-19222', config: 'F:\\cfg.json' }, ['click', '@e145']);
  assert.deepEqual(args, [
    '--config', 'F:\\cfg.json',
    '--cdp', '19222',
    '--session', 'synapse-19222',
    '--json',
    'click', '@e145',
  ]);
  assert.deepEqual(agentArgs({ port: 1 }, ['snapshot']), ['--cdp', '1', '--session', 'synapse', '--json', 'snapshot']);
});

test('a ref is normalized once, and a selector is left alone', () => {
  assert.equal(normalizeRef('e145'), '@e145');
  assert.equal(normalizeRef('@e145'), '@e145');
  assert.equal(normalizeRef(' 12 '), '@12');
  assert.equal(normalizeRef('#download'), '#download');
  assert.equal(normalizeRef(''), '');
});

test('the JSON answer is the last JSON line, and nonsense says so', () => {
  const one = parseAgentJSON('{"success":true,"data":{"snapshot":"- button \\"Go\\" [ref=e1]"}}');
  assert.equal(one.success, true);
  assert.match(one.data.snapshot, /ref=e1/);
  // A warning line before the answer must not hide it.
  const mixed = parseAgentJSON('warning: something\n{"success":false,"error":"covered by <div#cookie>"}');
  assert.equal(mixed.success, false);
  assert.match(mixed.error, /covered/);
  assert.throws(() => parseAgentJSON('not json at all'), /not JSON/);
  assert.throws(() => parseAgentJSON(''), /said nothing/);
});

test('a missing binary is reported, not faked', () => {
  assert.equal(agentBinary({ root: 'F:\\definitely\\no\\such\\folder' }), null);
  assert.match(agentSocketDir({ root: 'F:\\x' }), /data[\\/]browser[\\/]sockets$/);
});
