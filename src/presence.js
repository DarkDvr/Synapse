// Who is looking at Synapse, and who is editing Settings.
//
// A view is one page connected to the event stream. It carries the computer's
// name, which is what the lock messages say: "busy — laptop, Fever Tracker". The
// name is the host's own for loopback, a reverse lookup for a LAN address, and
// the address itself when the lookup has nothing to say.
//
// The Settings lock lives here because it is about a person, not about work: it
// is released by closing the panel, by losing the connection, or by going quiet
// for fifteen minutes — never by a run ending.
import os from 'node:os';
import dns from 'node:dns/promises';

export const LOCK_IDLE_MS = 15 * 60 * 1000;

const local = (address) => {
  const value = String(address || '');
  return value === '::1' || value === '127.0.0.1' || value === '::ffff:127.0.0.1';
};

export function createPresence({ logger, hostname = os.hostname(), reverse = (ip) => dns.reverse(ip), now = Date.now } = {}) {
  const log = logger?.channel?.('app');
  const views = new Map(); // id -> { id, address, name, local, since }
  const names = new Map(); // address -> resolved name
  let lock = null; // { id, name, since }

  const labelOf = (address) => (local(address) ? hostname : names.get(address) || address);

  function resolveLater(address) {
    if (local(address) || names.has(address)) return;
    Promise.resolve()
      .then(() => reverse(address))
      .then((found) => {
        const name = Array.isArray(found) ? found[0] : found;
        if (!name) return;
        names.set(address, String(name).replace(/\.local$/i, ''));
        for (const view of views.values()) if (view.address === address) view.name = labelOf(address);
        if (lock) lock.name = labelOf(views.get(lock.id)?.address) || lock.name;
      })
      .catch(() => { /* no reverse lookup: the address is the name */ });
  }

  function join({ id, address }) {
    const view = { id, address: String(address || ''), name: labelOf(address), local: local(address), since: now() };
    views.set(id, view);
    resolveLater(view.address);
    return view;
  }

  function leave(id) {
    const view = views.get(id);
    if (!view) return { left: false, released: false };
    views.delete(id);
    const released = Boolean(lock && lock.id === id);
    if (released) {
      log?.info(`settings lock released: ${lock.name} disconnected`);
      lock = null;
    }
    return { left: true, released };
  }

  const byId = (id) => (id && views.get(id)) || null;
  const nameOf = (id) => views.get(id)?.name || null;
  const count = () => views.size;

  const list = () =>
    [...views.values()]
      .map((v) => ({ id: v.id, name: v.name, local: v.local, since: v.since }))
      .sort((a, b) => a.since - b.since);

  const holder = () => (lock ? { name: lock.name, since: lock.since } : null);

  function status(clientId) {
    return {
      views: list(),
      lock: lock ? { name: lock.name, since: lock.since, yours: lock.id === clientId } : null,
    };
  }

  /** Take the Settings lock. A stale holder (fifteen quiet minutes) loses it. */
  function acquire(clientId) {
    const view = views.get(clientId);
    if (!view) return { ok: false, status: 409, error: 'this view is not connected' };
    if (lock && lock.id !== clientId) {
      if (now() - lock.since > LOCK_IDLE_MS) {
        log?.info(`settings lock expired: ${lock.name}`);
        lock = null;
      } else {
        return { ok: false, status: 409, holder: { name: lock.name, since: lock.since } };
      }
    }
    lock = { id: clientId, name: view.name, since: now() };
    return { ok: true, holder: { name: lock.name, since: lock.since, yours: true } };
  }

  function release(clientId) {
    if (!lock || lock.id !== clientId) return false;
    lock = null;
    return true;
  }

  /** A heartbeat while the panel is open keeps the lock from expiring. */
  function touch(clientId) {
    if (lock && lock.id === clientId) lock.since = now();
  }

  return { join, leave, byId, nameOf, count, list, status, acquire, release, touch, holder, hostname };
}
