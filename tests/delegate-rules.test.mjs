// A delegation is not refused for a list that is still growing.
//
// This file used to enforce "write the whole plan before the first task runs": a
// declared phase with no task under it refused the delegation. The record retired
// that rule - the Architect invented t3b and t3c to insert work between existing
// items, reopened a finished task after judging it, and added two more the next
// day. The list is a work list now, so what has to hold is the opposite: a partial
// list runs, and nothing is refused for being incomplete. Driven through the real
// runner with a stubbed engine.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRunner } from '../src/runs.js';
import { readPlan, ORIGINS } from '../src/plans.js';

const ROOT = path.join(os.tmpdir(), `synapse-delegate-rules-${process.pid}`);
const DIR = path.join(ROOT, 'project');
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const checks = [];
const expect = (label, ok, detail) =>
  checks.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  <- ${detail}` : ''}`);

const plan = (phases, tasks) => ({ version: 1, goal: 'x', ...(phases ? { phases } : {}), tasks });
const task = (id, role) => ({ id, title: `Do ${id}`, role, status: 'todo', detail: 'd', reads: [], dependsOn: [] });

const writePlan = (p) => {
  fs.mkdirSync(path.join(DIR, '.synapse'), { recursive: true });
  fs.writeFileSync(path.join(DIR, '.synapse', 'plan.json'), JSON.stringify(p, null, 2), 'utf8');
};

// ── the file's shape ────────────────────────────────────────────
writePlan(plan(['build', 'qc'], [
  task('t1', 'coder-1'),
  { ...task('t2', 'qc'), origin: 'found' },
  { ...task('t3', 'coder-1'), origin: 'operator' },
  { ...task('t4', 'coder-1'), origin: 'nonsense' },
]));
{
  const st = readPlan(DIR);
  const byId = Object.fromEntries((st.plan?.tasks || []).map((t) => [t.id, t]));
  expect(
    'an old plan that still names phases reads without a complaint',
    !(st.problems || []).some((p) => /phases/.test(p)),
    (st.problems || []).join(' | '),
  );
  expect('phases are dropped from what the harness reads', st.plan && !('phases' in st.plan), Object.keys(st.plan || {}).join(','));
  expect('a planned row defaults to origin=plan', byId.t1?.origin === 'plan', byId.t1?.origin);
  expect('a row noticed during the work keeps origin=found', byId.t2?.origin === 'found', byId.t2?.origin);
  expect('a row the operator asked for keeps origin=operator', byId.t3?.origin === 'operator', byId.t3?.origin);
  expect('an unknown origin is plan, not a complaint', byId.t4?.origin === 'plan', byId.t4?.origin);
  expect('the origins are named in one place', ORIGINS.join() === 'plan,found,operator', ORIGINS.join());
}

// ── the refusal, through handleTurn ─────────────────────────────
const makeRunner = ({ auto = true, stallSec = 5, workerMessages = null } = {}) => {
  const woke = [];
  const ran = [];
  const nudged = [];
  const arch = [{ id: 'm0', type: 'user', parts: [] }];
  const engine = {
    async getSession(id) {
      if (id === 'ses_arch') return { id, directory: DIR, internal: false, single: false, auto };
      return { id, directory: DIR, internal: true };
    },
    async getMessages(id) {
      return id === 'ses_arch' ? [...arch] : workerMessages ? workerMessages() : [];
    },
    // The recovery asks which conversations exist, newest first.
    async listSessions() {
      return [
        { id: 'ses_old', directory: DIR, internal: false, created: 1 },
        { id: 'ses_arch', directory: DIR, internal: false, created: 2 },
        { id: 'ses_worker', directory: DIR, internal: true, created: 3 },
      ];
    },
    // A wake is "landed" when the session grows an idle message, which is exactly
    // how the real engine ends a turn.
    async synthetic(id, text) {
      woke.push(text);
      arch.push({ id: `s${woke.length}`, type: 'synthetic', parts: [{ type: 'text', text }] });
      arch.push({ id: `i${woke.length}`, type: 'idle', parts: [] });
    },
    async createSession() { ran.push('createSession'); return { id: 'ses_w1' }; },
    async prompt() { ran.push('prompt'); },
    async setInstruction() {},
    async nudge(id, text) { nudged.push(text); },
    async interrupt() {},
  };
  const warns = [];
  const runner = createRunner({
    engine,
    logger: { channel: () => ({ ...quiet, warn: (m) => warns.push(String(m)) }) },
    getConfig: () => ({
      roles: { 'coder-1': { ref: 'opencode/x' } },
      worker: { ladder: ['coder-1'], stallSec, resumeMax: 0 },
    }),
    guard: null,
    notify: () => {},
    modelCache: null,
  });
  return { runner, woke, ran, warns, arch, nudged };
};

