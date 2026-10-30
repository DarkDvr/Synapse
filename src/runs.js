// The delegation runner: what the harness does when the Architect asks for work.
//
// The Architect calls the `delegate` tool with a task id. That tool is stateless
// on purpose — it cannot run anything and cannot see which session called it — so
// the request is picked up from the transcript on the turn boundary, the same way
// the census reads tool calls. The harness then does what a harness is for:
//
//   create a real session for that task's role, on that role's own model and
//   thinking effort → brief it → run it → record what actually happened →
//   report back to the Architect, waking it with a synthetic message so nobody
//   has to type "go on" for the loop to continue.
//
// Three rules this file exists to keep:
//
//   - **The Architect stays the only writer of the plan.** A worker is told the
//     plan is read-only, is handed only its own task, and never needs to open it.
//     If the file changes during a worker's turn, that is logged and reported as
//     suspicious rather than accepted.
//   - **A worker's "done" is a claim, not a verdict.** The harness records facts;
//     the Architect judges and moves the task. Nothing here marks a plan task
//     complete, ever.
//   - **A request is answered once.** The request is written to the run log by its
//     tool-call id before the worker starts, so a restart, a re-scan of the same
//     transcript, or a second event for the same turn cannot run it twice.
import {
  readPlan,
  briefSession,
  appendRun,
  readRuns,
  qcRoundsUsed,
  closeRound,
  sinceRoundClosed,
  QC_ROUNDS,
  planFingerprint,
  BRIEF_KEY,
  PLAN_DIR,
  roleWriteRules,
  roleReadRules,
  synapseFingerprint,
  fingerprintDiff,
  ownedFolder,
  SHARED_DIR,
  setTaskStatus,
  openDelegations,
} from './plans.js';
import { skillRules, describeSkills, roleMustLoad } from './skills.js';
import { rulesFor } from './permissions.js';
import { configSavedAt } from './config.js';
import { sweepProject, sweepScratch } from './cleanup.js';
import { classifyFailure, recordProviderError, pruneProviderLog } from './provider-errors.js';
import { providerLoadedWindow, providerType } from './providers.js';

const POLL_MS = 1500;
const RESULT_MAX = 4000;
const NOTE_MAX = 1000;

// The ledger owns the round boundary (plans.js); callers and tests still reach
// the counters through the runner module.
export { qcRoundsUsed, closeRound };// A task that keeps coming back gets escalated instead of retried forever. The
// Architect is told, and it is the Architect that marks the task blocked — the
// harness never writes the plan, and never decides a task is hopeless.
const MAX_ATTEMPTS = 3;
// A provider's free-plan usage cap can clear on its own, so it is retried — but
// not for ever. Ten minutes is long enough for the rolling window that let t8
// recover (~5 minutes) and short enough that a dead cap does not hold the
// project busy for an hour (t9 retried 13 times over 51 minutes).
const USAGE_LIMIT_MS = 10 * 60 * 1000;
// The QC loop's three rounds and the round boundary live with the ledger, in
// plans.js: `qcRoundsUsed`, `closeRound` and `sinceRoundClosed`. What is left
// here is the runner's use of them.
// Written by Synapse itself on every run, so a change to one of these is never a
// worker's doing. plan.json is reported separately (planTouched), which is why it
// is ignored here rather than alarming twice.
const HARNESS_FILES = new Set(['plan.json', 'runs.jsonl', 'requirement.md', 'decisions.md']);
// Fallbacks only: the real numbers come from config (`worker.*`).
const DEFAULT_STALL_SEC = 600;
const DEFAULT_RESUME_MAX = 4;
const DEFAULT_RETRY_BASE_SEC = 10;
const DEFAULT_RETRY_CAP_SEC = 300;
const MAX_RESUME_MAX = 20;
const MAX_STALL_SEC = 7200;
const MAX_RETRY_CAP_SEC = 3600;

// The peer ladder: roles that can stand in for one another, in escalation order.
// A task is written for one role, and the harness moves the same task down the
// line when that role cannot do the job — the Architect cannot make that call,
// because the first thing it ever learns about a refused model is a report saying
// nothing happened. Configurable as `worker.ladder`; a role not in it is tried on
// its own.
const DEFAULT_LADDER = ['coder-1', 'coder-2', 'coder-3'];

/**
 * Which rungs this attempt may use, starting with the one it starts on.
 *
 * `stepDown` is the only thing that moves a task down the ladder, and it is true
 * only when the previous attempt actually failed — not when the same coder
 * completed the work and the Architect wants it changed. Exported so the rule can
 * be asserted without a runner: it is one line, and one line that decides who
 * spends the next twenty minutes.
 */
export function nextRung(role, attempt, { stepDown = false, ladder = DEFAULT_LADDER } = {}) {
  const at = ladder.indexOf(role);
  if (at === -1) return [role];
  const room = Math.max(0, ladder.length - at - 1);
  const skip = stepDown ? Math.min(Math.max(0, (attempt || 1) - 1), room) : 0;
  return ladder.slice(at + skip);
}

// What the harness says when it restarts a turn. Short deliberately: the whole
// conversation is already in the session, and repeating the brief would invite
// the model to start over.
const STALL_NUDGE =
  'You were interrupted because nothing had changed in your session for a long time. ' +
  'Continue from exactly where you left off; do not start over and do not redo work that is already done.';
const RETRY_NUDGE =
  'Continue from where you left off. The previous turn was cut short by the provider, not by the operator. ' +
  'Do not start over.';
const WAKE_NUDGE =
  'Your previous turn was cut short by the provider, not by the operator. The report above still needs your ' +
  'judgement: continue from where you left off.';
// After a context-limit error the transcript has been summarised, so the request
// that failed is gone; what must not happen is the model reading that as "start
// again" and redoing work the summary already accounts for.
const CONTEXT_NUDGE =
  'Your last request was larger than the model\'s context window, so the conversation has just been summarised ' +
  'and you are continuing from that summary. Carry on with the task from where it stands - do not start over - ' +
  'and keep each turn small: read only what you need and write in short pieces.';

// The first Stop is graceful: finish the step in flight, then cut the turn at
// the boundary — like a dropped connection, with nothing said to the model. The
// second Stop is the old hard abort. This is a cap, not the mechanism.
export const STOP_GRACE_MS = 45_000;

/** Sleep, but let Stop cut it short: a five-minute backoff must not be five
 *  minutes of the operator pressing a button that does nothing. */
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener?.('abort', done, { once: true });
  });

// MCP tools arrive namespaced (`synapse-delegate_delegate`): match by suffix.
const isDelegate = (name) => {
  const n = String(name || '');
  return n === 'delegate' || n.endsWith('_delegate');
};

/** The tool input may arrive as an object or as a JSON string. */
function parseInput(input) {
  if (input && typeof input === 'object') return input;
  if (typeof input !== 'string') return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What a run cost in context, from the engine's own accounting.
 *
 * A worker's opening prompt is small — 7-8k tokens on the clock project — and its
 * transcript is not: the tasks that ran long finished at 200-290k and generated at
 * less than half the speed of the short ones, because every turn re-reads
 * everything before it, thinking included. Only the harness can see this, so it
 * says so: the Architect uses it to split the next task, and the run line keeps it
 * for the audit afterwards.
 *
 * `peak` is input + cache.read — the whole prompt of the biggest turn, cached or
 * not. `generated` is what the model wrote, thinking included.
 */
export function contextStats(messages) {
  let turns = 0;
  let peak = 0;
  let prompt = 0;
  let generated = 0;
  let thinking = 0;
  let thinkingChars = 0;
  let compactions = 0;
  for (const m of messages || []) {
    if (m.type === 'compaction') compactions += 1;
    if (m.type !== 'assistant') continue;
    // The reasoning block's own text, so a provider that reports no reasoning
    // tokens can still be described truthfully instead of as "0% thinking".
    for (const p of m.parts || []) {
      if (p?.type === 'reasoning') thinkingChars += String(p.text || '').length;
    }
    const t = m.raw?.tokens;
    if (!t) continue;
    turns += 1;
    const sent = (t.input || 0) + (t.cache?.read || 0);
    peak = Math.max(peak, sent);
    // Everything the provider was asked to read, summed over the run. This is the
    // number a free tier meters: a worker re-sends its whole transcript on every
    // turn, so 84 turns at 200k is 13.7M prompt tokens in half an hour — an order
    // of magnitude more per minute than an interactive chat, and the reason a
    // quota that looks untouched in a desktop app runs out under a build.
    prompt += sent;
    generated += (t.output || 0) + (t.reasoning || 0);
    thinking += t.reasoning || 0;
  }
  return {
    turns,
    peak,
    prompt,
    generated,
    thinking,
    thinkingChars,
    compactions,
    thinkShare: generated ? Math.round((thinking / generated) * 100) : 0,
    // The provider did not split thinking out of the answer: it is in `generated`
    // (so the total is right) but saying "0% thinking" would be a claim we cannot
    // make. Measured 23 Oct on a model whose own log showed 43k characters of
    // thinking in one turn while the engine reported `reasoning: 0`.
    thinkUnsplit: thinking === 0 && thinkingChars > 0,
  };
}

/**
 * There is deliberately no tokens-per-second figure here.
 *
 * The obvious one — the last turn's written tokens over `time.created` to
 * `time.streamed` — was wrong, and measurably so: on 27 Oct a turn the model
 * server clocked at 72.8 tok/s read 6.1 s for 169 tokens (28 tok/s) because the
 * window starts when the engine stamps the message, before it assembles a 97k
 * token prompt. The overhead is proportional to the transcript, so the number
 * drifted as a run grew. The only honest measurement is the stream's own first
 * and last piece, which the page sees and this file does not; it lives in
 * `web/app.js`. Do not reintroduce one from timestamps here.
 */

/** "23% thinking", or the truth when the provider did not separate it. */
export const thinkNote = (context) =>
  context?.thinkUnsplit ? 'thinking included, not counted separately' : `${context?.thinkShare || 0}% thinking`;

/** Token counts read as words, not as digits: 212k, 1.4M. */
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

/**
 * Did this write land outside the project folder?
 *
 * Relative paths are inside by definition: the worker's own working directory is
 * the project. Only an absolute path that is not under it counts, and the
 * comparison is done on forward slashes in one case, because Windows gives the
 * same folder in three spellings and a false "outside" is worse than none.
 */
export function outsideProject(file, dir) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const target = norm(file);
  if (!/^[a-z]:\//i.test(target)) return false;
  const root = norm(dir).replace(/\/+$/, '');
  return Boolean(root) && !target.startsWith(`${root}/`);
}

/**
 * Attempts a task has really spent.
 *
 * A refusal is not an attempt (it is recorded without an `attempt` number), and
 * neither is a run that did not get to fail: the operator stopped it, or Synapse
 * restarted under it. Counting those spent t1's whole budget on two stops and one
 * real run, and it is what pushed t3 off coder-2 after a restart — the ladder
 * stepped down for an interruption the role never caused.
 *
 * Only this round counts. Task ids are reused by every new plan (t1, t2, …), and
 * without the round boundary a project that ran four bugfix rounds reached the cap
 * on a task whose every attempt succeeded.
 */
export function countedAttempts(history, taskId) {
  const spent = sinceRoundClosed(history);
  const unspent = new Set(
    spent
      .filter((r) => r.kind === 'result' && (r.outcome === 'stopped' || r.outcome === 'interrupted'))
      .map((r) => r.callId),
  );
  return spent.filter(
    (r) => r.kind === 'delegate' && r.task === taskId && typeof r.attempt === 'number' && !unspent.has(r.callId),
  ).length;
}

/** Did this finished run count as a failed attempt for the role?
 *
 *  Only a run that got to fail does. A completed run, an operator's Stop and a
 *  restart are all "the role did not fail": stepping the task down for them sends
 *  it to the next coder for a reason the coder had no part in.
 */
const NOT_A_FAILURE = new Set(['completed', 'stopped', 'interrupted']);
export function attemptFailed(result) {
  return Boolean(result && !NOT_A_FAILURE.has(String(result.outcome || '')));
}

/** Has the planned role's model changed since it last tried this task?
 *
 *  A task's attempts are attempts on the model it was given. When the operator
 *  changes that role's model, the earlier failures belong to the old model: the
 *  task starts fresh, on the role they fixed, instead of being pushed further
 *  down a ladder for a model that is no longer selected.
 */
export function modelChangedSinceAttempt(history, taskId, role, ref) {
  if (!ref) return false;
  const modelByCall = new Map(
    (history || []).filter((r) => r.kind === 'delegate' && r.callId).map((r) => [r.callId, r.model || null]),
  );
  const last = (history || [])
    .filter((r) => r.kind === 'result' && r.task === taskId && r.role === role)
    .pop();
  if (!last) return false;
  const used = modelByCall.get(last.callId);
  return Boolean(used && used !== ref);
}

/** A role that finished its work on a marked model has proved the mark wrong.
 *
 *  The operator's rule: the badge clears when the model delivers, not when they
 *  remember to clear it. Only a completed run counts — a test is not work, and a
 *  model change is not evidence. Returns whether a mark was actually cleared.
 */
export function redeemModel({ outcome, modelRef, modelCache, notify, log } = {}) {
  if (outcome !== 'completed' || !modelRef || !modelCache?.clearIssues) return false;
  try {
    if (!modelCache.clearIssues(modelRef)) return false;
    notify?.({ kind: 'model', type: 'issues', ref: modelRef });
    log?.info?.(`model ${modelRef} redeemed: a completed run cleared its issue mark`);
    return true;
  } catch {
    return false; // the badge is not worth failing a run over
  }
}

/**
 * Which number a model's window is, given four claims about it.
 *
 * The order is the whole rule, and every step of it was earned:
 *  1. **loaded** — what a local runtime has actually reserved. A measurement, so
 *     it beats every claim, in both directions (Bionic: 42k in the config, 60,160
 *     loaded, and the smaller number was used for weeks).
 *  2. **override** — the operator's own `modelLimits` entry. It exists because a
 *     catalog can be wrong on the low side and was boundary-tested by hand: the
 *     engine's config takes `limit.context` per model, and DeepSeek V4.1 Flash
 *     Free serves 1,048,576 where the catalog says 200k. A refusal must NOT undo
 *     this one — the override is a deliberate test, and a provider's bad minute is
 *     not a verdict on it.
 *  3. **refused** — the size of a prompt the provider actually rejected. That is
 *     the only measurement a hosted model gives, and it beats a catalog claim that
 *     is larger than it.
 *  4. **catalog** — what the engine says, which is what we started with.
 */
export function resolveWindow({ override = 0, loaded = 0, refused = 0, catalog = 0 } = {}) {
  const n = (v) => Number(v) || 0;
  const o = n(override);
  const l = n(loaded);
  const r = n(refused);
  const c = n(catalog);
  if (l) return l;
  if (o) return o;
  if (r && (!c || r < c)) return r;
  return c;
}

/**
 * How big the last prompt this session sent was, in tokens.
 *
 * The whole prompt, cached or not: `input` plus `cache.read`. That is the number
 * the window is measured against, and the number the operator wants beside the
 * rate, not the delta since the previous turn.
 */
export function promptSize(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.type === 'assistant' && m.raw?.tokens);
  const t = last?.raw?.tokens;
  return t ? (t.input || 0) + (t.cache?.read || 0) : 0;
}

