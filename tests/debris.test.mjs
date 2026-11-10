// The debris the harness clears by rule, not by asking a model to tidy up.
//
// The operator's decision (10 Nov): a plan task for cleanup spends a worker run on
// files the harness can name, and the model that made the mess is the one deciding
// what the mess is. So: a finished task's scratch goes, a stray file in the project
// root is *moved* into `.synapse/reports/<date>/`, and anything in the scratch root
// that no live project claims is removed — the load-bearing word being *claims*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { taskScratchDir, removeTaskScratch, tidyProjectRoot } from '../src/cleanup.js';
import { createHousekeeping } from '../src/housekeeping.js';
import { scratchDir } from '../src/paths.js';
import { tmpdir } from './tmpdir.mjs';

const tmp = () => tmpdir('synapse-debris-');

test('a task id cannot build a path outside its own scratch folder', () => {
  const dir = path.join('F:', 'dev', 'Projects', 'demo');
  const inside = taskScratchDir(dir, 't6');
  assert.ok(inside && inside.includes('t6'), 'a plain id maps to the task folder');
  assert.equal(taskScratchDir(dir, '../escape'), null, 'a traversal was allowed');
  assert.equal(taskScratchDir(dir, 'a/b'), null, 'a nested path was allowed');
  assert.equal(taskScratchDir(dir, '  '), null, 'a blank id was allowed');
});

test('a finished task loses its scratch, and only its own', () => {
  const scratchRoot = tmp();
  const dir = path.join(scratchRoot, 'demo-project');
  const folder = scratchDir(dir, scratchRoot);
  fs.mkdirSync(path.join(folder, 't6'), { recursive: true });
  fs.mkdirSync(path.join(folder, 't7'), { recursive: true });
  fs.writeFileSync(path.join(folder, 't6', 'build.bin'), 'x');
  assert.ok(fs.existsSync(path.join(folder, 't6')));
  removeTaskScratch(dir, 't6', { root: scratchRoot });
  assert.ok(!fs.existsSync(path.join(folder, 't6')), 'the finished task kept its scratch');
  assert.ok(fs.existsSync(path.join(folder, 't7')), 'a finished task took another task with it');
  // A task with no folder is not an error: most tasks never build anything.
  assert.equal(removeTaskScratch(dir, 't9', { root: scratchRoot }), null);
});

test('a stray file in the project root is moved, never deleted', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.json'), '{"not":"the plan"}');
  fs.writeFileSync(path.join(dir, 't8-proof.txt'), 'the proof');
  fs.writeFileSync(path.join(dir, 'build.log'), 'log');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(dir, 'README.md'), '# project');
  fs.mkdirSync(path.join(dir, 'src'));

  const moved = tidyProjectRoot(dir, { at: Date.parse('2026-11-10T12:00:00Z') });
  const names = moved.map((m) => path.basename(m.from)).sort();
  assert.deepEqual(names, ['build.log', 'plan.json', 't8-proof.txt'], 'the wrong files moved');
  // The deliverable and the readme stay exactly where they were.
  assert.ok(fs.existsSync(path.join(dir, 'index.html')), 'index.html was moved out of the project root');
  assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'README.md was moved');
  assert.ok(fs.existsSync(path.join(dir, 'src')), 'a folder was moved');
  // And they are in the dated reports folder, not gone.
  const into = path.join(dir, '.synapse', 'reports', '2026-11-10');
  for (const name of names) assert.ok(fs.existsSync(path.join(into, name)), `${name} is missing from the reports folder`);
  // A second run of the same task does not overwrite the first proof.
  fs.writeFileSync(path.join(dir, 't9-proof.txt'), 'second');
  tidyProjectRoot(dir, { at: Date.parse('2026-11-10T13:00:00Z') });
  fs.writeFileSync(path.join(dir, 't9-proof.txt'), 'third');
  const again = tidyProjectRoot(dir, { at: Date.parse('2026-11-10T14:00:00Z') });
  assert.equal(again.length, 1);
  assert.ok(fs.existsSync(path.join(into, 't9-proof-2.txt')), 'the second proof overwrote the first');
});

test('the scratch root keeps what a project owns, and takes the rest', () => {
  const scratchRoot = tmp();
  fs.mkdirSync(path.join(scratchRoot, 'live-project-1234abcd', 't1'), { recursive: true });
  fs.writeFileSync(path.join(scratchRoot, 'live-project-1234abcd', 't1', 'work.bin'), 'x');
  fs.mkdirSync(path.join(scratchRoot, 'proofs-a-worker-made'), { recursive: true });
  fs.mkdirSync(path.join(scratchRoot, 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(scratchRoot, 'visual-review-1234'), { recursive: true });
  const old = Date.now() - 60 * 60 * 1000;
  for (const name of ['proofs-a-worker-made', 'visual-review-1234']) {
    fs.utimesSync(path.join(scratchRoot, name), new Date(old / 1000), new Date(old / 1000));
  }
  const house = createHousekeeping({ root: scratchRoot, scratchRoot, log: { info() {}, warn() {} } });
  const report = house.sweepUnclaimedScratch({ keep: ['live-project-1234abcd'], graceMs: 10 * 60 * 1000 });
  assert.equal(report.removed, 2, `removed ${report.removed}: ${report.names.join(', ')}`);
  assert.ok(fs.existsSync(path.join(scratchRoot, 'live-project-1234abcd')), 'a live project lost its scratch');
  assert.ok(fs.existsSync(path.join(scratchRoot, 'opencode')), 'the engine temp was removed');
  assert.ok(!fs.existsSync(path.join(scratchRoot, 'proofs-a-worker-made')), 'an unclaimed folder survived');
});
