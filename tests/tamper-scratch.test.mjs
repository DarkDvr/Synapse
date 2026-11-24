// The records check must not report the folders the role is allowed to write, or
// the folders the harness writes for it.
//
// 24 Nov: every QC run ended with a warning listing its own scratch files (and the
// shell logs) as "not this role's to write". The role rules explicitly allow
// `.project/scratch/**`; the fingerprint skipped only shots and reports, and it
// walked the whole browser profile under scratch on every run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_PROJECT_DIRS, synapseFingerprint } from '../src/plans.js';
import { tmpdir } from './tmpdir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the shared list is the one both sides use', () => {
  assert.deepEqual(
    [...SHARED_PROJECT_DIRS].sort(),
    ['logs', 'reports', 'scratch', 'shots'],
    'a shared folder is missing from the contract',
  );
  const runs = read('src/runs.js');
  assert.match(runs, /const sharedDirs = SHARED_PROJECT_DIRS/, 'the runner keeps its own copy of the list');
  const plans = read('src/plans.js');
  assert.match(plans, /resource: `\$\{PLAN_DIR\}\/scratch\/\*\*`, effect: 'allow'/);
});

test('the fingerprint does not walk scratch, logs, shots or reports', () => {
  const dir = tmpdir('synapse-fingerprint-');
  const at = (rel) => path.join(dir, '.project', rel);
  for (const rel of ['scratch/qc/run.txt', 'logs/shell-1.out', 'shots/a.png', 'reports/proof.txt', 'design/sheet.html']) {
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
    fs.writeFileSync(at(rel), rel);
  }
  const fp = synapseFingerprint(dir);
  assert.equal(Object.keys(fp).some((p) => p.startsWith('scratch/')), false, 'scratch was walked');
  assert.equal(Object.keys(fp).some((p) => p.startsWith('logs/')), false, 'logs were walked');
  assert.equal(Object.keys(fp).some((p) => p.startsWith('shots/')), false, 'shots were walked');
  assert.equal(Object.keys(fp).some((p) => p.startsWith('reports/')), false, 'reports were walked');
  assert.equal(Object.keys(fp).some((p) => p.startsWith('design/')), true, 'a role folder disappeared from the fingerprint');
});
