// app-check refuses what it cannot do, and names the window it found.
//
// The fast half only: no app is launched here. A wrong call must fail with a
// sentence the model can act on, because a checker that says "done" about nothing
// is worse than no checker at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = path.resolve('skills/app-check/bin/app-check.mjs');
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 30000 });

test('--help prints the usage and exits 0', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: app-check\.mjs/);
  assert.match(r.stdout, /--resize/);
});

test('no target at all prints the usage', () => {
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: app-check\.mjs/);
});

test('an unknown option is refused, not ignored', () => {
  const r = run('--nonsense', 'x.exe');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such option: --nonsense/);
});

test('an exe that is not there is refused before anything is launched', () => {
  const r = run('--exe', 'no-such-app.exe');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such file/);
});

test('the window tool exists beside it', () => {
  assert.equal(fs.existsSync(path.resolve('skills/app-check/bin/window.ps1')), true);
});

test('a role with app-check is told the tool path, and one without is not', async () => {
  const { describeSkills } = await import('../src/skills.js');
  const { SKILLS_DIR } = await import('../src/paths.js');
  const withIt = describeSkills({ roles: { qc: { skills: ['app-check'] } } }, 'qc');
  const without = describeSkills({ roles: { qc: { skills: [] } } }, 'qc');
  assert.ok(withIt.includes(path.join(SKILLS_DIR, 'app-check', 'bin', 'app-check.mjs')));
  assert.ok(!without.includes('app-check.mjs'));
});