/**
 * Every compaction in a transcript, with the size that went with it.
 *
 * A compaction is a real message the engine writes (`type: 'compaction'`), so
 * counting them needs nothing from the provider. The size shown beside it is the
 * prompt the engine *sent to write the summary* — that is the whole history as it
 * stood when the decision was made. Reading the last step's prompt instead (what
 * this used to do) is one tool result behind: it reported "context at 38k" for a
 * compaction the engine fired at 44k, which reads like a bug in the engine and is
 * really a bug in the label.
 *
 * **A compaction that is still running does not count.** The engine writes the
 * message when it starts (`status: 'running'`), keeps it while it summarizes and
 * marks it `completed` at the end. Counting it early made the tally disagree with
 * itself wherever the two are added together: the line in the chat says "this is
 * number N", built as *finished so far + 1*, and a running one already in the
 * transcript made that one too high while the operator was watching the real thing.
 */
export function compactionEvents(messages) {
  const out = [];
  let used = 0;
  for (const m of messages || []) {
    if (m.type === 'assistant' && m.raw?.tokens) {
      const t = m.raw.tokens;
      used = (t.input || 0) + (t.cache?.read || 0);
    } else if (m.type === 'compaction') {
      // A failed compaction is not a compaction: the engine tried to summarize,
      // the prompt was too large and it produced nothing. Counting it inflated
      // "Compacted ×4" to a fourth that never happened and labelled the run with
      // the failed prompt's 225K on a 131K window (28 Oct, t2).
      if (m.raw?.status === 'running' || m.raw?.status === 'failed') continue;
      const t = m.raw?.tokens;
      const sent = t ? (t.input || 0) + (t.cache?.read || 0) : 0;
      out.push({ used: sent || used });
    }
  }
  return out;
}

/** Every compaction message, running or not — what the watchdog needs to know a
 *  compaction has begun, rather than how many have finished. */
export function compactionMessages(messages) {
  return (messages || []).filter((m) => m.type === 'compaction');
}

/**
 * The last substantive thing a worker said, for a handover after its session is
 * replaced. Only text parts count; a tool call's output is already on disk.
 * Bounded: the handover must stay small enough to fit the fresh window.
 */
export function lastAssistantText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.type !== 'assistant') continue;
    const text = (m.parts || [])
      .filter((p) => p?.type === 'text' && p.text)
      .map((p) => String(p.text))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text.slice(0, 1200);
  }
  return '';
}

/**
 * How much of a model's window a prompt may use before it is full.
 *
 * The next turn needs room for its own output and for the tool results it will
 * pull in, so the ceiling is the window minus the model's output limit minus a
 * slice (5%, floor 6k). Deliberately derived from the model's own numbers: 1M
 * hosted models and 62k local ones both land on something sane, and a model whose
 * window nobody recorded gets no ceiling at all rather than a guessed one.
 *
 * The floor was 8k. It is 6k because Shift Test 3 never filled the extra 2k: the
 * biggest prompt a local 42k model accepted was 31,902 tokens, with no truncation
 * and no error, while the watchdog compacted at 26,048. The output limit is
 * already subtracted on top of this, so this floor is a second reserve for tool
 * results, not the output budget.
 */
export function windowRoom({ context, output } = {}) {
  if (!Number(context)) return 0;
  const slack = Math.max(6000, Math.round(context * 0.05));
  return Math.max(0, context - (Number(output) || 0) - slack);
}

/**
 * Where the engine compacts by itself, read from its own rule.
 *
 * `@opencode/SessionCompaction`, 2.1.2: it fires at `context − max(15%, 16,000)`.
 * On a 60,160 window that is 44,160; on 1,048,576 it is 891,290. Written down here
 * because the watchdog has to know it: two guards with their own numbers, ~1,800
 * tokens apart, is a race, and the engine won it.
 */
export function engineCompactAt({ context } = {}) {
  const c = Number(context) || 0;
  if (!c) return 0;
  const reserve = Math.max(Math.floor(c * 0.15), c >= 32000 ? 16000 : 0);
  return Math.max(0, c - reserve);
}

/**
 * Where *our* backstop sits — above the engine's trigger, never beside it.
 *
 * This is a safeguard for the case the engine cannot see the truth (a window it
 * was told wrongly, or a provider that refuses what the catalog promised), so by
 * definition it must act only after the engine's own rule has had its turn. On 23
 * Oct the two sat 1,808 tokens apart and both fired: the engine compacted at
 * 46,329, our request was queued one second later, and it ran four minutes later
 * against the fresh 10,986-token transcript — a compaction of nothing, on the
 * operator's log, for no reason.
 */
export function watchdogRoom({ context, output } = {}) {
  const base = windowRoom({ context, output });
  const engine = engineCompactAt({ context });
  if (!engine) return base;
  return Math.max(base, engine + Math.max(2000, Math.round((Number(context) || 0) * 0.05)));
}

// Turns at which a worker is asked, once, whether it is done. Not a limit and not
// a kill: the model decides, and a task that genuinely needs more carries on.
// Clock Test 3's designer was finished by turn ~50 and ran to 92 — the last twenty
// minutes moved a value by 0.04% and re-rendered to look at it.
const TURN_STEERS = [40, 90];

/** Which steer is due, given how many turns a session has taken. */
export const steerDue = (turns, sent) =>
  TURN_STEERS[sent] && turns >= TURN_STEERS[sent] ? TURN_STEERS[sent] : null;

/**
 * What the window watchdog should do on this poll.
 *
 * `armed` is the whole state machine: ask once when the prompt reaches the room,
 * then stay quiet until the transcript has actually shrunk (a compaction that did
 * not take must not become a request every 1.5 seconds).
 */
export function windowAction(state, ctx, room) {
  if (!room || !ctx || state?.off) return 'none';
  if (state.armed) return ctx >= room ? 'compact' : 'none';
  return ctx < room * 0.7 ? 'arm' : 'none';
}

