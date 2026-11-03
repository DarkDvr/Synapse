// The loop rescue, through the real delegation runner.
//
// A model that repeats one phrase keeps the activity clock moving, so the stall
// guard never sees it. This drives the other path: the runner notices the phrase,
// interrupts the turn, lowers the role's thinking effort one step, tells the
// worker to carry on, and finishes on the lower effort.
//
// The phrase is produced by a stub engine that grows one reasoning message every
// 200ms; the runner's poll is 1.5s and the guard waits ten seconds, so this test
// takes about a quarter of a minute. That is the point of the guard: it is slow
// enough that normal thinking never matches it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRunner } from '../src/runs.js';

const ROOT = path.join(os.tmpdir(), 'synapse-loop-run-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

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
        { id: 't1', title: 'Build the mock', role: 'coder-1', status: 'todo', detail: 'd', dependsOn: [], result: null, note: null },
      ],
    }),
  );
  return dir;
}

/** A worker whose thinking grows the same phrase; a nudge finishes the turn. */
function makeEngine(dir) {
  const sessions = new Map();
  const arch = [];
  const created = [];
  const interrupts = [];
  const switched = [];
  let seq = 0;
  let turns = 0;

  const stopStream = (s) => {
    if (s?.timer) clearInterval(s.timer);
    if (s) s.timer = null;
    if (s?.assistant) s.assistant.completed = Date.now();
  };
  const startLoop = (id) => {
    const s = sessions.get(id);
    s.assistant = { id: `${id}-a${(turns += 1)}`, type: 'assistant', parts: [{ type: 'reasoning', text: '' }], updated: Date.now() };
    s.messages.push(s.assistant);
    s.timer = setInterval(() => {
      s.assistant.parts[0].text += 'Building the gauge layout... '.repeat(4);
      s.assistant.updated = Date.now();
    }, 200);
  };

  const engine = {
    async getSession(id) {
      if (id === 'ses_arch') return { id, directory: dir, internal: false, single: false, auto: false };
      return { id, internal: true, role: sessions.get(id)?.role };
    },
    async createSession({ metadata }) {
      const id = `ses_w${(seq += 1)}`;
      created.push(id);
      sessions.set(id, { role: metadata?.synapse?.role || null, messages: [], timer: null, assistant: null });
      return { id };
    },
    async setInstruction() {},
    async prompt(id, text) {
      const s = sessions.get(id);
      s.messages.push({ id: `${id}-u${(turns += 1)}`, type: 'user', parts: [{ type: 'text', text }] });
      startLoop(id);
    },
    async synthetic(id, text) {
      if (id === 'ses_arch') {
        arch.push({ id: `a-s${arch.length}`, type: 'synthetic', parts: [{ type: 'text', text }] });
        setTimeout(() => {
          arch.push({ id: `a-a${arch.length}`, type: 'assistant', parts: [{ type: 'text', text: 'noted' }] });
          arch.push({ id: `a-i${arch.length}`, type: 'idle', parts: [] });
        }, 20);
        return;
      }
      const s = sessions.get(id);
      stopStream(s);
      setTimeout(() => {
        s.messages.push({ id: `${id}-a${(turns += 1)}`, type: 'assistant', parts: [{ type: 'text', text: 'Done.' }], completed: Date.now() });
        s.messages.push({ id: `${id}-i${(turns += 1)}`, type: 'idle', parts: [] });
      }, 80);
    },
    async getMessages(id) {
      return id === 'ses_arch' ? [...arch] : [...(sessions.get(id)?.messages || [])];
    },
    async interrupt(id) {
      interrupts.push(id);
      stopStream(sessions.get(id));
    },
    async switchModel(id, model) {
      switched.push({ id, model });
    },
    async updateSessionPermissions() {},
    async deleteSession(id) {
      sessions.delete(id);
    },
  };
  return { engine, sessions, arch, created, interrupts, switched };
}

async function waitFor(pred, ms = 40000) {
  for (let i = 0; i < ms / 25; i += 1) {
    const v = pred();
    if (v) return v;
    await sleep(25);
  }
  return null;
}

function readRuns(dir) {
  const file = path.join(dir, '.synapse', 'runs.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function startCase(name, variant) {
  const dir = project(name);
  const stub = makeEngine(dir);
  const events = [];
  const marks = [];
  const runner = createRunner({
    engine: stub.engine,
    logger: { channel: () => quiet },
    getConfig: () => ({
      roles: {
        'coder-1': { ref: 'polystrata/model', variant },
        'coder-2': { ref: 'opencode/two' },
        'coder-3': { ref: 'opencode/three' },
      },
      worker: { ladder: ['coder-1'], stallSec: 30, resumeMax: 0, retryBaseSec: 1, retryCapSec: 2, loopGuard: true },
      cleanup: { onFinish: false },
    }),
    modelCache: {
      get: () => ({ variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] }),
      noteIssue: (ref, issue) => {
        marks.push({ ref, issue });
        return true;
      },
    },
    notify: (ev) => events.push(ev),
  });

  stub.arch.push({ id: 'u1', type: 'user', created: Date.now(), parts: [{ type: 'text', text: 'go' }] });
  stub.arch.push({
    id: 'a1',
    type: 'assistant',
    created: Date.now() + 1,
    parts: [{ type: 'tool', name: 'synapse-delegate_delegate', id: `call_${name}`, input: { task: 't1' } }],
  });
  await runner.handleTurn('ses_arch', [...stub.arch]);

  const result = await waitFor(() => readRuns(dir).find((r) => r.kind === 'result'));
  return { dir, stub, events, marks, result };
}

test('a worker repeating one phrase is interrupted, lowered one effort and continues', async () => {
  const { stub, events, result } = await startCase('loop-high', 'high');
  assert.ok(result, 'the run finished and wrote a result');
  assert.equal(result.outcome, 'completed', 'the lower effort carried the task to the end');
  assert.equal(result.loops, 1, 'one rescue is recorded');

  const worker = stub.created[0];
  const switched = stub.switched.find((s) => s.id === worker);
  assert.ok(switched, 'the worker session was moved to the lower variant');
  assert.equal(switched.model.variant, 'medium', 'high stepped down to medium');

  const note = events.find((e) => e.type === 'run.note' && e.kind === 'loop');
  assert.ok(note, 'the card was told about the loop');
  assert.equal(note.times, 1);
  assert.equal(note.to, 'medium');
  assert.ok(stub.interrupts.includes(worker), 'the looping turn was interrupted');
});

test('at the lowest effort the model is marked and the Architect is told', async () => {
  const { stub, marks, result } = await startCase('loop-low', 'low');
  assert.ok(result, 'the run finished and wrote a result');
  assert.equal(result.outcome, 'error', 'a loop at the bottom is a failure, not a rescue');
  assert.equal(result.loops, 1, 'the loop is still counted');

  assert.equal(marks.length, 1, 'the model is marked once');
  assert.equal(marks[0].issue.kind, 'loop', 'the mark names the reason');
  assert.match(marks[0].issue.message, /lowest reasoning effort/);

  const report = stub.arch.filter((m) => m.type === 'synthetic').map((m) => m.parts[0]?.text || '').join('\n');
  assert.match(report, /ISSUES/, 'the Architect is told the model is marked');
  assert.match(report, /out of action/, 'and that the role is stuck until the operator fixes it');
});
