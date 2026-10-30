// The operator's steer: guidance into work that is already running.
//
// The engine side is a prompt with `delivery: "steer"` (measured on 2.1.2: it
// joins the running turn and is read at the next step boundary). These tests
// pin the Synapse side: who receives it, what the model is told it is, what the
// record keeps, and what the Architect reads afterwards.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/runs.js';
import { briefSession } from '../src/plans.js';
import { OpenCodeEngine } from '../src/engines/opencode.js';

const ROOT = path.join(os.tmpdir(), 'synapse-steer-test');
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function project(name) {
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
        { id: 't1', title: 'Do the thing', role: 'coder-1', status: 'todo', detail: 'd', dependsOn: [], result: null, note: null },
      ],
    }),
  );
  return dir;
}

function makeEngine(dir) {
  const sessions = new Map();
  const arch = [];
  const prompts = [];
  const synthetics = [];
  const interrupts = [];
  const woke = [];
  let seq = 0;

  const engine = {
    async getSession(id) {
      if (id === 'ses_arch') return { id, directory: dir, internal: false, single: false, auto: false };
      return { id, directory: dir, internal: true, role: sessions.get(id)?.role };
    },
    async createSession({ metadata }) {
      const id = `ses_w${(seq += 1)}`;
      sessions.set(id, { role: metadata?.synapse?.role || null, messages: [] });
      return { id };
    },
    async setInstruction() {},
    async prompt(id, text, opts = {}) {
      prompts.push({ id, text, ...opts });
      const s = sessions.get(id);
      if (s) s.messages.push({ id: `${id}-u${s.messages.length}`, type: 'user', parts: [{ type: 'text', text }] });
    },
    async synthetic(id, text) {
      synthetics.push({ id, text });
      if (id === 'ses_arch') {
        woke.push(text);
        arch.push({ id: `s${woke.length}`, type: 'synthetic', parts: [{ type: 'text', text }] });
        setTimeout(() => {
          arch.push({ id: `a${arch.length}`, type: 'assistant', parts: [{ type: 'text', text: 'noted' }] });
          arch.push({ id: `i${arch.length}`, type: 'idle', parts: [] });
        }, 20);
      }
    },
    async getMessages(id) {
      return id === 'ses_arch' ? [...arch] : [...(sessions.get(id)?.messages || [])];
    },
    async interrupt(id) { interrupts.push(id); },
    async updateSessionPermissions() {},
    async deleteSession(id) { sessions.delete(id); },
    async listActiveSessions() { return []; },
  };

  const finish = (id) => {
    const s = sessions.get(id);
    if (!s) return;
    s.messages.push({ id: `${id}-a`, type: 'assistant', parts: [{ type: 'text', text: 'done' }], completed: Date.now() });
    s.messages.push({ id: `${id}-i`, type: 'idle', parts: [] });
  };

  return { engine, sessions, arch, prompts, synthetics, interrupts, woke, finish };
}

function runnerFor(engine, dir, events = null) {
  return createRunner({
    engine,
    logger: { channel: () => quiet },
    getConfig: () => ({
      roles: { 'coder-1': { ref: 'opencode/one' } },
      worker: { ladder: ['coder-1'], stallSec: 30, resumeMax: 0, retryBaseSec: 1, retryCapSec: 2 },
    }),
    modelCache: { get: () => null, noteIssue: () => true },
    notify: (ev) => events?.push(ev),
  });
}

function archMessages(callId) {
  return [
    { id: 'u1', type: 'user', created: Date.now() - 2000, parts: [{ type: 'text', text: 'go' }] },
    {
      id: 'a1',
      type: 'assistant',
      created: Date.now() - 1000,
      parts: [{ type: 'tool', name: 'synapse-delegate_delegate', id: callId, input: { task: 't1' } }],
    },
  ];
}

function runs(dir) {
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

test('the adapter sends delivery: steer', async () => {
  const engine = new OpenCodeEngine({}, { logger: { channel: () => quiet }, workspaceDir: 'C:/x' });
  engine.base = 'http://engine';
  engine.password = 'pw';
  let seen = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    await engine.prompt('ses_1', 'hold on', { delivery: 'steer' });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.body.text, 'hold on');
  assert.equal(seen.body.delivery, 'steer');
});

