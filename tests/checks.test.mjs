// The acceptance checks a plan row can carry.
//
// The parser is small and the runner is the point: a task's own command must be
// judged by the same policy as a shell call, run in the project, and a failure
// must reach the worker once rather than the Architect's report doing the work of
// a verifier.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseChecks, runCheck, runTaskChecks, checkDecision, checkInfrastructureFailure, splitCommand, hasShellSyntax, CHECK_MAX } from '../src/checks.js';
import { createRunner } from '../src/runs.js';
import { tmpdir } from './tmpdir.mjs';

const ROOT = tmpdir('synapse-checks-test-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

test('parseChecks keeps one to three short commands, in order, without repeats', () => {
  assert.deepEqual(parseChecks(['  node a.js ', 'node a.js', 'node b.js', 7, '', 'node c.js', 'node d.js']), [
    'node a.js',
    'node b.js',
    'node c.js',
  ]);
  assert.equal(parseChecks('node a.js').length, 0);
  assert.equal(parseChecks(['x'.repeat(301)]).length, 0);
  assert.equal(parseChecks(['a', 'b', 'c', 'd']).length, CHECK_MAX);
});

test('a check is allowed inside the project and refused through the fence', () => {
  const dir = path.join(ROOT, 'decision');
  fs.mkdirSync(dir, { recursive: true });
  const config = { protection: { paths: [] } };
  assert.equal(checkDecision('node bin/test.js', { dir, config }).effect, 'allow');
  const outside = checkDecision('Remove-Item -Recurse C:\\Windows\\System32\\x', { dir, config });
  assert.notEqual(outside.effect, 'allow', 'a protected path is not a check');
  const other = checkDecision(`node ${path.join(ROOT, 'other-project', 'x.js')}`, { dir, config });
  assert.notEqual(other.effect, 'allow', 'another project is not the project');
});

test('a check whose own command is missing is invalid, not the worker’s code', async () => {
  assert.match(
    checkInfrastructureFailure({
      ok: false,
      output: "Get-FileHash : The term 'Get-FileHash' is not recognized as the name of a cmdlet, function, script file, or operable program.",
    }),
    /not available to the harness/,
  );
  assert.match(
    checkInfrastructureFailure({
      ok: false,
      output: "'definitely-not-a-command' is not recognized as an internal or external command,",
    }),
    /not available to the harness/,
  );
  assert.match(checkInfrastructureFailure({ ok: false, code: 127, output: '' }), /could not find a command/);
  assert.equal(
    checkInfrastructureFailure({ ok: false, code: 2, output: 'AssertionError: expected 2, got 3' }),
    '',
    'a real failing assertion is still the worker’s check',
  );
  const dir = path.join(ROOT, 'invalid');
  fs.mkdirSync(dir, { recursive: true });
  const result = await runTaskChecks(['definitely-not-a-command-synapse-test'], { dir, config: {}, taskId: 't1' });
  assert.ok(result.invalid, 'the runner marks a missing command invalid');
  assert.equal(result.failed?.invalid, result.invalid);
  assert.match(result.failed?.output || '', /not recognized|command not found/i);
});

test('a check that exits 0 passes and one that exits 3 fails with its output', async () => {
  const dir = path.join(ROOT, 'run');
  fs.mkdirSync(dir, { recursive: true });
  const ok = await runCheck('node -e "process.exit(0)"', { cwd: dir });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 0);
  const bad = await runCheck('node -e "console.log(\'broken output\'); process.exit(3)"', { cwd: dir });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
  assert.match(bad.output, /broken output/);
});

test('a check that never returns is stopped at the timeout, not left running', async () => {
  const dir = path.join(ROOT, 'timeout');
  fs.mkdirSync(dir, { recursive: true });
  const result = await runCheck('node -e "setTimeout(() => {}, 10000)"', { cwd: dir, timeoutMs: 400 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
});

// 28 Nov: the harness ran t2's check through cmd.exe, which split `'#result|^0$'`
// at the pipe and executed the tail as a program — the check the worker had just run
// successfully. A command without shell syntax is now spawned as the program and the
// arguments it names, so quoting is ours.
test('a command line is split on quotes, and keeps a path’s backslashes', () => {
  assert.deepEqual(splitCommand("node shot.mjs --expect '#result|^0$' --audit"), [
    'node',
    'shot.mjs',
    '--expect',
    '#result|^0$',
    '--audit',
  ]);
  assert.deepEqual(splitCommand('node -e "console.log(1)"'), ['node', '-e', 'console.log(1)']);
  assert.deepEqual(splitCommand(`node -e 'console.log("x")'`), ['node', '-e', 'console.log("x")']);
  assert.deepEqual(splitCommand('node C:\\dev\\x.js'), ['node', 'C:\\dev\\x.js'], 'a backslash is not an escape');
  assert.deepEqual(splitCommand('node -e "say \\"hi\\""'), ['node', '-e', 'say "hi"']);
  assert.deepEqual(splitCommand('node ""'), ['node', ''], 'an empty argument survives');
  assert.equal(splitCommand("node 'unclosed"), null, 'an unclosed quote is not guessed at');
});

test('only a real shell operator keeps cmd.exe in charge', () => {
  assert.equal(hasShellSyntax("node --expect '#a|b'"), false, 'a pipe inside quotes is an argument');
  assert.equal(hasShellSyntax('node a.mjs && node b.mjs'), true);
  assert.equal(hasShellSyntax('node a.mjs > out.txt'), true);
  assert.equal(hasShellSyntax('node a.mjs | more'), true);
  assert.equal(hasShellSyntax('echo %TEMP%'), true, 'a variable is the shell’s');
});

test('a pipe or a semicolon inside a quoted check argument reaches the program', async () => {
  const dir = path.join(ROOT, 'quoted');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'echo-args.mjs');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const result = await runCheck(`node "${script}" '#result|^0$' 'a;b'`, { cwd: dir });
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(JSON.parse(result.output.trim()), ['#result|^0$', 'a;b']);
});

test('a .cmd the project made is still run, through the shell, because only a shell can start it', async () => {
  const dir = path.join(ROOT, 'cmd-fallback');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hello.cmd'), '@echo off\r\necho hello-from-cmd\r\n');
  const result = await runCheck('hello.cmd', { cwd: dir });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /hello-from-cmd/);
});

