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

function project(name, ids = ['t1']) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.synapse', 'plan.json'),
    JSON.stringify({
      version: 1,
      goal: 'test',
      summary: '',
      tasks: ids.map((id) => ({
        id,
        title: `Build ${id}`,
        role: 'coder-1',
        status: 'todo',
        detail: 'd',
        dependsOn: [],
        result: null,
        note: null,
      })),
    }),
  );
  return dir;
}

/** A worker whose thinking grows the same phrase; a nudge finishes the turn.
 *  Roles outside `loopRoles` just finish, so one test can watch coder-2 take a
 *  task over after coder-1 was marked. */
function makeEngine(dir, loopRoles = ['coder-1']) {
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
      if (!loopRoles.includes(s.role)) {
        setTimeout(() => {
          s.messages.push({ id: `${id}-a${(turns += 1)}`, type: 'assistant', parts: [{ type: 'text', text: 'Done.' }], completed: Date.now() });
          s.messages.push({ id: `${id}-i${(turns += 1)}`, type: 'idle', parts: [] });
        }, 60);
        return;
      }
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

async function startCase(name, variant, { ladder = ['coder-1'], ids = ['t1'] } = {}) {
  const dir = project(name, ids);
  const stub = makeEngine(dir);
  const events = [];
  const marks = [];
  // A cache the runner can read back: a mark written by noteIssue has to be
  // visible to roleMarked on the next delegation, the way modelcache.js makes it.
  const models = new Map();
  const model = (ref) => {
    if (!models.has(ref)) {
      models.set(ref, { variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], issues: [] });
    }
    return models.get(ref);
  };
  const runner = createRunner({
    engine: stub.engine,
    logger: { channel: () => quiet },
    getConfig: () => ({
      roles: {
        'coder-1': { ref: 'polystrata/model', variant },
        'coder-2': { ref: 'opencode/two' },
        'coder-3': { ref: 'opencode/three' },
      },
      worker: { ladder, stallSec: 30, resumeMax: 0, retryBaseSec: 1, retryCapSec: 2, loopGuard: true },
      cleanup: { onFinish: false },
    }),
    modelCache: {
      get: (ref) => model(ref),
      noteIssue: (ref, issue) => {
        model(ref).issues.unshift(issue);
        marks.push({ ref, issue });
        return true;
      },
    },
    notify: (ev) => events.push(ev),
  });

  stub.arch.push({ id: 'u1', type: 'user', created: Date.now(), parts: [{ type: 'text', text: 'go' }] });

  const delegate = async (taskId) => {
    const callId = `call_${name}_${taskId}`;
    stub.arch.push({
      id: `a-${callId}`,
      type: 'assistant',
      created: Date.now(),
      parts: [{ type: 'tool', name: 'synapse-delegate_delegate', id: callId, input: { task: taskId } }],
    });
    await runner.handleTurn('ses_arch', [...stub.arch]);
    return waitFor(() => readRuns(dir).find((r) => r.kind === 'result' && r.task === taskId));
  };

  const result = await delegate('t1');
  return { dir, stub, events, marks, result, delegate };
}

/** Everything the Architect was told, in order. */
function told(stub) {
  return stub.arch
    .filter((m) => m.type === 'synthetic')
    .map((m) => m.parts[0]?.text || '')
    .join('\n---\n');
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

  const report = told(stub);
  assert.match(report, /ISSUES/, 'the Architect is told the model is marked');
  assert.match(report, /out of action/, 'and that the role is stuck until the operator fixes it');
});

// The move the operator asked for: a coder-1 that loops at the bottom must not
// end the night - the task carries on down the ladder in the same delegation, and
// the report names the coder that is marked, never the one that took over.
test('a loop at the bottom moves the task to coder-2, and the report names coder-1', async () => {
  const { stub, marks, result } = await startCase('loop-ladder', 'low', {
    ladder: ['coder-1', 'coder-2', 'coder-3'],
  });
  assert.ok(result, 'the run finished and wrote a result');
  assert.equal(result.role, 'coder-2', 'coder-2 ran the task');
  assert.equal(result.outcome, 'completed', 'and finished it');
  assert.equal(result.plannedRole, 'coder-1', 'the plan still says coder-1');
  assert.deepEqual(result.loopMark, { role: 'coder-1', model: 'polystrata/model' }, 'the log says which rung was marked');

  assert.deepEqual(marks.map((m) => m.ref), ['polystrata/model'], 'only the looping model is marked');

  const report = told(stub);
  assert.match(report, /ran on coder-2, not coder-1/, 'the Architect is told who actually ran it');
  assert.match(report, /polystrata\/model is marked with the ISSUES badge/, 'the marked model is named');
  assert.match(report, /start this project's build tasks one rung lower/, 'and the consequence for later tasks');
  assert.doesNotMatch(report, /opencode\/two is marked/, 'the coder that delivered is not accused');
  assert.doesNotMatch(report, /Do not delegate to coder-2/, 'and is not taken out of action');
});

test('once coder-1 is marked, the next task starts on coder-2', async () => {
  const { stub, delegate, result } = await startCase('loop-next-task', 'low', {
    ladder: ['coder-1', 'coder-2', 'coder-3'],
    ids: ['t1', 't2'],
  });
  assert.equal(result.role, 'coder-2');

  const second = await delegate('t2');
  assert.ok(second, 'the second task ran');
  assert.equal(second.role, 'coder-2', 'the task started on coder-2, without paying for the loop again');
  assert.equal(second.loops, 0, 'no rescue was needed this time');

  const roles = [...stub.sessions.values()].map((s) => s.role);
  assert.deepEqual(roles, ['coder-1', 'coder-2', 'coder-2'], 'coder-1 was never spawned a second time');

  const report = told(stub);
  assert.match(report, /coder-1's model is marked ISSUES, so this task started further down the line/);
});

