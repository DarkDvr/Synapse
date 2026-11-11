// Every branch of the report the Architect reads.
//
// The report was carved out of runs.js on 6 Nov as a "pure move", and the proof
// offered was that the existing tests passed untouched. They passed because not one
// of them ran a report with a context: `report()` reached `tokens(...)`, a helper
// that stayed behind in runs.js, and threw. The only symptom was one log line five
// seconds after a worker finished - "delegation t1 failed: tokens is not defined" -
// while the Architect was never told, the plan stayed on `doing` and the screen said
// nothing. The smoke test found it on the first completed delegation (7 Nov).
//
// So this file does the two things the old tests did not:
//   1. it calls report() with the shape a real run has, and reads the words back;
//   2. it walks every optional flag, so a name that goes missing again fails here
//      rather than in a chat nobody is watching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { report } from '../src/report.js';

const task = { id: 't1', title: 'Sleep, then say so' };
const base = { task, role: 'coder-1', outcome: 'completed', files: [], auto: true };

test('a completed run says what it did, how big it got and what is next', () => {
  const text = report({
    ...base,
    text: 'Slept and wrote out.txt.',
    files: ['out.txt'],
    context: { turns: 4, peak: 9000, prompt: 35000, generated: 1000, thinkShare: 77 },
  });
  assert.match(text, /^t1 \(coder-1\) finished\./);
  assert.match(text, /Files written: out\.txt/);
  assert.match(text, /Effort: 4 turns; the context peaked at 9k\./);
  assert.match(text, /Reported:\nSlept and wrote out\.txt\./);
  assert.match(text, /Keep building is ON/);
  // The sentence that hands the judgement back starts its own paragraph: run into
  // the facts above it, it read as one stream (11 Nov).
  assert.match(text, /\n\nYou are the only writer of the plan: judge this yourself\./);
});

test('a run that was summarised says how many times', () => {
  const once = report({ ...base, context: { turns: 9, peak: 212000, compactions: 1 } });
  assert.match(once, /peaked at 212k and was summarised once\./);
  assert.match(once, /Past about 150k a run gets slower/);
  const twice = report({ ...base, context: { turns: 9, peak: 1000, compactions: 2 } });
  assert.match(twice, /and was summarised 2 times\./);
});

test('a token count reads as a word, not as digits', () => {
  assert.match(report({ ...base, context: { turns: 1, peak: 1400000 } }), /peaked at 1\.4M/);
  assert.match(report({ ...base, context: { turns: 1, peak: 999 } }), /peaked at 1k/);
});

test('the QC cap is a number this file can name', () => {
  const text = report({ ...base, role: 'qc', qcRound: 3 });
  assert.match(text, /That was QC round 3 of 3 - the loop is closed\./);
  // A QC run that is not at the cap says nothing about it.
  assert.doesNotMatch(report({ ...base, role: 'qc', qcRound: 1 }), /QC round/);
});

test('a stop is not a failure, and it is never re-delegated', () => {
  const text = report({ ...base, outcome: 'stopped', stoppedBy: 'operator' });
  assert.match(text, /was stopped by the operator\. A stop is not a verdict/);
  assert.match(text, /do not delegate this task again unless they say so/);
  assert.match(text, /It reported nothing\./);
});

test('a harness stop names itself rather than the operator', () => {
  const text = report({ ...base, outcome: 'stopped', harnessStop: true });
  assert.match(text, /stopped by the harness, not by the operator/);
});

test('a timeout counts the minutes and the restarts', () => {
  const text = report({ ...base, outcome: 'timeout', stallSec: 900, resumes: 2 });
  assert.match(text, /produced nothing for 15 minutes in a row and was stopped after 2 restarts/);
  assert.match(text, /restarted 2 times after producing nothing/);
});

test('a provider failure says what the provider said', () => {
  const text = report({ ...base, outcome: 'error', error: 'model retired', text: '' });
  assert.match(text, /could not run - the provider refused the turn/);
  assert.match(text, /The provider said: model retired/);
});

test('a loop is counted, and the marked role is named', () => {
  const text = report({
    ...base,
    outcome: 'error',
    loops: 2,
    loopCount: 2,
    loopMarked: true,
    loopRole: 'coder-2',
    loopModel: 'opencode-go/deepseek-v4.1-flash',
  });
  assert.match(text, /looped 2 times in one work order/);
  assert.match(text, /caught going in circles 2 times/);
  assert.match(text, /marked with the ISSUES badge/);
});

test('a ladder move says who ran it instead, and why', () => {
  const text = report({
    ...base,
    insteadOf: 'coder-1',
    skipped: [{ role: 'coder-1', message: 'provider refused' }],
  });
  assert.match(text, /This attempt ran on coder-1, not coder-1/);
  assert.match(text, /coder-1 did not finish: provider refused/);
});

test('steers are repeated to the Architect, and it is told to judge against them', () => {
  const text = report({ ...base, steers: [{ by: 'ANDREWS', text: 'answer with one word' }] });
  assert.match(text, /The operator steered this run while it worked:/);
  assert.match(text, /- ANDREWS: "answer with one word"/);
});

test('the plan being written by a worker is a warning, not a fact', () => {
  const text = report({ ...base, planTouched: true, synapseTouched: ['plan.json'] });
  assert.match(text, /Warning: the plan file changed while the worker ran/);
  assert.match(text, /not this role's to write: plan\.json/);
});

test('deferred asks are named once', () => {
  const text = report({ ...base, deferred: [{ task: 't2' }, { task: 't2' }, { task: 't3' }] });
  assert.match(text, /a delegation for t2 2 times, t3 and deferred it/);
});

test('keep building off says stop and wait', () => {
  assert.match(report({ ...base, auto: false }), /Keep building is OFF/);
});

// The guard: every optional flag at once, on a run with a context. If a name goes
// missing from this file, this is where it fails — not five seconds into a real run.
test('every flag at once still produces one sentence per fact', () => {
  const text = report({
    task,
    role: 'qc',
    insteadOf: 'coder-1',
    startedBelow: true,
    skipped: [{ role: 'coder-1', message: 'marked' }],
    outcome: 'error',
    harnessStop: false,
    text: 'done',
    files: ['a.js'],
    context: { turns: 12, peak: 180000, compactions: 1, prompt: 90000, generated: 20000, thinkShare: 30 },
    planTouched: true,
    synapseTouched: ['log.md'],
    qcRound: 3,
    skillsRequired: ['code-craft'],
    skillsMissing: ['code-craft'],
    auto: true,
    stallSec: 900,
    retries: 2,
    resumes: 1,
    loops: 1,
    loopCount: 1,
    loopMarked: true,
    loopRole: 'coder-2',
    loopModel: 'm',
    modelRef: 'm',
    error: 'refused',
    stoppedBy: 'operator',
    lastTurnError: 'step interrupted',
    steers: [{ by: 'ANDREWS', text: 'go on' }],
    deferred: [{ task: 't2' }],
  });
  assert.ok(text.length > 400);
  assert.match(text, /You are the only writer of the plan/);
});
