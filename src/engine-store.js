// The engine's own database, and the one thing Synapse does to it: hand space back.
//
// Synapse never reads this file's schema and never writes a row. Two things it does
// do, both because the operator asked for them:
//
//   - forget a conversation it can never open again, through the engine's own API;
//   - and, only while the engine is *not* running, rewrite the file so the space
//     those deletions freed goes back to the disk.
//
// SQLite keeps freed pages for reuse. That is right for a database that grows, and
// wrong for one that shrank: measured 7 Nov, 430 MB holding 19 conversations nobody
// could open. `VACUUM` rewrites the whole file, so it must never run while the engine
// has it open — which is why the only caller is the adapter's `start()`, one line
// before it spawns the process.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIN_FREE_BYTES = 4 * 1024 * 1024;
const mb = (bytes) => `${(Math.max(0, bytes) / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Rewrite the database if it is holding more free space than `minFreeBytes`.
 *
 * Returns `{ before, after, freed }`, or `{ skipped }` with the reason. Never throws:
 * a store that cannot be rewritten is a slower store, not a broken one.
 */
export function vacuumStore(file, { log = null, minFreeBytes = MIN_FREE_BYTES } = {}) {
  if (!file || !fs.existsSync(file)) return { skipped: 'no database yet' };
  const before = fs.statSync(file).size;
  let db = null;
  try {
    db = new DatabaseSync(file);
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size) || 4096;
    const free = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count) || 0;
    const freeBytes = free * pageSize;
    if (freeBytes < minFreeBytes) {
      db.close();
      db = null;
      return { skipped: `${free} free page(s), not worth a rewrite`, before, after: before, freed: 0 };
    }
    // A write-ahead log has to be folded back first: VACUUM cannot run with one open.
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* no WAL in use */ }
    db.exec('VACUUM');
    db.close();
    db = null;
    const after = fs.statSync(file).size;
    log?.info?.(`engine store: reclaimed ${mb(before - after)} of ${mb(before)} (${free} free page(s))`);
    return { before, after, freed: before - after };
  } catch (err) {
    try { db?.close(); } catch { /* already closed */ }
    log?.warn?.(`engine store: could not reclaim space — ${err.message}`);
    return { skipped: err.message, before, after: before, freed: 0 };
  }
}