test('a steer goes into the live worker, marked as guidance', async () => {
  const dir = project('live');
  const stub = makeEngine(dir);
  const events = [];
  const runner = runnerFor(stub.engine, dir, events);
  await runner.handleTurn('ses_arch', archMessages('call_steer'));
  const live = await waitFor(() => runner.active().find((r) => r.workerId));
  assert.ok(live, 'the run should have a worker session');
  // The UI only knows the worker exists from this event; the first `run.started`
  // fires before the session is created and carries `workerId: null`.
  assert.ok(
    events.some((e) => e.type === 'run.progress' && e.workerId === live.workerId),
    'the worker session is broadcast after it is created',
  );

  const result = await runner.steer(dir, { text: 'Use the other file, not main.cpp', actor: { name: 'PC-A' } });
  assert.equal(result.ok, true);
  assert.equal(result.target, 'worker');

  const sent = stub.prompts.find((p) => p.id === live.workerId && p.delivery === 'steer');
  assert.ok(sent, 'the worker should receive a steer prompt');
  assert.equal(sent.text, '[steer] Use the other file, not main.cpp');
  assert.doesNotMatch(sent.text, /new task/, 'the marker is the model-side signal; the brief carries the rule');

  const line = runs(dir).find((r) => r.kind === 'steer');
  assert.ok(line, 'a steer line should be journalled');
  assert.equal(line.by, 'PC-A');
  assert.equal(line.task, 't1');

  stub.finish(live.workerId);
  const done = await waitFor(() => runs(dir).find((r) => r.kind === 'result'));
  assert.ok(done, 'the run should finish');
  assert.equal(done.steers.length, 1);
  assert.equal(done.steers[0].text, 'Use the other file, not main.cpp');

  const report = stub.woke.find((t) => /steered this run/.test(t));
  assert.ok(report, 'the Architect should be told about the steer');
  assert.match(report, /Use the other file, not main\.cpp/);
  assert.match(report, /Judge the work against those instructions/);

  // The run is over, and a steer admitted just before the end could have started
  // a turn nobody is polling. The runner cuts that one.
  assert.ok(stub.interrupts.includes(live.workerId), 'the worker is interrupted after the run');
});

