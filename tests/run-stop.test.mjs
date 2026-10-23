// Stop means stop.
//
// Measured 23 Oct: the operator pressed Stop, the run carried on to completion,
// and the next task started anyway. A delegated task runs in its own worker
// session, so interrupting the session on screen did nothing to it — and once the
// report came back the harness nudged the Architect, which delegated again.
//
// These checks drive the runner's own stop/resume with a stub engine: the latch is
// what the delegation gate reads, so it is the latch that has to hold.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunner } from '../src/runs.js';
import { setTaskStatus, readPlan } from '../src/plans.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-stop-'));
fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
const planFile = path.join(dir, '.synapse', 'plan.json');
fs.writeFileSync(planFile, JSON.stringify({
  version: 1,
  goal: 'x',
  tasks: [{ id: 't1', title: 'one', role: 'coder-1', status: 'doing', detail: '', reads: [], dependsOn: [] }],
}, null, 2));

const logs = [];
const channel = () => ({
  info: (m) => logs.push(m),
  warn: (m) => logs.push(m),
  error: (m) => logs.push(m),
  debug: () => {},
});
const engine = {
  status: () => ({ ready: true }),
  getSession: async () => ({ id: 'ses_x', directory: dir, auto: true }),
  getMessages: async () => [],
  interrupt: async () => {},
  listSessions: async () => [],
};
const runner = createRunner({
  engine,
  logger: { channel },
  getConfig: () => ({ roles: {} }),
  guard: null,
  notify: null,
  modelCache: null,
  onModelWindow: null,
});

// ── the plan's "doing" is put back when the operator stops ───────
check('a task marked doing is what the plan says before the stop', readPlan(dir).plan.tasks[0].status === 'doing');
check('the status helper puts one field back', setTaskStatus(dir, 't1', 'todo') === true);
check('and leaves the rest of the plan alone', readPlan(dir).plan.tasks[0].id === 't1' && readPlan(dir).plan.goal === 'x');
check('asking for the same status again writes nothing', setTaskStatus(dir, 't1', 'todo') === false);
check('an unknown task changes nothing', setTaskStatus(dir, 't99', 'done') === false);

// ── holding a project with nothing in flight ────────────────────
check('a hold is reported the first time', runner.hold(dir) === true, 'hold returned false');
check('and is not reported twice', runner.hold(dir) === false);
check('it is written down', logs.some((l) => /stopped by the operator/.test(l)), logs.slice(-3).join(' | '));

// ── the gate refuses while held, and only while held ────────────
{
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  plan.tasks[0].status = 'todo';
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  const messages = [{
    type: 'user',
    parts: [{ type: 'tool', id: 'call_1', name: 'delegate', input: { task: 't1' }, status: 'completed' }],
  }];
  await runner.handleTurn('ses_x', messages);
  const held = fs.readFileSync(path.join(dir, '.synapse', 'runs.jsonl'), 'utf8');
  check('a delegation while held is recorded, not run', held.includes('stopped-by-operator'), held);
  check('and nothing was started', !logs.some((l) => /run t1 \(/.test(l)), logs.slice(-4).join(' | '));
}

// ── the operator speaking releases it ───────────────────────────
check('speaking releases the hold', runner.resume(dir) === true);
check('and releasing twice is not news', runner.resume(dir) === false);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