test('a command line the shell split is named as that, not as a missing program', () => {
  const split = checkInfrastructureFailure({
    ok: false,
    code: 255,
    output: "'0$'' is not recognized as an internal or external command,",
  });
  assert.match(split, /split the command line/);
  assert.doesNotMatch(split, /not available to the harness/);
  assert.match(
    checkInfrastructureFailure({ ok: false, code: 255, output: "'definitely-not-a-command' is not recognized as an internal or external command," }),
    /not available to the harness/,
    'a name that could be a program is still a missing program',
  );
});

test('runTaskChecks stops at the first failure and keeps the log inside the project', async () => {
  const dir = path.join(ROOT, 'sequence');
  fs.mkdirSync(dir, { recursive: true });
  const result = await runTaskChecks(['node -e "process.exit(2)"', 'node -e "process.exit(0)"'], {
    dir,
    config: {},
    taskId: 't1',
  });
  assert.equal(result.failed?.code, 2);
  assert.equal(result.ran, 1, 'the second check is not run after a failure');
  assert.ok(result.logPath?.startsWith('.project/reports/checks/'));
  assert.ok(fs.existsSync(path.join(dir, ...result.logPath.split('/'))));
});

// ── through the delegation runner ────────────────────────────────────

function project(name, checks, script = {}) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.project'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'check.js'), script.check || 'process.exit(0);\n');
  fs.writeFileSync(
    path.join(dir, '.project', 'plan.json'),
    JSON.stringify({
      version: 1,
      goal: 'test',
      summary: '',
      tasks: [
        {
          id: 't1',
          title: 'Do the thing',
          role: 'coder-1',
          status: 'todo',
          detail: 'd',
          checks,
          dependsOn: [],
          result: null,
          note: null,
        },
      ],
    }),
  );
  return dir;
}

/** A stub engine with one scripted turn per worker session (see ladder.test). */
function makeEngine({ dir, script }) {
  const sessions = new Map();
  const arch = [];
  let seq = 0;
  const startTurn = (id) => {
    const s = sessions.get(id);
    const step = s.script.length > 1 ? s.script.shift() : s.script[0];
    if (!step) return;
    const n = (s.turn = (s.turn || 0) + 1);
    setTimeout(() => {
      if (!sessions.has(id)) return;
      s.messages.push({
        id: `${id}-a${n}`,
        type: 'assistant',
        parts: [{ type: 'text', text: 'done' }],
        completed: Date.now(),
      });
      s.messages.push({ id: `${id}-i${n}`, type: 'idle', parts: [] });
    }, step.delay ?? 10);
  };
  const engine = {
    async getSession(id) {
      if (id === 'ses_arch') return { id, directory: dir, internal: false, single: false, auto: false };
      return { id, directory: dir, internal: true };
    },
    async createSession({ metadata }) {
      const id = `ses_w${(seq += 1)}`;
      sessions.set(id, { role: metadata?.synapse?.role || null, messages: [], script: [...script] });
      return { id };
    },
    async setInstruction() {},
    async prompt(id) {
      const s = sessions.get(id);
      s.messages.push({ id: `${id}-u`, type: 'user', parts: [{ type: 'text', text: 'go' }] });
      startTurn(id);
    },
    async synthetic(id, text) {
      if (id === 'ses_arch') {
        arch.push({ id: `a-s${arch.length}`, type: 'synthetic', parts: [{ type: 'text', text }] });
        setTimeout(() => {
          arch.push({ id: `a-r${arch.length}`, type: 'assistant', parts: [{ type: 'text', text: 'noted' }] });
          arch.push({ id: `a-i${arch.length}`, type: 'idle', parts: [] });
        }, 10);
        return;
      }
      const s = sessions.get(id);
      s.messages.push({ id: `${id}-s${s.messages.length}`, type: 'synthetic', parts: [{ type: 'text', text }] });
      startTurn(id);
    },
    async getMessages(id) {
      return id === 'ses_arch' ? [...arch] : [...(sessions.get(id)?.messages || [])];
    },
    async interrupt() {},
    async switchModel() {},
    async updateSessionPermissions() {},
    async deleteSession(id) { sessions.delete(id); },
  };
  return { engine, sessions, arch };
}

