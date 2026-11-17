// The turn watcher's second job: copy a backgrounded command's output into the project,
// in every mode. The loop half can be switched off; this half cannot — a chat member that
// cannot read its own command's output ends the turn "waiting" and the work stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTurnGuard } from '../src/turn-guard.js';
import { tmpdir } from './tmpdir.mjs';

const backgroundPart = (source) => ({
  id: 'p1',
  type: 'tool',
  name: 'shell',
  output: `Command moved to the background (shell ID: sh_abc123). Output is streaming to: ${source}`,
});

const ticks = async (guard) => {
  guard.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  guard.stop();
};

const guardFor = ({ dir, engine, loops = false, perTick = 1 }) =>
  createTurnGuard({
    engine,
    sessionId: 's1',
    dir,
    loops,
    log: { warn() {} },
    // Call the poll directly rather than wait four seconds for the real timer.
    setInterval: (fn) => {
      for (let i = 0; i < perTick; i += 1) fn();
      return 1;
    },
    clearInterval: () => {},
  });

test('the guard mirrors the output and steers the turn once, even with the loop guard off', async () => {
  const dir = tmpdir('synapse-guard-mirror-');
  const source = path.join(dir, 'engine', 'sh_abc123.out');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'suite: 74 asserts, 0 failed\n');

  const steers = [];
  const engine = {
    listActiveSessions: async () => ['s1'],
    getMessages: async () => [{ id: 'm1', type: 'assistant', parts: [backgroundPart(source)] }],
    prompt: async (sessionId, text, opts) => { steers.push({ sessionId, text, opts }); },
  };

  // Two polls in one turn: the copy is refreshed, but the steer is sent once.
  await ticks(guardFor({ dir, engine, loops: false, perTick: 2 }));

  const copy = path.join(dir, '.project', 'logs', 'shell-sh_abc123.out');
  assert.equal(fs.existsSync(copy), true, 'the output is copied into the project');
  assert.match(fs.readFileSync(copy, 'utf8'), /74 asserts, 0 failed/);
  assert.equal(steers.length, 1, 'the turn is told once, not on every poll');
  assert.equal(steers[0].sessionId, 's1');
  assert.match(steers[0].text, /\[harness\]/);
  assert.match(steers[0].text, /\.project\/logs\/shell-sh_abc123\.out/);
  assert.equal(steers[0].opts.delivery, 'steer');

  // A new turn is a new guard: it is told once again.
  await ticks(guardFor({ dir, engine, loops: true }));
  assert.equal(steers.length, 2);
});
