// What a worker may write inside .synapse, and what the harness must not blame it for.
//
// Two rules that pull against each other, and one evening that proved they did:
//
//  - the brief tells every role to put its proof, logs and notes in
//    `.synapse/reports/`, because that is where the operator looks;
//  - the role's permission rules deny `.synapse/**` and allow only the role's own
//    folder (plus screenshots), so a coder's `write` into `reports/` was refused.
//
// On 10 Nov the coder did what the brief said anyway, by shell redirect, and the
// tamper check reported its compliance as tampering — a false alarm in a real run.
// So `reports/` is a shared folder now, like `shots/`, and the stray-write check
// ignores both. A worker writing `plan.json` is still news.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { roleWriteRules, EVIDENCE_DIR, SHARED_DIR, PLAN_DIR } from '../src/plans.js';
import { tmpdir } from './tmpdir.mjs';
import { tidyProjectRoot } from '../src/cleanup.js';
import { wroteIt } from '../src/synapse-writes.js';

const DIR = 'F:/work/some-project';
const rulesFor = (role) => roleWriteRules(DIR, role);
const allows = (role) => rulesFor(role).filter((r) => r.effect === 'allow').map((r) => r.resource);

test('a worker may keep evidence where the brief tells it to', () => {
  for (const role of ['coder-1', 'coder-2', 'designer', 'inventor', 'qc']) {
    const allowed = allows(role).map((r) => r.replace(/\\/g, '/'));
    assert.ok(
      allowed.includes(`${PLAN_DIR}/reports/**`),
      `${role} may not write ${PLAN_DIR}/reports/**`,
    );
    assert.ok(allowed.includes(`${PLAN_DIR}/shots/**`), `${role} lost its screenshots folder`);
  }
  assert.equal(EVIDENCE_DIR, `${PLAN_DIR}/reports`);
  assert.equal(SHARED_DIR, `${PLAN_DIR}/shots`);
});

test('the rest of .synapse stays denied for a coder', () => {
  const rules = rulesFor('coder-1');
  const deny = rules.find((r) => r.effect === 'deny' && r.resource === `${PLAN_DIR}/**`);
  assert.ok(deny, 'the broad deny is what makes the folder list a rule rather than a wish');
  const allowed = allows('coder-1').map((r) => r.replace(/\\/g, '/'));
  assert.equal(allowed.includes(`${PLAN_DIR}/qc_findings/**`), false, 'a coder may not edit QC findings');
  assert.equal(allowed.includes(`${PLAN_DIR}/design/**`), false, 'a coder may not edit the design');
});

test('a proof the harness moved out of the project root is marked as the harness writing it', () => {
  const project = tmpdir('synapse-role-writes-');
  fs.writeFileSync(path.join(project, 't1-proof.txt'), 'I checked it.\n');
  const since = Date.now() - 1000;
  const moved = tidyProjectRoot(project);
  assert.equal(moved.length, 1, 'the mover did not move the proof');
  assert.equal(fs.existsSync(path.join(project, 't1-proof.txt')), false);
  // The fingerprint reports the path relative to `.synapse`, and the check under
  // test resolves it against the project — the same file the mover wrote.
  assert.equal(
    wroteIt(moved[0].to, since),
    true,
    `the harness did not claim its own move: ${moved[0].to}`,
  );
});
