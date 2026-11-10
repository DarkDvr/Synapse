// The brief is three sections, in the order a reader needs them.
//
// It had become one pile: the rules that never bend, the habits of the harness, and
// whatever this round happens to be — with a project's own situation at the bottom of
// three thousand tokens. These tests are about the shape of the text a model actually
// receives, which is cheap to assert and easy to lose in a refactor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefSession } from '../src/plans.js';

const NOWHERE = 'F:/dev/Synapse.Projects/__no_such_project__';
const multi = (role) => briefSession({ dir: NOWHERE, role });

const headings = (text) => text.split('\n').filter((l) => l.startsWith('## '));
const at = (text, needle) => text.indexOf(needle);

test('the harness brief has its three sections, in order, and the chat does not', () => {
  for (const role of ['architect', 'coder-1', 'qc', 'designer']) {
    const brief = multi(role);
    assert.deepEqual(
      headings(brief),
      ['## What never changes', '## How we work', '## This round'],
      `${role}'s brief lost a section`,
    );
    assert.ok(at(brief, '## What never changes') < at(brief, '## How we work'), 'the laws come after the habits');
    assert.ok(at(brief, '## How we work') < at(brief, '## This round'), 'the round comes before the habits');
  }
  // Single is a chat, not this harness: no sections, and no laws about judging work.
  const single = briefSession({ dir: NOWHERE, role: 'architect', single: true });
  assert.deepEqual(headings(single), [], 'Single grew harness sections');
  assert.doesNotMatch(single, /You judge; you do not build/, 'Single was told to judge instead of act');
});

test('a law is moved, not copied: each one is said once', () => {
  const architect = multi('architect');
  const worker = multi('coder-1');
  const laws = [
    [/You judge; you do not build/g, 'judge, do not build', 'architect'],
    [/never do that work yourself/g, 'never do refused work', 'architect'],
    [/every piece of work goes through the plan/g, 'everything goes through the plan', 'architect'],
    [/Do not write "doing"/g, 'do not write doing', 'architect'],
    [/Stop a process you started by its id/g, 'stop by id', 'both'],
  ];
  for (const [re, label, who] of laws) {
    const texts = who === 'architect' ? [architect] : [architect, worker];
    for (const text of texts) assert.equal((text.match(re) || []).length, 1, `${label} is said more than once`);
  }
  // The one every role runs commands by is in every role's brief.
  assert.match(worker, /Stop a process you started by its id/, 'the worker lost the process law');
  // And a worker is not handed the Architect's laws.
  assert.doesNotMatch(worker, /You judge; you do not build/, 'a worker was told to judge');
  assert.doesNotMatch(worker, /Do not write "doing"/, 'a worker was told how to write the plan');
});

test('the laws are at the top, where a reader looks first', () => {
  const brief = multi('architect');
  const firstLaw = at(brief, '## What never changes');
  // Everything before the laws is identity and mechanics: where the scratch folder is,
  // where app data lives. Nothing about the work.
  const before = brief.slice(0, firstLaw);
  assert.ok(before.length < 1400, `the head before the laws is ${before.length} characters`);
  assert.match(before, /Scratch folder:/);
  // And the round is the tail, so a project's own situation never buries a rule.
  const round = brief.slice(at(brief, '## This round'));
  assert.match(round, /Current plan:|The plan file does not exist yet|The plan is empty/, 'the round carries no plan state');
});
