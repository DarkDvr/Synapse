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
  planFingerprint,
  BRIEF_KEY,
  PLAN_DIR,
  roleWriteRules,
  roleReadRules,
  synapseFingerprint,
  fingerprintDiff,
  ownedFolder,
} from './plans.js';
import { skillRules, describeSkills } from './skills.js';
import { classifyFailure, recordProviderError, pruneProviderLog } from './provider-errors.js';

const POLL_MS = 1500;
const RESULT_MAX = 4000;
const NOTE_MAX = 1000;
// A task that keeps coming back gets escalated instead of retried forever. The
// Architect is told, and it is the Architect that marks the task blocked — the
// harness never writes the plan, and never decides a task is hopeless.
const MAX_ATTEMPTS = 3;
// How many hack rounds a project gets before the harness closes the loop. A
// model will keep finding "one more issue" until the quota runs out; three
// rounds is the deal, then the remainder is the operator's to judge.
const HACK_ROUNDS = 3;
/** Completed hack rounds on a project: the loop is bounded by them, not by the
 *  model's appetite for one more issue. */
const hackRoundsUsed = (dir) =>
  readRuns(dir).filter((r) => r.kind === 'result' && r.role === 'hacker' && r.outcome === 'completed').length;
// Written by Synapse itself on every run, so a change to one of these is never a
// worker's doing. plan.json is reported separately (planTouched), which is why it
// is ignored here rather than alarming twice.
const HARNESS_FILES = new Set(['plan.json', 'runs.jsonl', 'requirement.md']);
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

