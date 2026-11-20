// One turn at a time per local model server.
//
// Two projects on the same server on this machine do not take turns politely. Each
// turn sends its whole prompt, so two at once means the server re-reads both, and may
// even reload a different model between them: both turns crawl and the operator sees
// "the model got slow". The harness is the only place that knows when a turn starts
// and when it ends, so it holds a lease per server: a turn that needs a busy server
// waits, in arrival order, until the turn holding it ends.
//
// What the lease is not:
//   - not global: two different local servers are two different leases, and a cloud
//     provider is never waited on at all;
//   - not per project: the unit is the turn, because the server is busy for exactly
//     as long as a turn is open, whether it is thinking, blocked on a card, or waiting
//     for the operator to answer a question.
//
// A lease is released by the turn's own `idle` (index.js does that for every turn),
// by a prompt that failed to start, or by `maxHoldMs` — a turn that never ends must
// not own the server for the rest of the evening.
import { isLocalProvider } from './providers.js';

/** The local server a model ref belongs to, or null for a cloud model. */
export function localServer(config, ref) {
  const text = String(ref || '').trim();
  const slash = text.indexOf('/');
  if (slash <= 0) return null;
  const id = text.slice(0, slash);
  const provider = (config?.engine?.opencode?.providers || []).find((p) => String(p.id) === id);
  if (!provider || !isLocalProvider(provider)) return null;
  const base = String(provider.baseURL || '').trim().replace(/\/+$/, '').toLowerCase();
  return { key: base || id, id, label: provider.name || id };
}

/**
 * @param {{log?: object, notify?: Function, maxHoldMs?: number}} [options]
 */
