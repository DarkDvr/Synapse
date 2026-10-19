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
import { readPlan, briefSession, appendRun, readRuns, planFingerprint, BRIEF_KEY, PLAN_DIR } from './plans.js';

const POLL_MS = 1500;
const RESULT_MAX = 4000;
const NOTE_MAX = 1000;
// A task that keeps coming back gets escalated instead of retried forever. The
// Architect is told, and it is the Architect that marks the task blocked — the
// harness never writes the plan, and never decides a task is hopeless.
const MAX_ATTEMPTS = 3;
// Fallback only: the real ceiling comes from config (worker.timeoutSec, with a
// per-role override on roles.<id>.timeoutSec).
const DEFAULT_TIMEOUT_SEC = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export function createRunner({ engine, logger, getConfig, guard, notify }) {
  const log = logger.channel('tools');
  // One worker per project at a time: two Architects on the same plan is the
  // one thing that can actually corrupt it.
  const busy = new Set();
  // Requests picked up in this process, so a transcript re-read cannot re-run one.
  const claimed = new Set();
  // What is running right now, keyed by directory. The UI draws the cards' state
  // and the live path from this; it is also served over HTTP so a page reload
  // mid-run does not lose the picture.
  const running = new Map();
  const dirKey = (d) => String(d ?? '').replace(/[\\/]+$/, '').toLowerCase();

  /** Tell the open UIs what a worker is doing. A broken listener must never
   *  break a run, so this can never throw. */
  const emit = (type, data) => {
    try {
      notify?.({ kind: 'run', type, ...data });
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
        // Deliberately not awaited: the Architect's turn is over, and the worker
        // reports back through its own message when it is done.
        run(sessionId, session.directory, request).catch((err) =>
          log.warn(`delegation ${request.task} failed: ${err.message}`),
        );
      }
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

    const role = task.role;
    const roleConfig = getConfig()?.roles?.[role] || {};
    const modelRef = roleConfig.ref || null;
    const variant = roleConfig.variant || null;
    // The ceiling for this task: the role's own, else the global default.
    const config = getConfig() || {};
    const timeoutSec = Math.max(
      30,
      Number(roleConfig.timeoutSec) || Number(config.worker?.timeoutSec) || DEFAULT_TIMEOUT_SEC,
    );
    const timeoutMs = timeoutSec * 1000;
    const fingerprintBefore = planFingerprint(dir);
    const startedAt = Date.now();
    let worker = null;
    let outcome = 'failed';
    let text = '';
    let files = [];

    // Written before the worker starts: this is what makes the request answered
    // exactly once, whatever happens next.
    appendRun(dir, {
      kind: 'delegate',
      callId: request.callId,
      task: request.task,
      role,
      title: task.title,
      model: modelRef,
      variant,
      architect: architectId,
      attempt: attempts + 1,
    });
    log.info(
      `delegation: ${request.task} "${task.title}" -> ${role} ` +
        `(${modelRef || 'engine default'}${variant ? `#${variant}` : ''}) in ${project}, ceiling ${timeoutSec}s`,
    );

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
      timeoutSec,
      tool: null,
    };
    running.set(dirKey(dir), live);
    emit('run.started', live);

    // A restore point first, then a clean baseline: the harness is committed as it
    // stands, so anything it shows once the worker has stopped is the worker's
    // doing and can be put back. Both calls are cheap and neither is on the
    // worker's critical path — the snapshot is one `git add -u` + commit in the
    // harness repository, which a project never lives inside.
    await guard?.snapshot?.(`before ${task.id} (${role})`).catch(() => {});
    const harnessBefore = await guard?.state?.().catch(() => null);

    try {
      worker = await engine.createSession({
        title: `${request.task} - ${role}`,
        model: modelRef ? { ref: modelRef, variant } : undefined,
        directory: dir,
        // Workers carry the harness guard too: they have the same toolset as the
        // Architect, and a worker is the most likely place for a stray absolute
        // path — it is the one being told to write files.
        permissions: guard?.rules?.() || [],
        // Hidden from the rail: it runs in the project directory, so only this
        // mark tells Synapse it is scaffolding and not the operator's session.
        metadata: { synapse: { internal: true, role, task: request.task, architect: architectId } },
      });

      // Its context: where it is, what the plan says, and that the plan is not
      // its to touch. The task itself goes in the message below.
      try {
        await engine.setInstruction(worker.id, BRIEF_KEY, briefSession({ dir, role }));
      } catch (err) {
        log.warn(`worker brief failed for ${request.task}: ${err.message}`);
      }
      const before = (await engine.getMessages(worker.id)).length;
      await engine.prompt(worker.id, workerPrompt({ task, note: request.note, goal: plan.plan?.goal }));
      const finished = await waitForIdle(worker.id, before, timeoutMs, (tool) => {
        live.tool = tool;
        emit('run.progress', { ...live });
      });
      if (finished.timedOut) {
        outcome = 'timeout';
        try { await engine.interrupt(worker.id); } catch { /* already gone */ }
      } else {
        outcome = 'completed';
      }

      const messages = await engine.getMessages(worker.id);
      text = workerText(messages);
      files = workerFiles(messages);
    } catch (err) {
      outcome = 'failed';
      text = `the worker could not run: ${err.message}`;
      log.warn(`worker for ${request.task} failed: ${err.message}`);
    } finally {
      busy.delete(dir);
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

    // And nor must the harness. The snapshot above left a known state; whatever
    // the repository shows now that it did not show then happened while the
    // worker was running — however it happened, and whether or not a tool call
    // named a path. Reported before the Architect is woken, so the two never
    // disagree about what the worker did.
    const harnessAfter = await guard?.state?.().catch(() => null);
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
      role,
      worker: worker?.id || null,
      outcome,
      ms: Date.now() - startedAt,
      files,
      text: text.slice(0, RESULT_MAX),
      planTouched,
    });
    log.info(
      `delegation finished: ${request.task} (${role}) ${outcome} in ${Math.round((Date.now() - startedAt) / 1000)}s` +
        (files.length ? `, ${files.length} file(s) written` : '') +
        (planTouched ? ' - THE PLAN FILE CHANGED DURING THE WORKER TURN' : ''),
    );

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
        outcome,
        ms: Date.now() - startedAt,
        text,
        files,
        workerId: worker?.id,
        planTouched,
        auto,
        timeoutMs,
      }),
    });
  }

  /** Poll until the worker's turn closes with `idle`, which is the engine's own
   *  end-of-turn signal — never a timer. The ceiling is the task's own
   *  (per-role) one, and hitting it interrupts the session and reports a timeout;
   *  whatever the worker produced up to then is still gathered as evidence.
   *
   *  The same poll is where the card's live activity comes from: the worker's
   *  transcript is already being fetched, so the newest tool call costs nothing
   *  extra and the operator can watch the work instead of guessing at it. */
  async function waitForIdle(workerId, before, timeoutMs, onTool) {
    let deadline = Date.now() + timeoutMs;
    let lastKey = '';
    let asking = false;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      let messages;
      try {
        messages = await engine.getMessages(workerId);
      } catch {
        continue;
      }
      if (onTool) {
        const tool = latestTool(messages, before);
        const key = tool ? `${tool.name}\u0000${tool.target}` : '';
        if (key && key !== lastKey) {
          lastKey = key;
          onTool(tool);
        }
      }

      // A question for the operator is not a stalled worker. The engine blocks
      // the turn until it is answered, which may be hours — so while one is
      // pending the ceiling stops counting, or every worker that asks anything
      // is guaranteed to be interrupted for asking. It is read from the
      // transcript already being polled, so this costs nothing.
      const last = messages[messages.length - 1];
      const waiting = (last?.parts || []).some(
        (p) => p?.type === 'tool' && /^question$/.test(String(p.name || '')) && /run|pend|progress/i.test(String(p.status || '')),
      );
      if (waiting) {
        deadline = Date.now() + timeoutMs;
        if (!asking) log.info(`worker ${workerId} is waiting on an answer; its ceiling is paused`);
      } else if (asking) {
        log.info(`worker ${workerId} has an answer; its ceiling is running again`);
      }
      asking = waiting;

      if (messages.length > before && messages[messages.length - 1]?.type === 'idle') {
        return { timedOut: false };
      }
    }
    return { timedOut: true };
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

  function report({ task, role, outcome, ms, text, files, workerId, planTouched, auto, timeoutMs }) {
    const head =
      outcome === 'completed'
        ? `${task.id} (${role}) finished in ${Math.round(ms / 1000)}s.`
        : outcome === 'timeout'
          ? `${task.id} (${role}) did not finish within ${Math.round(timeoutMs / 1000)}s and was interrupted.`
          : `${task.id} (${role}) could not run.`;
    const lines = [head];
    // The evidence, never omitted: a worker that claims a file it did not write
    // is a real failure mode (it happened on the first run: the report named
    // bin/calendar_design.md and no such file existed). "Files written: none"
    // is what made the claim obvious to the Architect.
    lines.push(files.length ? `Files written: ${files.join(', ')}` : `Files written: none.`);
    if (text) lines.push(`Reported:\n${text}`);
    else lines.push(`It reported nothing.`);
    if (planTouched) {
      lines.push(
        `Warning: the plan file changed while the worker ran. A worker is never meant to write it — ` +
          `check what changed before trusting the file.`,
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
  /** Wake the Architect with the harness speaking. A synthetic message keeps it
   *  out of the operator's voice; the prompt route is the fallback if an engine
   *  has no such thing. */
  async function wake(architectId, dir, { description, text }) {
    try {
      await engine.synthetic(architectId, text, { description });
    } catch (err) {
      log.warn(`synthetic message failed (${err.message}); falling back to a prompt`);
      try {
        await engine.prompt(architectId, text);
      } catch (err2) {
        log.warn(`could not report back to ${architectId}: ${err2.message}`);
      }
    }
  }

  /** What is running now, for `GET /api/runs` — so a reloaded UI reopens onto
   *  the same picture the cards had before it. */
  const active = () => [...running.values()];

  return { handleTurn, requestsIn, active };
}

