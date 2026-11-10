// The loop guard, through the real delegation runner.
//
// A model that repeats one phrase keeps the activity clock moving, so the stall
// guard never sees it; this drives the other path. The runner notices the loop,
// interrupts the turn, tells the worker to carry on and counts it. Effort is never
// changed. At the configured number of loops in one work order (Settings > Workers,
// three by default) the model is marked ISSUES and the task moves to the next coder.
//
// The phrase is produced by a stub engine that grows one reasoning message every
// 200ms; the runner's poll is 1.5s and the guard waits ten seconds, so a phrase
// loop takes about a quarter of a minute. A tool loop (the same call four times in
// eight) is caught in about three seconds, which is the point of the second half.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRunner } from '../src/runs.js';
import { tmpdir } from './tmpdir.mjs';

const ROOT = tmpdir('synapse-loop-run-test-');
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

/** A worker that loops: one phrase over and over, or the same call again and again.
 *  `keepLooping` makes the nudge start another loop, so a run can reach the limit;
 *  otherwise the nudge finishes the turn. Roles outside `loopRoles` just finish, so
 *  one test can watch coder-2 take a task over after coder-1 was marked. */
function makeEngine(dir, { loopRoles = ['coder-1'], keepLooping = false, toolLoop = false, emptyLoop = false } = {}) {
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
  // The action half: a new call every 400ms, same name and same command. Three of
  // them inside five is a loop, and no thinking is involved.
  const startToolLoop = (id) => {
    const s = sessions.get(id);
    let n = 0;
    s.timer = setInterval(() => {
      const at = Date.now();
      n += 1;
      s.messages.push({
        id: `${id}-t${(turns += 1)}`,
        type: 'assistant',
        created: at,
        updated: at,
        completed: at,
        parts: [
          {
            type: 'tool',
            name: 'bash',
            id: `${id}-call${n}`,
            input: { command: 'node proof.js' },
            status: 'completed',
          },
        ],
      });
    }, 400);
  };
  // The 4 Nov false positive: tool calls whose input never arrived (`{}`), so every
  // one of them had the empty target. Eight of them used to look like two loops.
  const startEmptyTools = (id) => {
    const s = sessions.get(id);
    let n = 0;
    s.timer = setInterval(() => {
      const at = Date.now();
      n += 1;
      s.messages.push({
        id: `${id}-e${(turns += 1)}`,
        type: 'assistant',
        created: at,
        updated: at,
        completed: at,
        parts: [{ type: 'tool', name: n % 2 ? 'read' : 'glob', id: `${id}-ecall${n}`, input: {}, status: 'error' }],
      });
      if (n >= 6) {
        clearInterval(s.timer);
        s.timer = null;
        s.messages.push({ id: `${id}-f`, type: 'assistant', parts: [{ type: 'text', text: 'Done.' }], completed: Date.now() });
        s.messages.push({ id: `${id}-fi`, type: 'idle', parts: [] });
      }
    }, 120);
  };
  const start = (id) => (emptyLoop ? startEmptyTools(id) : toolLoop ? startToolLoop(id) : startLoop(id));

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
      start(id);
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
      if (keepLooping) {
        // The nudge did not help: the same loop starts again, which is how a run
        // reaches the limit.
        setTimeout(() => start(id), 40);
        return;
      }
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

async function waitFor(pred, ms = 90000) {
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

async function startCase(name, variant, { ladder = ['coder-1'], ids = ['t1'], loopLimit = 3, keepLooping = false, toolLoop = false, emptyLoop = false } = {}) {
  const dir = project(name, ids);
  const stub = makeEngine(dir, { keepLooping, toolLoop, emptyLoop });
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
        'qc': { ref: 'opencode/three' },
      },
      worker: { ladder, stallSec: 30, resumeMax: 0, retryBaseSec: 1, retryCapSec: 2, loopGuard: true, loopLimit },
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

test('a call with no input is not a repeated call', async () => {
  // Eight tool parts with `input: {}` — four reads, four globs — shared the empty
  // target, and three of a kind marked a worker that had only begun to read its
  // files (4 Nov, twice in three seconds).
  const { result, marks } = await startCase('empty-tools', 'medium', { emptyLoop: true, loopLimit: 1 });
  assert.ok(result, 'the run finished and wrote a result');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.loops, 0, 'no loop was counted');
  assert.equal(marks.length, 0, 'nothing was marked');
});

test('a repeating worker is interrupted, asked to carry on, and finishes', async () => {
  const { stub, events, result } = await startCase('loop-phrase', 'medium');
  assert.ok(result, 'the run finished and wrote a result');
  assert.equal(result.outcome, 'completed', 'the nudge carried the task to the end');
  assert.equal(result.loops, 1, 'one rescue is recorded');
  assert.equal(stub.switched.length, 0, 'the effort is never changed');

  const worker = stub.created[0];
  const note = events.find((e) => e.type === 'run.note' && e.kind === 'loop');
  assert.ok(note, 'the card was told about the loop');
  assert.equal(note.times, 1);
  assert.equal(note.limit, 3);
  assert.ok(stub.interrupts.includes(worker), 'the looping turn was interrupted');
});

test('at the limit the model is marked and the Architect is told', async () => {
  const { stub, marks, result } = await startCase('loop-limit', 'medium', { keepLooping: true, loopLimit: 2 });
  assert.ok(result, 'the run finished and wrote a result');
  assert.equal(result.outcome, 'error', 'the limit ends the run');
  assert.equal(result.loops, 2, 'both loops are counted');
  assert.equal(stub.switched.length, 0, 'no effort step');

  assert.equal(marks.length, 1, 'the model is marked once');
  assert.equal(marks[0].issue.kind, 'loop', 'the mark names the reason');
  assert.match(marks[0].issue.message, /looped 2 times/);

  const report = told(stub);
  assert.match(report, /looped 2 times in one work order/, 'the Architect is told the count');
  assert.match(report, /ISSUES/, 'and that the model is marked');
  assert.match(report, /out of action/, 'and that the role is stuck until the operator fixes it');
});

// The incident of 4 Nov: the worker never repeated a phrase, it ran the same command
// over and over. The thinking check cannot see that; the tool window can.
test('a tool loop — the same call four times — is caught without any thinking loop', async () => {
  const { stub, marks, result } = await startCase('loop-tool', 'medium', {
    keepLooping: true,
    toolLoop: true,
    loopLimit: 1,
  });
  assert.ok(result, 'the run finished and wrote a result');
  assert.equal(result.outcome, 'error', 'the tool loop is a loop like any other');
  assert.equal(result.loops, 1);
  assert.equal(marks.length, 1, 'the model is marked');
  assert.match(marks[0].issue.message, /bash/, 'the mark names what it kept running');
  const report = told(stub);
  assert.match(report, /node proof\.js/, 'the report quotes the repeated call');
});

// The task carries on down the ladder in the same delegation, and the report names
// the coder that is marked, never the one that took over.
test('a looped coder moves the task to coder-2, and the report names coder-1', async () => {
  const { stub, marks, result } = await startCase('loop-ladder', 'medium', {
    ladder: ['coder-1', 'coder-2', 'qc'],
    keepLooping: true,
    loopLimit: 1,
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
  const { stub, delegate, result } = await startCase('loop-next-task', 'medium', {
    ladder: ['coder-1', 'coder-2', 'qc'],
    ids: ['t1', 't2'],
    keepLooping: true,
    loopLimit: 1,
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
