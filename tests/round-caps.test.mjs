// Caps belong to a round, not to a project's whole life.
//
// A round ends when the Architect says the plan is done: every task `done` and
// the customer-facing summary written. That is recorded as a `round` line in
// runs.jsonl, and the QC loop's three rounds and every task's three attempts are
// counted from it. Measured 27 Oct on Fever Tracker: its fourth bugfix round had
// no QC left to spend (three rounds used in its first two days), and its t2 was
// already on attempt 3 of a cap it had never actually reached — task ids are
// reused by every new plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendRun, readRuns } from '../src/plans.js';
import { closeRound, countedAttempts, qcRoundsUsed } from '../src/runs.js';

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-round-'));
const task = (id, status) => ({ id, title: `task ${id}`, role: 'coder-1', status });

function writePlan(dir, { tasks, summary = 'It works.' }) {
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.synapse', 'plan.json'),
    JSON.stringify({ version: 1, goal: 'fix it', summary, tasks }),
    'utf8',
  );
}

test('a finished plan closes the round and the caps start over', () => {
  const dir = project();
  writePlan(dir, { tasks: [task('t1', 'done')] });
  for (const [callId, attempt] of [['a', 1], ['b', 2], ['c', 3]]) {
    appendRun(dir, { kind: 'delegate', task: 't1', attempt, callId });
    appendRun(dir, { kind: 'result', role: 'coder-1', task: 't1', callId, outcome: 'completed' });
  }
  for (const callId of ['q1', 'q2', 'q3']) {
    appendRun(dir, { kind: 'result', role: 'qc', task: 't1', callId, outcome: 'completed' });
  }

  assert.equal(countedAttempts(readRuns(dir), 't1'), 3, 'three attempts spent in this round');
  assert.equal(qcRoundsUsed(dir), 3, 'three QC rounds spent in this round');
  assert.equal(closeRound(dir), true, 'a done plan with a summary closes the round');

  assert.equal(countedAttempts(readRuns(dir), 't1'), 0, 'attempts are counted from the close');
  assert.equal(qcRoundsUsed(dir), 0, 'QC rounds are counted from the close');

  appendRun(dir, { kind: 'delegate', task: 't1', attempt: 1, callId: 'd' });
  assert.equal(countedAttempts(readRuns(dir), 't1'), 1, 'the new round spends its own attempts');
});

test('a round closes once, and only when the Architect has said done', () => {
  const dir = project();
  writePlan(dir, { tasks: [task('t1', 'todo')] });
  assert.equal(closeRound(dir), false, 'unfinished work stays open');

  writePlan(dir, { tasks: [task('t1', 'done')], summary: '' });
  assert.equal(closeRound(dir), false, 'done without a summary is not "said done"');

  writePlan(dir, { tasks: [task('t1', 'done')], summary: 'The form defaults now work.' });
  assert.equal(closeRound(dir), true);
  assert.equal(closeRound(dir), false, 'the same finished plan is not closed twice');
  assert.equal(readRuns(dir).filter((r) => r.kind === 'round').length, 1);
});

test('an unfinished plan after a close does not spend the new round on the old one', () => {
  const dir = project();
  writePlan(dir, { tasks: [task('t1', 'done')], summary: 'Shipped.' });
  assert.equal(closeRound(dir), true);
  // The next plan is written unfinished; its work counts as the new round.
  writePlan(dir, { tasks: [task('t1', 'todo')], summary: '' });
  appendRun(dir, { kind: 'delegate', task: 't1', attempt: 1, callId: 'a' });
  assert.equal(countedAttempts(readRuns(dir), 't1'), 1);
  assert.equal(closeRound(dir), false);
});
