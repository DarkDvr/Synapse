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
import { classifyFailure, PROVIDER_LOG } from '../src/provider-errors.js';

const ROOT = path.join(os.tmpdir(), 'synapse-provider-test');
const RATE = 'Rate limit exceeded. Please try again later.';
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
  const interrupts = [];
  let seq = 0;

  const startTurn = (id) => {
    const s = sessions.get(id);
    const step = s.script.length > 1 ? s.script.shift() : s.script[0];
    if (!step || step.silent) return;
    const n = (s.turn = (s.turn || 0) + 1);
    setTimeout(() => {
      if (!sessions.has(id)) return;
      const err = step.error || null;
      s.messages.push({ id: `${id}-a${n}`, type: 'assistant', parts: [{ type: 'text', text: err ? '' : 'done' }], completed: Date.now(), error: err });
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
      sessions.set(id, { role: metadata?.synapse?.role || null, model: model?.ref || null, messages: [], script: [...script] });
      return { id };
    },
    async setInstruction() {},
    async prompt(id, text) {
      push(id, { id: `${id}-u`, type: 'user', parts: [{ type: 'text', text }] });
    },
    async synthetic(id, text) {
      if (!sessions.has(id)) sessions.set(id, { messages: [], script: [...wakeScript] });
      woke.push(text);
      push(id, { id: `${id}-s${woke.length}`, type: 'synthetic', parts: [{ type: 'text', text }] });
    },
    async getMessages(id) {
      const s = sessions.get(id);
      return s ? [...s.messages] : [];
    },
    async interrupt(id) { interrupts.push(id); },
    async updateSessionPermissions() {},
  };
  return { engine, sessions, woke, interrupts };
}

async function runCase({ name, script, wakeScript = [{}], ladder = ['coder-1'], roleRef = 'opencode/deepseek-v4.1-flash-free', cancelAfter = 0, untilWoke = 1 }) {
  const dir = project(name);
  const runsFile = path.join(dir, '.synapse', 'runs.jsonl');
  const { engine, sessions, woke, interrupts } = makeEngine({ dir, script, wakeScript });
  const events = [];
  const noted = [];
  const runner = createRunner({
    engine,
    logger: { channel: () => quiet },
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
  return { dir, result, runs: lines, woke, interrupts, events, noted, sessions: [...sessions.values()] };
}

const checks = [];
const expect = (label, ok, detail) => checks.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  <- ${detail}` : ''}`);

// 1. classification
expect('rate limit is transient', classifyFailure(RATE).kind === 'transient');
expect('rate limit is named', classifyFailure(RATE).reason === 'rate-limit');
expect('connection is transient', classifyFailure('read ECONNRESET').kind === 'transient');
expect('deprecated is terminal', classifyFailure(DEPRECATED).kind === 'terminal');
expect('invalid key is terminal', classifyFailure('Invalid API key').kind === 'terminal');
expect('bad request is terminal', classifyFailure('Invalid request: text is required').kind === 'terminal');
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

// 5. Stop cuts a backoff short and does not wake the Architect
const stopped = await runCase({ name: 'stopped', script: [{ error: RATE }], cancelAfter: 900, untilWoke: 0 });
expect('stop: outcome stopped', stopped.result?.outcome === 'stopped', stopped.result?.outcome);
expect('stop: the Architect was not woken', stopped.woke.length === 0, String(stopped.woke.length));

// 6. the Architect's failed wake is retried
const woken = await runCase({ name: 'woken', script: [{}], wakeScript: [{ error: RATE }, {}], untilWoke: 2 });
expect('wake: sent twice', woken.woke.length === 2, String(woken.woke.length));
expect('wake: second attempt says continue', /continue/i.test(woken.woke[1] || ''));
expect(
  'wake: retry announced',
  woken.events.some((e) => e.kind === 'role-error' && e.role === 'architect' && e.retrying),
);

// restore the operator's diary — a test must not write into a month of evidence
if (logBefore === null) fs.rmSync(PROVIDER_LOG, { force: true });
else fs.writeFileSync(PROVIDER_LOG, logBefore, 'utf8');

console.log(checks.join('\n'));
const failed = checks.filter((c) => c.startsWith('FAIL')).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
