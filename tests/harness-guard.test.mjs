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
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createHarnessGuard } from '../src/harness.js';
import { ROOT } from '../src/paths.js';
import { tmpdir } from './tmpdir.mjs';

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

// A toolbox run whose page is a `file:///` URL inside the harness's own skills
// folder is still the toolbox: the URL names the same file as the path. It used to
// be reported as "naming the harness" because the token began with the scheme, and
// the operator got a second alarm beside the real one (11 Nov).
test('a shipped tool run from a file URL is not "naming the harness"', () => {
  const alarms = [];
  const guard = createHarnessGuard({ root: ROOT, logger: quiet, notify: (event) => alarms.push(event) });
  const shot = `${ROOT}\\skills\\visual-review\\bin\\shot.mjs`;
  const page = `file:///${ROOT.replace(/\\/g, '/')}/skills/visual-review/template/mock-2.html`;
  guard.checkTurn({
    sessionId: 'ses_3',
    messages: [message('m1', shell('p1', `node "${shot}" --url "${page}" 2>&1`))],
    label: 'turn 1',
  });
  assert.equal(alarms.length, 0, `a toolbox run was alarmed: ${JSON.stringify(alarms)}`);
});

// The alarm is for a **write shape**, not for a command the reader did not recognise.
// On 11 Nov a QC run's own transcript raised the popup: a multi-line block of
// `git grep`, `Get-Item` and `Select-Object` that happened to name the harness. A
// false popup costs more than a missed read, because it teaches the operator to skip
// the line.
test('a multi-line block of reads that names the harness is a read, not an alarm', () => {
  const alarms = [];
  const logged = [];
  const guard = createHarnessGuard({
    root: ROOT,
    logger: { channel: () => ({ info: (m) => logged.push(m), warn() {}, error: (m) => logged.push(m), debug() {} }) },
    notify: (event) => alarms.push(event),
  });
  const command = [
    `$clone='${ROOT}\\bin'`,
    `git -C $clone grep -n -E "something" -- '*.js' | Select-Object -First 20`,
    `(Get-Item "${ROOT}\\package.json").VersionInfo | Select-Object FileVersion`,
    `if (Test-Path "${ROOT}\\AGENTS.md") { Get-Content "${ROOT}\\AGENTS.md" -TotalCount 5 }`,
  ].join('\n');
  guard.checkTurn({ sessionId: 'ses_4', messages: [message('m1', shell('p1', command))], label: 'turn 1' });
  assert.equal(alarms.length, 0, `reads were alarmed: ${JSON.stringify(alarms)}`);
  assert.ok(logged.some((line) => /read the harness/.test(line)), 'a read should still be written down');
});

test('a write shape naming the harness still alarms', () => {
  for (const command of [
    `Set-Content -Path ${ROOT}\\logs\\x.txt -Value hi`,
    `git -C ${ROOT} checkout -- AGENTS.md`,
    `Copy-Item ${ROOT}\\AGENTS.md ${ROOT}\\logs\\copy.md`,
    `[System.IO.File]::WriteAllText('${ROOT}\\logs\\x.txt', 'hi')`,
    `Get-Content ${ROOT}\\AGENTS.md > ${ROOT}\\logs\\swept.txt`,
  ]) {
    const alarms = [];
    const guard = createHarnessGuard({ root: ROOT, logger: quiet, notify: (event) => alarms.push(event) });
    guard.checkTurn({ sessionId: 'ses_5', messages: [message('m1', shell('p1', command))], label: 'turn 1' });
    assert.equal(alarms.length, 1, `${command} was not alarmed`);
  }
});

// A run must never commit the harness. The snapshot used to `git add -u` and commit
// with a generated message, and on 7 Nov that swept three half-finished edits into
// `snapshot: before t1 (coder-1)`. Now it reports a dirty tree and commits nothing —
// HEAD is the restore point, and HEAD does not include work in progress.
test('a run reports a dirty harness and commits nothing', async () => {
  const dir = tmpdir('synapse-snapshot-');
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
