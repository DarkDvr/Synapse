// The screen: one project at a time may use it, and only because the operator
// said so.
//
// A worker that launches an app or photographs a window takes the mouse, the
// keyboard and the focus of whatever the operator was doing — a game, a sentence
// half typed. That is not a question about a file; it is "may I use your PC for a
// moment". So it is asked once, in the operator's own words, and the answer is a
// lease they can take back at any moment (5 Nov).
//
// The lease is machine-wide on purpose: there is one mouse and one keyboard, so a
// second project asking while another holds it is refused, not queued.
//
// It ends when the work that asked ends (the run), when the operator takes it back,
// or when the worker says it is done with the screen. Every ending is announced:
// the operator needs to know when their PC is theirs again.
const norm = (dir) => String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Has the tool call that took the screen finished?
 *
 * The lease is about the call, not the run: a worker that clicks one button and
 * carries on must not keep the operator's mouse for the rest of a two-hour turn.
 * A call that is not in the transcript yet is not over — the poll will see it.
 */
export function screenCallOver(messages, callId) {
  if (!callId) return false;
  const part = (messages || [])
    .flatMap((message) => message?.parts || [])
    .find((p) => p?.type === 'tool' && p.id === callId);
  return Boolean(part && part.status && part.status !== 'running');
}

export function createDesk({ log = null, notify = null, getMessages = null } = {}) {
  let held = null; // { dir, key, role, task, sessionId, callId, at }
  // The lease is watched, not assumed: whoever asked may be a worker in a run or
  // the Architect's own turn, and only the transcript knows when the call is over.
  // Measured 6 Nov: a launch in a Single-mode chat held the badge for two and a
  // half minutes, because the per-call release only existed in the run loop.
  let watcher = 0;

  function stopWatching() {
    if (watcher) clearInterval(watcher);
    watcher = 0;
  }

  function watch(lease) {
    stopWatching();
    if (!getMessages || !lease?.sessionId || !lease?.callId) return;
    let ticks = 0;
    watcher = setInterval(async () => {
      if (!held || held !== lease || (ticks += 1) > 1800) {
        stopWatching();
        return;
      }
      let messages = null;
      try {
        messages = await getMessages(lease.sessionId);
      } catch {
        return; // the engine is restarting; the next tick decides
      }
      if (screenCallOver(messages, lease.callId)) release('the call finished with the screen', lease.dir);
    }, 1000);
    watcher.unref?.();
  }

  const announce = (type, extra = {}) => {
    notify?.({
      kind: 'desk',
      type,
      desk: held ? { ...held } : null,
      ...extra,
      ts: Date.now(),
    });
  };

  /** Is this project holding the screen right now? */
  const holds = (dir) => Boolean(held) && held.key === norm(dir);

  /** The project that holds it, or null. */
  const holder = () => (held ? { ...held } : null);

  /**
   * Give this project the screen. Refused when another project holds it: the
   * operator can only be using one of them.
   */
  function take({ dir, role = null, task = null, sessionId = null, callId = null } = {}) {
    const key = norm(dir);
    if (!key) return { ok: false, reason: 'no directory' };
    if (held && held.key !== key) {
      return { ok: false, reason: `${held.dir} already has the screen`, held: { ...held } };
    }
    const already = Boolean(held);
    held = { dir, key, role, task, sessionId, callId: callId || held?.callId || null, at: held?.at || Date.now() };
    watch(held);
    if (!already) {
      log?.info(`the screen was given to ${task || role || 'a worker'} (${dir})`);
      announce('desk.taken');
    }
    return { ok: true, already, held: { ...held } };
  }

  /** Give it back. `why` is the sentence the operator sees; `onlyDir` limits the
   *  release to that project, so a run ending cannot take another project's lease. */
  function release(why = '', onlyDir = null) {
    if (!held) return { ok: false, released: false };
    if (onlyDir && held.key !== norm(onlyDir)) return { ok: false, released: false };
    stopWatching();
    const was = held;
    held = null;
    log?.info(`the screen was released${why ? `: ${why}` : ''} (${was.dir})`);
    announce('desk.released', { why });
    return { ok: true, released: true, held: was };
  }

  return {
    take,
    release,
    holds,
    holder,
    state: () => ({ desk: held ? { ...held } : null }),
  };
}