test('a steer is refused when nothing is running', async () => {
  const dir = project('idle');
  const stub = makeEngine(dir);
  const runner = runnerFor(stub.engine, dir);
  const result = await runner.steer(dir, { text: 'hello', actor: { name: 'PC-A' } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Nothing is running/);
});

test('an operator stop wakes nobody and explains nothing', async () => {
  const dir = project('stopped');
  const stub = makeEngine(dir);
  const runner = runnerFor(stub.engine, dir);
  await runner.handleTurn('ses_arch', archMessages('call_stop'));
  const live = await waitFor(() => runner.active().find((r) => r.workerId));
  assert.ok(live);
  runner.cancel(dir);
  const done = await waitFor(() => runs(dir).find((r) => r.kind === 'result'));
  assert.ok(done);
  assert.equal(done.stoppedBy, 'operator');
  assert.equal(stub.woke.length, 0, 'Stop must leave the system idle');
  const brief = briefSession({ dir, role: 'architect' });
  assert.doesNotMatch(brief, /stopped by the operator|do not retry/, 'the brief explains nothing');
});

test('a stopped run still carries its steer into the next brief', async () => {
  const dir = project('stopped-steer');
  const stub = makeEngine(dir);
  const runner = runnerFor(stub.engine, dir);
  await runner.handleTurn('ses_arch', archMessages('call_stop_steer'));
  const live = await waitFor(() => runner.active().find((r) => r.workerId));
  assert.ok(live);
  await runner.steer(dir, { text: 'Use the US, not Canada', actor: { name: 'PC-A' } });
  runner.cancel(dir);
  const done = await waitFor(() => runs(dir).find((r) => r.kind === 'result'));
  assert.ok(done);
  assert.equal(done.stoppedBy, 'operator');
  const brief = briefSession({ dir, role: 'architect' });
  assert.match(brief, /Use the US, not Canada/, 'the steer survives the stop');
  assert.match(brief, /still stands/);
  assert.doesNotMatch(brief, /stopped by the operator/, 'the stop itself is not explained');
});

test('the first stop cuts at the step boundary, with no note to the model', async () => {
  const dir = project('graceful');
  const stub = makeEngine(dir);
  const runner = runnerFor(stub.engine, dir);
  await runner.handleTurn('ses_arch', archMessages('call_grace'));
  const live = await waitFor(() => runner.active().find((r) => r.workerId));
  assert.ok(live);

  // The step in flight: one assistant message, still open.
  stub.sessions.get(live.workerId).messages.push({
    id: 'a-current',
    type: 'assistant',
    parts: [{ type: 'text', text: 'working' }],
    completed: null,
  });

  const asked = await runner.requestStop(dir);
  assert.equal(asked.ok, true);
  assert.equal(runner.active()[0].stopping, true, 'the run says it is stopping');
  assert.equal(stub.synthetics.length, 0, 'nothing is said to the model');

  stub.finish(live.workerId);
  const done = await waitFor(() => runs(dir).find((r) => r.kind === 'result'));
  assert.ok(done);
  assert.equal(done.outcome, 'stopped');
  assert.equal(done.stoppedBy, 'operator');
  assert.equal(stub.woke.length, 0, 'a graceful stop still wakes nobody');
  assert.ok(stub.interrupts.includes(live.workerId), 'the boundary cut interrupts the worker');
  const brief = briefSession({ dir, role: 'architect' });
  assert.doesNotMatch(brief, /stopped by the operator|do not retry/, 'the brief explains nothing');
});

test('the second stop is immediate', async () => {
  const dir = project('hard');
  const stub = makeEngine(dir);
  const runner = runnerFor(stub.engine, dir);
  await runner.handleTurn('ses_arch', archMessages('call_hard'));
  const live = await waitFor(() => runner.active().find((r) => r.workerId));
  assert.ok(live);
  await runner.requestStop(dir);
  assert.equal(runner.cancel(dir), true);
  const done = await waitFor(() => runs(dir).find((r) => r.kind === 'result'));
  assert.ok(done);
  assert.equal(done.outcome, 'stopped');
  assert.equal(done.stoppedBy, 'operator');
  assert.equal(stub.woke.length, 0);
});

test('a stop request with nothing running is refused', async () => {
  const dir = project('nothing');
  const stub = makeEngine(dir);
  const runner = runnerFor(stub.engine, dir);
  assert.equal((await runner.requestStop(dir)).ok, false);
});

test('the briefs explain a steer and an interrupted turn', () => {
  const dir = project('briefs');
  const arch = briefSession({ dir, role: 'architect' });
  const worker = briefSession({ dir, role: 'coder-1' });
  assert.match(arch, /\[steer\]/);
  assert.doesNotMatch(arch, /Step interrupted/, 'a stop is not explained to the model');
  assert.match(arch, /guidance for the turn you are in/);
  assert.match(worker, /\[steer\]/);
  assert.match(worker, /guidance while you work/);
});

test('the first Stop says it is finishing the step', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'web', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(process.cwd(), 'web', 'synapse.css'), 'utf8');
  const app = fs.readFileSync(path.join(process.cwd(), 'web', 'app.js'), 'utf8');
  assert.match(html, /finish this step, then stop/);
  assert.match(html, /id="stopNotice"/);
  assert.match(css, /#stopBtn\.is-stopping/);
  assert.match(css, /body\.is-stopping \.chat-dock/);
  assert.match(app, /\/stop`/);
});

test('the composer says what a steer will do', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'web', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(process.cwd(), 'web', 'synapse.css'), 'utf8');
  assert.match(app, /seen at its next step/);
  assert.match(app, /seen mid-turn/);
  assert.match(app, /STEER:/);
  assert.match(app, /msg-steer/);
  assert.match(app, /'Steer' : 'Send'/);
  assert.match(css, /#sendBtn\.is-steer/);
  assert.match(app, /steerNotes/);
  assert.match(css, /\.trace-line\.is-steer/);
  assert.match(app, /\/steer`/);
});