function runnerFor(engine) {
  return createRunner({
    engine,
    logger: { channel: () => quiet },
    getConfig: () => ({
      roles: { 'coder-1': { ref: 'opencode/one' } },
      worker: { ladder: ['coder-1'], stallSec: 30, resumeMax: 0, retryBaseSec: 1, retryCapSec: 2 },
    }),
    modelCache: { get: () => null, noteIssue: () => true },
    notify: () => {},
  });
}

function delegate(runner, arch, callId) {
  arch.push({ id: `u_${callId}`, type: 'user', created: Date.now(), parts: [{ type: 'text', text: 'go' }] });
  arch.push({
    id: `a_${callId}`,
    type: 'assistant',
    created: Date.now() + 1,
    parts: [{ type: 'tool', name: 'synapse-delegate_delegate', id: callId, input: { task: 't1' } }],
  });
  return runner.handleTurn('ses_arch', [...arch]);
}

function readResult(dir) {
  const file = path.join(dir, '.project', 'runs.jsonl');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return lines.find((r) => r.kind === 'result') || null;
}

async function waitFor(fn, ms = 12000) {
  for (let i = 0; i < ms / 25; i += 1) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  return null;
}

/** The report is the synthetic message the Architect is woken with. */
function wakeText(stub) {
  return (
    [...stub.arch]
      .reverse()
      .filter((m) => m.type === 'synthetic')
      .map((m) => String(m.parts?.[0]?.text || ''))
      .find((t) => /^t1 \(coder-1\)/.test(t)) || ''
  );
}

test('a failing check is sent back once, and a passing second run completes', async () => {
  const dir = project('repair', ['node check.js'], {
    // Fails the first time, passes once the marker exists. The worker's second
    // turn is the repair; the issue is the check's, not the script's.
    check:
      "const fs = require('fs'); if (fs.existsSync('marker.txt')) process.exit(0); " +
      "fs.writeFileSync('marker.txt', '1'); process.exit(1);\n",
  });
  const stub = makeEngine({ dir, script: [{}] });
  const runner = runnerFor(stub.engine);
  await delegate(runner, stub.arch, 'call_repair');
  const result = await waitFor(() => readResult(dir));
  assert.ok(result, 'a result was recorded');
  assert.equal(result.outcome, 'completed', String(result.text || result.error || ''));
  const report = await waitFor(() => wakeText(stub));
  assert.match(report, /Checks: 1 command passed/);
  const worker = [...stub.sessions.values()][0];
  assert.ok(
    worker.messages.some((m) => m.type === 'synthetic' && /harness ran your task's check/.test(m.parts?.[0]?.text || '')),
    'the worker was told its check failed',
  );
});

test('a check that still fails is reported to the Architect and not marked as proof', async () => {
  const dir = project('still-failing', ['node check.js'], { check: 'process.exit(9);\n' });
  const stub = makeEngine({ dir, script: [{}] });
  const runner = runnerFor(stub.engine);
  await delegate(runner, stub.arch, 'call_still');
  const result = await waitFor(() => readResult(dir));
  assert.ok(result);
  assert.equal(result.outcome, 'completed', String(result.text || result.error || ''));
  const report = await waitFor(() => wakeText(stub));
  assert.match(report, /finished, but its check fails/);
  assert.match(report, /exited 9/);
  assert.match(report, /still failed/);
});

test('a check whose own command is missing is reported invalid, never sent back', async () => {
  const dir = project('invalid-check', ['definitely-not-a-command-synapse-test'], {});
  const stub = makeEngine({ dir, script: [{}] });
  const runner = runnerFor(stub.engine);
  await delegate(runner, stub.arch, 'call_invalid');
  const result = await waitFor(() => readResult(dir));
  assert.ok(result);
  assert.equal(result.outcome, 'completed', String(result.text || result.error || ''));
  const report = await waitFor(() => wakeText(stub));
  assert.match(report, /finished, but its check could not run/);
  assert.match(report, /check-environment problem/);
  assert.match(report, /do not send the worker back/);
  assert.doesNotMatch(report, /still failed/, 'there is nothing for the worker to repair');
  const worker = [...stub.sessions.values()][0];
  assert.ok(
    !worker.messages.some((m) => m.type === 'synthetic' && /harness ran your task's check/.test(m.parts?.[0]?.text || '')),
    'the worker is not nudged about a missing harness command',
  );
});
