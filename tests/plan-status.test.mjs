// Who keeps score on a plan row: the harness, not the model.
//
// The operator's rule (10 Nov): the model decides and judges, the harness records what
// mechanically happens. "A worker is on this row" is the clearest case — only the
// harness can see it — so `doing` is written when a worker starts and released when the
// run ends, whatever the outcome. What the Architect writes is its judgement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPlan, setTaskStatus, releaseDoing, clearPlanCache, invalidatePlan } from '../src/plans.js';

const project = (tasks) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-plan-status-'));
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.synapse', 'plan.json'),
    JSON.stringify({ version: 1, goal: 'g', tasks }, null, 2),
  );
  clearPlanCache();
  return dir;
};
const statusOf = (dir, id) => readPlan(dir).plan.tasks.find((t) => t.id === id)?.status;

test('the harness starts a row and stops it; the model never has to', () => {
  const dir = project([
    { id: 't1', title: 'one', role: 'coder-1', status: 'todo' },
    { id: 't2', title: 'two', role: 'coder-1', status: 'done' },
  ]);
  assert.equal(statusOf(dir, 't1'), 'todo');
  // A worker starts: the runner writes this itself now.
  setTaskStatus(dir, 't1', 'doing');
  invalidatePlan(dir);
  assert.equal(statusOf(dir, 't1'), 'doing');
  // The run ends: released to unjudged work, whatever happened in it.
  assert.equal(releaseDoing(dir, 't1'), true, 'the row was not released');
  invalidatePlan(dir);
  assert.equal(statusOf(dir, 't1'), 'todo', 'a finished run left the row doing');
});

test('a row the Architect has already judged is left alone', () => {
  const dir = project([
    { id: 't1', title: 'one', role: 'coder-1', status: 'done' },
    { id: 't2', title: 'two', role: 'coder-1', status: 'blocked' },
    { id: 't3', title: 'three', role: 'coder-1', status: 'todo' },
  ]);
  assert.equal(releaseDoing(dir, 't1'), false, 'a judged row was moved');
  assert.equal(releaseDoing(dir, 't2'), false, 'a blocked row was moved');
  assert.equal(releaseDoing(dir, 't3'), false, 'a todo row was moved');
  assert.equal(releaseDoing(dir, 't9'), false, 'a missing row was moved');
  invalidatePlan(dir);
  assert.equal(statusOf(dir, 't1'), 'done');
  assert.equal(statusOf(dir, 't2'), 'blocked');
});

test('the brief tells the Architect not to write it, and the runner does', () => {
  const plans = fs.readFileSync(path.join(process.cwd(), 'src', 'plans.js'), 'utf8');
  assert.match(plans, /Do not write "doing"/, 'the brief still asks for it');
  assert.match(plans, /the harness marks a row doing the moment a worker starts/, 'the brief does not say who writes it');
  const runs = fs.readFileSync(path.join(process.cwd(), 'src', 'runs.js'), 'utf8');
  assert.match(runs, /setTaskStatus\(dir, task\.id, 'doing'\)/, 'the runner does not start the row');
  assert.match(runs, /releaseDoing\(dir, task\.id\)/, 'the runner does not release it');
});

test('a row marked done owes a result, and a fresh write is not judged yet', () => {
  // The operator's own projects all carry a result on every done row; the two that did
  // not were the ones nobody could read afterwards (10 Nov).
  const project = (tasks) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-plan-result-'));
    fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
    const file = path.join(dir, '.synapse', 'plan.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, goal: 'g', tasks }, null, 2));
    // The rule waits for the file to stand still: `result` and `status` land in two
    // writes, and judging between them flagged six of six finished runs on the clock
    // project. Backdate the file so this test is past that grace.
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(file, old, old);
    clearPlanCache();
    return dir;
  };
  const withResult = project([{ id: 't1', title: 'one', role: 'coder-1', status: 'done', result: 'the check passed' }]);
  assert.equal(readPlan(withResult).problems.filter((p) => /records no result/.test(p)).length, 0);

  const bare = project([{ id: 't1', title: 'one', role: 'coder-1', status: 'done' }]);
  const problems = readPlan(bare).problems;
  assert.equal(problems.filter((p) => /records no result/.test(p)).length, 1, problems.join(' | '));
  assert.match(problems.join(' '), /claim with nothing behind it/, 'the sentence does not say why it matters');

  // A fresh write is not judged: the two-step save is not a fault.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-plan-fresh-'));
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.synapse', 'plan.json'), JSON.stringify({ version: 1, tasks: [{ id: 't1', title: 'one', role: 'coder-1', status: 'done' }] }));
  clearPlanCache();
  assert.equal(readPlan(dir).problems.filter((p) => /records no result/.test(p)).length, 0, 'a fresh write was judged');
});
