// Stop: one intent per project, and one definition of stopped.
//
// Stop has been patched a dozen times — a flag in the run loop, a 45-second timer
// in the API, a wake abort, a hold, a page-side second press — and each patch
// fixed the leak the one before it left. The leak that survived them all is the
// engine's own retry loop: when the provider answers 429 the engine schedules a
// retry *inside the session* and fires it about thirty seconds later, on its own.
// An interrupt that lands during that wait has nothing to abort, so it does
// nothing at all; the retry fires and the work carries on.
//
// Measured 6 Nov: five Stops at 11:51:47–11:51:51 were each answered "1 session
// interrupted", and the engine retried at 11:52:05, 11:52:36, 11:53:07, 11:53:38
// and 11:54:08. The sixth Stop landed 1.6 s after a step had started and worked.
// After the eighth failure the engine scheduled a retry for 11:58:00, never fired
// it, and left the session listed as active with nothing running — the state
// where the Stop button is enabled, the log says "interrupted", and the event
// list freezes on `retry.scheduled`.
//
// So this module owns Stop. One intent per project, one timer, and one answer to
// "is it stopped?":
//
//   - no session in the project is active, and
//   - every session we touched ends its transcript with an `idle` message, which
//     is the engine's own end-of-turn marker.
//
// Anything else is still stopping. A session that is not active but has no idle
// marker is the wedged state above; it is interrupted again, and that is what
// clears it. A second press cuts now instead of waiting for the step boundary.
//
// The first press stays gentle: the step in flight finishes, and the turn is cut
// when the next one begins (the engine's `session.step.started`) or when the
// engine schedules a retry — a step that failed has nothing left to finish. After
// STOP_GRACE_MS it cuts anyway. Every harness-side effect of a stop (the run's
// report, the Architect's wake loop, the hold that keeps the plan reminder quiet,
// the screen lease) happens here, once, so no caller has to remember it.

/** How long a gentle Stop lets the step in flight run before cutting anyway. */
export const STOP_GRACE_MS = 45_000;
/** Quiet ticks in a row before a stop is called done. */
const QUIET_TICKS = 2;
/** After this, the stop is reported as stuck instead of quietly continuing. */
const STUCK_MS = 60_000;
/** After this, stop hammering: report it and leave the operator to decide. */
const GIVE_UP_MS = 300_000;
const TICK_MS = 1_000;

// Which sessions a Stop must reach.
//
// Stop used to interrupt the session on screen. That is usually the Architect,
// and it is usually idle while a worker works — so the worker carried on, the
// Architect was woken by its report, and the operator watched a run that would
// not stop. The run record is not a reliable list either: a worker can outlive a
// run that has already reported or been cancelled.
//
// The engine's own list of active sessions is the authority. This picks the ones
// in the same project as the session whose Stop was pressed, plus that session,
// so a stale active list cannot leave the asked session un-interrupted.
export function stopTargets({ sessionId, directory, active = [], sessions = [] }) {
  const norm = (value) =>
    String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();

  const targets = new Set();
  if (sessionId) targets.add(sessionId);
  if (!directory) return [...targets];

  const byId = new Map((sessions || []).map((s) => [s.id, s]));
  for (const id of active || []) {
    if (!id || id === sessionId) continue;
    const session = byId.get(id);
    // A session the engine could not describe is left alone: interrupting a
    // different project's work because its directory is unknown is worse than
    // missing it.
    if (!session?.directory) continue;
    if (norm(session.directory) !== norm(directory)) continue;
    targets.add(id);
  }
  return [...targets];
}

/**
 * The one owner of Stop.
 *
 * @param engine   the engine contract (active list, sessions, messages, interrupt)
 * @param runs     the runner, for the harness side of a stop (all optional)
 * @param desk     the screen lease, released when the work stops (optional)
 * @param log      a logger channel
 * @param notify   broadcast to the pages (optional)
 */
