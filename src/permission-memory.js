// "Always Allow" memory, on disk.
//
// The gate remembers one exact request — same session, same action, same resource
// — so the card does not come back for it. That memory used to live in a Map and
// died with the process: a restart made the operator answer the same question
// again, while the session it belonged to survived. Permission grants are the
// operator's decisions, so they are written down.
//
// Keyed by session id, which the engine keeps across a restart. Capped: this is a
// convenience for a session, not a policy store, and it must never grow without a
// bound.
import fs from 'node:fs';
import path from 'node:path';

export function createPermissionMemory({ file, limit = 500, logger } = {}) {
  const log = logger?.channel?.('app');
  const entries = new Map();
  const key = (sessionId, action, resources) =>
    `${String(sessionId || '')}\u0000${String(action || '').toLowerCase()}\u0000${(resources || [])
      .map(String)
      .join('\u0001')}`;

  const trim = () => {
    if (entries.size <= limit) return;
    const oldest = [...entries.values()].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    for (const entry of oldest.slice(0, entries.size - limit)) {
      entries.delete(key(entry.sessionId, entry.action, entry.resources));
    }
  };

  const flush = () => {
    if (!file) return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: [...entries.values()] }, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      log?.warn(`permission memory could not be saved: ${err.message}`);
      return false;
    }
  };

  // Load whatever the last process remembered. A missing file is normal; a
  // corrupt one is dropped rather than failing the boot over a convenience.
  try {
    if (file && fs.existsSync(file)) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
      for (const entry of Array.isArray(doc?.entries) ? doc.entries : []) {
        if (!entry?.sessionId || !entry.action || !Array.isArray(entry.resources)) continue;
        entries.set(key(entry.sessionId, entry.action, entry.resources), {
          sessionId: String(entry.sessionId),
          action: String(entry.action),
          resources: entry.resources.map(String),
          at: Number(entry.at) || 0,
        });
      }
      trim();
    }
  } catch (err) {
    log?.warn(`permission memory could not be read (${err.message}); starting empty`);
  }

  /** Remember one exact request. Writes through, so a shutdown cannot lose it. */
  function remember(sessionId, action, resources) {
    if (!sessionId || !action) return false;
    const entry = {
      sessionId: String(sessionId),
      action: String(action),
      resources: (resources || []).map(String),
      at: Date.now(),
    };
    entries.set(key(entry.sessionId, entry.action, entry.resources), entry);
    trim();
    flush();
    return true;
  }

  const has = (sessionId, action, resources) => entries.has(key(sessionId, action, resources));

  /** The operator deleted a session: its grants are meaningless now. */
  function forgetSession(sessionId) {
    let removed = 0;
    for (const [k, entry] of [...entries.entries()]) {
      if (entry.sessionId !== String(sessionId)) continue;
      entries.delete(k);
      removed += 1;
    }
    if (removed) flush();
    return removed;
  }

  /**
   * A conversation was replaced by a fresh one: its grants move with it.
   *
   * Compaction is about context, not consent. The operator said "always allow
   * this exact request" and a new session id is an implementation detail of how
   * the conversation was discarded — asking again after every compact is
   * friction, and the grant is about a file, not about a transcript.
   */
  function carry(from, to) {
    if (!from || !to || String(from) === String(to)) return 0;
    let moved = 0;
    for (const entry of [...entries.values()]) {
      if (entry.sessionId !== String(from)) continue;
      const next = { ...entry, sessionId: String(to), at: Date.now() };
      entries.delete(key(entry.sessionId, entry.action, entry.resources));
      entries.set(key(next.sessionId, next.action, next.resources), next);
      moved += 1;
    }
    if (moved) flush();
    return moved;
  }

  return { remember, has, forgetSession, carry, list: () => [...entries.values()], flush };
}
