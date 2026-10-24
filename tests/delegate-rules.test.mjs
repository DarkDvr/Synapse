// A delegation is refused while the plan declares a phase it has not planned.
//
// This is the enforcement behind the brief line "write the whole plan before the
// first task runs". Clock Test 3 showed the instruction alone was not enough: the
// Architect wrote t1, delegated it in the same turn, and added t2-t10 afterwards,
// so the first task ran against a two-task plan that grew to ten behind the
// operator's back. Driven through the real runner with a stubbed engine.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRunner } from '../src/runs.js';
import { uncoveredPhases } from '../src/plans.js';

const ROOT = path.join(os.tmpdir(), `synapse-delegate-rules-${process.pid}`);
const DIR = path.join(ROOT, 'project');
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const checks = [];
const expect = (label, ok, detail) =>
  checks.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  <- ${detail}` : ''}`);

const plan = (phases, tasks) => ({ version: 1, goal: 'x', phases, tasks });
const task = (id, role) => ({ id, title: `Do ${id}`, role, status: 'todo', detail: 'd', reads: [], dependsOn: [] });

const writePlan = (p) => {
  fs.mkdirSync(path.join(DIR, '.synapse'), { recursive: true });
  fs.writeFileSync(path.join(DIR, '.synapse', 'plan.json'), JSON.stringify(p, null, 2), 'utf8');
};

// ── the pure answer ─────────────────────────────────────────────
expect(
  'an unplanned phase is reported',
  uncoveredPhases(plan(['invent', 'build'], [task('t1', 'inventor')])).join() === 'build',
);
expect(
  'a covered phase is not',
  uncoveredPhases(plan(['build'], [task('t1', 'coder-2')])).length === 0,
);
expect(
  'an unknown phase is the Architect\'s menu, not ours',
  uncoveredPhases(plan(['polish'], [task('t1', 'coder-1')])).length === 0,
);
expect('an empty plan has nothing to complain about', uncoveredPhases({ phases: [], tasks: [] }).length === 0);

// ── the refusal, through handleTurn ─────────────────────────────
const makeRunner = ({ auto = true } = {}) => {
  const woke = [];
  const ran = [];
  const arch = [{ id: 'm0', type: 'user', parts: [] }];
  const engine = {
    async getSession(id) {
      if (id === 'ses_arch') return { id, directory: DIR, internal: false, single: false, auto };
      return { id, directory: DIR, internal: true };
    },
    async getMessages(id) {
      return id === 'ses_arch' ? [...arch] : [];
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
    async nudge() {},
  };
  const warns = [];
  const runner = createRunner({
    engine,
    logger: { channel: () => ({ ...quiet, warn: (m) => warns.push(String(m)) }) },
    getConfig: () => ({
      roles: { 'coder-1': { ref: 'opencode/x' } },
      worker: { ladder: ['coder-1'], stallSec: 5, resumeMax: 0 },
    }),
    guard: null,
    notify: () => {},
    modelCache: null,
  });
  return { runner, woke, ran, warns, arch };
};

/** A run is started without being awaited, so give it a tick to reach the prompt. */
const settle = () => new Promise((r) => setTimeout(r, 300));

// A distinct call id per case: a request is answered once, so reusing one would be
// skipped as already handled rather than run.
const delegate = (taskId, callId = `call_${taskId}`) => [
  { id: 'msg1', type: 'assistant', parts: [{ type: 'tool', id: callId, name: 'synapse-delegate_delegate', input: { task: taskId } }] },
];

try {
  // 1. an unplanned phase: refused, the Architect is told, nothing runs
  writePlan(plan(['invent', 'build', 'hack'], [task('t1', 'inventor')]));
  {
    const { runner, woke, ran } = makeRunner();
    await runner.handleTurn('ses_arch', delegate('t1'));
    const run = fs.existsSync(path.join(DIR, '.synapse', 'runs.jsonl'))
      ? fs.readFileSync(path.join(DIR, '.synapse', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
    expect('the delegation is refused', ran.length === 0, ran.join(','));
    expect('the Architect is woken with what to do', woke.length === 1 && /declares the phases "build", "hack"/.test(woke[0]), woke[0]?.slice(0, 90));
    expect('the refusal is recorded', run.some((r) => r.outcome === 'plan-incomplete'));
  }

  // 2. the same delegation, once the plan is whole: it runs
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