/** A run is started without being awaited, so give it a tick to reach the prompt. */
const settle = () => new Promise((r) => setTimeout(r, 300));

// A distinct call id per case: a request is answered once, so reusing one would be
// skipped as already handled rather than run.
const delegate = (taskId, callId = `call_${taskId}`) => [
  { id: 'msg1', type: 'assistant', parts: [{ type: 'tool', id: callId, name: 'synapse-delegate_delegate', input: { task: taskId } }] },
];

try {
  // 1. a list that is still growing runs anyway
  // The operator's list is a work list, so a partial one is the normal case. This
  // used to be the refusal case, and it is now the opposite: the delegation goes
  // through and nothing is written to runs.jsonl as a refusal.
  writePlan(plan(['invent', 'build', 'hack'], [task('t1', 'inventor')]));
  {
    const { runner, woke, ran } = makeRunner();
    await runner.handleTurn('ses_arch', delegate('t1'));
    await settle();
    const run = fs.existsSync(path.join(DIR, '.synapse', 'runs.jsonl'))
      ? fs.readFileSync(path.join(DIR, '.synapse', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
    expect('a partial list is not refused', ran.includes('prompt'), ran.join(','));
    expect('so nothing is woken to complain', woke.length === 0, woke[0]?.slice(0, 90));
    expect('and no refusal is recorded', !run.some((r) => r.outcome === 'plan-incomplete'), JSON.stringify(run));
  }

  // 2. a second task on the same list still runs
  writePlan(plan(['invent', 'build'], [task('t1', 'inventor'), task('t2', 'coder-1')]));
  {
    const { runner, woke, ran, warns } = makeRunner();
    await runner.handleTurn('ses_arch', delegate('t1', 'call_second_try'));
    await settle();
    expect('a whole plan lets the work start', ran.includes('prompt'), ran.join(',') + ' warns=' + warns.join(' | '));
    expect('and nothing is refused', woke.length === 0);
  }
  // 3. a delegation no turn ever read: picked up once, at boot
  // Fever Tracker, 22 Oct: the Architect delegated t8 inside a turn that ended in
  // a question, Synapse restarted, the engine cancelled the question, the turn
  // never ended — and the delegation sat in the transcript for ever, answered
  // "Queued", with nothing running. This is the pass that notices.
  writePlan(plan(['invent', 'build'], [task('t1', 'inventor'), task('t8', 'coder-1')]));
  {
    const { runner, ran, arch, warns } = makeRunner();
    arch.push(...delegate('t8', 'call_recover'));
    const n = await runner.recoverDelegations([DIR]);
    await settle();
    expect('a delegation with no turn behind it is picked up', n === 1, String(n));
    expect('and the work starts', ran.includes('prompt'), `${ran.join(',')} warns=${warns.join(' | ')}`);

    // 4. the same pass again: it is journalled now, so nothing runs twice
    const before = ran.length;
    const again = await runner.recoverDelegations([DIR]);
    await settle();
    expect('a journalled delegation is not run twice', again === 0 && ran.length === before, `${again} / ${ran.join(',')}`);
  }
  // 5. a QC task past the cap: refused, and the Architect is told to settle it
  // Silent refusal is how t16 sat in `doing` for hours with nothing running — a
  // plan with one unfinished task cannot close, so a refusal the Architect never
  // hears about is a project that never finishes.
  writePlan(plan(['build', 'qc'], [task('t1', 'coder-1'), { ...task('t16', 'qc'), status: 'doing' }]));
  {
    const journal = path.join(DIR, '.synapse', 'runs.jsonl');
    const rounds = ['t6', 't8', 't13']
      .map((id) => JSON.stringify({ at: Date.now(), kind: 'result', task: id, role: 'qc', outcome: 'completed' }))
      .join('\n');
    fs.writeFileSync(journal, `${rounds}\n`, 'utf8');
    const { runner, woke, ran } = makeRunner();
    await runner.handleTurn('ses_arch', delegate('t16', 'call_qc_cap'));
    await settle();
    expect('a QC task past the cap does not run', !ran.includes('prompt'), ran.join(','));
    expect('and the Architect is told, not left waiting', woke.length === 1 && /will not start however many times/.test(woke[0]), woke[0]?.slice(0, 110));
    expect('the refusal is journalled as qc-cap', fs.readFileSync(journal, 'utf8').includes('"qc-cap"'));
  }
  // 6. a plan step nobody asked for: reminded once, then left alone
  // t16 and t19 were both planned, never delegated, and left the project one task
  // short of finished with nothing running. A delegation that is never attempted
  // cannot be refused, so nothing else in the harness could notice it.
  writePlan(
    plan(
      ['build', 'qc'],
      [{ ...task('t1', 'coder-1'), status: 'done' }, { ...task('t20', 'coder-1'), status: 'done' }, { ...task('t21', 'qc'), dependsOn: ['t20'] }],
    ),
  );
  {
    const { runner, woke, arch } = makeRunner();
    // A report has just arrived, so the Architect is working on its own and the
    // newest message is not the operator's.
    arch.push({ id: 's1', type: 'synthetic', parts: [{ type: 'text', text: 't20 finished.' }], created: Date.now() });
    await runner.handleTurn('ses_arch', arch);
    expect('a ready step nobody asked for gets one reminder', woke.length === 1 && /t21 is still to do/.test(woke[0]), woke[0]?.slice(0, 120));
    expect('and it is told to try once more', /delegate t21 as the plan has it/.test(woke[0] || ''));
    expect('with the way out named', /mark it `blocked`/.test(woke[0] || ''));

    const before = woke.length;
    await runner.handleTurn('ses_arch', arch);
    expect('the reminder is not repeated', woke.length === before, `${woke.length} vs ${before}`);
  }

  // 6b. a step marked doing with nothing running: woken, once
  // 24 Oct, on a real project: the Architect wrote "Now delegate t5 with concrete
  // instructions…" as a sentence and ended its turn. The plan claimed a task was
  // doing, the status made the rule below blind to it, and ten minutes passed with
  // nothing running. A sentence is not a tool call, and only this can tell.
  writePlan(
    plan(
      ['build', 'qc'],
      [{ ...task('t1', 'coder-1'), status: 'done' }, { ...task('t5', 'coder-1'), status: 'doing' }, { ...task('t6', 'qc'), dependsOn: ['t5'] }],
    ),
  );
  {
    const { runner, woke, arch } = makeRunner();
    arch.push({ id: 's2', type: 'synthetic', parts: [{ type: 'text', text: 't4 finished.' }], created: Date.now() });
    await runner.handleTurn('ses_arch', arch);
    expect(
      'a step marked doing with nothing running wakes the Architect',
      woke.length === 1 && /says t5 is `doing`, and nothing is running/.test(woke[0]),
      woke[0]?.slice(0, 130),
    );
    expect('it is told a sentence is not a delegation', /is not a delegation/.test(woke[0] || ''));
    expect('and given both ways out', /Delegate t5 now/.test(woke[0] || '') && /back to `todo`/.test(woke[0] || ''));

    const before = woke.length;
    await runner.handleTurn('ses_arch', arch);
    expect('the doing reminder is not repeated', woke.length === before, `${woke.length} vs ${before}`);
  }

  // 6c. a step that ends in an error is over — do not wait out the stall window
  // 25 Oct, a real QC run: two steps ended `error: aborted, "Step interrupted"` and
  // the runner sat on each for the full 900-second stall window, which was 30 of a
  // 33-minute run. The transcript had already said the step failed; the watchdog was
  // waiting for an idle that was never coming.
  writePlan(plan(['build'], [{ ...task('t1', 'coder-1'), status: 'doing' }]));
  {
    const aborted = [
      { id: 'w1', type: 'user', parts: [] },
      { id: 'w2', type: 'assistant', parts: [], raw: { error: { type: 'aborted', message: 'Step interrupted' }, finish: 'error' } },
    ];
    // stallSec 30: without the early return this case cannot finish inside the test.
    const { runner, ran } = makeRunner({ stallSec: 30, workerMessages: () => [...aborted] });
    const started = Date.now();
    await runner.handleTurn('ses_arch', delegate('t1'));
    // Wait for the run to end, up to 12s: the point is that it is far short of 30.
    for (let i = 0; i < 24 && !ran.includes('prompt'); i += 1) await settle();
    const took = (Date.now() - started) / 1000;
    expect('an errored step is noticed at once', ran.includes('prompt'), ran.join(','));
    expect('and the wait is seconds, not the stall window', took < 12, `${took.toFixed(1)}s of a 30s window`);
  }

  // …and quiet when it is not safe: the operator is driving, or they just spoke.
  {
    const { runner, woke } = makeRunner({ auto: false });
    await runner.handleTurn('ses_arch', [{ id: 'm1', type: 'user', parts: [], created: Date.now() }]);
    expect('keep-building off means no reminder', woke.length === 0, woke.join(' | ').slice(0, 90));
  }
  {
    const { runner, woke } = makeRunner();
    await runner.handleTurn('ses_arch', [{ id: 'm2', type: 'user', parts: [], created: Date.now() }]);
    expect('an operator waiting for an answer means no reminder', woke.length === 0, woke.join(' | ').slice(0, 90));
  }
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(checks.join('\n'));
const failed = checks.filter((c) => c.startsWith('FAIL')).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
