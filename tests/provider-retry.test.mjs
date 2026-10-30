// Drives the real delegation runner with a stubbed engine.
//
// What it guards, and why it is worth a test rather than a read:
//  - a rate limit must NOT end a run: the same session is nudged to continue,
//    with backoff, and nothing is counted as an attempt;
//  - a retired model must end it, and mark the model;
//  - a silent turn (no part changes at all) must be interrupted and resumed;
//  - Stop must cut a backoff short and leave no wake behind;
//  - the Architect's wake must retry when its own turn fails — the clock run died
//    in exactly that hole, with the report delivered and nobody reading it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRunner } from '../src/runs.js';
import { briefSession } from '../src/plans.js';
import { classifyFailure, PROVIDER_LOG } from '../src/provider-errors.js';

const ROOT = path.join(os.tmpdir(), 'synapse-provider-test');
const RATE = 'Rate limit exceeded. Please try again later.';
const FREE_LIMIT =
  'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.';
const DEPRECATED = 'Model muse-spark-1.3-contributor-free has been deprecated.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const logBefore = fs.existsSync(PROVIDER_LOG) ? fs.readFileSync(PROVIDER_LOG, 'utf8') : null;

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

/** A turn-by-turn stub. `script` is consumed one entry per turn; the last entry
 *  repeats. `{ silent: true }` starts a turn that never closes — the shape of a
 *  session the engine has silently lost. */
function makeEngine({ dir, script, wakeScript }) {
  const sessions = new Map();
  const woke = [];
  const descriptions = [];
  const interrupts = [];
  const created = [];
  const deleted = [];
  const prompts = [];
  let seq = 0;

  const startTurn = (id) => {
    const s = sessions.get(id);
    const step = s.script.length > 1 ? s.script.shift() : s.script[0];
    if (!step || step.silent) return;
    const n = (s.turn = (s.turn || 0) + 1);
    setTimeout(() => {
      if (!sessions.has(id)) return;
      const err = step.error || null;
      const text = err ? (step.text || '') : 'done';
      s.messages.push({ id: `${id}-a${n}`, type: 'assistant', parts: [{ type: 'text', text }], completed: Date.now(), error: err });
      s.messages.push({ id: `${id}-i${n}`, type: 'idle', parts: [], error: err });
    }, 15);
  };

  const push = (id, msg) => {
    sessions.get(id).messages.push(msg);
    startTurn(id);
  };

  const engine = {
    async getSession(id) {
      if (id === 'ses_arch') return { id, directory: dir, internal: false, single: false, auto: false };
      const s = sessions.get(id);
      return { id, directory: dir, internal: true, role: s?.role };
    },
    async createSession({ model, metadata }) {
      const id = `ses_w${(seq += 1)}`;
      created.push(id);
      // The first session gets the case's script. A replacement (a session after
      // a compaction reset) gets a clean turn, which is what the real reset is
      // for: the new transcript is short, so the same turn no longer fails.
      sessions.set(id, {
        role: metadata?.synapse?.role || null,
        model: model?.ref || null,
        messages: [],
        script: created.length === 1 ? [...script] : [{}],
      });
      return { id };
    },
    async setInstruction() {},
    async prompt(id, text) {
      prompts.push({ id, text });
      push(id, { id: `${id}-u`, type: 'user', parts: [{ type: 'text', text }] });
    },
    async synthetic(id, text, opts) {
      if (!sessions.has(id)) sessions.set(id, { messages: [], script: [...wakeScript] });
      woke.push(text);
      descriptions.push(opts?.description || '');
      push(id, { id: `${id}-s${woke.length}`, type: 'synthetic', parts: [{ type: 'text', text }] });
    },
    async getMessages(id) {
      const s = sessions.get(id);
      return s ? [...s.messages] : [];
    },
    async interrupt(id) { interrupts.push(id); },
    async updateSessionPermissions() {},
    async deleteSession(id) {
      deleted.push(id);
      sessions.delete(id);
    },
  };
  return { engine, sessions, woke, descriptions, interrupts, created, deleted, prompts };
}