export function createStopper({
  engine,
  runs = null,
  desk = null,
  log = null,
  notify = null,
  now = Date.now,
  tickMs = TICK_MS,
  graceMs = STOP_GRACE_MS,
  stuckMs = STUCK_MS,
  giveUpMs = GIVE_UP_MS,
} = {}) {
  const norm = (value) =>
    String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();

  /** project key → the intent in force */
  const intents = new Map();
  /** project key → the one timer watching it */
  const timers = new Map();
  /** session id → its project, so an engine event can find the intent */
  const known = new Map();

  // ── what is running, and where ───────────────────────────
  async function directoryOf(sessionId) {
    if (known.has(sessionId)) return known.get(sessionId);
    try {
      const session = await engine.getSession(sessionId);
      if (session?.directory) {
        known.set(sessionId, session.directory);
        return session.directory;
      }
    } catch { /* a session the engine cannot describe is left alone */ }
    return null;
  }

  async function activeHere(intent) {
    let active = [];
    try {
      active = (await engine.listActiveSessions()) || [];
    } catch {
      // The engine is restarting or gone. That is not "quiet": leave the intent
      // where it is and let the next tick decide.
      return null;
    }
    const alive = [];
    for (const id of active) {
      if (!id) continue;
      const dir = await directoryOf(id);
      if (!dir || norm(dir) !== norm(intent.dir)) continue;
      known.set(id, dir);
      intent.sessions.add(id);
      alive.push(id);
    }
    return alive;
  }

  /**
   * Is every session we touched really at rest?
   *
   * The active list alone is not enough: during the engine's retry wait the
   * session can drop off it and come back thirty seconds later, and calling that
   * "stopped" is the bug this module exists to kill. The engine appends an
   * `idle` message at the end of every turn, so the transcript is the check.
   */
  async function atRest(intent) {
    for (const id of intent.sessions) {
      let messages;
      try {
        messages = await engine.getMessages(id);
      } catch {
        continue; // a session that is gone is quiet
      }
      const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
      if (!last) continue;
      if (last.type === 'idle') continue;
      // A failed step waiting out the engine's own retry, or a turn still open.
      // Either way there is a generation coming that nobody asked for.
      return false;
    }
    return true;
  }

  async function cut(intent, ids) {
    const targets = [...new Set([...ids].filter(Boolean))];
    if (!targets.length) return 0;
    intent.cuts += targets.length;
    let sent = 0;
    for (const id of targets) {
      try {
        await engine.interrupt(id);
        sent += 1;
      } catch { /* already gone */ }
    }
    if (sent && (intent.cuts <= 2 || intent.cuts % 10 === 0)) {
      log?.info(`stop: cut ${sent} session(s) in ${intent.dir} (${intent.cuts} cuts so far)`);
    }
    return sent;
  }

  function stopTimer(intent) {
    const timer = timers.get(norm(intent.dir));
    if (timer) clearInterval(timer);
    timers.delete(norm(intent.dir));
  }

  function finish(intent, why) {
    stopTimer(intent);
    intents.delete(norm(intent.dir));
    intent.phase = 'stopped';
    log?.info(`stop: ${intent.dir} is quiet — stopped${why ? ` (${why})` : ''}`);
    notify?.({ kind: 'stop', type: 'stop.done', dir: intent.dir, sessionId: intent.sessionId });
  }

  function reportStuck(intent, age) {
    if (intent.phase === 'stuck' || intent.phase === 'gave-up') return;
    intent.phase = 'stuck';
    log?.warn(
      `stop: ${intent.dir} is still running after ${Math.round(age / 1000)}s — ${
        intent.note || 'the engine will not stop'
      }`,
    );
    // The reason is the engine's own sentence when there is one; the page supplies
    // the plain-English wrapper, so a page can say "it will not stop" without the
    // log having to invent a cause.
    notify?.({ kind: 'stop', type: 'stop.stuck', dir: intent.dir, sessionId: intent.sessionId, reason: intent.note || null });
  }

  async function tick(intent) {
    if (!intents.has(norm(intent.dir))) return;
    if (intent.phase === 'gave-up') return;

    const age = now() - intent.at;
    if (age >= giveUpMs) {
      intent.phase = 'gave-up';
      stopTimer(intent);
      log?.warn(
        `stop: ${intent.dir} would not stop after ${Math.round(age / 1000)}s — giving up. ` +
          `${intent.note || 'the engine kept the session running.'}`,
      );
      notify?.({ kind: 'stop', type: 'stop.failed', dir: intent.dir, sessionId: intent.sessionId, reason: intent.note });
      return;
    }

    const alive = await activeHere(intent);
    if (alive === null) return;

    if (!alive.length) {
      if (await atRest(intent)) {
        intent.quiet += 1;
        if (intent.quiet >= QUIET_TICKS) finish(intent);
        return;
      }
      // Nothing is active, but a turn is still open: the engine's retry is
      // waiting, or the session wedged. Interrupting is what clears it.
      intent.quiet = 0;
      if (age >= stuckMs) {
        reportStuck(intent, age);
        if (now() - intent.lastCutAt < 5_000) return;
      }
      intent.lastCutAt = now();
      await cut(intent, [...intent.sessions]);
      return;
    }

    intent.quiet = 0;
    if (age >= stuckMs) {
      reportStuck(intent, age);
      // Keep trying, but slowly: a wedged engine does not need a request a second.
      if (now() - intent.lastCutAt < 5_000) return;
    }

    // The gentle press waits for the step boundary. A retry is a boundary too:
    // the step failed, so there is nothing left to finish.
    if (intent.phase === 'graceful' && !intent.boundary && age < graceMs) return;
    if (intent.phase === 'graceful') intent.phase = 'cutting';
    intent.lastCutAt = now();
    await cut(intent, alive);
  }

  function start(intent) {
    const timer = setInterval(() => {
      tick(intent).catch((err) => log?.warn(`stop: the watcher failed: ${err.message}`));
    }, tickMs);
    timer.unref?.();
    timers.set(norm(intent.dir), timer);
  }

  // ── the public surface ──────────────────────────────────

  /**
   * A Stop was pressed.
   *
   * `hard` cuts now; otherwise the step in flight finishes and the turn is cut at
   * the next boundary. Pressing Stop again while one is in force cuts now.
   */
  async function stop({ sessionId, hard = false } = {}) {
    const session = await engine.getSession(sessionId).catch(() => null);
    const dir = session?.directory || null;
    if (!dir) {
      const err = new Error('That session has no project, so there is nothing to stop.');
      err.status = 409;
      throw err;
    }
    known.set(sessionId, dir);

    let intent = intents.get(norm(dir));
    if (intent) {
      intent.hard = true;
      intent.boundary = true;
      intent.phase = 'cutting';
      const ids = [...intent.sessions];
      log?.info(`stop: pressed again in ${dir} — cutting now`);
      try {
        runs?.cancel?.(dir);
      } catch { /* the sessions are cut below either way */ }
      await cut(intent, ids);
      return { ok: true, stopping: true, phase: intent.phase, target: intent.target, already: true };
    }

    const live = (runs?.active?.() || []).find((r) => norm(r.dir) === norm(dir)) || null;
    intent = {
      dir,
      sessionId,
      at: now(),
      phase: hard ? 'cutting' : 'graceful',
      sessions: new Set([sessionId]),
      cuts: 0,
      quiet: 0,
      boundary: false,
      hard,
      note: null,
      lastCutAt: 0,
      target: live ? 'worker' : 'architect',
    };
    if (live?.workerId) {
      intent.sessions.add(live.workerId);
      known.set(live.workerId, dir);
    }
    intents.set(norm(dir), intent);

    // The harness side of a stop, once, here. A run that is cut now has its own
    // control aborted, so a worker asleep in a provider backoff wakes at once
    // instead of after its wait; a gentle stop only marks the run, and the turn
    // ends at the boundary. The wake loop dies either way, the hold keeps the plan
    // reminder from waking the Architect the moment the turn ends, and the screen
    // goes back.
    const quietly = (what, fn) => {
      try {
        fn();
      } catch (err) {
        log?.warn(`stop: could not ${what}: ${err.message}`);
      }
    };
    if (hard) {
      quietly('cancel the run', () => runs?.cancel?.(dir));
      quietly('mark the run stopped', () => runs?.requestStop?.(dir));
    } else {
      quietly('ask the run to end', () => runs?.requestStop?.(dir));
    }
    quietly('stop the Architect wake loop', () => runs?.stopWake?.(dir));
    quietly('hold the project', () => runs?.hold?.(dir));
    quietly('release the screen', () => desk?.release?.('the operator stopped the work', dir));

    log?.info(
      `stop: ${live ? `${live.task} (${live.role})` : sessionId} in ${dir} — ${
        hard ? 'cutting now' : 'finishing the step first'
      }`,
    );
    notify?.({ kind: 'stop', type: 'stop.started', dir, sessionId, hard });
    start(intent);
    if (hard) await cut(intent, [...intent.sessions]);
    return { ok: true, stopping: true, phase: intent.phase, target: intent.target };
  }

  /**
   * The operator spoke to the project again, so the stop no longer applies. Their
   * next turn must not be interrupted by a stop they have moved on from.
   */
  function clear(dir) {
    const intent = intents.get(norm(dir));
    if (!intent) return false;
    stopTimer(intent);
    intents.delete(norm(dir));
    log?.info(`stop: ${dir} was cleared — the operator spoke again`);
    return true;
  }

  /** The boundary detector. Fed every engine event by the boot wiring. */
  function handleEvent(ev) {
    if (!ev?.sessionId) return;
    const dir = known.get(ev.sessionId);
    if (!dir) return;
    const intent = intents.get(norm(dir));
    if (!intent) return;
    if (ev.type === 'session.step.started') intent.boundary = true;
    if (ev.type === 'session.retry.scheduled') {
      intent.boundary = true;
      const said = ev.raw?.properties?.error?.message || ev.message;
      if (said) intent.note = String(said).replace(/\s+/g, ' ').slice(0, 200);
    }
    if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(ev.type)) intent.boundary = true;
  }

  /** Is a stop in force for this project? */
  function stopping(dir) {
    const intent = intents.get(norm(dir));
    return Boolean(intent) && intent.phase !== 'gave-up';
  }

  /** What the pages show: one line per project that is stopping. */
  function state(dir) {
    const intent = dir ? intents.get(norm(dir)) : null;
    if (!intent) return null;
    return {
      dir: intent.dir,
      sessionId: intent.sessionId,
      phase: intent.phase,
      target: intent.target,
      since: intent.at,
      cuts: intent.cuts,
      reason: intent.note,
      hard: intent.hard,
    };
  }

  /** Every project currently stopping. */
  function all() {
    return [...intents.values()].map((intent) => state(intent.dir));
  }

  function dispose() {
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    intents.clear();
  }

  return { stop, clear, handleEvent, stopping, state, all, dispose };
}
