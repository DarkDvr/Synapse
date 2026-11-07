// The harness guard's per-turn check.
//
// Every finished turn is handed the whole transcript. Before this test existed,
// that meant the same tool call was inspected on every later turn and its alarm
// rang again each time — three identical "shell command naming the harness"
// alarms for one command in the permission test.
//
// Run: node tests\harness-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createHarnessGuard } from '../src/harness.js';
import { ROOT } from '../src/paths.js';

const quiet = { channel: () => ({ info() {}, warn() {}, error() {}, debug() {} }) };

const message = (id, part) => ({ id, parts: [part] });
const shell = (id, command) => ({ id, type: 'tool', name: 'shell', input: { command } });

test('one harness call alarms once, not once per finished turn', () => {
  const alarms = [];
  const guard = createHarnessGuard({ root: ROOT, logger: quiet, notify: (event) => alarms.push(event) });
  const messages = [message('m1', shell('p1', `Set-Content -Path ${ROOT}\\logs\\probe.txt -Value x`))];

  guard.checkTurn({ sessionId: 'ses_1', messages, label: 'turn 1' });
  guard.checkTurn({ sessionId: 'ses_1', messages, label: 'turn 2' });
  assert.equal(alarms.length, 1, 'the same call was alarmed twice');

  const later = [
    ...messages,
    message('m2', shell('p2', `Set-Content -Path ${ROOT}\\logs\\probe2.txt -Value y`)),
  ];
  guard.checkTurn({ sessionId: 'ses_1', messages: later, label: 'turn 3' });
  assert.equal(alarms.length, 2, 'a new call must still alarm');
});

test('a read naming the harness is logged, not alarmed', () => {
  const alarms = [];
  const guard = createHarnessGuard({ root: ROOT, logger: quiet, notify: (event) => alarms.push(event) });
  guard.checkTurn({
    sessionId: 'ses_2',
    messages: [message('m1', shell('p1', `Get-Content ${ROOT}\\logs\\app.log -Tail 5`))],
    label: 'turn 1',
  });
  assert.equal(alarms.length, 0);
});

// A run must never commit the harness. The snapshot used to `git add -u` and commit
// with a generated message, and on 7 Nov that swept three half-finished edits into
// `snapshot: before t1 (coder-1)`. Now it reports a dirty tree and commits nothing —
// HEAD is the restore point, and HEAD does not include work in progress.
test('a run reports a dirty harness and commits nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-snapshot-'));
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  try {
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-m', 'first');

    const warned = [];
    const guard = createHarnessGuard({
      root: dir,
      logger: { channel: () => ({ info() {}, debug() {}, warn: (m) => warned.push(m), error() {} }) },
      notify: () => {},
    });

    // Work in progress: the operator's own edit.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    const dirty = await guard.snapshot('before t1 (coder-1)');
    assert.equal(dirty.committed, false);
    assert.equal(dirty.dirty, true);
    assert.match(warned.join('\n'), /uncommitted change/);
    assert.equal(git('rev-list', '--count', 'HEAD').stdout.trim(), '1', 'nothing was committed');
    assert.equal(git('log', '-1', '--format=%s').stdout.trim(), 'first', 'HEAD is still the operator’s');

    // A clean tree: nothing to say, and still nothing to commit.
    git('checkout', '--', 'a.txt');
    const clean = await guard.snapshot('before t2 (coder-1)');
    assert.equal(clean.committed, false);
    assert.equal(clean.clean, true);
    assert.equal(git('rev-list', '--count', 'HEAD').stdout.trim(), '1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