async function runCase({ name, script, wakeScript = [{}], ladder = ['coder-1'], roleRef = 'opencode/deepseek-v4.1-flash-free', cancelAfter = 0, untilWoke = 1, harnessStopAfter = 0, harnessReason = '' }) {
  const dir = project(name);
  const runsFile = path.join(dir, '.synapse', 'runs.jsonl');
  const { engine, sessions, woke, descriptions, interrupts, created, deleted, prompts } = makeEngine({ dir, script, wakeScript });
  const events = [];
  const noted = [];
  const logged = [];
  const runner = createRunner({
    engine,
    logger: {
      channel: () => ({
        info: () => {},
        debug: () => {},
        warn: (m) => logged.push(`warn ${m}`),
        error: (m) => logged.push(`error ${m}`),
      }),
    },
    getConfig: () => ({
      roles: { 'coder-1': { ref: roleRef } },
      worker: { ladder, stallSec: 30, resumeMax: 2, retryBaseSec: 5, retryCapSec: 10 },
    }),
    modelCache: { get: () => null, noteIssue: (ref, issue) => { noted.push({ ref, issue }); return true; } },
    notify: (ev) => events.push(ev),
  });

  runner.handleTurn('ses_arch', [
    { id: 'u1', type: 'user', created: 1000, parts: [{ type: 'text', text: 'go' }] },
    {
      id: 'a1',
      type: 'assistant',
      created: 3000,
      parts: [{ type: 'tool', name: 'synapse-delegate_delegate', id: `call_${name}`, input: { task: 't1' } }],
    },
  ]);

  if (cancelAfter) {
    setTimeout(() => runner.cancel(dir), cancelAfter);
  }

  // A harness stop is the question-loop guard's verdict: the worker asked the
  // same thing three times and had the answer. It must reach the Architect, so
  // this finds the worker session as soon as the run creates it and stops *it*.
  if (harnessStopAfter) {
    setTimeout(async () => {
      for (let i = 0; i < 50 && sessions.size === 0; i += 1) await sleep(20);
      const workerId = [...sessions.keys()][0];
      if (workerId) runner.stopWithReason(workerId, harnessReason);
    }, harnessStopAfter);
  }

  // Wait for the result line (the run is detached), then for the wake it sends.
  // The stall case needs ~35s of real time, so this is generous on purpose.
  let result = null;
  for (let i = 0; i < 900 && !result; i += 1) {
    await sleep(100);
    if (fs.existsSync(runsFile)) {
      const lines = fs.readFileSync(runsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      result = lines.find((r) => r.kind === 'result') || null;
    }
  }
  for (let i = 0; i < 200 && woke.length < untilWoke; i += 1) await sleep(100);
  await sleep(400);
  const lines = fs.existsSync(runsFile)
    ? fs.readFileSync(runsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { dir, result, runs: lines, woke, descriptions, interrupts, events, noted, logged, created, deleted, prompts, sessions: [...sessions.values()] };
}

const checks = [];
const expect = (label, ok, detail) => checks.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  <- ${detail}` : ''}`);

// 1. classification
expect('rate limit is transient', classifyFailure(RATE).kind === 'transient');
expect('rate limit is named', classifyFailure(RATE).reason === 'rate-limit');
expect('connection is transient', classifyFailure('read ECONNRESET').kind === 'transient');
expect('deprecated is terminal', classifyFailure(DEPRECATED).kind === 'terminal');
expect('a free usage cap is transient, not a rate limit', classifyFailure(FREE_LIMIT).kind === 'transient', JSON.stringify(classifyFailure(FREE_LIMIT)));
expect('and it is named', classifyFailure(FREE_LIMIT).reason === 'usage-limit');
expect(
  'a compaction that produced no summary is named',
  classifyFailure('Compaction produced no summary').kind === 'transient' &&
    classifyFailure('Compaction produced no summary').reason === 'compaction',
);
expect('invalid key is terminal', classifyFailure('Invalid API key').kind === 'terminal');
expect('bad request is terminal', classifyFailure('Invalid request: text is required').kind === 'terminal');
// A session the operator deleted answers 404. It is terminal, and the runner
// treats `gone` as "stopped", not as an error: a retry cannot reach a session
// that no longer exists, and the work was cancelled on purpose.
expect(
  'a deleted session is gone, not transient',
  classifyFailure('POST /api/session/ses_x/synthetic -> 404 Session not found: ses_x').kind === 'terminal' &&
    classifyFailure('POST /api/session/ses_x/synthetic -> 404 Session not found: ses_x').reason === 'gone',
  JSON.stringify(classifyFailure('404 Session not found: ses_x')),
);
expect(
  'a deleted project folder is gone too',
  classifyFailure('LocationNotFoundError: location not found').reason === 'gone',
);
// LM Studio refuses an oversized prompt with a 400 that reads like a bad request.
// It is a context failure: compaction makes it fit, and Shift Test 2 lost a task
// to this exact sentence being classified as terminal.
expect(
  'LM Studio context refusal is a context failure, not terminal',
  classifyFailure(
    'Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (17704 tokens) exceeds the available context size (16384 tokens)"}}',
  ).kind === 'context',
  classifyFailure('request (17704 tokens) exceeds the available context size (16384 tokens)').kind,
);
expect('unknown defaults to transient', classifyFailure('a brand new sentence').kind === 'transient');
// A prompt that does not fit is neither: retrying it cannot help, and it is not
// the end of the run - a compaction makes it fit. Local servers set to "Stop at
// Limit" answer this way, and OpenAI wraps it in a 400, so this rule is tested
// before bad-request.
expect(
  'context overflow is its own kind',
  classifyFailure('This model\'s maximum context length is 39168 tokens. However, you requested 42000 tokens.').kind === 'context',
);
expect(
  'context overflow beats the 400 in the same sentence',
  classifyFailure('400 Bad Request: context_length_exceeded').kind === 'context',
);
expect('the reason is named', classifyFailure('prompt is too long: 42000 tokens').reason === 'context');

// 2. a rate limit is retried, not an attempt
const retried = await runCase({ name: 'retried', script: [{ error: RATE }, {}] });
expect('rate limit: run completes', retried.result?.outcome === 'completed', retried.result?.outcome);
expect('rate limit: one retry recorded', retried.result?.retries === 1, String(retried.result?.retries));
expect('rate limit: model not marked', retried.noted.length === 0, JSON.stringify(retried.noted));
expect('rate limit: same worker session reused', retried.sessions.filter((s) => s.role === 'coder-1').length === 1);
expect(
  'rate limit: a retry event was emitted',
  retried.events.some((e) => e.kind === 'role-error' && e.retrying),
);
expect('rate limit: report delivered to the Architect', retried.woke.some((t) => /finished in/.test(t)), `woke=${retried.woke.length}`);
expect('rate limit: logged to the provider diary', fs.readFileSync(PROVIDER_LOG, 'utf8').includes(`rate-limit`));

// 3. a retired model ends the run and is marked
const dead = await runCase({ name: 'dead', script: [{ error: DEPRECATED }] });
expect('deprecated: outcome error', dead.result?.outcome === 'error', dead.result?.outcome);
expect('deprecated: model marked', dead.noted.some((n) => n.issue.kind === 'provider'));
expect('deprecated: no retry', !dead.result?.retries, String(dead.result?.retries));

// 4. silence: interrupted and resumed, not failed
const stalled = await runCase({ name: 'stalled', script: [{ silent: true }, {}] });
expect('silence: run completes after resume', stalled.result?.outcome === 'completed', stalled.result?.outcome);
expect('silence: one resume recorded', stalled.result?.resumes === 1, String(stalled.result?.resumes));
expect('silence: the worker was interrupted', stalled.interrupts.length >= 1);
expect('silence: logged as stalled', fs.readFileSync(PROVIDER_LOG, 'utf8').includes('stalled'));
// The red "nothing happened — restarting" line must go when the worker starts
// doing something, not when the whole turn ends. One clear is the resume, one is
// the clean turn; before 30 Oct there was only the second.
const stallClears = stalled.events.filter((e) => e.kind === 'role-error' && e.clear).length;
expect('silence: the restart line clears when the worker resumes', stallClears >= 2, `clears=${stallClears}`);

// 5. Stop cuts a backoff short and wakes nobody: Stop means the system is idle.
// It explains nothing to the model either — a stop is a cut, not a story.
const stopped = await runCase({ name: 'stopped', script: [{ error: RATE }], cancelAfter: 900, untilWoke: 0 });
expect('stop: outcome stopped', stopped.result?.outcome === 'stopped', stopped.result?.outcome);
expect('stop: the Architect was not woken', stopped.woke.length === 0, String(stopped.woke.length));
const stoppedBrief = briefSession({ dir: stopped.dir, role: 'architect' });
expect(
  'stop: the brief explains nothing',
  !/stopped by the operator|do not retry/.test(stoppedBrief),
  stoppedBrief.match(/The last run[^\n]*/)?.[0] || '',
);

// 5b. A harness stop with a reason still reports. It used to be handed the run's
// own aborted signal, which wake() reads as "the operator said stop, say
// nothing": the reason was written, logged, and never delivered, so the screen
// said "Waiting on you" with no question to answer (shift-test-5).
const LOOP =
  'Stopped: the worker asked the same question 3 times and had the answer. ' +
  'Question: "Overtime flag style | Invalid input style". The operator answered: "Grouped". ' +
  'Do not re-delegate this task as it is: split it, or make the decision yourself and say what you chose.';
const looped = await runCase({
  name: 'looped',
  script: [{ silent: true }],
  harnessStopAfter: 400,
  harnessReason: LOOP,
});
expect('harness stop: outcome failed', looped.result?.outcome === 'failed', looped.result?.outcome);
expect('harness stop: the reason is the report', looped.result?.text === LOOP, String(looped.result?.text).slice(0, 200) || looped.logged.join(' / '));
expect('harness stop: the Architect was told', looped.woke.length === 1, `woke=${looped.woke.length}`);
expect(
  'harness stop: the report says who stopped it',
  /stopped by the harness, not by the operator/.test(looped.woke[0] || ''),
  (looped.woke[0] || '').slice(0, 80),
);
expect('harness stop: the reason survives the trip', /asked the same question/.test(looped.woke[0] || ''), (looped.woke[0] || '').slice(-260));
expect(
  // This is the header of the yellow Synapse line in the chat: it is what the
  // operator reads first, so it must name the stop rather than say "failed".
  'harness stop: the chat header names it',
  /stopped by the harness/.test(looped.descriptions[0] || ''),
  looped.descriptions[0],
);
expect(
  'harness stop: it is not called "could not run"',
  !/could not run/.test(looped.woke[0] || ''),
  (looped.woke[0] || '').slice(0, 80),
);
expect(
  'harness stop: the operator is told',
  looped.events.some((e) => e.kind === 'note' && /Harness/.test(e.title || '')),
);

// 6. the Architect's failed wake is retried
const woken = await runCase({ name: 'woken', script: [{}], wakeScript: [{ error: RATE }, {}], untilWoke: 2 });
expect('wake: sent twice', woken.woke.length === 2, String(woken.woke.length));
expect('wake: second attempt says continue', /continue/i.test(woken.woke[1] || ''));
expect(
  'wake: retry announced',
  woken.events.some((e) => e.kind === 'role-error' && e.role === 'architect' && e.retrying),
);

// 7. a failed compaction replaces the worker session with a handover
const reset = await runCase({
  name: 'compaction-reset',
  script: [{ error: 'Compaction produced no summary', text: 'The frame is half built.' }, {}],
});
expect('compaction reset: the run completed', reset.result?.outcome === 'completed', reset.result?.outcome);
expect('compaction reset: a second session was created', reset.created.length === 2, String(reset.created.length));
expect('compaction reset: the old session was deleted', reset.deleted.length === 1, String(reset.deleted.length));
const handover = reset.prompts.at(-1)?.text || '';
expect('compaction reset: the handover names the replacement', /replaced because/.test(handover), handover.slice(0, 100));
expect('compaction reset: the files are the state', /files are the work/.test(handover));
expect("compaction reset: the worker's last words carry over", /The frame is half built/.test(handover));
expect('compaction reset: it says not to repeat work', /Do not repeat finished work/.test(handover));

// 8. a provider context-limit error takes the same road: a fresh worker with the
// handover, not the engine's compaction of the transcript that was just refused.
const ctxReset = await runCase({
  name: 'context-reset',
  script: [{ error: "This model's maximum context length is 4096 tokens. However, your messages resulted in 6000 tokens." }, {}],
});
expect('context reset: the run completed', ctxReset.result?.outcome === 'completed', ctxReset.result?.outcome);
expect('context reset: a second session was created', ctxReset.created.length === 2, String(ctxReset.created.length));
expect('context reset: the old session was deleted', ctxReset.deleted.length === 1, String(ctxReset.deleted.length));
expect(
  'context reset: the handover says the prompt was too large',
  /larger than the model window/.test(ctxReset.prompts.at(-1)?.text || ''),
  (ctxReset.prompts.at(-1)?.text || '').slice(0, 120),
);

// restore the operator's diary — a test must not write into a month of evidence
if (logBefore === null) fs.rmSync(PROVIDER_LOG, { force: true });
else fs.writeFileSync(PROVIDER_LOG, logBefore, 'utf8');

console.log(checks.join('\n'));
const failed = checks.filter((c) => c.startsWith('FAIL')).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
