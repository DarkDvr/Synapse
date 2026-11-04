// Who is looking at Synapse, and who is editing Settings.
//
// A view is one page connected to the event stream. It carries the computer's
// name, which is what the lock messages say: "busy — laptop, Fever Tracker". The
// name is the host's own for loopback and a reverse lookup for a LAN address; a
// lookup that has not answered yet leaves the address in place, and the page is
// told again when a name arrives (4 Nov: the tooltip kept the IP because the
// resolution finished quietly, with no frame to carry it).
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

/** IPv4-mapped IPv6 (`::ffff:192.168.1.5`) is the IPv4 address, for every use. */
const clean = (address) => String(address || '').replace(/^::ffff:(?=\d{1,3}\.)/i, '');

export function createPresence({
  logger,
  hostname = os.hostname(),
  reverse = (ip) => dns.reverse(ip),
  now = Date.now,
  onChange = null,
  retryMs = 5000,
  retries = 4,
} = {}) {
  const log = logger?.channel?.('app');
  const views = new Map(); // id -> { id, address, name, local, since }
  const names = new Map(); // address -> resolved name
  let lock = null; // { id, name, since }

  const labelOf = (address) => (local(address) ? hostname : names.get(address) || address);
  const announce = () => {
    try {
      onChange?.();
    } catch { /* one listener's failure is not the presence list's */ }
  };

  function resolveLater(address, attempt = 0) {
    if (local(address) || names.has(address)) return;
    Promise.resolve()
      .then(() => reverse(address))
      .then((found) => {
        const name = Array.isArray(found) ? found[0] : found;
        if (!name) return;
        names.set(address, String(name).replace(/\.local$/i, ''));
        let changed = false;
        for (const view of views.values()) {
          if (view.address !== address) continue;
          view.name = labelOf(address);
          changed = true;
        }
        if (changed) {
          // The lock's sentence names the same computer, so it is refreshed too.
          if (lock) lock.name = labelOf(views.get(lock.id)?.address) || lock.name;
          announce();
        }
      })
      .catch(() => {
        // A lookup that fails now can succeed once the router's table has caught
        // up, or once the machine answers. Retrying quietly costs nothing and is
        // the difference between a tooltip that says "192.168…" and one that says
        // the laptop's name.
        if (attempt < retries && views.size) {
          setTimeout(() => resolveLater(address, attempt + 1), retryMs).unref?.();
        }
      });
  }

  function join({ id, address }) {
    const at = clean(address);
    const view = { id, address: at, name: labelOf(at), local: local(at), since: now() };
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

  /** The lock, with the view that holds it.
   *
   *  The id travels on purpose: every view receives the same broadcast frame, so
   *  "is this mine?" can only be answered by comparing ids — a frame cannot carry a
   *  per-client `yours`. Without it a page closed its own Settings panel and said the
   *  settings were "now being edited on ANDREWS": itself, on this PC, with no other
   *  view holding anything. Measured 31 Oct. */
  const holder = () => (lock ? { id: lock.id, name: lock.name, since: lock.since } : null);

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
