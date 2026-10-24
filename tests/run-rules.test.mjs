// The rules the first real run changed, asserted.
//
// Three things are driven here, each one a live complaint from Clock Test 2:
//  - the plan's phases: a declared phase with no task under it is named, so a
//    plan cannot grow a task at a time while its own phases say it is finished;
//    "finished" also means every phase is covered, which is what stopped the
//    missing-summary note firing while the Architect was still planning;
//  - result + "todo" is only a fault once the file has stood still: the Architect
//    records the result first and flips the status seconds later, and inside that
//    gap the note fired after every single run (six for six);
//  - the harness guard trusts a shell that names the harness only for sessions
//    Synapse did not mark internal — the Architect's eleven visual-review renders
//    were all alarms, and a worker's would still be one.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readPlan, briefSession, appendAnswers } from '../src/plans.js';
import { contextStats, windowRoom, windowAction, steerDue, nextRung, countedAttempts, promptSize, compactionEvents, compactionMessages, resolveWindow, engineCompactAt, watchdogRoom } from '../src/runs.js';
import { createHarnessGuard } from '../src/harness.js';

const checks = [];
const expect = (label, ok, detail) =>
  checks.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  <- ${detail}` : ''}`);

// ── the plan ────────────────────────────────────────────────────
const ROOT = path.join(os.tmpdir(), `synapse-run-rules-${process.pid}`);
const DIR = path.join(ROOT, 'project');
const PLAN = path.join(DIR, '.synapse', 'plan.json');
const write = (plan, ageMs = 0) => {
  fs.mkdirSync(path.dirname(PLAN), { recursive: true });
  fs.writeFileSync(PLAN, JSON.stringify(plan, null, 2), 'utf8');
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(PLAN, when, when);
  }
  return readPlan(DIR);
};
const has = (state, needle) => state.problems.some((p) => p.includes(needle));
const task = (id, role, status = 'todo', extra = {}) => ({
  id,
  title: `Do ${id}`,
  role,
  status,
  detail: 'Something concrete.',
  reads: [],
  dependsOn: [],
  result: status === 'done' ? 'It is done.' : null,
  ...extra,
});

