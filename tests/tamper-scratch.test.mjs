// The records check must not report the folders the role is allowed to write.
//
// 24 Nov: every QC run ended with a warning listing its own scratch files (and the
// shell logs) as "not this role's to write". The role rules explicitly allow
// `.project/scratch/**`; the fingerprint simply forgot to exempt it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the records check exempts scratch and shell logs', () => {
  const src = read('src/runs.js');
  assert.match(
    src,
    /const sharedDirs = \[SHARED_DIR, EVIDENCE_DIR, 'scratch', 'logs'\]/,
    'scratch or logs are reported as stray writes',
  );
  // The policy makes the same promise, so the two cannot drift.
  const plans = read('src/plans.js');
  assert.match(plans, /resource: `\$\{PLAN_DIR\}\/scratch\/\*\*`, effect: 'allow'/);
});
