// The coder ladder, exercised through the real delegation runner.
//
// The pure rung arithmetic is tested in run-rules.test.mjs. This drives what
// actually decides who runs: the delegation loop, the in-run escalation when a
// provider refuses a model, and the history that decides where the *next*
// delegation starts.
//
// It also pins the two edges the runner had wrong on 29 Oct:
//  - an operator Stop must not leave the previous attempt's provider error in the
//    result line (the Architect read it as the cause of the stop);
//  - a Stop must not push the task down the ladder.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRunner } from '../src/runs.js';

const ROOT = path.join(os.tmpdir(), 'synapse-ladder-test');
const TERMINAL = 'Invalid request: text is required';
const FREE_LIMIT =
  'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function project(name, role = 'coder-1') {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.synapse', 'plan.json'),
    JSON.stringify({
      version: 1,
      goal: 'test',
      summary: '',
      tasks: [
        { id: 't1', title: 'Do the thing', role, status: 'todo', detail: 'd', dependsOn: [], result: null, note: null },
      ],
    }),
  );
  return dir;
}

/** A stub engine with one script per worker session. `delay` keeps a turn open
 *  long enough for Stop to land in the middle of it. */
function makeEngine({ dir, script, turnDelay = 15 }) {
  const sessions = new Map();
  const arch = [];
  const created = [];
  const interrupts = [];
  const switched = [];
  let seq = 0;

  const startTurn = (id) => {
    const s = sessions.get(id);
    const step = s.script.length > 1 ? s.script.shift() : s.script[0];
    if (!step) return;
    const n = (s.turn = (s.turn || 0) + 1);
    setTimeout(() => {
      if (!sessions.has(id)) return;
      const err = step.error || null;
      s.messages.push({
        id: `${id}-a${n}`,
        type: 'assistant',
        parts: [{ type: 'text', text: err ? 'partial' : 'done' }],
        completed: Date.now(),
        error: err,
      });
      s.messages.push({ id: `${id}-i${n}`, type: 'idle', parts: [], error: err });
    }, step.delay ?? turnDelay);
  };

  const engine = {
    async getSession(id) {
      if (id === 'ses_arch') return { id, directory: dir, internal: false, single: false, auto: false };
      return { id, directory: dir, internal: true, role: sessions.get(id)?.role };
    },
    async createSession({ metadata }) {
      const id = `ses_w${(seq += 1)}`;
      created.push(id);
      sessions.set(id, { role: metadata?.synapse?.role || null, messages: [], script: [...script] });
      return { id };
    },
    async setInstruction() {},
    async prompt(id, text) {
      const s = sessions.get(id);
      s.messages.push({ id: `${id}-u`, type: 'user', parts: [{ type: 'text', text }] });
      startTurn(id);
    },
    async synthetic(id, text, opts) {
      if (id === 'ses_arch') {
        arch.push({ id: `a-s${arch.length}`, type: 'synthetic', parts: [{ type: 'text', text }], description: opts?.description });
        setTimeout(() => {
          arch.push({ id: `a-r${arch.length}`, type: 'assistant', parts: [{ type: 'text', text: 'noted' }] });
          arch.push({ id: `a-i${arch.length}`, type: 'idle', parts: [] });
        }, 20);
        return;
      }
      const s = sessions.get(id);
      s.messages.push({ id: `${id}-s`, type: 'synthetic', parts: [{ type: 'text', text }] });
      startTurn(id);
    },
    async getMessages(id) {
      return id === 'ses_arch' ? [...arch] : [...(sessions.get(id)?.messages || [])];
    },
    async interrupt(id) { interrupts.push(id); },
    async switchModel(id, model) { switched.push({ id, model }); },
    async updateSessionPermissions() {},
    async deleteSession(id) { sessions.delete(id); },
  };
  return { engine, sessions, created, arch, interrupts, switched };
}

function runnerFor({ engine, ladder, retryBaseSec = 1, retryCapSec = 2 }) {
  return createRunner({
    engine,
    logger: { channel: () => quiet },
    getConfig: () => ({
      roles: {
        'coder-1': { ref: 'opencode/one' },
        'coder-2': { ref: 'opencode/two' },
        'coder-3': { ref: 'opencode/three' },
      },
      worker: { ladder, stallSec: 30, resumeMax: 0, retryBaseSec, retryCapSec },
    }),
    modelCache: { get: () => null, noteIssue: () => true },
    notify: () => {},
  });
}