export function createRunner({ engine, logger, getConfig, guard, notify, modelCache, onModelWindow }) {
  const log = logger.channel('tools');
  // The same milestones into the app channel, which is mirrored to the console:
  // a bat file leaves a window open all day, and "what is it doing" should be
  // answerable by looking at it rather than by opening a log file.
  const out = logger.channel('app');
  // One worker per project at a time: two Architects on the same plan is the
  // one thing that can actually corrupt it.
  const busy = new Set();
  // Requests picked up in this process, so a transcript re-read cannot re-run one.
  const claimed = new Set();
  // Projects whose leftovers have already been swept, so a finished plan that is
  // opened again does not go hunting every time a note is added.
  const cleaned = new Set();
  // Steps the Architect has already been reminded about, keyed `${dir}|${task}`.
  // One reminder each: the point is to break a silence, not to nag a model that
  // has read the message and decided otherwise.
  const nudged = new Set();
  // What is running right now, keyed by directory. The UI draws the cards' state
  // and the live path from this; it is also served over HTTP so a page reload
  // mid-run does not lose the picture.
  const running = new Map();
  // One stop button per live run: Stop must cut a backoff short, not wait it out.
  const controls = new Map();
  // Projects the operator has stopped. Nothing is delegated and no reminder is
  // sent until they speak again: their next message is the answer to "what now".
  const stoppedByOperator = new Set();
  const dirKey = (d) => String(d ?? '').replace(/[\\/]+$/, '').toLowerCase();

  /** The worker settings, read once per decision so a change lands next time. */
  function workerSettings(config) {
    const w = config?.worker || {};
    const num = (v, lo, hi, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
    };
    return {
      stallSec: num(w.stallSec, 30, MAX_STALL_SEC, DEFAULT_STALL_SEC),
      resumeMax: num(w.resumeMax, 0, MAX_RESUME_MAX, DEFAULT_RESUME_MAX),
      retryBaseSec: num(w.retryBaseSec, 5, 300, DEFAULT_RETRY_BASE_SEC),
      retryCapSec: num(w.retryCapSec, 10, MAX_RETRY_CAP_SEC, DEFAULT_RETRY_CAP_SEC),
    };
  }

  /** Wait before retry number `n`, 1-based: 10s, 20s, 40s … capped, ±20% jitter
   *  so two roles retrying together do not arrive in lockstep. */
  function backoffMs(n, settings) {
    const raw = Math.min(settings.retryCapSec, settings.retryBaseSec * 2 ** Math.max(0, n - 1));
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(raw * 1000 * jitter);
  }

  /** Has this role's model already been refused outright — deprecated, or unable
   *  to drive the critical tools? A provider *rate limit* is not a mark: it is a
   *  bad minute, and the next attempt may be fine. */
  function providerMarked(roleId, config) {
    const ref = config?.roles?.[roleId]?.ref;
    if (!ref || !modelCache?.get) return false;
    return Boolean(
      modelCache.get(ref)?.issues?.some((i) => i.kind === 'provider' || i.kind === 'tools'),
    );
  }

  /** Did the operator speak after the last report?
   *
   *  The harness's wakes are `synthetic`, so the newest timestamp of each type
   *  answers it with no stored state: a `user` message newer than the newest
   *  `synthetic` means the operator has said something since the work was reported
   *  back. Timestamps rather than array order, because the engine returns messages
   *  newest-first.
   */
  function operatorSpokeSince(messages) {
    let lastUser = 0;
    let lastReport = 0;
    for (const m of messages || []) {
      if (m?.type === 'user') lastUser = Math.max(lastUser, m.created || 0);
      if (m?.type === 'synthetic') lastReport = Math.max(lastReport, m.created || 0);
    }
    return lastUser > lastReport;
  }

  /** The task the runner last reported back for this project, or null. */
  function lastReportedTask(directory) {
    const results = readRuns(directory).filter((r) => r.kind === 'result');
    return results.length ? results[results.length - 1].task : null;
  }

  /**
   * The rungs to try, in order, for this attempt of this task.
   *
   * Three rules, all about a coder that cannot do the job:
   *
   *  - **a failed attempt starts a rung further down.** Not every attempt: a
   *    task the coder *completed* and the Architect sent back with a note is a
   *    task the same coder can finish. The verdict "this coder cannot do it" is
   *    a run that failed or timed out, or a model the provider has refused. In
   *    Shift Test 6 a one-character regex change sent a completed task to a fresh
   *    coder-2 session for 136k tokens of prompt, and coder-1 was told nothing;
   *  - a rung whose model carries a provider mark is skipped, because the provider
   *    has already said it will not run it;
   *  - the next rung is tried after a failure, floored at the last one.
   *
   * A role outside the ladder has no peers and is tried alone.
   */
  function candidatesFor(role, attempt, config, { stepDown = false } = {}) {
    const ladder =
      Array.isArray(config?.worker?.ladder) && config.worker.ladder.length ? config.worker.ladder : DEFAULT_LADDER;
    const rest = nextRung(role, attempt, { stepDown, ladder });
    // A rung whose model the provider has refused is skipped: the provider has
    // already said it will not run it. If every rung is marked, the list is left
    // as it was — a refusal inside the run is a better answer than no attempt.
    const clean = rest.filter((id) => !providerMarked(id, config));
    return clean.length ? clean : rest;
  }

  /** Tell the open UIs what a worker is doing. A broken listener must never
   *  break a run, so this can never throw. */
  const emit = (type, data) => {
    try {
      notify?.({ kind: 'run', type, ...data });
    } catch { /* ignore */ }
  };

  /** A provider failure for a role's card. Deliberately *not* `emit`: that tags
   *  everything `kind: 'run'`, and the UI would read this as a run event. */
  const alert = (data) => {
    try {
      notify?.({ kind: 'role-error', ...data });
    } catch { /* ignore */ }
  };

  /** Delegation requests in a transcript that have not been answered yet. */
  function requestsIn(messages, dir) {
    const handled = new Set(
      readRuns(dir)
        .filter((r) => r.kind === 'delegate')
        .map((r) => r.callId),
    );
    const out = [];
    for (const message of messages || []) {
      for (const part of message?.parts || []) {
        if (part?.type !== 'tool' || !isDelegate(part.name)) continue;
        const callId = part.id;
        if (!callId || handled.has(callId) || claimed.has(callId)) continue;
        const input = parseInput(part.input);
        const task = String(input?.task || '').trim();
        if (!task) continue;
        out.push({ callId, task, note: input.note ? String(input.note).slice(0, NOTE_MAX) : null });
      }
    }
    return out;
  }

  /**
   * Pick up a delegation nobody read.
   *
   * A delegation is read when its turn ends (`session.execution.succeeded` →
   * `handleTurn`). If that turn never comes back — Synapse restarted while the
   * session was waiting on a question, so the engine cancelled the question and
   * the turn has nothing left to finish — the request sits in the transcript for
   * ever: answered "Queued", unjournalled, unrun. The operator then has an
   * Architect that says the work is done, a plan with one task in `todo`, nothing
   * running and nothing to press. That is Fever Tracker on 22 Oct.
   *
   * One pass at boot, over each project's newest conversation. Safe by
   * construction: `requestsIn` only returns calls that are neither journalled nor
   * claimed, and every gate in `handleTurn` still applies — single mode, keep
   * building, an unplanned phase, the QC cap.
   */
  /**
   * Close the runs a previous process left open, and tell the Architect.
   *
   * Measured 26 Oct: t3 started, asked to write outside the project, and Synapse
   * was restarted. The runner died before writing a result, so the record stayed
   * open, the plan said `todo`, and the Architect's last line was "t3 is queued
   * and waiting to run" — a worker that no longer existed. From the operator's
   * seat the Architect was stuck waiting on them.
   *
   * A boot is the one place that knows the truth: nothing is running yet, so a
   * delegate with no result was interrupted. Close it, put the task back to
   * `todo`, hold the project so a wake cannot retry it on its own, and say what
   * happened in the Architect's own transcript.
   */
  async function recoverInterrupted(dirs = []) {
    const closed = [];
    for (const dir of dirs || []) {
      if (!dir) continue;
      for (const entry of openDelegations(readRuns(dir))) {
        appendRun(dir, {
          kind: 'result',
          callId: entry.callId,
          task: entry.task,
          title: entry.title || null,
          role: entry.role || null,
          plannedRole: entry.plannedRole || null,
          // Whose delegation this closes: the plan pane counts a session's own
          // work only, and a restart must not orphan the record from its asker.
          architect: entry.architect || null,
          worker: null,
          outcome: 'interrupted',
          ms: Date.now() - (Number(entry.at) || Date.now()),
          retries: 0,
          resumes: 0,
          error: 'Synapse restarted while this task was running',
          files: [],
          text: '',
          planTouched: false,
          synapseTouched: [],
          filesOutside: [],
        });
        setTaskStatus(dir, entry.task, 'todo');
        hold(dir, 'interrupted by a restart');
        closed.push({ ...entry, dir });
        out.warn(
          `run ${entry.task} (${entry.role || 'worker'}) was interrupted by a restart - closed, back to todo`,
        );
      }
    }
    if (!closed.length) return 0;

    // One message per Architect, however many of its runs were open.
    const byArchitect = new Map();
    for (const entry of closed) {
      if (!entry.architect) continue;
      if (!byArchitect.has(entry.architect)) byArchitect.set(entry.architect, []);
      byArchitect.get(entry.architect).push(entry);
    }
    for (const [architectId, list] of byArchitect) {
      const dir = list[0].dir;
      const what = list.map((e) => `${e.task}${e.title ? ` (${e.title})` : ''}`).join(', ');
      try {
        await wake(architectId, dir, {
          description: 'run interrupted by a restart',
          text:
            `Synapse restarted while ${what} was running, so the worker did not finish. ` +
            `Nothing is running now and the task is back in todo. Do not retry it on your own - ` +
            `tell the operator it was interrupted and wait for their instruction.`,
        });
      } catch (err) {
        out.warn(`could not tell the Architect about the interrupted run: ${err.message}`);
      }
    }
    return closed.length;
  }

  /**
   * Replay a report whose wake never landed.
   *
   * The result line is written before the Architect is woken, so a crash between
   * the two leaves a finished run that nobody was told about: the plan says
   * `todo`, no message follows the result, and the screen sits on "Waiting on
   * you" (the emulator project on 29 Oct, t2). The record itself is the tell:
   * a result newer than every message in the Architect's transcript.
   *
   * Only the newest few results of the open round are considered, and only
   * within two days, so an old project does not replay its history at every
   * boot.
   */
  async function recoverLostReports(dirs = []) {
    let replayed = 0;
    for (const dir of dirs || []) {
      if (!dir || running.has(dirKey(dir))) continue;
      const history = readRuns(dir);
      const recent = sinceRoundClosed(history);
      const done = new Set(
        recent.filter((r) => r.kind === 'wake' && r.status === 'done' && r.callId).map((r) => r.callId),
      );
      const results = recent.filter((r) => r.kind === 'result' && r.architect && !done.has(r.callId)).slice(-3);
      for (const result of results) {
        const at = Number(result.at) || 0;
        if (!at || Date.now() - at > 48 * 60 * 60 * 1000) continue;
        let messages = [];
        try {
          messages = await engine.getMessages(result.architect);
        } catch {
          continue;
        }
        if ((messages || []).some((m) => (Number(m.created) || 0) >= at)) continue;
        try {
          await wake(result.architect, dir, {
            description: `run ${result.task} finished but its report was never read`,
            text:
              `A run finished before Synapse restarted, and the report may not have reached you: ` +
              `${result.task} (${result.role || 'worker'}) ${result.outcome || 'finished'}` +
              `${result.error ? ` - ${result.error}` : ''}. Read .synapse/runs.jsonl and judge it; ` +
              `do not assume it succeeded.`,
          });
          appendRun(dir, { kind: 'wake', callId: result.callId, at: Date.now(), status: 'done' });
          replayed += 1;
          out.warn(`replayed the report for ${result.task} (${result.role || 'worker'}) - its wake was never delivered`);
        } catch (err) {
          out.warn(`could not replay the report for ${result.task}: ${err.message}`);
        }
      }
    }
    return replayed;
  }

  async function recoverDelegations(dirs) {
    let picked = 0;
    let sessions = [];
    try {
      sessions = await engine.listSessions();
    } catch {
      return 0;
    }
    for (const dir of dirs || []) {
      if (!dir || running.has(dirKey(dir))) continue;
      const newest = sessions
        .filter((s) => s && s.id && !s.internal && dirKey(s.directory) === dirKey(dir))
        .sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0))[0];
      if (!newest) continue;
      let messages = [];
      try {
        messages = await engine.getMessages(newest.id);
      } catch {
        continue;
      }
      const pending = requestsIn(messages, dir);
      if (!pending.length) continue;
      out.warn(
        `no turn ever read ${pending.length} delegation${pending.length === 1 ? '' : 's'} in ${dir} ` +
          `(${pending.map((r) => r.task).join(', ')}) - reading them now`,
      );
      await handleTurn(newest.id, messages);
      picked += pending.length;
    }
    return picked;
  }

  /**
   * Look for delegation requests in a session's transcript. Called on every
   * finished turn; only a non-internal session (the Architect) can ask for work.
   */
  async function handleTurn(sessionId, messages) {
    try {
      const session = await engine.getSession(sessionId);
      if (!session?.directory || session.internal) return;
      const requests = requestsIn(messages, session.directory);
      // Single mode promises no delegation — that is the whole difference
      // between the two modes. The tool is offered by the engine regardless
      // (tool rulesets cannot see an MCP tool), and its own description tells the
      // model to use it, so the refusal happens here, out loud — and it says what
      // Single is, not what Multi would be: telling it to ask the operator for a
      // mode switch turned one refused call into a question nobody had asked.
      if (session.single) {
        for (const request of requests) {
          claimed.add(request.callId);
          appendRun(session.directory, {
            kind: 'delegate',
            callId: request.callId,
            task: request.task,
            outcome: 'single-mode',
          });
          log.info(`delegation refused: ${request.task} asked in Single mode`);
          await wake(sessionId, session.directory, {
            description: `delegate ${request.task} refused`,
            text:
              `Nothing was run: this is a Single conversation, so there is no team to hand work to. ` +
              `Do ${request.task} yourself, here, with your own tools - and do not delegate again. ` +
              `If the job is genuinely team-sized, say so to the operator; switching to Multi is theirs to decide.`,
          });
        }
        return;
      }
      for (const request of requests) {
        claimed.add(request.callId);
        // The operator stopped the run. A task arriving now is the Architect
        // carrying on by itself, which is the one thing Stop exists to prevent.
        // Recorded rather than refused silently, and no wake: waking it would open
        // another turn to delegate in.
        if (stoppedByOperator.has(dirKey(session.directory))) {
          appendRun(session.directory, {
            kind: 'delegate',
            callId: request.callId,
            task: request.task,
            outcome: 'stopped-by-operator',
          });
          log.info(`delegation refused: ${request.task} - the operator stopped this run`);
          notify?.({
            kind: 'note',
            title: 'Run Stopped',
            body: `${request.task} was not started: the operator stopped this run. Nothing runs until they say what is next.`,
          });
          continue;
        }
        // Keep building is off, and the operator has not spoken since the last
        // report: a delegation now is the model deciding to carry on by itself.
        // A *re-delegation of the task that was just reported* is still allowed —
        // that is a retry, which is the Architect's judgement, not a decision to
        // start the next piece of work. Refused silently: waking it to say "stop"
        // would start another turn it could delegate in again.
        if (!session.auto && !operatorSpokeSince(messages) && lastReportedTask(session.directory) !== request.task) {
          appendRun(session.directory, {
            kind: 'delegate',
            callId: request.callId,
            task: request.task,
            outcome: 'keep-building-off',
          });
          log.info(`delegation refused: ${request.task} while keep building is off`);
          emit('keep-building-refused', { task: request.task, dir: session.directory });
          notify?.({
            kind: 'note',
            title: 'Keep building is off',
            body: `${request.task} was not delegated - the Architect tried to start the next task by itself.`,
          });
          continue;
        }
        // The list is live, so nothing is refused for being incomplete: a work list
        // that grows is the point, and the operator is told in one line what was
        // added (see the brief). Clock Test 3 refused a delegation for this and the
        // rule was right for a plan signed off once; it is wrong for a list that is
        // allowed to grow, and it stopped productive work to enforce a fiction.
        const currentPlan = readPlan(session.directory).plan;

        // The QC loop closes after three completed rounds. A model will keep
        // finding one more issue until the quota is gone; the third report says so
        // too, and this is what makes it true if the model ignores it.
        const asked = (currentPlan?.tasks || []).find((t) => t.id === request.task);
        if (asked?.role === 'qc' && qcRoundsUsed(session.directory) >= QC_ROUNDS) {
          appendRun(session.directory, {
            kind: 'delegate',
            callId: request.callId,
            task: request.task,
            outcome: 'qc-cap',
          });
          log.info(`delegation refused: ${request.task} - ${QC_ROUNDS} QC rounds are already spent`);
          notify?.({
            kind: 'note',
            title: 'QC Loop Capped',
            body: `${QC_ROUNDS} QC rounds are spent on this project, so ${request.task} was not run.`,
          });
          // And it has to be *told*, not just toasted at the operator. The first
          // version of this branch was silent, so the Architect went on believing
          // its check was queued: Fever Tracker's t16 sat in `doing` for hours with
          // nothing running, and a plan with one task unfinished cannot close. The
          // task is the Architect's to settle, and saying so is the whole fix.
          await wake(sessionId, session.directory, {
            description: `delegate ${request.task} refused: QC cap reached`,
            text:
              `Nothing was run: ${QC_ROUNDS} QC rounds are already spent on this project, so ${request.task} will ` +
              `not start however many times it is asked for. Do not wait for it. Settle it yourself: mark it ` +
              `\`blocked\` with a note saying the independent check was not run, or \`done\` if you have verified ` +
              `it yourself and say how - then finish the plan, write its summary, and hand over. Anything still ` +
              `unverified is the operator's to judge, and the plan is how you say so.`,
          });
          continue;
        }
        // Deliberately not awaited: the Architect's turn is over, and the worker
        // reports back through its own message when it is done.
        run(sessionId, session.directory, request).catch((err) =>
          log.warn(`delegation ${request.task} failed: ${err.message}`),
        );      }

      // The Architect asked for nothing this turn. That is usually right — it has
      // just read a report — but twice now it has meant a plan step nobody will
      // ever start: t16 and t19 were both planned, never asked for, and left the
      // project one task short of finished with nothing running.
      if (!requests.length) await remindSkippedWork(session, messages);
    } catch (err) {
      log.warn(`could not look for delegation requests in ${sessionId}: ${err.message}`);
    }
  }

  /**
   * A plan step nobody asked for.
   *
   * A delegation that is never *attempted* cannot be refused, so no gate in this
   * file will notice it: the plan simply sits one task short of finished, nothing
   * is running, and the Architect looks idle next to a task it forgot. This is the
   * one word that notices — after a turn in which the Architect asked for nothing,
   * if a step's dependencies are met and it is still `todo`, say so, once.
   *
   * Quiet unless it is safe to run. It needs keep-building on (otherwise the
   * operator is driving the project turn by turn), an Architect that is not
   * answering the operator, nothing already running in the project, the plan
   * itself whole, and a role whose model the provider has not marked. One reminder
   * per step per process: a model that ignores it is not nagged, and the operator
   * can always say what they want.
   */
  async function remindSkippedWork(session, messages) {
    const dir = session.directory;
    if (!session.auto) return;
    // The operator stopped the run. Nothing starts again, and nobody is nudged,
    // until they say what they want next: a reminder here is the "it retried on
    // its own" that made Stop mean nothing.
    if (stoppedByOperator.has(dirKey(dir))) return;
    if (operatorSpokeSince(messages)) return;
    if (running.has(dirKey(dir))) return;
    const plan = readPlan(dir).plan;
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    if (!tasks.length) return;
    const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));

    // A step the Architect claimed and never started.
    //
    // It says `doing`, so the rule below cannot see it — that one looks for `todo`
    // — and every other gate in this file is about a delegation that was
    // *attempted*. Measured 24 Oct: the Architect wrote "Now delegate t5 with
    // concrete instructions…" as a sentence, ended its turn with no tool call, and
    // the project sat for ten minutes with the plan claiming a task was running and
    // nothing running at all. A sentence about delegating is not a delegation, and
    // only the harness can tell the two apart.
    const claimed = tasks.find((t) => t.status === 'doing' && !nudged.has(`${dirKey(dir)}|doing|${t.id}`));
    if (claimed) {
      nudged.add(`${dirKey(dir)}|doing|${claimed.id}`);
      out.info(`plan says ${claimed.id} (${claimed.role}) is doing, and nothing is running - waking the Architect`);
      await wake(session.id, dir, {
        description: `${claimed.id} is marked doing, but nothing is running`,
        text:
          `The plan says ${claimed.id} is \`doing\`, and nothing is running in this project. Writing that you ` +
          `will delegate is not a delegation: nothing starts until the delegate call is made, in the turn ` +
          `where you decide it. Delegate ${claimed.id} now — or put it back to \`todo\` if it is not next. ` +
          `This is the one reminder the harness gives about it.`,
      });
      return;
    }

    const ready = tasks.find(
      (t) =>
        t.status === 'todo' &&
        !nudged.has(`${dirKey(dir)}|${t.id}`) &&
        (Array.isArray(t.dependsOn) ? t.dependsOn : []).every((d) => done.has(d)),
    );
    if (!ready) return;
    if (providerMarked(ready.role, getConfig() || {})) return;
    nudged.add(`${dirKey(dir)}|${ready.id}`);
    out.info(
      `plan step ${ready.id} (${ready.role}) is ready and was never asked for - reminding the Architect once`,
    );
    await wake(session.id, dir, {
      description: `${ready.id} is ready and was not asked for`,
      text:
        `Nothing is running and ${ready.id} is still to do: its dependencies are met, nothing has asked for ` +
        `it, and the plan cannot finish without it. Start it now - delegate ${ready.id} as the plan has it. ` +
        `If it cannot run - refused, a loop that is capped, or a model the provider has marked - do not wait ` +
        `on it and do not do the work yourself: mark it \`blocked\` with the reason, or \`done\` if you have ` +
        `verified it yourself, and say so in your reply. This is the one reminder the harness gives; nothing ` +
        `else will arrive.`,
    });
  }

  async function run(architectId, dir, request) {
    const plan = readPlan(dir);
    const task = (plan.plan?.tasks || []).find((t) => t.id === request.task);
    const project = dir.split(/[\\/]/).filter(Boolean).pop() || dir;

    if (!task) {
      // Recorded so the same call is not retried forever, and the Architect is
      // told rather than left waiting.
      appendRun(dir, { kind: 'delegate', callId: request.callId, task: request.task, outcome: 'unknown-task' });
      log.warn(`delegation rejected: no task "${request.task}" in ${project}`);
      await wake(architectId, dir, {
        description: `delegate ${request.task} rejected`,
        text:
          `Nothing was run: the plan has no task "${request.task}". ` +
          `Check the id against the plan file and ask again.`,
      });
      return;
    }

    if (busy.has(dir)) {
      // Recorded, not only answered. `requestsIn` treats a journalled call as
      // read, and without a line here the request is replayed by the next boot
      // scan or turn as if nobody had ever seen it: measured 27 Oct, a restart
      // started t5 again from a round the operator had stopped, because its
      // deferral had left no record.
      appendRun(dir, { kind: 'delegate', callId: request.callId, task: request.task, outcome: 'deferred' });
      log.warn(`delegation deferred: a worker is already running in ${project}`);
      await wake(architectId, dir, {
        description: `delegate ${request.task} deferred`,
        text:
          `Nothing was run yet: another task is already running in this project. ` +
          `Ask again when it reports back.`,
      });
      return;
    }

    const config = getConfig() || {};
    // How many times this task has actually been run — see countedAttempts. A
    // model change for the planned role starts the count over: the earlier
    // failures were the old model's, and the operator has fixed it.
    const history = readRuns(dir);
    const plannedRef = config.roles?.[task.role]?.ref || null;
    const modelChanged = modelChangedSinceAttempt(history, task.id, task.role, plannedRef);
    const attempts = modelChanged ? 0 : countedAttempts(history, task.id);
    // What the last attempt actually achieved. Only a real failure moves the task
    // down the ladder; a stop or a restart is not the role's failure.
    const previous = history.filter((r) => r.kind === 'result' && r.task === task.id).pop() || null;
    const stepDown = !modelChanged && attemptFailed(previous);
    if (attempts >= MAX_ATTEMPTS) {
      appendRun(dir, {
        kind: 'delegate',
        callId: request.callId,
        task: task.id,
        role: task.role,
        outcome: 'too-many-attempts',
        attempts,
      });
      log.warn(`delegation refused: ${task.id} has already been attempted ${attempts} times`);
      await wake(architectId, dir, {
        description: `delegate ${task.id} refused`,
        text:
          `Nothing was run: ${task.id} has already been attempted ${attempts} times in this ` +
          `project, and the harness will not keep spending turns on it. Either the task needs to be ` +
          `broken down differently, or a different role or model for it, or the operator needs to ` +
          `decide. Mark ${task.id} blocked with what you have learned and say so to the operator.`,
      });
      return;
    }
    busy.add(dir);

    // Which role gets this attempt, before anything is created: the plan's role is
    // the first rung of its ladder. See candidatesFor().
    const settings = workerSettings(config);
    const candidates = candidatesFor(task.role, attempts + 1, config, { stepDown });
    let role = candidates[0];
    let roleConfig = config.roles?.[role] || {};
    let modelRef = roleConfig.ref || null;
    let variant = roleConfig.variant || null;
    // How long a worker may produce *nothing* before it is interrupted and told to
    // carry on. A role may override it; there is no wall-clock ceiling any more,
    // because a turn that is working is allowed to take as long as it takes.
    let stallSec = Math.max(30, Number(roleConfig.stallSec) || settings.stallSec);
    const fingerprintBefore = planFingerprint(dir);
    const synapseBefore = synapseFingerprint(dir);
    const startedAt = Date.now();
    let worker = null;
    let before = null;
    let outcome = 'failed';
    let text = '';
    let files = [];
    // The subset of `files` that landed outside the project folder; see outsideProject.
    let filesOutside = [];
    let context = null;
    let turnError = null;
    // Who ended a stopped run: the operator's Stop, or a harness guard. Kept
    // apart from `turnError` because a Stop is not a provider failure — the
    // previous attempt's error used to survive into the result line, and the
    // Architect read it as the cause of the stop (29 Oct).
    let stoppedBy = null;
    // The last turn's own error at the moment of the stop, recorded separately so
    // the record can still answer "what was the worker doing".
    let lastTurnError = null;
    // Set when the operator (or the gate) refused a tool: the refusal note is the
    // turn's last word, not a provider failure to retry.
    let declined = false;
    // Skills the brief required and the worker never loaded; see workerSkills.
    let skillsMissing = [];
    let skillsRequired = [];
    // How many times this delegation was rescued rather than abandoned. Recorded
    // on the result line so the morning's log explains a long night.
    let retries = 0;
    let resumes = 0;
    // How many times this task's worker session has been replaced because its
    // transcript outgrew the model window. A fresh session starts with a short
    // handover, so this is a rescue, not a loop; after a few the run reports.
    let resets = 0;
    const RESET_MAX = 3;
    // Stop: the operator's way out of a retry loop that is going nowhere — and
    // the question-loop guard's way out of a worker that keeps asking the same
    // thing. A plain abort leaves the run "stopped"; a stop with a reason says
    // why, and the report carries it to the Architect and the operator.
    const controller = new AbortController();
    let stopReason = null;
    // The first Stop asks the worker to finish the step it is in and end the
    // turn; the second (or the grace running out) aborts it. See requestStop().
    let gracefulStop = false;
    let stopRequestedAt = 0;
    let stopTimer = null;
    controls.set(dirKey(dir), {
      abort: () => controller.abort(),
      stop: (why) => {
        stopReason = String(why || '').trim() || null;
        controller.abort();
      },
      requestStop: async () => {
        if (gracefulStop) return false;
        gracefulStop = true;
        stopRequestedAt = Date.now();
        // Nothing new may be delegated from here, even while the last step runs.
        stoppedByOperator.add(dirKey(dir));
        const liveNow = running.get(dirKey(dir));
        if (liveNow) {
          liveNow.stopping = true;
          liveNow.stopRequestedAt = stopRequestedAt;
          emit('run.stopping', { dir, task: request.task, role, startedAt });
        }
        // The step in flight is the assistant message that is open now. When a
        // different one begins, that step is over: cut the turn there, exactly as
        // a dropped connection would. Nothing is said to the model.
        if (worker?.id) {
          try {
            const messages = await engine.getMessages(worker.id);
            const last = [...messages].reverse().find((m) => m.type === 'assistant');
            if (liveNow) liveNow.stopAssistant = last?.id || null;
          } catch { /* the boundary check falls back to the grace timer */ }
        }
        stopTimer = setTimeout(() => {
          if (!running.has(dirKey(dir))) return;
          out.warn(`graceful stop for ${request.task} took too long; cutting the turn`);
          try { controller.abort(); } catch { /* already gone */ }
          if (worker?.id) engine.interrupt(worker.id).catch(() => { /* already gone */ });
        }, STOP_GRACE_MS);
        stopTimer.unref?.();
        return true;
      },
    });
    const signal = controller.signal;
    // Roles that were tried for this task and refused by their model. The report
    // carries the reason and the cards show it while the run is live.
    const skipped = [];
    // Guidance the operator sent while the worker was working. Each entry is in
    // runs.jsonl as it happens, and the report quotes them: the Architect judges
    // the work against the instruction that was actually in force, not the brief
    // the task started with.
    const steers = [];

    // Written before the worker starts: this is what makes the request answered
    // exactly once, whatever happens next.
    appendRun(dir, {
      kind: 'delegate',
      callId: request.callId,
      task: request.task,
      role,
      plannedRole: task.role,
      title: task.title,
      model: modelRef,
      variant,
      architect: architectId,
      attempt: attempts + 1,
      ladder: candidates,
    });
    log.info(
      `delegation: ${request.task} "${task.title}" -> ${role}` +
        (role === task.role ? '' : ` (planned for ${task.role})`) +
        ` (${modelRef || 'engine default'}${variant ? `#${variant}` : ''}) in ${project}, stall ${stallSec}s`,
    );
    out.info(`run ${request.task} (${role}) started — ${modelRef || 'engine default'} · ${task.title}`);

    // The card that will run this, and the path the UI draws to it. Kept in a
    // map as well as broadcast, so a page reloaded mid-run can ask what is
    // happening rather than showing an idle screen while work is in flight.
    const live = {
      dir,
      role,
      task: task.id,
      title: task.title,
      architect: architectId,
      model: modelRef,
      variant,
      startedAt,
      stallSec,
      workerId: null,
      retry: null,
      tool: null,
      skipped,
      stopping: false,
      stopRequestedAt: 0,
      stopAssistant: null,
      // The operator's guidance for this run, newest last. Shared with the local
      // `steers` array so the report and the result line read the same record.
      steers,
      steered: 0,
    };
    running.set(dirKey(dir), live);
    emit('run.started', live);

    // A restore point first, then a clean baseline: the harness is committed as it
    // stands, so anything it shows once the worker has stopped is the worker's
    // doing and can be put back. Both calls are cheap and neither is on the
    // worker's critical path — the snapshot is one `git add -u` + commit in the
    // harness repository, which a project never lives inside.
    await (guard?.snapshot?.(`before ${task.id} (${role})`) || Promise.resolve()).catch(() => {});
    const harnessBefore = await (guard?.state?.() || Promise.resolve(null)).catch(() => null);

    /**
     * Build the worker session for the current role and model. Used at the start
     * of a rung and again when a transcript has to be replaced; keeping it one
     * function is what makes the replacement carry the same rules and briefing.
     */
    async function spawnWorker() {
      // Full auto belongs to the project, and the worker is the one that will ask
      // most of the questions. Carry the Architect's switch into the worker's
      // metadata: the gate reads it when a card is raised, and a worker created
      // while it is on must answer its own asks after a restart too.
      let architectFullAuto = false;
      try {
        architectFullAuto = (await engine.getSession(architectId))?.metadata?.synapse?.fullAuto === true;
      } catch { /* a worker with the switch off is the safe default */ }
      const w = await engine.createSession({
        title: `${request.task} - ${role}`,
        model: modelRef ? { ref: modelRef, variant } : undefined,
        directory: dir,
        // Workers carry the same permission ladder as the Architect: their run
        // directory is the workspace, the harness is read-only, and anything
        // outside asks. Role rules come after the ladder so a role's deny wins
        // by being last; skills live last of all.
        permissions: [
          ...rulesFor(),
          ...roleWriteRules(dir, role),
          ...roleReadRules(dir, role),
          ...skillRules(config, role),
        ],
        // Hidden from the rail: it runs in the project directory, so only this
        // mark tells Synapse it is scaffolding and not the operator's session.
        metadata: {
          synapse: {
            internal: true,
            role,
            task: request.task,
            architect: architectId,
            ...(architectFullAuto ? { fullAuto: true } : {}),
          },
        },
      });
      live.workerId = w.id;
      // Its context: where it is, what the plan says, and that the plan is not
      // its to touch. The task itself goes in the message that prompts it.
      try {
        await engine.setInstruction(
          w.id,
          BRIEF_KEY,
          briefSession({
            dir,
            role,
            skills: describeSkills(config, role),
            focus: roleConfig.focus,
            instructions: roleConfig.instructions,
          }),
        );
      } catch (err) {
        log.warn(`worker brief failed for ${request.task}: ${err.message}`);
      }
      return w;
    }

    /**
     * Replace a worker's transcript because it no longer fits the model window.
     *
     * The engine's compaction prompt is the whole retained transcript, not the
     * current context, so a long task can reach a summarise call larger than the
     * window (28 Oct: 225k on a 131k model). The engine's summary is not available
     * when that call failed, so the handover is Synapse's: the task, the last thing
     * the worker said, and the project's files as they now stand. Same role, same
     * model, same attempt and clock; the new session starts with a short log.
     */
    async function replaceWorker(reason, previous) {
      const old = worker;
      const lastSaid = lastAssistantText(previous || []);
      worker = await spawnWorker();
      resets += 1;
      retries += 1;
      if (old?.id) {
        windows.delete(old.id);
        try {
          await engine.deleteSession?.(old.id);
        } catch (err) {
          log.warn(`could not delete the replaced worker session ${old.id}: ${err.message}`);
        }
      }
      before = markOf(await engine.getMessages(worker.id));
      live.retry = { attempt: resets, at: Date.now(), message: reason, reason: 'compaction' };
      emit('run.progress', { ...live });
      await engine.prompt(worker.id, workerHandover({ task, note: request.note, goal: plan.plan?.goal, reason, lastSaid }));
      live.retry = null;
      emit('run.progress', { ...live });
      log.warn(
        `worker ${request.task} (${role}) replaced its session: ${reason} - continuing with a handover`,
      );
    }

    try {
      // One worker run per rung. The loop exists for one case: the provider
      // refusing the model outright (a retired model answers 410 in about two
      // seconds). Retrying that same dead model would spend the Architect's turn
      // for nothing, so the next peer takes over inside this same delegation —
      // same task, same attempt — and the report says who actually ran it.
      //
      // A *recoverable* failure never moves the ladder. A rate limit or a reset
      // connection is the provider's minute, not the model's verdict, so the same
      // session is told to continue, with backoff, for as long as it takes. That
      // is the difference between a run that survives peak time and one that dies
      // at 2am with five hours of the night left.
      for (let rung = 0; rung < candidates.length; rung += 1) {
        const candidate = candidates[rung];
        if (rung > 0) {
          log.warn(
            `worker ${request.task}: ${candidates[rung - 1]} could not run it (${outcome}), moving to ${candidate}`,
          );
        }
        role = candidate;
        roleConfig = config.roles?.[role] || {};
        modelRef = roleConfig.ref || null;
        variant = roleConfig.variant || null;
        stallSec = Math.max(30, Number(roleConfig.stallSec) || settings.stallSec);
        turnError = null;
        // The card and the live path follow the role that is actually working.
        live.role = role;
        live.model = modelRef;
        live.variant = variant;
        live.stallSec = stallSec;
        live.retry = null;
        live.tool = null;
        emit('run.progress', { ...live });

        // What the server really has loaded, before anything is sent to it.
        await noteLoadedWindow(modelRef).catch(() => {});

        worker = await spawnWorker();
        // The session exists now. Broadcast it at once: a UI that only ever saw
        // `run.started` (workerId null) could not offer Steer until the first tool
        // call, which is exactly when a model that is only thinking shows nothing.
        emit('run.progress', { ...live });

        before = markOf(await engine.getMessages(worker.id));
        await engine.prompt(worker.id, workerPrompt({ task, note: request.note, goal: plan.plan?.goal }));

        // Rescue loop: one turn at a time, with the whole session kept between
        // them. Nothing is restarted from scratch, so the work already on disk and
        // in the transcript is the starting point of the next attempt.
        let rungRetries = 0;
        let rungResumes = 0;
        // When the usage cap was first seen in this attempt. Reset by any other
        // kind of turn; a cap that clears and returns starts a new grace.
        let usageSince = 0;
        for (;;) {
          const finished = await waitForIdle(
            worker.id,
            before,
            stallSec * 1000,
            (tool) => {
              live.tool = tool;
              emit('run.progress', { ...live });
            },
            signal,
            // The room this model actually has (or nothing at all), and the one
            // "are you done" steer a long worker gets. Context and compactions ride
            // out on the same poll, so the card can say "27k/60k ctx" while it
            // works and the chat keeps a line for every compaction.
            {
              window: contextWindow(modelRef),
              steer: true,
              // The graceful stop cuts at the step boundary, not mid-token.
              stopCheck: (messages) => {
                if (!gracefulStop) return false;
                const last = [...messages].reverse().find((m) => m.type === 'assistant');
                if (!live.stopAssistant) {
                  if (last) live.stopAssistant = last.id;
                  return false;
                }
                return Boolean(last && last.id !== live.stopAssistant);
              },
              // The first sign of life clears whatever the card was still saying
              // about the last failure or stall. It is not only the retry path:
              // any new turn means the worker is working.
              onActivity: () => alert({ dir, role, clear: true }),
              onContext: (used, room, context) => {
                live.ctx = used;
                live.ctxRoom = room;
                live.ctxLimit = context;
                emit('run.progress', { ...live });
              },
              onCompact: (times, used, context) => {
                live.compactions = times;
                // Also on the run itself, not just in the note: a page opened after
                // this happened has only `/api/runs` to rebuild the trace from, and
                // a count with no size beside it says less than it could.
                live.compactAt = used;
                live.compactLimit = context;
                emit('run.note', {
                  dir,
                  role,
                  task: request.task,
                  startedAt,
                  kind: 'compact',
                  times,
                  used,
                  context,
                });
              },
            },
          );

          if (finished.stopped) {
            if (stopReason) {
              // A harness stop with a reason is a failure the operator must see,
              // not a quiet "stopped": the worker was looping on a question it
              // already had the answer to.
              outcome = 'failed';
              stoppedBy = 'harness';
              text = stopReason;
              log.warn(`${request.task} (${role}) stopped by the harness: ${stopReason}`);
            } else {
              outcome = 'stopped';
            }
            try { await engine.interrupt(worker.id); } catch { /* already gone */ }
            break;
          }

          const now = await engine.getMessages(worker.id);

          if (finished.stalled) {
            // Nothing written, read, said or streamed for the whole window: the
            // shape of a silently lost session, not a slow one. Interrupt it and
            // say "continue" — the operator's own recovery, performed for them.
            try { await engine.interrupt(worker.id); } catch { /* already gone */ }
            if (rungResumes >= settings.resumeMax) {
              outcome = 'timeout';
              turnError = `nothing happened for ${Math.round(stallSec / 60)} minutes`;
              log.warn(`worker ${request.task} (${role}) stalled ${rungResumes + 1} times; reporting a timeout`);
              alert({ dir, role, message: turnError, final: true });
              break;
            }
            rungResumes += 1;
            resumes += 1;
            recordProviderError({
              message: `no activity for ${stallSec}s`,
              classification: { kind: 'transient', reason: 'stalled' },
              role,
              model: modelRef,
              task: request.task,
              attempt: rungResumes,
              note: 'stall restart',
            });
            log.warn(
              `worker ${request.task} (${role}) produced nothing for ${stallSec}s — restarting it ` +
                `(${rungResumes}/${settings.resumeMax})`,
            );
            alert({
              dir,
              role,
              message: `Nothing happened for ${Math.round(stallSec / 60)} min — restarting`,
              attempt: rungResumes,
              retrying: true,
            });
            await sleep(1500, signal);
            if (signal?.aborted) { outcome = 'stopped'; break; }
            // The worker is being woken: the red "nothing happened" line has done
            // its job. Leaving it up while the worker is visibly working is the
            // card lying (29 Oct: 306 tok/s under "retrying").
            alert({ dir, role, clear: true });
            await nudge(worker.id, STALL_NUDGE, signal);
            before = markOf(await engine.getMessages(worker.id));
            continue;
          }

          turnError = turnErrorOf(now, before);
          // The worker read the stop note and ended its turn: that is the
          // graceful stop. The report it wrote is the text, and nothing failed.
          if (gracefulStop) {
            outcome = 'stopped';
            stoppedBy = 'operator';
            turnError = null;
            alert({ dir, role, clear: true });
            break;
          }
          if (!turnError) {
            outcome = 'completed';
            // The role is working again: whatever the card was saying about a
            // provider failure is no longer news.
            alert({ dir, role, clear: true });
            break;
          }

          if (toolDeclined(now, before)) {
            // A refusal is not a network failure. The gate has already explained
            // it to the worker; retrying would tell it the provider cut the turn
            // and invite the same tool call again. Report what the worker has and
            // let the Architect judge.
            declined = true;
            outcome = 'completed';
            turnError = null;
            alert({ dir, role, clear: true });
            out.info(`run ${request.task} (${role}): a tool permission was declined; reporting without a retry`);
            break;
          }

          const cls = classifyFailure(turnError);
          // The session is gone: the operator stopped the run and deleted the
          // session (or the project folder) while this turn was in flight. No
          // retry can reach a session that no longer exists, and this is not a
          // failure to paint on a card — the work was cancelled on purpose.
          if (cls.reason === 'gone') {
            outcome = 'stopped';
            log.info(`worker ${request.task} (${role}) ended: its session no longer exists`);
            break;
          }
          recordProviderError({
            message: turnError,
            classification: cls,
            role,
            model: modelRef,
            task: request.task,
            attempt: rungRetries + 1,
          });
          log.error(
            `worker ${request.task} (${role}) turn ended in an error [${cls.kind}/${cls.reason}]: ${turnError}`,
          );

          if (cls.kind === 'terminal') {
            outcome = 'error';
            // Only a model that is *gone* is marked. A wrong key, a malformed
            // request or a rate limit says nothing about the model itself, and a
            // badge lives until the operator clears it by hand.
            if (cls.reason === 'deprecated') refuseModel(modelRef, turnError);
            alert({ dir, role, message: turnError, final: true });
            break;
          }

          // A usage cap that has not cleared in ten minutes is not a pause: the
          // operator has to change the model, and retrying only keeps the project
          // busy (t9, 27 Oct: 13 retries, 51 minutes, stopped by hand).
          if (cls.reason === 'usage-limit') {
            if (!usageSince) usageSince = Date.now();
            if (Date.now() - usageSince > USAGE_LIMIT_MS) {
              outcome = 'error';
              turnError =
                `${turnError} Synapse stopped retrying this usage cap after ` +
                `${Math.round(USAGE_LIMIT_MS / 60000)} minutes — switch this role to another model.`;
              alert({ dir, role, message: turnError, final: true });
              out.warn(`worker ${request.task} (${role}) stopped: the usage cap did not clear`);
              break;
            }
          } else {
            usageSince = 0;
          }

          // A failed compaction is the engine's own summary call being larger than
          // the window: it summarises the whole retained transcript, not the current
          // prompt. Retrying in the same session asks for the same oversized call;
          // a fresh session with a handover is the way out. (28 Oct, t2: 225k on a
          // 131k model.)
          if (cls.reason === 'compaction' && resets < RESET_MAX) {
            alert({
              dir,
              role,
              message: 'Summarising the conversation failed — starting a fresh worker session',
              attempt: resets + 1,
              retrying: true,
            });
            await replaceWorker('the conversation no longer fits the model window', now);
            if (signal?.aborted) { outcome = 'stopped'; break; }
            alert({ dir, role, clear: true });
            continue;
          }

          // The prompt is bigger than the window. Waiting changes nothing and
          // repeating the request fails identically, so the answer is the one the
          // engine already has: summarise, then carry on. A local server set to
          // "Stop at Limit" reports it this way instead of truncating silently.
          if (cls.kind === 'context') {
            // The provider just refused a prompt this big. For a cloud model that
            // refusal is the only measurement there is — there is no endpoint that
            // reports a loaded window — so it is recorded and the next turn budgets
            // under it instead of trusting the catalog.
            try {
              const refusedAt = promptSize(now);
              if (refusedAt && modelCache?.noteContext?.(modelRef, { refusedAt })) {
                log.warn(
                  `${modelRef}: refused a ${tokens(refusedAt)} prompt - the window is smaller than that; budgeting below it`,
                );
              }
            } catch { /* the run matters more than the bookkeeping */ }

            // A fresh session is the better answer for a worker: the engine's
            // compaction of this transcript is exactly the call that may be too
            // large, and a new session with the task and the files continues.
            if (resets < RESET_MAX) {
              alert({
                dir,
                role,
                message: 'The prompt is too large — starting a fresh worker session',
                attempt: resets + 1,
                retrying: true,
              });
              await replaceWorker('the prompt was larger than the model window', now);
              if (signal?.aborted) { outcome = 'stopped'; break; }
              alert({ dir, role, clear: true });
              continue;
            }

            rungRetries += 1;
            retries += 1;
            out.warn(
              `context limit hit in ${request.task} (${role}); asking the engine to compact and carrying on`,
            );
            live.retry = { attempt: rungRetries, at: Date.now(), message: turnError, reason: 'context' };
            emit('run.progress', { ...live });
            try {
              await engine.compact(worker.id);
            } catch (err) {
              log.warn(`compaction after a context error failed: ${err.message}`);
            }
            await sleep(3000, signal);
            if (signal?.aborted) { outcome = 'stopped'; break; }
            live.retry = null;
            emit('run.progress', { ...live });
            await nudge(worker.id, CONTEXT_NUDGE, signal);
            before = markOf(await engine.getMessages(worker.id));
            continue;
          }

          // Recoverable: wait, then ask the same session to carry on. No attempt is
          // consumed, the ladder does not move, and this does not end.
          rungRetries += 1;
          retries += 1;
          const delay = backoffMs(rungRetries, settings);
          live.retry = { attempt: rungRetries, at: Date.now() + delay, message: turnError, reason: cls.reason };
          emit('run.progress', { ...live });
          alert({
            dir,
            role,
            message: turnError,
            attempt: rungRetries,
            retrying: true,
            at: Date.now() + delay,
          });
          log.warn(
            `worker ${request.task} (${role}) ${cls.reason}: retrying in ${Math.round(delay / 1000)}s ` +
              `(try ${rungRetries}); a recoverable failure is not an attempt`,
          );
          await sleep(delay, signal);
          if (signal?.aborted) { outcome = 'stopped'; break; }
          live.retry = null;
          emit('run.progress', { ...live });
          // The retry is starting now: the card's red "retrying at 20:53" line
          // must go before the worker resumes, or it sits there while the worker
          // is working. A fresh failure raises a fresh line.
          alert({ dir, role, clear: true });
          await nudge(worker.id, RETRY_NUDGE, signal);
          before = markOf(await engine.getMessages(worker.id));
        }

        const messages = await engine.getMessages(worker.id);
        // A stop with a reason *is* the report: the reason explains a run that
        // ended early, and a worker interrupted mid-question has nothing to say
        // for itself. Recomputing this from the transcript overwrote the reason
        // with an empty string, so the Architect was told "It reported nothing"
        // and the run log recorded no reason at all.
        if (!stopReason) text = workerText(messages);
        if (!text && declined) {
          text = 'The tool call was declined and the worker stopped without a report. Nothing else was attempted.';
        }
        files = workerFiles(messages);
        // A file written outside the project is odd enough to say out loud: a coder
        // ran a scratch script out of %TEMP% through `shell`, where no path rule can
        // reach it. It is a note and not a refusal - a scratch script is not an act
        // of vandalism - but the operator should be able to see it happened.
        filesOutside = files.filter((file) => outsideProject(file, dir));
        context = contextStats(messages);
        // The brief tells a role to load its skills before its first edit. This is
        // the only way to know whether it did: Shift Test 3 and 4 both shipped
        // without a single `code-craft` load, and nothing noticed.
        const skillsUsed = workerSkills(messages);
        skillsRequired = roleMustLoad(getConfig(), role);
        skillsMissing = skillsRequired.filter((s) => !skillsUsed.has(s));
        if (skillsMissing.length) {
          out.warn(
            `${request.task} (${role}) never loaded ${skillsMissing.join(', ')} — the brief asks for it before the first edit`,
          );
        }

        // The provider refused this model outright: the next rung can still do the
        // work, and the operator is not asked to decide anything about it.
        if (outcome === 'error' && rung + 1 < candidates.length) {
          skipped.push({ role, message: turnError });
          live.skipped = skipped;
          emit('run.progress', { ...live });
          continue;
        }
        break;
      }

      // A Stop can land in any of the waits above (a turn, a backoff, a session
      // replacement). Whatever path it took, the record must say the operator
      // stopped it and must not carry the previous attempt's provider error as
      // the reason. The last finished turn's own error is kept beside it, not
      // instead of it.
      if (outcome === 'stopped' && !stoppedBy) {
        stoppedBy = 'operator';
        try {
          lastTurnError = worker?.id ? turnErrorOf(await engine.getMessages(worker.id)) : turnError;
        } catch {
          lastTurnError = turnError;
        }
        turnError = null;
      }
    } catch (err) {
      outcome = 'failed';
      text = `the worker could not run: ${err.message}`;
      log.warn(`worker for ${request.task} failed: ${err.message}`);
    } finally {
      busy.delete(dir);
      controls.delete(dirKey(dir));
      // The card goes back to idle and the path is erased as soon as the worker
      // stops — before the Architect is woken, so the two never disagree.
      running.delete(dirKey(dir));
      // A steer admitted just as the turn ended can start a turn of its own with
      // nobody polling it. The run is over, so cut that turn; a steer delivered
      // inside the run kept the worker busy, and we would not be here yet.
      if (steers.length && worker?.id) {
        try { await engine.interrupt(worker.id); } catch { /* already gone */ }
      }
      if (stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
      }
      // A graceful stop's note can start a turn of its own if the turn ended
      // before reading it; the run is over, so cut that turn.
      if (gracefulStop && worker?.id) {
        try { await engine.interrupt(worker.id); } catch { /* already gone */ }
      }
      emit('run.finished', {
        dir,
        role,
        task: task.id,
        title: task.title,
        outcome,
        ms: Date.now() - startedAt,
        files: files.length,
      });
    }

    // The plan must not have moved under the worker's feet.
    const after = planFingerprint(dir);
    const planTouched = fingerprintBefore !== after;

    // Neither must anything else in .synapse that is not this role's to write.
    // The path rules stop the file tools; a shell redirect, the `execute` tool or
    // an absolute path can still land, so the folder is compared around the turn
    // the way the harness repository is.
    const synapseAfter = synapseFingerprint(dir);
    const shared = SHARED_DIR.split('/').pop();
    const strayWrites = fingerprintDiff(synapseBefore, synapseAfter, ownedFolder(role))
      // Screenshots are everyone's folder: the visual-review skill writes there
      // from whichever role is looking at the page.
      .filter((p) => !(p === shared || p.startsWith(`${shared}/`)))
      .filter((p) => !HARNESS_FILES.has(p));
    if (strayWrites.length) {
      if (guard?.alarm) {
        guard.alarm({
          sessionId: architectId,
          what: 'WROTE INSIDE .synapse OUTSIDE ITS FOLDER',
          paths: strayWrites.slice(0, 12),
          note: `${request.task} (${role})`,
        });
      } else {
        log.error(`.synapse changed during ${request.task} (${role}): ${strayWrites.join(', ')}`);
      }
    }

    // And nor must the harness. The snapshot above left a known state; whatever
    // the repository shows now that it did not show then happened while the
    // worker was running — however it happened, and whether or not a tool call
    // named a path. Reported before the Architect is woken, so the two never
    // disagree about what the worker did.
    const harnessAfter = await (guard?.state?.() || Promise.resolve(null)).catch(() => null);
    const harnessChanged = (guard?.changed?.(harnessBefore, harnessAfter) || []).filter((line) => {
      // The Settings dialog is Synapse writing its own file, and Synapse knows
      // when it did: `configSavedAt` moves at the save. A change to the config
      // that no save of ours explains is still a worker's — the ruleset denies
      // it, but a shell redirect can land — so only our own save is excused.
      if (!line.includes('config/synapse.config.json')) return true;
      const ours = configSavedAt() >= startedAt;
      if (ours) log.info(`${request.task} (${role}) ran while the operator saved settings - not tampering`);
      return !ours;
    });
    if (harnessChanged.length) {
      guard.alarm({
        sessionId: architectId,
        what: 'CHANGED DURING A WORKER RUN',
        paths: harnessChanged.slice(0, 12),
        note: `${request.task} (${role})`,
      });
    }

    // A stop puts the task back in todo: nothing is running, and a task left
    // `doing` reports "1 running" on the plan for the rest of the day.
    if (outcome === 'stopped' && stoppedBy === 'operator') setTaskStatus(dir, task.id, 'todo');

    appendRun(dir, {
      kind: 'result',
      callId: request.callId,
      task: request.task,
      title: task.title,
      role,
      plannedRole: task.role,
      // The session that asked for this run. The plan pane and the role cards
      // answer "what did *this* session spend" from it, so an old run under the
      // same task id can never be read as this session's work.
      architect: architectId || null,
      worker: worker?.id || null,
      outcome,
      ms: Date.now() - startedAt,
      // How the night went: a run that took three hours because the provider was
      // rate limiting is explained by these two numbers and the incident log.
      retries,
      resumes,
      error: turnError,
      // Why a stopped run stopped, and what its last finished turn had said. The
      // two must not be one field: a provider sentence from an earlier attempt is
      // not the reason an operator pressed Stop.
      stoppedBy,
      lastTurnError,
      // The guidance the operator sent while it worked, in order. A report that
      // judged the original brief and ignored these would be judging the wrong
      // task.
      steers: steers.slice(-20),
      files,
      text: text.slice(0, RESULT_MAX),
      // What the run cost in context, so the audit after a project reads the run
      // log instead of the engine's database. `peak` is the whole prompt of the
      // biggest turn; `thinkShare` is how much of the writing was thinking.
      context,
      planTouched,
      synapseTouched: strayWrites,
      filesOutside,
    });

    // Redemption: a role that finished its work on a marked model has proved the
    // mark wrong. The operator's rule — the badge clears when the model delivers,
    // not when the operator remembers to clear it. A clean probe still does not
    // clear anything: this is work, not a test.
    if (outcome === 'completed' && modelRef && modelCache?.clearIssues) {
      try {
        if (modelCache.clearIssues(modelRef)) {
          notify?.({ kind: 'model', type: 'issues', ref: modelRef });
          log.info(`model ${modelRef} redeemed: a completed run cleared its issue mark`);
        }
      } catch { /* the badge is not worth failing a run over */ }
    }

    log.info(
      `delegation finished: ${request.task} (${role}) ${outcome} in ${Math.round((Date.now() - startedAt) / 1000)}s` +
        (retries ? `, ${retries} retr${retries === 1 ? 'y' : 'ies'}` : '') +
        (resumes ? `, ${resumes} restart${resumes === 1 ? '' : 's'}` : '') +
        (files.length ? `, ${files.length} file(s) written` : '') +
        (planTouched ? ' - THE PLAN FILE CHANGED DURING THE WORKER TURN' : '') +
        (strayWrites.length ? ` - .synapse WRITTEN OUTSIDE ITS FOLDER: ${strayWrites.join(', ')}` : '') +
        (filesOutside.length ? ` - WROTE OUTSIDE THE PROJECT: ${filesOutside.join(', ')}` : ''),
    );

    out.info(
      `run ${request.task} (${role}) ${outcome} in ${Math.round((Date.now() - startedAt) / 1000)}s` +
        (retries ? `, ${retries} retr${retries === 1 ? 'y' : 'ies'}` : '') +
        (resumes ? `, ${resumes} restart${resumes === 1 ? '' : 's'}` : '') +
        (files.length ? `, ${files.length} file(s)` : '') +
        (context?.turns
          ? `, ${context.turns} turns, ctx peak ${tokens(context.peak)}, ${tokens(context.prompt)} prompt tok, ` +
            `${tokens(context.generated)} written (${thinkNote(context)})` +
            (context.compactions ? `, ${context.compactions} compaction(s)` : '')
          : ''),
    );

    // A stop wakes nobody: Stop means the whole system is idle. The stop is on
    // disk (runs.jsonl, the task back in todo) and the next Architect brief says
    // what happened, so the next turn starts with the fact instead of a guess.
    if (outcome === 'stopped' && stoppedBy === 'operator') {
      out.warn(`run ${request.task} (${role}) stopped by the operator`);
      notify?.({
        kind: 'note',
        title: 'Run Stopped',
        body: `${request.task} was stopped. Nothing is running.`,
      });
      return;
    }

    // A finished plan is the end of the project, and the end of everything its
    // workers started: a static server, a watcher. Nothing else owns them, so they
    // outlive the run by hours (Timer Test 1 left one on 8765, Shift Test 6 one on
    // 8321). Swept once per directory, and only when the operator has not turned it
    // off — see src/cleanup.js for what may and may not be stopped.
    try {
      const done = readPlan(dir).plan;
      const complete = Boolean(done?.tasks?.length) && done.tasks.every((t) => t.status === 'done');
      if (complete && !cleaned.has(dir) && getConfig()?.cleanup?.onFinish !== false) {
        cleaned.add(dir);
        // Files first: a helper script is not a process, and the two left behind
        // by the Designer (contrast.mjs, serve.mjs) were the operator's to clean.
        // Only scripts and temp files inside .synapse, never a plan deliverable.
        try {
          const named = (done?.tasks || []).flatMap((t) => (Array.isArray(t.reads) ? t.reads : []));
          const files = sweepScratch(dir, { log, named });
          if (files.removed.length) {
            out.info(`cleanup: ${files.removed.length} scratch file(s) removed (${files.removed.join(', ')})`);
          }
        } catch (err) {
          log.warn(`scratch cleanup failed for ${dir}: ${err.message}`);
        }
        sweepProject(dir, { log })
          .then((r) => {
            if (!r.found) return;
            out.info(`cleanup: ${r.stopped.length} process(es) from this project stopped`);
            notify?.({
              kind: 'note',
              title: 'Project Finished',
              body: r.stopped.length
                ? `Stopped ${r.stopped.length} process(es) the project left running (${r.stopped
                    .map((s) => s.pid)
                    .join(', ')}).`
                : 'Everything the project left running has already gone.',
            });
          })
          .catch((err) => log.warn(`cleanup failed for ${dir}: ${err.message}`));
      }
    } catch (err) {
      log.warn(`cleanup check failed for ${dir}: ${err.message}`);
    }

    // The "keep building" switch is read at report time, so flipping it while a
    // worker runs takes effect on the very next judgement.
    let auto = false;
    try {
      auto = (await engine.getSession(architectId))?.auto === true;
    } catch { /* session gone; treat as off */ }

    // A harness stop still owes the Architect the report: the reason *is* the
    // report, and the guard that stopped the run said so. Two things had to be
    // handled here. The head used to read "could not run", which is a lie about a
    // task that ran for nine minutes, so it says who stopped it. And the wake used
    // to be handed the run's own signal — already aborted by the stop — which
    // `wake()` reads as "the operator said stop, say nothing". The report was
    // written, logged and never delivered: the screen then said "Waiting on you"
    // with no question and no reason (shift-test-5, the designer looping on its
    // own question).
    if (stopReason) {
      notify?.({
        kind: 'note',
        title: 'Run Stopped By The Harness',
        body: `${request.task} (${role}) was stopped: ${firstSentence(stopReason)} The Architect is being told.`,
      });
    }

    const told = await wake(architectId, dir, {
      // The header of the yellow Synopsis line in the chat. "failed" says nothing
      // about who ended the run; a harness stop is the one the operator cannot
      // work out for themselves, so the line names it.
      description: stopReason
        ? `${request.task} (${role}) stopped by the harness`
        : `worker ${request.task} (${role}) ${outcome}`,
      text: report({
        task,
        role,
        insteadOf: task.role !== role ? task.role : null,
        skipped,
        outcome,
        harnessStop: Boolean(stopReason),
        ms: Date.now() - startedAt,
        text,
        files,
        context,
        workerId: worker?.id,
        planTouched,
        synapseTouched: strayWrites,
        qcRound: qcRoundsUsed(dir),
        skillsRequired,
        skillsMissing,
        error: turnError,
        stoppedBy,
        lastTurnError,
        steers,
        auto,
        stallSec,
        retries,
        resumes,
      }),
    }, signal?.aborted ? undefined : signal);
    // A stop aborts the run's signal, and passing that to the wake made the wake
    // return before the Architect heard anything: the operator stopped a worker
    // and the Architect kept waiting for a report that was already on disk (the
    // emulator project, 29 Oct). A stopped run owes the Architect the same
    // report as any other; the project is held, so it cannot delegate from it.
    // The report was delivered. The marker is what lets the next boot tell a
    // delivered report from one the crash interrupted (see recoverLostReports).
    if (told?.ok) appendRun(dir, { kind: 'wake', callId: request.callId, at: Date.now(), status: 'done' });
  }

  /** Tell a session to carry on after a failure. `synthetic`, so it reads as the
   *  harness in the transcript rather than as the operator typing "continue". */
  async function nudge(sessionId, text, signal) {
    for (let i = 0; i < 5; i += 1) {
      if (signal?.aborted) return false;
      try {
        await engine.synthetic(sessionId, text, { description: 'harness' });
        return true;
      } catch (err) {
        log.warn(`could not nudge ${sessionId} (${i + 1}/5): ${err.message}`);
        await sleep(5000 * (i + 1), signal);
      }
    }
    return false;
  }

  /** Mark a model the provider has retired — and nothing else. A rate limit, a
   *  bad key or a malformed request says nothing about the model, and a provider
   *  mark makes the ladder skip that role on every later attempt. */
  function refuseModel(ref, message) {
    try {
      if (modelCache?.noteIssue?.(ref, { kind: 'provider', message })) {
        notify?.({ kind: 'model', type: 'issues', ref });
      }
    } catch { /* the cache is not worth failing a run over */ }
  }

  /** Everything a turn has said so far, as one comparable string.
   *
   *  This is how "nothing at all happened" is decided: message count, part count,
   *  text length and timestamps. A tool call, a reasoning block that streams, a
   *  file written — each one changes it. The engine's own retries (5–10 of them
   *  before it gives up) change nothing, which is exactly the silence the operator
   *  wants to catch, while a slow model that is *thinking* keeps producing deltas.
   */
  function activityKey(messages) {
    let key = '';
    for (const m of messages || []) {
      let parts = 0;
      let chars = 0;
      for (const p of m?.parts || []) {
        parts += 1;
        if (p?.text) chars += String(p.text).length;
      }
      key += `${m?.id || ''}:${m?.updated || 0}:${m?.completed || 0}:${parts}:${chars}|`;
    }
    return key;
  }

  /**
   * The room a model has, if the catalog actually knows it.
   *
   * Never guessed. A worker's window is 1M on most hosted models, 200k on a few
   * free ones and ~62k on a local LLM, so any single number baked in here is wrong
   * for most runs — 200k was the old assumption and it was only ever right by
   * accident. `modelCache.get()` is the engine's own catalog, recorded at boot;
   * the operator's `modelLimits` override wins when they have set one.
   */
  function contextWindow(ref) {
    if (!ref) return null;
    const cached = (() => {
      try { return modelCache?.get?.(ref); } catch { return null; }
    })();
    // The operator's override may be keyed either way: the engine's config takes
    // the BARE model id under its provider (`providers.opencode.models.<id>.limit`),
    // while a ref here is `provider/model`. Honouring only the ref spelling meant
    // the engine and the watchdog could disagree about the same model.
    const limits = getConfig()?.modelLimits || {};
    const bare = String(ref).split('/').pop();
    const override = limits[ref] || limits[bare] || {};
    const context = resolveWindow({
      override: override.context,
      loaded: loadedWindows.get(ref) || 0,
      refused: cached?.refusedAt,
      catalog: cached?.context,
    });
    const output = Number(override.output) || Number(cached?.output) || 0;
    if (!context) return null;
    return { context, output, room: watchdogRoom({ context, output }) };
  }

  /**
   * Ask a local server what window it has loaded for this model, once per run.
   *
   * Shift Test 2 died on the gap this closes: LM Studio was serving a 16,384-token
   * window while the config still said 39,168, so the watchdog thought there was
   * room and the server refused a 17.7k request mid-task. The config is what the
   * operator meant; the loaded length is what the server will do.
   */
  const loadedWindows = new Map();
  async function noteLoadedWindow(ref) {
    const [providerId, modelId] = String(ref || '').split('/');
    if (!providerId || !modelId) return;
    const provider = (getConfig()?.engine?.opencode?.providers || []).find((p) => p.id === providerId);
    if (!provider || providerType(provider) !== 'local') return;
    const loaded = await providerLoadedWindow({ baseURL: provider.baseURL, model: modelId }).catch(() => 0);
    if (!loaded) return;
    loadedWindows.set(ref, loaded);
    // The same lookup as contextWindow: the operator's `modelLimits` may use the
    // bare model id, which is what the engine config takes.
    const limits = getConfig()?.modelLimits || {};
    const bare = String(ref || '').split('/').pop();
    const override = limits[ref] || limits[bare] || {};
    const declared = Number(override.context) || Number((provider.models || []).find((m) => m.id === modelId)?.context) || 0;
    if (declared === loaded) return;
    // Boot keeps these two in step, so a difference here means the model was
    // reloaded in its own app while Synapse was running. This run budgets for the
    // real window either way; the engine keeps the old compaction point until it
    // is restarted, because reloading its config would cancel every open form.
    const reserve = Math.max(Math.floor(declared * 0.15), declared >= 32000 ? 16000 : 0);
    log.warn(
      declared
        ? `${ref}: the server now has ${loaded} tokens loaded, the config says ${declared}. This run budgets for ` +
          `${loaded}, but the engine still compacts at ${declared - reserve} - restart Synapse to hand it ${loaded}.`
        : `${ref}: the server has ${loaded} tokens loaded and nothing is configured. This run budgets for ${loaded}; ` +
          `set its context in Settings > Providers so the engine compacts on the same number.`,
    );
    // Keep the file in step, so the next boot starts from the truth.
    try { onModelWindow?.(ref, loaded); } catch { /* the run does not depend on it */ }
  }

  // One entry per session: the last turn's prompt size, whether the watchdog is
  // armed, and how many times it has asked. A run-wide Map because a session is
  // polled once per 1.5s and this has to survive between polls.
  const windows = new Map();

  // How many "are you done" steers a session has been sent.
  const steered = new Map();

  /**
   * Ask a long-running worker whether it is done.
   *
   * The brief says to stop when the deliverable exists, and the window watchdog
   * catches the transcript filling up — but neither notices a model that is happy
   * polishing. This is the harness's one word on the subject, at a turn count and
   * not a wall clock: it is a question the model is free to answer "no" to.
   */
  async function steerIfLong(sessionId, messages) {
    const turns = (messages || []).filter((m) => m.type === 'assistant').length;
    const sent = steered.get(sessionId) || 0;
    const due = steerDue(turns, sent);
    if (!due) return;
    steered.set(sessionId, sent + 1);
    const text =
      `You are ${turns} turns into this task. If what was asked for is essentially there, stop: finish the ` +
      `deliverable, write your report and end the run - the Architect judges the files, not the effort, and ` +
      `polishing past the checks the task names is not part of it. If it genuinely needs more work, carry on.`;
    try {
      await engine.synthetic(sessionId, text, { description: 'harness: are you done?' });
      out.info(`asked ${sessionId} whether it is done (turn ${turns})`);
    } catch (err) {
      log.warn(`could not ask ${sessionId} whether it is done: ${err.message}`);
    }
  }

  /**
   * Compact *before* the window closes, never on a schedule.
   *
   * This is a safeguard, not a policy: the engine compacts by itself when it
   * decides to, and on the clock run it did so at 290k on a model advertising 1M.
   * What Synapse adds is the case where the engine's own read of the window is
   * wrong or absent — a local model, a provider lying about its limit — because
   * the failure there is an oversized request, and an oversized request is the
   * one error a retry can never fix.
   *
   * Silent when nothing is known, and silent until the boundary is actually near.
   */
  async function watchWindow(sessionId, messages, window) {
    if (!window?.room) return;
    const last = [...messages].reverse().find((m) => m.type === 'assistant' && m.raw?.tokens);
    if (!last) return;
    const t = last.raw.tokens;
    const ctx = (t.input || 0) + (t.cache?.read || 0);
    if (!ctx) return;

    const state = windows.get(sessionId) || { armed: true, times: 0, off: false };
    windows.set(sessionId, state);

    // The engine compacted while we were watching. Two things follow, and both
    // were learned on one run: the transcript in hand is stale (it still carries
    // the large prompt), so this poll must not act on it, and the request that a
    // "compact" would send cannot be cancelled — a queued compaction runs at the
    // next step boundary even if the transcript has shrunk by then. On 23 Oct the
    // engine compacted at 46,329 and our watchdog asked again one second later;
    // the second request ran four minutes later against the *fresh* 10,986-token
    // transcript, throwing away what the first had just kept.
    //
    // A session that compacted before this run existed is not news: the first look
    // takes the count as the baseline rather than treating old compactions as one
    // that has just happened.
    const seen = compactionMessages(messages).length;
    if (!Number.isInteger(state.compactions)) state.compactions = seen;
    else if (seen > state.compactions) {
      state.compactions = seen;
      state.armed = false;
      out.info(
        `the engine compacted ${sessionId} at ${tokens(ctx)} - not asking again; waiting for the transcript to shrink`,
      );
      return;
    }

    const action = windowAction(state, ctx, window.room);
    if (action === 'arm') { state.armed = true; return; }
    if (action !== 'compact') return;

    state.armed = false;
    state.times += 1;
    out.warn(
      `context ${tokens(ctx)} of ${tokens(window.context)} in ${sessionId} - compacting before the window closes`,
    );
    try {
      const ok = await engine.compact(sessionId);
      if (!ok) {
        state.off = true;
        out.warn(`the engine has no compaction to offer; ${sessionId} is left to its own limit`);
      }
    } catch (err) {
      // A refused request is not a failed run: re-arm and let the engine's own
      // handling have its turn.
      state.armed = true;
      out.warn(`compaction request refused for ${sessionId}: ${err.message}`);
    }
  }

  /**
   * Poll until the turn closes with `idle`, or nothing has changed for `stallMs`.
   *
   * There is deliberately no wall-clock ceiling. A turn that is working is left
   * alone for as long as it needs — an evening of 20-minute designer turns is
   * normal, and a 40-minute one is the provider being slow, not a failure. The
   * only thing worth stopping is a turn that has produced *nothing* for a long
   * time, because that is what a silently lost session looks like: the operator
   * has seen the desktop app sit on "Working…" for an hour with nothing happening
   * behind it, and a "you got stuck, continue" fixed it immediately.
   *
   * The answer to a stall is therefore an interrupt and a resume, not a failure.
   * A pending question also pauses the clock: the operator may take hours, and
   * the transcript itself says so.
   */
  async function waitForIdle(sessionId, before, stallMs, onTool, signal, { window = null, steer = false, onContext = null, onCompact = null, onActivity = null, stopCheck = null } = {}) {
    let lastActivity = Date.now();
    let lastKey = '';
    let lastCtx = 0;
    let compactions = 0;
    let sig = '';
    // One "it is doing something again" per turn: the first change of any kind is
    // enough to take a stale retry or stall line off the card, and repeating it on
    // every streamed token would only be traffic.
    let announced = false;
    let asking = false;
    for (;;) {
      if (signal?.aborted) return { stopped: true };
      await sleep(POLL_MS, signal);
      if (signal?.aborted) return { stopped: true };

      let messages;
      try {
        messages = await engine.getMessages(sessionId);
      } catch {
        // A poll that failed is not silence: the engine may be restarting. The
        // stall clock is left where it is and the next poll decides.
        continue;
      }

      // The graceful stop's boundary: the assistant message that was open when
      // Stop was pressed has finished, and another has begun. Cut here, with
      // nothing said to the model.
      if (stopCheck?.(messages)) {
        try { await engine.interrupt(sessionId); } catch { /* already gone */ }
        return { stopped: true };
      }

      const nextSig = activityKey(messages);
      if (nextSig !== sig) {
        sig = nextSig;
        lastActivity = Date.now();
        if (!announced) {
          announced = true;
          onActivity?.();
        }
      }

      if (onTool) {
        const tool = latestTool(messages, before);
        const key = tool ? `${tool.name}\u0000${tool.target}` : '';
        if (key && key !== lastKey) {
          lastKey = key;
          onTool(tool);
        }
      }

      // Two numbers the operator watches, read from the same poll: how full the
      // window is, and how many times it has been compacted. Both are facts from
      // the transcript, so neither costs an engine call.
      if (onContext || onCompact) {
        const used = promptSize(messages);
        if (used && used !== lastCtx) {
          lastCtx = used;
          onContext?.(used, window?.room || 0, window?.context || 0);
        }
        const events = compactionEvents(messages);
        if (events.length > compactions) {
          compactions = events.length;
          onCompact?.(compactions, events[compactions - 1]?.used || used, window?.context || 0);
        }
      }

      // The prompt is in hand on every poll, which is the only place in a run
      // where the window can be watched without another engine call. It does
      // nothing at all unless the model's real limit is known and near.
      if (window) await watchWindow(sessionId, messages, window);
      // And the same poll is where "this has been going a long time" can be said
      // once, to a worker, without a new engine call.
      if (steer) await steerIfLong(sessionId, messages);

      const last = messages[messages.length - 1];
      const waiting = (last?.parts || []).some(
        (p) => p?.type === 'tool' && /^question$/.test(String(p.name || '')) && /run|pend|progress/i.test(String(p.status || '')),
      );
      if (waiting) {
        lastActivity = Date.now();
        if (!asking) log.info(`${sessionId} is waiting on an answer; its stall clock is paused`);
      } else if (asking) {
        log.info(`${sessionId} has an answer; its stall clock is running again`);
      }
      asking = waiting;

      if (messages.length && messages[messages.length - 1]?.type === 'idle' && messages[messages.length - 1]?.id !== before) {
        return { timedOut: false };
      }
      // A step that ended in an error is over, whether or not the engine appends an
      // idle after it. Measured 25 Oct: two aborted steps left this loop waiting the
      // full fifteen-minute stall window - twice - which was 30 of a 33-minute QC
      // run. The transcript already said the step had failed; the watchdog was
      // waiting for a message that was never coming. A retried step is the engine
      // trying again in place, so only an error with no retry ends the wait.
      if (
        last?.type === 'assistant' &&
        last.id !== before &&
        last.raw?.error &&
        !last.raw?.retry
      ) {
        return { timedOut: false, ended: 'error' };
      }
      if (Date.now() - lastActivity >= stallMs) return { timedOut: true, stalled: true };
    }
  }

  /**
   * The worker's newest tool call, and what it is pointed at.
   *
   * Only messages from `from` onward are scanned, so a long turn costs one pass
   * over its new messages rather than a re-read of the whole transcript. The
   * input field name differs per tool, which is why file, shell, search, fetch,
   * skill and subagent targets are all read here: the card says "writing
   * calendar.py", not "write".
   */
  function latestTool(messages, mark = '') {
    let found = null;
    for (const message of afterMark(messages, mark)) {
      for (const part of message?.parts || []) {
        if (part?.type !== 'tool' || !part.name) continue;
        const input = parseInput(part.input) || {};
        const raw =
          input.filePath ?? input.file_path ?? input.path ??
          input.command ?? input.pattern ?? input.url ??
          input.skill ?? input.agent ?? '';
        found = { name: String(part.name), target: String(raw || '').trim() };
      }
    }
    return found;
  }

  function workerPrompt({ task, note, goal }) {
    const lines = [`Task ${task.id}: ${task.title}`];
    if (task.detail) lines.push(`What is wanted: ${task.detail}`);
    if (Array.isArray(task.reads) && task.reads.length) {
      lines.push(`Read these before you start: ${task.reads.join(', ')}.`);
    }
    if (goal) lines.push(`The project goal, for context: ${goal}`);
    if (note) lines.push(`The Architect adds: ${note}`);
    lines.push(
      `Work in the project directory you were given. Deliverables go in bin/ (create it if it does not ` +
        `exist); everything else there is scratch. Do only this task.`,
    );
    lines.push(
      `When you are finished, reply with a short report: what you produced, the exact file paths you ` +
        `wrote, and anything the Architect needs to know to judge it.`,
    );
    return lines.join('\n');
  }

  /**
   * The prompt a replacement worker gets. The task and its detail are the same
   * brief it had; the rest says why the transcript is gone and that the project
   * is the state. Deliberately short: this message is the new session's first
   * and must not recreate the problem it is solving.
   */
  function workerHandover({ task, note, goal, reason, lastSaid }) {
    return [
      workerPrompt({ task, note, goal }),
      '',
      '---',
      `Your earlier session was replaced because ${reason}. Its conversation is gone; the project's files are the work.`,
      lastSaid ? `What you last said before the reset: "${lastSaid}"` : '',
      'Look at the project as it stands now (git status, git diff, the files and bin/), keep whatever is already done, and continue this task from there. Do not repeat finished work.',
      'When you are finished, give the usual short report.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** The provider's own words for a turn that ended in an error, or null.
   *
   *  The engine appends `idle` even when the step failed — a retired model answers
   *  HTTP 410 in about two seconds — so the idle message alone cannot be read as
   *  success. Both it and the assistant message carry the error, which is also the
   *  only place the reason is written down. */
  /**
   * The last message id, used as "where I was" when a turn starts.
   *
   * It replaces the message *count*, which was the right idea and the wrong
   * number: `getMessages` returns a fixed-size page of the newest messages, so
   * past that size the length stops growing and `length > before` is never true —
   * a long session would look like a turn that never ends, or (worse) never look
   * finished at all. An id keeps working however much the window slides.
   */
  const markOf = (messages) => (messages?.[messages?.length - 1]?.id || '');

  /** The messages after `mark`. Everything, when the mark has aged out of the page. */
  function afterMark(messages, mark) {
    if (!mark) return messages || [];
    const at = (messages || []).findIndex((m) => m.id === mark);
    return at >= 0 ? messages.slice(at + 1) : messages || [];
  }

  /**
   * Did the turn end in an error? The *last* assistant message is the answer, not
   * the first error anywhere after the mark. A permission decline ends one step
   * with "Step interrupted", but the gate writes a refusal note and the worker can
   * answer it with its report; reading the first error made the runner retry a
   * turn that had already recovered, and told the worker the provider cut it.
   */
  function turnErrorOf(messages, mark = '') {
    let last = null;
    for (const message of afterMark(messages, mark)) {
      if (message?.type === 'assistant') last = message;
    }
    return last?.error ? String(last.error) : null;
  }

  /** Did a tool in this turn end because its permission was declined? The gate
   *  already sent the refusal note; retrying the turn as a provider failure would
   *  tell the worker the wrong story and invite it to run the same tool again. */
  function toolDeclined(messages, mark = '') {
    for (const message of afterMark(messages, mark)) {
      for (const part of message?.parts || []) {
        if (part?.type !== 'tool') continue;
        if (/declined this tool call|permission (?:was )?denied|permission refused/i.test(String(part.error || ''))) {
          return true;
        }
      }
    }
    return false;
  }

  const textOf = (m) => (m.parts || []).filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n\n').trim();

  function workerText(messages) {
    const answers = (messages || [])
      .filter((m) => m.type === 'assistant')
      .map(textOf)
      .filter(Boolean);
    const last = answers[answers.length - 1] || '';
    return last.length > RESULT_MAX ? `${last.slice(0, RESULT_MAX)}…` : last;
  }

  /** Files the worker wrote or edited, from its own tool calls — the evidence,
   *  not its claim. */
  function workerFiles(messages) {
    const seen = new Set();
    for (const message of messages || []) {
      for (const part of message?.parts || []) {
        if (part?.type !== 'tool') continue;
        if (!/^(write|edit)$/.test(String(part.name || ''))) continue;
        const input = parseInput(part.input) || {};
        const file = input.filePath || input.file_path || input.path;
        if (file) seen.add(String(file));
      }
    }
    return [...seen];
  }

  /** Which skills a worker actually loaded, read from its own tool calls. The
   *  `skill` tool carries `input.id`; older shapes put the name in `title`, and the
   *  returned text always starts `<skill_content name="…">`, so all three are read. */
  function workerSkills(messages) {
    const seen = new Set();
    for (const message of messages || []) {
      for (const part of message?.parts || []) {
        if (part?.type !== 'tool' || part.name !== 'skill') continue;
        const input = parseInput(part.input) || {};
        const named = input.id || input.name || input.skill || part.title;
        if (named) seen.add(String(named).trim());
        const m = String(part.output || '').match(/<skill_content name="([^"]+)"/);
        if (m) seen.add(m[1]);
      }
    }
    return seen;
  }

  /** The first sentence of a long reason, for the line the operator reads in a toast. */
  function firstSentence(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    const at = t.indexOf('. ');
    return at === -1 ? t : t.slice(0, at + 1);
  }

  function report({ task, role, insteadOf, skipped, outcome, harnessStop, ms, text, files, context, workerId, planTouched, synapseTouched, qcRound, skillsRequired, skillsMissing, auto, stallSec, retries, resumes, error, stoppedBy, lastTurnError, steers }) {
    const head =
      outcome === 'completed'
        ? `${task.id} (${role}) finished in ${Math.round(ms / 1000)}s.`
        : outcome === 'timeout'
          ? `${task.id} (${role}) produced nothing for ${Math.round(stallSec / 60)} minutes in a row and was stopped` +
            `${resumes ? ` after ${resumes} restart${resumes === 1 ? '' : 's'}` : ''}.`
          : harnessStop
            ? `${task.id} (${role}) ran for ${Math.round(ms / 1000)}s and was stopped by the harness, not by the operator.`
            : stoppedBy === 'operator'
              ? `${task.id} (${role}) was stopped by the operator after ${Math.round(ms / 1000)}s. ` +
                `A stop is not a verdict on the task or the model.`
              : outcome === 'error'
                ? `${task.id} (${role}) could not run - the provider refused the turn, so no further work was attempted.`
                : `${task.id} (${role}) could not run.`;
    const lines = [head];
    if (insteadOf) {
      const why = (skipped || []).find((s) => s.role === insteadOf);
      lines.push(
        `This attempt ran on ${role}, not ${insteadOf}: ${insteadOf} could not do it, so the harness moved the ` +
          `task down its line of coders. The plan still says ${insteadOf} - leave the role as it is and judge ` +
          `the work on its merits.` +
          (why?.message ? `\n${insteadOf}'s model was refused: ${why.message}` : ''),
      );
    }
    // The operator may have changed the task while it ran. The Architect must
    // judge the work against what was actually asked for at the end, not the
    // brief the worker started with.
    if (steers?.length) {
      lines.push('The operator steered this run while it worked:');
      for (const s of steers.slice(-3)) {
        const said = String(s.text || '').replace(/\s+/g, ' ').trim();
        lines.push(`- ${s.by ? `${s.by}: ` : ''}"${said}"`);
      }
      lines.push(
        'Judge the work against those instructions, and put the change in the task note and the plan so the ' +
          'plan matches the work. If a steer changes the task materially, ask the operator with the question ' +
          'tool before locking it in.',
      );
    }
    // A stop is the operator's decision, not a coder's failure. Without this the
    // Architect's first move was to delegate the same task again; the project is
    // held, so that delegation is refused - better not to ask.
    if (stoppedBy === 'operator') {
      lines.push('The operator stopped it on purpose: do not delegate this task again unless they say so.');
    }
    // The evidence, never omitted: a worker that claims a file it did not write
    // is a real failure mode (it happened on the first run: the report named
    // bin/calendar_design.md and no such file existed). "Files written: none"
    // is what made the claim obvious to the Architect.
    if (lastTurnError && !/step interrupted/i.test(lastTurnError)) {
      lines.push(`Before the stop, the last turn had ended with: ${lastTurnError}`);
    }
    lines.push(files.length ? `Files written: ${files.join(', ')}` : `Files written: none.`);
    if (skillsMissing?.length) {
      lines.push(
        `Skills this role is required to load, and did not: ${skillsMissing.join(', ')}. The brief asks for ` +
          `them before the first edit; judge whether the work is complete without them.`,
      );
    }
    // reached 200k generated at half the rate of one that stayed under 50k, so a
    // long run is mostly a big transcript — which is the signal to split it, not
    // to doubt the model.
    if (context && context.turns) {
      lines.push(
        `Effort: ${context.turns} turn${context.turns === 1 ? '' : 's'}, ${tokens(context.prompt)} prompt tokens ` +
          `read (the provider's meter), ${tokens(context.generated)} written (${thinkNote(context)}), ` +
          `context peaked at ${tokens(context.peak)}` +
          (context.compactions
            ? context.compactions === 1
              ? ' and was summarised once.'
              : ` and was summarised ${context.compactions} times.`
            : '.') +
          (context.peak > 150000 ? ' Past about 150k a run gets slower with every turn.' : ''),
      );
    }
    // How much of the night went into this. A recovered run is not a bad run, and
    // the Architect should not read five retries as five failures.
    if (retries) {
      lines.push(
        `The provider failed ${retries} time${retries === 1 ? '' : 's'} on the way (rate limits and connection ` +
          `errors are retried, not counted as attempts); the work above is what survived.`,
      );
    }
    if (resumes) {
      lines.push(
        `It was restarted ${resumes} time${resumes === 1 ? '' : 's'} after producing nothing for a long stretch, ` +
          `and carried on from where it was.`,
      );
    }
    if (error) {
      lines.push(`The provider said: ${error}`);
      lines.push(
        `That is not a judgement on the task. If it names a retired or unknown model, pick another model for ` +
          `that role (or run the task on another role), then delegate this task again.`,
      );
    }
    if (text) lines.push(`Reported:\n${text}`);
    else if (!error) lines.push(`It reported nothing.`);
    if (planTouched) {
      lines.push(
        `Warning: the plan file changed while the worker ran. A worker is never meant to write it — ` +
          `check what changed before trusting the file.`,
      );
    }
    if (Array.isArray(synapseTouched) && synapseTouched.length) {
      lines.push(
        `Warning: these files changed inside .synapse while the worker ran, and they are not this role's to ` +
          `write: ${synapseTouched.slice(0, 8).join(', ')}. The file tools are refused there, so this went ` +
          `around them; check the contents before you trust the plan or the contract.`,
      );
    }
    if (role === 'qc' && qcRound >= QC_ROUNDS) {
      lines.push(
        `That was QC round ${qcRound} of ${QC_ROUNDS} - the loop is closed. Do not delegate another QC pass: ` +
          `tell the operator what is still open, with the issue ids, and let them decide.`,
      );
    }
    lines.push(
      `You are the only writer of the plan: judge this yourself. Mark ${task.id} done if it holds, ` +
        `send it back with what is wrong if it does not, or mark it blocked if it needs the operator.`,
    );
    lines.push(
      auto
        ? `Keep building is ON: having judged this, delegate the next task whose dependencies are done ` +
            `and keep going until the plan is finished or a task is blocked.`
        : `Keep building is OFF: stop after judging this one and wait for the operator.`,
    );
    return lines.join('\n');
  }
  /**
   * Wake the Architect with the harness speaking, and make sure it landed.
   *
   * This used to be fire-and-forget: `synthetic` was admitted, the runner moved
   * on, and nothing watched what happened next. In the clock run the Architect's
   * own turn then failed on a rate limit two seconds later — the report sat in
   * the transcript, nobody read it, no delegation followed, and the run stopped
   * with the UI showing an idle screen. The words were delivered; the work was
   * not.
   *
   * So the wake is watched now, and a recoverable failure is retried with the
   * same backoff as a worker's turn. The report itself is sent once — it is in
   * the transcript — and later attempts just say "continue".
   */
  async function wake(architectId, dir, { description, text }, signal) {
    const settings = workerSettings(getConfig() || {});
    let tries = 0;
    let usageSince = 0;
    for (;;) {
      if (signal?.aborted) return { ok: false, stopped: true };
      let before = '';
      try {
        before = markOf(await engine.getMessages(architectId));
      } catch { /* the send below will surface it */ }

      try {
        await engine.synthetic(architectId, tries === 0 ? text : WAKE_NUDGE, {
          description: tries === 0 ? description : `${description} (retry)`,
        });
      } catch (err) {
        const cls = classifyFailure(err.message);
        // Nothing to wake: the Architect's session was deleted under us, which is
        // the operator's own cancellation. Quiet on purpose — a red card for work
        // they stopped is noise.
        if (cls.reason === 'gone') {
          log.info(`nothing to wake: ${architectId} no longer exists`);
          return { ok: false, gone: true };
        }
        recordProviderError({
          message: err.message,
          classification: cls,
          role: 'architect',
          note: 'the synthetic message could not be sent',
        });
        if (cls.kind === 'terminal') {
          log.error(`could not report to the Architect: ${err.message}`);
          notify?.({ kind: 'role-error', dir, role: 'architect', message: err.message, final: true });
          return { ok: false, error: err.message };
        }
        tries += 1;
        const delay = backoffMs(tries, settings);
        notify?.({
          kind: 'role-error',
          dir,
          role: 'architect',
          message: err.message,
          retrying: true,
          at: Date.now() + delay,
        });
        log.warn(`wake ${architectId} failed (${cls.reason}); retrying in ${Math.round(delay / 1000)}s`);
        await sleep(delay, signal);
        continue;
      }

      // Watch the turn it started. Without this the runner cannot tell a report
      // that was judged from one that was read by nobody. The Architect's session
      // outlives every delegation, so it gets the same window watch — and its own
      // model, not the card's, since the operator may have switched it.
      let archRef = getConfig()?.roles?.architect?.ref || null;
      try {
        archRef = (await engine.getSession(architectId))?.model || archRef;
      } catch { /* the card's choice is the best we have */ }
      const finished = await waitForIdle(
        architectId,
        before,
        settings.stallSec * 1000,
        null,
        signal,
        { window: contextWindow(archRef) },
      );
      if (finished.stopped) return { ok: false, stopped: true };

      let messages = [];
      try {
        messages = await engine.getMessages(architectId);
      } catch { /* checked below as "no error seen" */ }
      const err = finished.stalled ? `nothing happened for ${Math.round(settings.stallSec / 60)} minutes` : turnErrorOf(messages, before);
      if (!err) {
        notify?.({ kind: 'role-error', dir, role: 'architect', clear: true });
        return { ok: true };
      }

      const cls = finished.stalled
        ? { kind: 'transient', reason: 'stalled' }
        : classifyFailure(err);
      recordProviderError({ message: err, classification: cls, role: 'architect', note: 'the wake turn failed' });

      if (cls.kind === 'terminal') {
        log.error(`the Architect could not process the report: ${err}`);
        notify?.({ kind: 'role-error', dir, role: 'architect', message: err, final: true });
        return { ok: false, error: err };
      }

      // The Architect's model hit a usage cap. Give it the same grace a worker
      // gets, then stop and say so: a capped Architect cannot read any report,
      // and the loop would otherwise retry it all evening.
      if (cls.reason === 'usage-limit') {
        if (!usageSince) usageSince = Date.now();
        if (Date.now() - usageSince > USAGE_LIMIT_MS) {
          const message =
            `${err} Synapse stopped retrying the Architect's usage cap after ` +
            `${Math.round(USAGE_LIMIT_MS / 60000)} minutes — switch the Architect to another model.`;
          log.error(`the Architect's usage cap did not clear: ${err}`);
          notify?.({ kind: 'role-error', dir, role: 'architect', message, final: true });
          return { ok: false, error: message };
        }
      } else {
        usageSince = 0;
      }

      // The Architect's own transcript outgrew the window. Compact it, then let
      // the loop send the report again - the transcript keeps a summary of what
      // came before, so nothing is lost that a retry would have kept.
      if (cls.kind === 'context') {
        out.warn(`the Architect's context is full; compacting it and sending the report again`);
        try {
          await engine.compact(architectId);
        } catch (e) {
          log.warn(`compaction after a context error failed: ${e.message}`);
        }
        await sleep(3000, signal);
        continue;
      }

      tries += 1;
      const delay = backoffMs(tries, settings);
      notify?.({
        kind: 'role-error',
        dir,
        role: 'architect',
        message: err,
        retrying: true,
        at: Date.now() + delay,
      });
      log.warn(
        `the Architect's turn failed (${cls.reason}: ${err}); waking it again in ${Math.round(delay / 1000)}s`,
      );
      await sleep(delay, signal);
    }
  }

  /** What is running now, for `GET /api/runs` — so a reloaded UI reopens onto
   *  the same picture the cards had before it. */
  const active = () => [...running.values()];

  /**
   * Put the operator's words into the live worker's turn.
   *
   * Measured on engine 2.1.2: a prompt with `delivery: "steer"` joins the turn
   * already running and is read at its next step boundary — after the tool call
   * in flight, not in the middle of a token. That is the only kind of "during
   * work" the engine offers; Stop remains the hard interrupt.
   *
   * Refused while the worker is between attempts: a steer admitted during a
   * provider backoff would start a turn of its own and race the retry.
   */
  async function steer(dir, { text, files, actor } = {}) {
    const key = dirKey(dir);
    const live = running.get(key);
    if (!live) return { ok: false, reason: 'Nothing is running in this project.' };
    if (!live.workerId) return { ok: false, reason: 'The worker is starting; try again in a moment.' };
    if (live.retry) {
      return { ok: false, reason: 'The worker is waiting out a provider limit; Stop it or wait.' };
    }
    const said = String(text || '').trim();
    if (!said) return { ok: false, reason: 'The steer is empty.' };
    try {
      // `[steer]` is what tells the model this is guidance for the current task
      // and not a new request; the role briefs say how to treat it.
      await engine.prompt(live.workerId, `[steer] ${said}`, { files, delivery: 'steer' });
    } catch (err) {
      return { ok: false, reason: `Could not reach the worker: ${err.message}` };
    }
    const at = Date.now();
    const entry = { at, by: actor?.name || null, text: said.slice(0, 1200) };
    live.steers.push(entry);
    live.steered = live.steers.length;
    appendRun(dir, { kind: 'steer', scope: 'worker', task: live.task, role: live.role, ...entry });
    emit('run.steer', {
      dir,
      task: live.task,
      role: live.role,
      startedAt: live.startedAt,
      ...entry,
    });
    out.info(`steer -> ${live.task} (${live.role}) from ${entry.by || 'operator'}: ${said.slice(0, 120)}`);
    return { ok: true, target: 'worker', task: live.task, role: live.role, at };
  }

  /** Ask the live run to stop at the end of the step it is in. The second Stop
   *  is `cancel()` below; this one only sets the intention. */
  async function requestStop(dir) {
    const key = dirKey(dir);
    const control = controls.get(key);
    const live = running.get(key);
    if (!control?.requestStop || !live) return { ok: false };
    const fresh = await control.requestStop();
    return { ok: true, stopping: true, already: !fresh, task: live.task, role: live.role };
  }

  /** Stop the run in a project, whichever part of it is running. Returns whether
   *  there was anything to stop. The wait loops see the abort on their next poll
   *  (and a backoff sleep is cut short), so this is immediate even mid-retry. */
  function cancel(dir) {
    const key = dirKey(dir);
    const control = controls.get(key);
    if (!control) return false;
    // Stop means stop: nothing is delegated and nobody is reminded until the
    // operator speaks again. Without this the run stopped and the next task
    // started anyway, which is what the operator saw as "it just retries later".
    stoppedByOperator.add(key);
    const live = running.get(key);
    control.abort();
    if (live?.workerId) {
      engine.interrupt(live.workerId).catch(() => { /* already gone */ });
    }
    // Nothing is running now, so a task marked `doing` is not doing anything — and
    // an untouched one says "1 running" on the plan for the rest of the day.
    if (live?.task) setTaskStatus(dir, live.task, 'todo');
    log.warn(`run in ${dir} stopped by the operator`);
    return true;
  }

  /** The operator has spoken. Whatever they stopped may run again. */
  function resume(dir) {
    const key = dirKey(dir);
    if (!stoppedByOperator.delete(key)) return false;
    log.info(`the operator spoke in ${dir} - runs may start again`);
    return true;
  }

  /** Nothing was running, but the operator pressed Stop: hold the project so the
   *  Architect's next turn cannot delegate the work they just stopped. */
  function hold(dir, why = 'stopped by the operator') {
    if (stoppedByOperator.has(dirKey(dir))) return false;
    stoppedByOperator.add(dirKey(dir));
    log.warn(`run in ${dir} ${why} - nothing will be delegated until they speak`);
    return true;
  }

  /**
   * Stop the run a session belongs to, with a reason the report will carry.
   *
   * Used by the question-loop guard in src/api.js: a worker that asks the same
   * question a third time is not gathering information, it is stuck, and the
   * operator asked to be told that rather than asked again. Returns whether a run
   * was found.
   */
  function stopWithReason(sessionId, reason) {
    const live = [...running.values()].find((r) => r.workerId === sessionId || r.architectId === sessionId);
    if (!live) return false;
    const control = controls.get(dirKey(live.dir));
    if (!control) return false;
    if (typeof control.stop === 'function') control.stop(reason);
    else control.abort();
    if (live.workerId) engine.interrupt(live.workerId).catch(() => { /* already gone */ });
    log.warn(`run in ${live.dir} stopped by the harness: ${reason}`);
    return true;
  }

  return {
    handleTurn,
    recoverDelegations,
    recoverInterrupted,
    recoverLostReports,
    requestsIn,
    active,
    steer,
    requestStop,
    cancel,
    resume,
    hold,
    stopWithReason,
    closeRound,
  };
}