export function createLocalLease({ log = null, notify = null, maxHoldMs = 6 * 60 * 60 * 1000 } = {}) {
  const queue = []; // waiters, in arrival order
  const held = new Map(); // server key -> handle
  const bySession = new Map(); // session id -> handle
  let seq = 0;

  const say = (handle) => handle?.holder || 'another turn';

  function start(waiter) {
    const handle = { ...waiter, at: Date.now() };
    held.set(handle.key, handle);
    if (handle.sessionId) bySession.set(handle.sessionId, handle);
    handle.holdTimer = setTimeout(() => {
      log?.warn(
        `local server ${handle.label}: ${say(handle)} held it for over ` +
          `${Math.round(maxHoldMs / 60_000)} minutes; letting go`,
      );
      release(handle);
    }, maxHoldMs);
    handle.holdTimer.unref?.();
    log?.info(`local server ${handle.label}: ${say(handle)} has it`);
    if (!handle.quiet) {
      notify?.({
        kind: 'lease-server',
        type: 'lease.taken',
        server: handle.label,
        holder: say(handle),
        dir: handle.dir || null,
        ts: Date.now(),
      });
    }
    handle.resolve(handle);
  }

  function pump() {
    for (let i = 0; i < queue.length; ) {
      const waiter = queue[i];
      if (held.has(waiter.key)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      dropTimers(waiter);
      start(waiter);
    }
  }

  function dropTimers(waiter) {
    if (waiter.waitTimer) clearTimeout(waiter.waitTimer);
    waiter.waitTimer = null;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener?.('abort', waiter.onAbort);
  }

  function giveUp(waiter, why = 'gave up waiting') {
    const at = queue.indexOf(waiter);
    if (at >= 0) queue.splice(at, 1);
    dropTimers(waiter);
    log?.info(`local server ${waiter.label}: ${say(waiter)} ${why}`);
    waiter.resolve(null);
  }

  /** Wait for this server, then hand back a handle (or null on timeout/abort). */
  function acquire({
    serverKey,
    label = '',
    sessionId = null,
    holder = '',
    dir = null,
    waitMs = 0,
    signal = null,
    quiet = false,
    kind = 'turn',
  } = {}) {
    if (!serverKey) return Promise.resolve(null);
    // A session has one turn open at a time, so a second ask from it is the same lease.
    const existing = sessionId ? bySession.get(sessionId) : null;
    if (existing) return Promise.resolve(existing);
    const waiter = { id: ++seq, key: serverKey, label, sessionId, holder, dir, quiet, signal, kind };
    return new Promise((resolve) => {
      waiter.resolve = resolve;
      if (waitMs > 0) {
        waiter.waitTimer = setTimeout(() => giveUp(waiter, 'timed out waiting'), waitMs);
        waiter.waitTimer.unref?.();
      }
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      if (signal?.addEventListener) {
        waiter.onAbort = () => giveUp(waiter, 'was cancelled');
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      queue.push(waiter);
      if (held.has(serverKey)) {
        const owner = held.get(serverKey);
        log?.info(`local server ${label}: ${holder || 'a turn'} waits for ${say(owner)}`);
        if (!quiet) {
          notify?.({
            kind: 'lease-server',
            type: 'lease.waiting',
            server: label,
            holder: say(owner),
            waiter: holder || '',
            dir,
            ts: Date.now(),
          });
        }
      } else {
        pump();
      }
    });
  }

  function release(handle) {
    if (!handle) return false;
    if (handle.holdTimer) clearTimeout(handle.holdTimer);
    dropTimers(handle);
    if (held.get(handle.key) === handle) {
      held.delete(handle.key);
      log?.info(`local server ${handle.label}: ${say(handle)} is done with it`);
      if (!handle.quiet) {
        notify?.({
          kind: 'lease-server',
          type: 'lease.free',
          server: handle.label,
          holder: say(handle),
          dir: handle.dir || null,
          ts: Date.now(),
        });
      }
    }
    if (handle.sessionId && bySession.get(handle.sessionId) === handle) bySession.delete(handle.sessionId);
    pump();
    return true;
  }

  /** The turn for this session ended: free the server, or leave the queue. */
  function releaseSession(sessionId) {
    if (!sessionId) return false;
    const handle = bySession.get(sessionId);
    if (handle) return release(handle);
    const waiter = queue.find((w) => w.sessionId === sessionId);
    if (waiter) {
      giveUp(waiter, 'was cancelled');
      return true;
    }
    return false;
  }

  const holderOf = (serverKey) => held.get(serverKey) || null;
  const waiting = (sessionId) => queue.some((w) => w.sessionId === sessionId);
  const norm = (dir) => String(dir || '').replace(/[\\/]+$/, '').toLowerCase();
  /**
   * What is happening on this project's behalf, for the chat's waiting post.
   *
   * `waiting` is this project's turn standing in the queue (the operator's message,
   * usually); `held` is who has the server while it waits. Everything here comes from
   * memory the server owns, which is what lets the post survive switching projects and
   * a page reload.
   */
  function forDir(dir, sessionId = null) {
    const key = norm(dir);
    const idx = queue.findIndex(
      (w) => (sessionId && w.sessionId === sessionId) || (key && norm(w.dir) === key),
    );
    if (idx < 0) return null;
    const waiter = queue[idx];
    const owner = held.get(waiter.key) || null;
    // Who is ahead of this turn, in order: the answer the post needs to be honest about
    // — "VPA has it" alone is a lie once two more projects are queued in front (21 Nov).
    const ahead = queue
      .slice(0, idx)
      .filter((w) => w.key === waiter.key)
      .map((w) => w.holder || 'another turn');
    return {
      waiting: { server: waiter.label, holder: waiter.holder || '', since: waiter.at || Date.now(), kind: waiter.kind || 'turn' },
      held: owner ? { server: owner.label, holder: owner.holder || '', since: owner.at || 0 } : null,
      ahead,
      aheadCount: ahead.length,
    };
  }

  /** A project went away: its queued turns go with it. */
  function dropDir(dir) {
    const key = norm(dir);
    if (!key) return 0;
    let dropped = 0;
    for (const waiter of [...queue]) {
      if (norm(waiter.dir) === key) {
        giveUp(waiter, 'was dropped with its project');
        dropped += 1;
      }
    }
    return dropped;
  }
  const state = () => ({
    held: [...held.values()].map((h) => ({ server: h.label, holder: say(h), dir: h.dir || null, since: h.at })),
    queue: queue.map((w) => ({ server: w.label, waiter: w.holder || '', dir: w.dir || null, since: w.at || Date.now() })),
  });

  return { acquire, release, releaseSession, holderOf, waiting, forDir, dropDir, state };
}