export function createRunner({ engine, logger, getConfig, guard, notify, modelCache }) {
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
  // What is running right now, keyed by directory. The UI draws the cards' state
  // and the live path from this; it is also served over HTTP so a page reload
  // mid-run does not lose the picture.
  const running = new Map();
  // One stop button per live run: Stop must cut a backoff short, not wait it out.
  const controls = new Map();
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
   * Two rules, both about the same thing — a coder that cannot do the job:
   *
   *  - an attempt after the first starts a rung further down, because the
   *    Architect re-delegating the same task *is* its verdict that the previous
   *    coder did not deliver. It is the only verdict the harness can see, and it
   *    is exactly "blocked by a coder not able to do its job";
   *  - a rung whose model carries a provider mark is skipped, because the provider
   *    has already said it will not run it.
   *
   * A role outside the ladder has no peers and is tried alone.
   */
  function candidatesFor(role, attempt, config) {
    const ladder =
      Array.isArray(config?.worker?.ladder) && config.worker.ladder.length ? config.worker.ladder : DEFAULT_LADDER;
    const at = ladder.indexOf(role);
    if (at === -1) return [role];
    // Start at the role's own rung, not at the ladder's first: this used to be
    // `ladder.slice(skip)`, so a task written for coder-2 began on coder-1 — which
    // is how test-project-1's t2 "ran on coder-1, not coder-2" without anything
    // having failed. Step one rung per attempt, floored at the last rung.
    const room = Math.max(0, ladder.length - at - 1);
    const skip = Math.min(Math.max(0, (attempt || 1) - 1), room);
    const rest = ladder.slice(at + skip);
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
      // (tool rulesets cannot see it), so the refusal happens here, out loud.
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
              `Nothing was run: delegation is off in Single mode. ` +
              `Ask the operator to switch to Multi, then delegate ${request.task} again.`,
          });
        }
        return;
      }
      for (const request of requests) {
        claimed.add(request.callId);
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
        // The hack loop closes after three completed rounds. A model will keep
        // finding one more issue until the quota is gone; the third report says so
        // too, and this is what makes it true if the model ignores it.
        const asked = (readPlan(session.directory).plan?.tasks || []).find((t) => t.id === request.task);
        if (asked?.role === 'hacker' && hackRoundsUsed(session.directory) >= HACK_ROUNDS) {
          appendRun(session.directory, {
            kind: 'delegate',
            callId: request.callId,
            task: request.task,
            outcome: 'hack-cap',
          });
          log.info(`delegation refused: ${request.task} - ${HACK_ROUNDS} hack rounds are already spent`);
          notify?.({
            kind: 'note',
            title: 'Hack Loop Capped',
            body: `${HACK_ROUNDS} hack rounds are spent on this project, so ${request.task} was not run.`,
          });
          continue;
        }
        // Deliberately not awaited: the Architect's turn is over, and the worker
        // reports back through its own message when it is done.
        run(sessionId, session.directory, request).catch((err) =>
          log.warn(`delegation ${request.task} failed: ${err.message}`),
        );      }
    } catch (err) {
      log.warn(`could not look for delegation requests in ${sessionId}: ${err.message}`);
    }
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
      log.warn(`delegation deferred: a worker is already running in ${project}`);
      await wake(architectId, dir, {
        description: `delegate ${request.task} deferred`,
        text:
          `Nothing was run yet: another task is already running in this project. ` +
          `Ask again when it reports back.`,
      });
      return;
    }

    // How many times this task has actually been run. A refusal is not an
    // attempt, so refusals are recorded without an `attempt` number.
    const attempts = readRuns(dir).filter(
      (r) => r.kind === 'delegate' && r.task === task.id && typeof r.attempt === 'number',
    ).length;
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
    const config = getConfig() || {};
    const settings = workerSettings(config);
    const candidates = candidatesFor(task.role, attempts + 1, config);
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
    let outcome = 'failed';
    let text = '';
    let files = [];
    let turnError = null;
    // How many times this delegation was rescued rather than abandoned. Recorded
    // on the result line so the morning's log explains a long night.
    let retries = 0;
    let resumes = 0;
    // Stop: the operator's way out of a retry loop that is going nowhere.
    const controller = new AbortController();
    controls.set(dirKey(dir), { abort: () => controller.abort() });
    const signal = controller.signal;
    // Roles that were tried for this task and refused by their model. The report
    // carries the reason and the cards show it while the run is live.
    const skipped = [];

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

        worker = await engine.createSession({
          title: `${request.task} - ${role}`,
          model: modelRef ? { ref: modelRef, variant } : undefined,
          directory: dir,
          // Workers carry the harness guard too: they have the same toolset as the
          // Architect, and a worker is the most likely place for a stray absolute
          // path — it is the one being told to write files. The role's skill list
          // rides last so its allows beat the broad allow above.
          permissions: [
            ...(guard?.rules?.() || []),
            ...roleWriteRules(dir, role),
            ...roleReadRules(dir, role),
            ...skillRules(config, role),
          ],
          // Hidden from the rail: it runs in the project directory, so only this
          // mark tells Synapse it is scaffolding and not the operator's session.
          metadata: { synapse: { internal: true, role, task: request.task, architect: architectId } },
        });
        live.workerId = worker.id;

        // Its context: where it is, what the plan says, and that the plan is not
        // its to touch. The task itself goes in the message below.
        try {
          await engine.setInstruction(
            worker.id,
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

        let before = (await engine.getMessages(worker.id)).length;
        await engine.prompt(worker.id, workerPrompt({ task, note: request.note, goal: plan.plan?.goal }));

        // Rescue loop: one turn at a time, with the whole session kept between
        // them. Nothing is restarted from scratch, so the work already on disk and
        // in the transcript is the starting point of the next attempt.
        let rungRetries = 0;
        let rungResumes = 0;
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
          );

          if (finished.stopped) {
            outcome = 'stopped';
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
            await nudge(worker.id, STALL_NUDGE, signal);
            before = (await engine.getMessages(worker.id)).length;
            continue;
          }

          turnError = turnErrorOf(now, before);
          if (!turnError) {
            outcome = 'completed';
            // The role is working again: whatever the card was saying about a
            // provider failure is no longer news.
            alert({ dir, role, clear: true });
            break;
          }

          const cls = classifyFailure(turnError);
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
          await nudge(worker.id, RETRY_NUDGE, signal);
          before = (await engine.getMessages(worker.id)).length;
        }

        const messages = await engine.getMessages(worker.id);
        text = workerText(messages);
        files = workerFiles(messages);

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
    const strayWrites = fingerprintDiff(synapseBefore, synapseAfter, ownedFolder(role)).filter(
      (p) => !HARNESS_FILES.has(p),
    );
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
    const harnessChanged = guard?.changed?.(harnessBefore, harnessAfter) || [];
    if (harnessChanged.length) {
      guard.alarm({
        sessionId: architectId,
        what: 'CHANGED DURING A WORKER RUN',
        paths: harnessChanged.slice(0, 12),
        note: `${request.task} (${role})`,
      });
    }

    appendRun(dir, {
      kind: 'result',
      callId: request.callId,
      task: request.task,
      title: task.title,
      role,
      plannedRole: task.role,
      worker: worker?.id || null,
      outcome,
      ms: Date.now() - startedAt,
      // How the night went: a run that took three hours because the provider was
      // rate limiting is explained by these two numbers and the incident log.
      retries,
      resumes,
      error: turnError,
      files,
      text: text.slice(0, RESULT_MAX),
      planTouched,
      synapseTouched: strayWrites,
    });
    log.info(
      `delegation finished: ${request.task} (${role}) ${outcome} in ${Math.round((Date.now() - startedAt) / 1000)}s` +
        (retries ? `, ${retries} retr${retries === 1 ? 'y' : 'ies'}` : '') +
        (resumes ? `, ${resumes} restart${resumes === 1 ? '' : 's'}` : '') +
        (files.length ? `, ${files.length} file(s) written` : '') +
        (planTouched ? ' - THE PLAN FILE CHANGED DURING THE WORKER TURN' : '') +
        (strayWrites.length ? ` - .synapse WRITTEN OUTSIDE ITS FOLDER: ${strayWrites.join(', ')}` : ''),
    );

    out.info(
      `run ${request.task} (${role}) ${outcome} in ${Math.round((Date.now() - startedAt) / 1000)}s` +
        (retries ? `, ${retries} retr${retries === 1 ? 'y' : 'ies'}` : '') +
        (resumes ? `, ${resumes} restart${resumes === 1 ? '' : 's'}` : '') +
        (files.length ? `, ${files.length} file(s)` : ''),
    );

    // A stopped run is the operator's decision: no report and no wake. Waking the
    // Architect here would start a turn that could re-delegate the very task that
    // was just stopped, and the operator is about to say what they want instead.
    if (outcome === 'stopped') {
      out.warn(`run ${request.task} (${role}) stopped by the operator`);
      notify?.({
        kind: 'note',
        title: 'Run Stopped',
        body: `${request.task} was stopped. Nothing was reported to the Architect.`,
      });
      return;
    }

    // The "keep building" switch is read at report time, so flipping it while a
    // worker runs takes effect on the very next judgement.
    let auto = false;
    try {
      auto = (await engine.getSession(architectId))?.auto === true;
    } catch { /* session gone; treat as off */ }

    await wake(architectId, dir, {
      description: `worker ${request.task} (${role}) ${outcome}`,
      text: report({
        task,
        role,
        insteadOf: task.role !== role ? task.role : null,
        skipped,
        outcome,
        ms: Date.now() - startedAt,
        text,
        files,
        workerId: worker?.id,
        planTouched,
        synapseTouched: strayWrites,
        hackRound: hackRoundsUsed(dir),
        error: turnError,
        auto,
        stallSec,
        retries,
        resumes,
      }),
    }, signal);
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
  async function waitForIdle(sessionId, before, stallMs, onTool, signal) {
    let lastActivity = Date.now();
    let lastKey = '';
    let sig = '';
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

      const nextSig = activityKey(messages);
      if (nextSig !== sig) {
        sig = nextSig;
        lastActivity = Date.now();
      }

      if (onTool) {
        const tool = latestTool(messages, before);
        const key = tool ? `${tool.name}\u0000${tool.target}` : '';
        if (key && key !== lastKey) {
          lastKey = key;
          onTool(tool);
        }
      }

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

      if (messages.length > before && messages[messages.length - 1]?.type === 'idle') {
        return { timedOut: false };
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
  function latestTool(messages, from = 0) {
    let found = null;
    for (let i = Math.max(0, from | 0); i < (messages || []).length; i += 1) {
      for (const part of messages[i]?.parts || []) {
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

  /** The provider's own words for a turn that ended in an error, or null.
   *
   *  The engine appends `idle` even when the step failed — a retired model answers
   *  HTTP 410 in about two seconds — so the idle message alone cannot be read as
   *  success. Both it and the assistant message carry the error, which is also the
   *  only place the reason is written down. */
  function turnErrorOf(messages, from = 0) {
    for (const message of (messages || []).slice(Math.max(0, from | 0))) {
      if (message?.error) return String(message.error);
    }
    return null;
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

  function report({ task, role, insteadOf, skipped, outcome, ms, text, files, workerId, planTouched, synapseTouched, hackRound, auto, stallSec, retries, resumes, error }) {
    const head =
      outcome === 'completed'
        ? `${task.id} (${role}) finished in ${Math.round(ms / 1000)}s.`
        : outcome === 'timeout'
          ? `${task.id} (${role}) produced nothing for ${Math.round(stallSec / 60)} minutes in a row and was stopped` +
            `${resumes ? ` after ${resumes} restart${resumes === 1 ? '' : 's'}` : ''}.`
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
    // The evidence, never omitted: a worker that claims a file it did not write
    // is a real failure mode (it happened on the first run: the report named
    // bin/calendar_design.md and no such file existed). "Files written: none"
    // is what made the claim obvious to the Architect.
    lines.push(files.length ? `Files written: ${files.join(', ')}` : `Files written: none.`);
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
    if (role === 'hacker' && hackRound >= HACK_ROUNDS) {
      lines.push(
        `That was hack round ${hackRound} of ${HACK_ROUNDS} - the loop is closed. Do not delegate another hack: ` +
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
    for (;;) {
      if (signal?.aborted) return { ok: false, stopped: true };
      let before = 0;
      try {
        before = (await engine.getMessages(architectId)).length;
      } catch { /* the send below will surface it */ }

      try {
        await engine.synthetic(architectId, tries === 0 ? text : WAKE_NUDGE, {
          description: tries === 0 ? description : `${description} (retry)`,
        });
      } catch (err) {
        const cls = classifyFailure(err.message);
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
      // that was judged from one that was read by nobody.
      const finished = await waitForIdle(architectId, before, settings.stallSec * 1000, null, signal);
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

  /** Stop the run in a project, whichever part of it is running. Returns whether
   *  there was anything to stop. The wait loops see the abort on their next poll
   *  (and a backoff sleep is cut short), so this is immediate even mid-retry. */
  function cancel(dir) {
    const control = controls.get(dirKey(dir));
    if (!control) return false;
    control.abort();
    const live = running.get(dirKey(dir));
    if (live?.workerId) {
      engine.interrupt(live.workerId).catch(() => { /* already gone */ });
    }
    log.warn(`run in ${dir} stopped by the operator`);
    return true;
  }

  return { handleTurn, requestsIn, active, cancel };
}

