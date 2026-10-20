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
import { readPlan } from '../src/plans.js';
import { contextStats, windowRoom, windowAction } from '../src/runs.js';
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
    tasks: [task('t1', 'inventor', 'done'), task('t2', 'coder-1', 'done'), task('t3', 'hacker', 'done')],
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
  expect('result+todo is named once settled', has(s, 'has a result but its status'));

  const real = readPlan('F:/dev/Synapse.Projects/clock-test-2');
  expect('clock-test-2 has no problems under the new rules', real.problems.length === 0, real.problems.join(' | '));
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
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
  expect('a 62k local model lands near 46k', local === 46000, String(local));
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
  expect(
    'writing into skills is an alarm',
    alarmCount(turn('Set-Content F:/dev/Synapse/skills/visual-review/bin/shot.mjs -Value "x"')) === 1,
  );
  expect(
    'redirecting a skill run into a file is an alarm',
    alarmCount(turn('node F:/dev/Synapse/skills/visual-review/bin/shot.mjs F:/x.html > out.txt')) === 1,
  );
  expect(
    'a command naming the rest of the harness is an alarm',
    alarmCount(turn('node F:/dev/Synapse/src/index.js')) === 1,
  );
  expect(
    'a write tool on a harness file is an alarm',
    alarmCount([{ parts: [{ type: 'tool', name: 'write', input: { filePath: 'F:\\dev\\Synapse\\src\\index.js' } }] }]) === 1,
  );
  expect(
    'naming the projects root is not naming the harness',
    alarmCount(turn('node F:/dev/Synapse.Projects/x/bin/app.js')) === 0,
  );
}

console.log(checks.join('\n'));
const failed = checks.filter((c) => c.startsWith('FAIL')).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