function readRuns(dir) {
  const file = path.join(dir, '.synapse', 'runs.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function waitFor(pred, ms = 12000) {
  for (let i = 0; i < ms / 25; i += 1) {
    const v = pred();
    if (v) return v;
    await sleep(25);
  }
  return null;
}

/** Ask the Architect for t1 under a fresh call id. */
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

async function startCase(name, { script, cancelAfter = 0 }) {
  const dir = project(name);
  const stub = makeEngine({ dir, script });
  const runner = runnerFor({ engine: stub.engine, ladder: ['coder-1', 'coder-2', 'coder-3'] });
  await delegate(runner, stub.arch, `call_${name}_a`);
  if (cancelAfter) setTimeout(() => runner.cancel(dir), cancelAfter);
  const first = await waitFor(() => readRuns(dir).find((r) => r.kind === 'result'));
  return { dir, stub, runner, first };
}

const checks = [];
const expect = (label, ok, detail) => checks.push({ label, ok, detail });

// 1. a refused model escalates inside the run: coder-1 -> coder-2 -> coder-3
{
  const { dir, stub, first } = await startCase('refused', { script: [{ error: TERMINAL }] });
  expect('the delegation starts on coder-1', readRuns(dir).find((r) => r.kind === 'delegate')?.role === 'coder-1');
  expect('a refused model is not a dead end: the task lands on coder-3', first?.role === 'coder-3', first?.role);
  expect('three worker sessions were tried', stub.created.length === 3, String(stub.created.length));
  expect('the run is still a failure the Architect must judge', first?.outcome === 'error', first?.outcome);
  expect('the report says who it really ran on', /moved/.test(first?.text || '') || first?.role === 'coder-3');
}

// 2. the next delegation starts one rung down from the plan's role
{
  const { dir, stub, runner } = await startCase('next-rung', { script: [{ error: TERMINAL }] });
  await delegate(runner, stub.arch, 'call_next-rung_b');
  const second = await waitFor(() => readRuns(dir).find((r) => r.kind === 'delegate' && r.callId === 'call_next-rung_b'));
  expect('the retry is delegated to coder-2', second?.role === 'coder-2', second?.role);
  expect('the plan still belongs to coder-1', second?.plannedRole === 'coder-1', second?.plannedRole);
}

// 3. an operator Stop is not a failure and leaves no stale provider error
{
  const { dir, stub, runner, first } = await startCase('stopped', {
    script: [{ error: FREE_LIMIT }, { delay: 8000 }],
    cancelAfter: 3200,
  });
  expect('the cap was retried, then the stop landed', first?.outcome === 'stopped', first?.outcome);
  expect('a stopped run carries no provider error', first?.error === null, String(first?.error));
  expect('it says the operator stopped it', first?.stoppedBy === 'operator', String(first?.stoppedBy));
  expect('the last turn error is kept apart', first?.lastTurnError === FREE_LIMIT, String(first?.lastTurnError));
  runner.resume(dir);
  await delegate(runner, stub.arch, 'call_stopped_b');
  const second = await waitFor(() => readRuns(dir).find((r) => r.kind === 'delegate' && r.callId === 'call_stopped_b'));
  expect('a stop does not push the task down the ladder', second?.role === 'coder-1', second?.role);
}

// 4. changing a role's model ends its provider wait and continues at once
{
  const dir = project('model-wake');
  const stub = makeEngine({ dir, script: [{ error: FREE_LIMIT }, {}] });
  const runner = runnerFor({
    engine: stub.engine,
    ladder: ['coder-1', 'coder-2', 'coder-3'],
    retryBaseSec: 60,
    retryCapSec: 3600,
  });
  await delegate(runner, stub.arch, 'call_model-wake_a');
  const live = await waitFor(() => runner.active().find((r) => r.workerId && r.retry));
  expect('the run is asleep in a provider backoff', Boolean(live), JSON.stringify(runner.active()));

  const woke = await runner.wakeRole('coder-1', 'opencode/two');
  expect('the model change wakes the role', woke === 1, String(woke));
  expect(
    'the running session is moved to the new model',
    stub.switched.some((s) => s.model === 'opencode/two'),
    JSON.stringify(stub.switched),
  );
  const done = await waitFor(() => readRuns(dir).find((r) => r.kind === 'result'), 3000);
  expect('and the run continues without waiting out the backoff', Boolean(done), 'no result within 3s');
  expect('the run finishes on the new model', done?.outcome === 'completed', done?.outcome);
}

// 5. a task the operator asked to run on coder-2 starts there
{
  const dir = project('operator-coder', 'coder-2');
  const stub = makeEngine({ dir, script: [{}] });
  const runner = runnerFor({ engine: stub.engine, ladder: ['coder-1', 'coder-2', 'coder-3'] });
  await delegate(runner, stub.arch, 'call_operator-coder_a');
  const first = await waitFor(() => readRuns(dir).find((r) => r.kind === 'result'));
  const row = readRuns(dir).find((r) => r.kind === 'delegate');
  expect('a task written for coder-2 starts on coder-2', row?.role === 'coder-2', row?.role);
  expect('and the work still completes', first?.outcome === 'completed', first?.outcome);
}

// 6. a result whose wake never landed is replayed at boot
{
  const dir = project('lost-wake');
  const now = Date.now();
  fs.writeFileSync(
    path.join(dir, '.synapse', 'runs.jsonl'),
    [
      JSON.stringify({ kind: 'delegate', callId: 'c_lost', task: 't1', role: 'coder-1', architect: 'ses_arch', at: now - 60000 }),
      JSON.stringify({ kind: 'result', callId: 'c_lost', task: 't1', role: 'coder-1', architect: 'ses_arch', outcome: 'completed', at: now - 30000, error: null }),
    ].join('\n') + '\n',
  );
  const stub = makeEngine({ dir, script: [{}] });
  const runner = runnerFor({ engine: stub.engine, ladder: ['coder-1', 'coder-2', 'coder-3'] });
  const n = await runner.recoverLostReports([dir]);
  expect('a result newer than the Architect last heard is replayed', n === 1, String(n));
  expect(
    'the replay says the report may not have landed',
    stub.arch.some((m) => /report may not have reached/.test(String(m.parts?.[0]?.text || ''))),
  );
  expect('a delivered wake is marked', readRuns(dir).some((r) => r.kind === 'wake' && r.status === 'done' && r.callId === 'c_lost'));
  const again = await runner.recoverLostReports([dir]);
  expect('it is not replayed twice', again === 0, String(again));
}

for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.ok || !c.detail ? '' : `  <- ${c.detail}`}`);
}
if (checks.some((c) => !c.ok)) process.exitCode = 1;