try {
  let s = write({
    version: 1,
    goal: 'A clock.',
    phases: ['invent', 'build', 'hack'],
    tasks: [task('t1', 'inventor', 'done'), task('t2', 'coder-1')],
  });
  expect('uncovered phase is named', has(s, 'phases lists "hack" but the plan has no task'));
  expect('covered phase is not named', !has(s, 'phases lists "build"'));
  expect('unknown phase is left alone', !has(s, '"design"'));

  s = write({
    version: 1,
    goal: 'A clock.',
    phases: ['invent', 'build', 'hack'],
    tasks: [task('t1', 'inventor', 'done'), task('t2', 'coder-1', 'done'), task('t3', 'qc', 'done')],
  });
  expect('finished and covered asks for the summary', has(s, 'no "summary"'));

  s = write({
    version: 1,
    goal: 'A clock.',
    phases: ['invent', 'build', 'hack'],
    tasks: [task('t1', 'inventor', 'done'), task('t2', 'coder-1', 'done')],
  });
  expect('unfinished plan does not ask for the summary', !has(s, 'no "summary"'));

  const half = { ...task('t2', 'coder-1', 'todo'), result: 'All nine findings fixed.' };
  s = write({ version: 1, goal: 'A clock.', phases: ['build'], tasks: [task('t1', 'inventor', 'done'), half] }, 0);
  expect('result+todo is quiet inside the grace', !has(s, 'has a result but its status'));
  s = write({ version: 1, goal: 'A clock.', phases: ['build'], tasks: [task('t1', 'inventor', 'done'), half] }, 5 * 60 * 1000);
  expect('result+todo stays quiet through a long judging turn', !has(s, 'has a result but its status'));
  s = write({ version: 1, goal: 'A clock.', phases: ['build'], tasks: [task('t1', 'inventor', 'done'), half] }, 15 * 60 * 1000);
  expect('result+todo is named once settled', has(s, 'has a result but its status'));

  const real = readPlan('F:/dev/Synapse.Projects/clock-test-2');
  // This plan was written before the ladder rule, by an Architect that spread the
  // build tasks across all three coders — which is the thing the rule was added
  // for. So the assertion is that every *other* rule stays quiet on a real plan,
  // and that the ladder rule is the only thing it now trips.
  //
  // It lives in the operator's projects folder, which they are free to delete —
  // and did, on 22 Oct. A missing fixture is a skip that says so, never a silent
  // pass: the rules above still cover the behaviour with plans made here.
  if (!real.exists) {
    expect('clock-test-2 is gone, so the real-plan check was skipped', true);
  } else {
    const ladder = real.problems.filter((p) => /is written for coder-/.test(p));
    const other = real.problems.filter((p) => !/is written for coder-/.test(p));
    expect('clock-test-2 trips no rule but the coder ladder', other.length === 0, other.join(' | '));
    expect('and it does trip that one, as the old Architect did', ladder.length === 2, ladder.join(' | '));
  }
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

// ── the brief says what a turn costs ────────────────────────────
{
  const nowhere = path.join(ROOT, 'no-plan-here');
  const coder = briefSession({ dir: nowhere, role: 'coder-2' });
  const designer = briefSession({ dir: nowhere, role: 'designer' });
  const architect = briefSession({ dir: nowhere, role: 'architect' });

  expect('a worker is told what a turn costs', coder.includes('Mind the bill'));
  expect('a worker is told to read a file once', coder.includes('Read each file once'));
  expect('a worker is told to edit rather than rewrite', coder.includes('change it with edits'));
  expect('a worker is still told when to stop', coder.includes('Stop when the deliverable exists'));
  expect('the designer has a spec size', designer.includes('200 lines'));
  expect('the architect caps reads at two files', architect.includes('Two files at most'));
  expect('the architect is told to write provable tasks', architect.includes('the command that proves'));
  expect('the architect is not given the worker bill rules', !architect.includes('Mind the bill'));
  // Judge, don't build: Fever Tracker was built for seven hours by its Architect
  // after one delegation was silently refused. The rule has to be in the brief it
  // re-reads every step, and the two escape hatches have to be named, or a stuck
  // Architect invents a third one.
  expect('the architect is told to judge, not build', architect.includes('You judge; you do not build'));
  expect('a refused delegation has two ways out, not self-service', architect.includes('never do that') && architect.includes('Record the task as blocked'));
  expect('the architect is told its own turns are the dearest', architect.includes('the dearest in the harness'));
  // Routing is the failure that survives a menu: a plan whose every task is on a
  // coder delivers the files and skips the craft. The brief has to name the
  // crafts and say a coder builds a decision rather than making one.
  expect('the architect is told who does what', architect.includes('Who does what') && architect.includes('qc judges the finished thing'));
  expect('and that a coder does not decide the look', architect.includes('a coder builds a decision, never makes one'));
  // QC has two focuses and the harness picks which one by config, so the table may
  // not describe QC as a person's-use reviewer: that would be the wrong hunt in
  // Security mode, written into the plan before QC is ever asked.
  expect('the qc line leaves the focus to its own brief', architect.includes('what it hunts for is set by the brief'));
  expect('a worker is not told who does what', !coder.includes('Who does what'));
  expect('a worker is not told to judge anything', !coder.includes('You judge; you do not build'));
  // The brief is sent to every project this harness will ever run, so it may not
  // describe the arrangement of the day: a worker's session, the model a role was
  // given, whether a run is cheap or independent. Those belong to the config.
  for (const [label, pattern] of [
    ['a fresh session', /fresh session/i],
    ['the model a role was given', /model its role/i],
    ['a warm cache', /no cache/i],
    ['a second opinion', /second opinion/i],
    ['a named model or project', /fever|tracker|bionic|qwen|deepseek|opencode-go/i],
  ]) {
    expect(`the brief does not assume ${label}`, !pattern.test(architect), 'brief mentions it');
  }
}

// ── the operator's answers live on disk, not only in the transcript ──
{
  const dir = path.join(ROOT, 'with-answers');
  fs.mkdirSync(dir, { recursive: true });
  const fields = [
    { key: 'ot', title: 'Overtime flag style' },
    { key: 'bad', title: 'Invalid input style' },
  ];
  appendAnswers(dir, {
    at: Date.parse('2026-10-21T19:51:00'),
    signature: 'Overtime flag style | Invalid input style',
    fields,
    answer: { ot: 'Allow amber for warnings', bad: 'Ink + glyph, no hue' },
  });
  const file = path.join(dir, '.synapse', 'decisions.md');
  const first = fs.readFileSync(file, 'utf8');
  expect('the answer is written as a line a model can read', /\*\*Overtime flag style\*\* -> Allow amber/.test(first), first.slice(-80));
  expect('the file says an answered question is settled', /settled/.test(first));
  appendAnswers(dir, { fields: [fields[0]], answer: { ot: 'Green + text only' } });
  const both = fs.readFileSync(file, 'utf8');
  expect('answers append, they never overwrite', both.includes('Allow amber') && both.includes('Green + text only'));
  appendAnswers(dir, { fields: [fields[0]], answer: { ot: '' } });
  expect('a blank answer is recorded as blank', fs.readFileSync(file, 'utf8').includes('(left blank)'));

  const brief = briefSession({ dir, role: 'designer' });
  expect('the brief points at the answers file', brief.includes('.synapse/decisions.md'));
  expect('the brief says not to re-ask', /never ask a question it already answers/.test(brief));
  const before = briefSession({ dir: path.join(ROOT, 'still-none'), role: 'designer' });
  expect('no answers file, no line about one', !before.includes('decisions.md'));
}

// ── the coder ladder moves only when a coder failed ──────────────
{
  const same = JSON.stringify(['coder-1', 'coder-2', 'coder-3']);
  expect('first attempt starts on coder-1', JSON.stringify(nextRung('coder-1', 1)) === same);
  // The case that cost 136k prompt tokens in Shift Test 6: a *completed* task,
  // sent back with a one-character change, moved to a fresh coder-2 session.
  expect(
    'a completed task re-delegated stays on the same coder',
    JSON.stringify(nextRung('coder-1', 2, { stepDown: false })) === same,
  );
  expect(
    'a failed attempt steps one rung down',
    JSON.stringify(nextRung('coder-1', 2, { stepDown: true })) === JSON.stringify(['coder-2', 'coder-3']),
  );
  expect(
    'two failures reach coder-3',
    JSON.stringify(nextRung('coder-1', 3, { stepDown: true })) === JSON.stringify(['coder-3']),
  );
  expect(
    'the ladder floors at its last rung',
    JSON.stringify(nextRung('coder-1', 9, { stepDown: true })) === JSON.stringify(['coder-3']),
  );
  expect('a role off the ladder is tried alone', JSON.stringify(nextRung('designer', 2, { stepDown: true })) === '["designer"]');
  expect(
    'a task written for coder-2 starts there',
    JSON.stringify(nextRung('coder-2', 1)) === JSON.stringify(['coder-2', 'coder-3']),
  );
}

// ── what a run cost ─────────────────────────────────────────────
{
  const msg = (input, cache, output, reasoning) => ({
    type: 'assistant',
    raw: { tokens: { input, output, reasoning, cache: { read: cache, write: 0 } } },
  });
  const stats = contextStats([
    msg(4000, 60000, 300, 1000),
    msg(2000, 140000, 500, 2000),
    { type: 'compaction' },
    msg(500, 3000, 100, 0),
    { type: 'user', raw: {} },
  ]);
  expect('peak is input + cache.read of the biggest turn', stats.peak === 142000, String(stats.peak));
  expect('turns count assistant messages only', stats.turns === 3, String(stats.turns));
  // 64k + 142k + 3.5k: everything the provider was asked to read.
  expect('prompt tokens are the sum of every prompt', stats.prompt === 209500, String(stats.prompt));
  // 1300 + 2500 + 100 written, of which 3000 was thinking.
  expect('generated is output + reasoning', stats.generated === 3900, String(stats.generated));
  expect('thinking share is reported', stats.thinkShare === 77, String(stats.thinkShare));
  expect('a compaction is counted', stats.compactions === 1);
  expect('no messages is not a crash', contextStats([]).turns === 0 && contextStats(null).peak === 0);
}

// ── the window watchdog ─────────────────────────────────────────
{
  // The three windows this machine actually has: a 1M hosted model, a 200k free
  // one, and the 62k local LLM the operator will plug in later.
  const big = windowRoom({ context: 1048576, output: 32000 });
  const free = windowRoom({ context: 200000, output: 32000 });
  const local = windowRoom({ context: 62000, output: 8000 });
  // 1,048,576 - 32,000 output - 52,429 (5%) slack.
  expect('a 1M model keeps room for output and slack', big === 964147, String(big));
  expect('a 200k model lands near 158k', free === 158000, String(free));
  // 62,000 - 8,000 output - 6,000 slack floor (5% of 62k would be 3,100).
  expect('a 62k local model lands near 48k', local === 48000, String(local));
  expect('an unknown window has no ceiling', windowRoom({}) === 0 && windowRoom({ context: 0 }) === 0);

  // The state machine: ask once at the boundary, then stay quiet until the
  // transcript actually shrinks.
  const s = { armed: true, times: 0, off: false };
  expect('nothing happens well below the room', windowAction(s, 100000, big) === 'none');
  expect('it fires at the room', windowAction(s, big, big) === 'compact');
  s.armed = false;
  expect('a second poll does not fire again', windowAction(s, big + 1000, big) === 'none');
  expect('still quiet while above 70%', windowAction(s, Math.round(big * 0.8), big) === 'none');
  expect('it re-arms once the transcript shrinks', windowAction(s, Math.round(big * 0.6), big) === 'arm');
  expect('an engine without compaction stays off', windowAction({ armed: true, off: true }, big, big) === 'none');
  expect('no window, no action', windowAction(s, 999999, 0) === 'none');
  expect('no context yet, no action', windowAction(s, 0, big) === 'none');
}

// ── the "are you done" steer ────────────────────────────────────
{
  expect('no steer before 40 turns', steerDue(39, 0) === null);
  expect('the first steer lands at 40', steerDue(40, 0) === 40);
  expect('and never repeats', steerDue(41, 1) === null && steerDue(80, 1) === null);
  expect('the second lands at 90', steerDue(90, 1) === 90);
  expect('and then it is quiet for good', steerDue(400, 2) === null);
  expect('a session that starts past 40 still gets one', steerDue(52, 0) === 40);
}

// ── the attempt budget ──────────────────────────────────────────
// Fever Tracker: t1 was run three times, two of them stopped by the operator.
// Counting the stops spent the whole budget, and the Architect was then refused
// the retry it needed — so the cap is spent by real attempts, not by cancels.
{
  const at = (n) => ({ kind: 'delegate', callId: `c${n}`, task: 't1', attempt: n });
  const res = (n, outcome) => ({ kind: 'result', callId: `c${n}`, task: 't1', outcome });
  expect(
    'three runs, two of them operator stops, spend one attempt',
    countedAttempts([at(1), res(1, 'stopped'), at(2), res(2, 'stopped'), at(3), res(3, 'completed')], 't1') === 1,
  );
  expect(
    'a delivered run is still an attempt',
    countedAttempts([at(1), res(1, 'completed')], 't1') === 1,
  );
  expect(
    'a harness stop counts: the harness spent it',
    countedAttempts([at(1), res(1, 'failed')], 't1') === 1,
  );
  expect(
    'a refusal without an attempt number is not one',
    countedAttempts([{ kind: 'delegate', callId: 'r1', task: 't1', outcome: 'too-many-attempts' }], 't1') === 0,
  );
  expect('another task does not count', countedAttempts([at(1), res(1, 'completed')], 't2') === 0);
}

// ── the context numbers ─────────────────────────────────────────
// What the card shows beside the rate, and the size that preceded a compaction.
{
  const msg = (input, read) => ({ type: 'assistant', raw: { tokens: { input, cache: { read } } } });
  expect('prompt size is input plus cache read', promptSize([msg(12000, 15000)]) === 27000);
  expect('the last turn wins, not the first', promptSize([msg(1000, 0), msg(9000, 18000)]) === 27000);
  expect('no tokens, no number', promptSize([{ type: 'user' }]) === 0);
  const events = compactionEvents([msg(9000, 23000), { type: 'compaction' }, msg(4000, 9000), { type: 'compaction' }]);
  expect('two compactions, each with the prompt that caused it', events.length === 2 && events[0].used === 32000);
  expect('a transcript with none reports none', compactionEvents([msg(100, 100)]).length === 0);
  // The engine records the prompt it sent to write its summary. That is the size
  // the decision was made on — a step earlier is one tool result short, and this
  // reported 38k for a compaction that fired at 44k.
  const own = compactionEvents([msg(9000, 29000), { type: 'compaction', raw: { tokens: { input: 48243, output: 2552 } } }]);
  expect('the size is what the compaction itself sent', own[0].used === 48243, String(own[0]?.used));
  // A compaction with no usage of its own falls back to the prompt before it —
  // never to zero, which would read as "compacted at 0".
  const bare = compactionEvents([msg(9000, 29000), { type: 'compaction' }]);
  expect('no usage on the compaction means the prompt before it', bare[0].used === 38000, String(bare[0].used));
  // The engine writes the message when a compaction *starts*, so counting it at
  // that moment made the chat's "this is number N" one too high while the operator
  // was watching it happen. Only finished ones count; a running one is still a
  // running one for the watchdog, which needs to know it began.
  const running = [
    { type: 'assistant', raw: { tokens: { input: 40000 } } },
    { type: 'compaction', raw: { status: 'completed', tokens: { input: 46000 } } },
    { type: 'compaction', raw: { status: 'running' } },
  ];
  expect('a compaction in flight is not yet counted', compactionEvents(running).length === 1, String(compactionEvents(running).length));
  expect('the finished one keeps its own size', compactionEvents(running)[0].used === 46000);
  expect('the watchdog still sees both', compactionMessages(running).length === 2, String(compactionMessages(running).length));
}

// ── the two compaction guards must not race ──────────────────
// The engine fires at `context − max(15%, 16k)`; ours has to sit above that, or the
// two fire a second apart and the second request compacts the transcript the first
// just wrote — which is what produced "Compacted ×2 · context at 11K" on 23 Oct.
{
  const engineAt = engineCompactAt({ context: 60160 });
  expect('the engine compacts 60,160 at 44,160', engineAt === 44160, String(engineAt));
  expect('a million-token window has no 16k floor', engineCompactAt({ context: 1048576 }) === 891290, String(engineCompactAt({ context: 1048576 })));
  expect('an unknown window has no trigger', engineCompactAt({}) === 0);

  const ours = watchdogRoom({ context: 60160, output: 8192 });
  expect('our backstop sits above the engine, not beside it', ours > engineAt, `${ours} vs ${engineAt}`);
  expect(
    'and leaves the engine room to act first',
    ours - engineAt >= 2000 && ours - engineAt <= 60160 * 0.1,
    `${ours - engineAt} tokens of separation`,
  );
  expect('it is never earlier than the plain room', watchdogRoom({ context: 60160, output: 8192 }) >= windowRoom({ context: 60160, output: 8192 }));
  expect('a small window still gets a sane ceiling', watchdogRoom({ context: 8192, output: 2048 }) > 0);
}

// ── which number wins ────────────────────────────────────────
// Four claims about one window, and the order is the rule. The override is there
// because a catalog can be wrong on the low side: DeepSeek V4.1 Flash Free serves
// 1,048,576 when asked via the engine's per-model `limit`, and was tested by hand.
// A provider refusing a prompt one afternoon must not quietly cancel that test.
{
  expect(
    'a hand-tested override beats the catalog',
    resolveWindow({ override: 1048576, catalog: 200000 }) === 1048576,
  );
  expect(
    'a refusal does not undo the override',
    resolveWindow({ override: 1048576, refused: 200000, catalog: 200000 }) === 1048576,
  );
  expect(
    'what the local runtime loaded beats a stale override, both ways',
    resolveWindow({ loaded: 60160, override: 42240 }) === 60160,
  );
  expect(
    'a refusal corrects a catalog that is too big',
    resolveWindow({ refused: 128000, catalog: 200000 }) === 128000,
  );
  expect(
    'a refusal bigger than the catalog changes nothing',
    resolveWindow({ refused: 400000, catalog: 200000 }) === 200000,
  );
  expect('nothing said, nothing known', resolveWindow({}) === 0);
}

// ── the harness guard ───────────────────────────────────────────
{
  const seen = [];
  const guard = createHarnessGuard({
    root: 'F:\\dev\\Synapse',
    logger: { channel: () => ({ info: (m) => seen.push('info: ' + m), error: (m) => seen.push('error: ' + m), warn: (m) => seen.push('warn: ' + m) }) },
    notify: (n) => seen.push('alarm: ' + n.what),
  });
  const turn = (cmd) => [{ parts: [{ type: 'tool', name: 'shell', input: { command: cmd } }] }];
  const alarmCount = (msgs, sessionId = 'arch') => {
    seen.length = 0;
    guard.checkTurn({ sessionId, messages: msgs, label: 'turn' });
    return seen.filter((s) => s.startsWith('alarm:')).length;
  };

  const render = 'node "F:/dev/Synapse/skills/visual-review/bin/shot.mjs" "F:/Synapse.Projects/x/bin/index.html" --out "F:/Synapse.Projects/x/shot.png"';
  expect('running a skill is not an alarm', alarmCount(turn(render)) === 0);
  expect('running a skill is not an alarm for a worker either', alarmCount(turn(render), 'worker') === 0);
  expect(
    'a piped render with a 2>&1 is still tool use',
    alarmCount(turn('Get-ChildItem F:\\dev\\Synapse\\skills\\visual-review -Recurse | node "F:/dev/Synapse/skills/visual-review/bin/shot.mjs" "F:/x.html" 2>&1 | Out-String')) === 0,
  );
  // The real Clock Test 3 command: clear the project's own shots, then render.
  // One line, it names a skill, and it writes only inside the project.
  expect(
    'a render that also clears project scratch is tool use',
    alarmCount(
      turn(
        '$dir = "F:\\dev\\Synapse.Projects\\x\\.synapse\\design\\shots"; Remove-Item $dir -Recurse -Force; ' +
          'node "F:/dev/Synapse/skills/visual-review/bin/shot.mjs" "file:///F:/x/mock-a.html?state=day" --out "F:/x/shots/a.png" 2>&1 | Out-String',
      ),
    ) === 0,
  );
  expect(
    'redirecting a skill run into the project is tool use',
    alarmCount(turn('node F:/dev/Synapse/skills/visual-review/bin/shot.mjs F:/x.html > out.txt')) === 0,
  );
  expect(
    'redirecting into the harness is an alarm whatever it names',
    alarmCount(turn('node F:/dev/Synapse/skills/visual-review/bin/shot.mjs F:/x.html > F:/dev/Synapse/skills/leak.txt')) === 1,
  );
  expect(
    'a command naming the rest of the harness is an alarm',
    alarmCount(turn('node F:/dev/Synapse/src/index.js')) === 1,
  );
  // Timer Test 1: a worker could not find the renderer its skill named, so it
  // listed the harness to look for it. A read cannot write, and every model that
  // loses a tool does this first — a popup for it is noise where the alarm has to
  // stay loud.
  seen.length = 0;
  guard.checkTurn({
    sessionId: 'arch',
    label: 'turn',
    messages: turn(
      'Get-ChildItem -Recurse F:\\dev\\Synapse.Projects\\x\\.synapse -Filter shot.mjs | Select-Object FullName; ' +
        'Get-ChildItem F:\\dev\\Synapse\\skills -Recurse -Filter shot.mjs',
    ),
  });
  expect('looking for a tool in the harness is not an alarm', seen.filter((s) => s.startsWith('alarm:')).length === 0);
  expect('but it is written down', seen.some((s) => s.startsWith('info: read the harness')));
  expect(
    'a read that is told to remove something is still an alarm',
    alarmCount(turn('Get-ChildItem F:/dev/Synapse/src | Remove-Item -Recurse')) === 1,
  );
  expect(
    'a write tool on a harness file is an alarm',
    alarmCount([{ parts: [{ type: 'tool', name: 'write', input: { filePath: 'F:\\dev\\Synapse\\src\\index.js' } }] }]) === 1,
  );
  expect(
    'naming the projects root is not naming the harness',
    alarmCount(turn('node F:/dev/Synapse.Projects/x/bin/app.js')) === 0,
  );
  // 23 Oct, every delegation: the Architect starts each command with `cd <project>`
  // and then reads Synapse's own log to diagnose its run. The whole-string check
  // needed a read verb at character one, so the `cd` made it a popup — on a benign
  // read, every single time, which is exactly what trains an operator to ignore it.
  const diagnose =
    'cd F:\\dev\\Synapse.Projects\\fever-tracker; Get-Content F:\\dev\\Synapse\\logs\\app.log -Tail 5';
  seen.length = 0;
  guard.checkTurn({ sessionId: 'arch', label: 'turn', messages: turn(diagnose) });
  expect('cd then reading the harness log is not an alarm', seen.filter((s) => s.startsWith('alarm:')).length === 0);
  expect('and it is written down', seen.some((s) => s.startsWith('info: read the harness')));
  expect(
    'cd then deleting a harness file still is',
    alarmCount(turn('cd F:\\dev\\Synapse; Remove-Item logs\\app.log -Force')) === 1,
  );
  expect(
    'a read followed by a write is judged on the write',
    alarmCount(turn('Get-Content F:\\dev\\Synapse\\logs\\app.log; Set-Content F:\\dev\\Synapse\\logs\\app.log ""')) === 1,
  );
  expect(
    'a semicolon inside a quoted path is not a second command',
    alarmCount(turn('Get-Content "F:\\dev\\Synapse\\logs\\a;b.log" -Tail 3')) === 0,
  );
  expect(
    'a variable holding a read is still a read',
    alarmCount(turn('$a = Get-Content F:\\dev\\Synapse\\logs\\app.log; $a | Select-String error')) === 0,
  );
}

console.log(checks.join('\n'));
const failed = checks.filter((c) => c.startsWith('FAIL')).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
