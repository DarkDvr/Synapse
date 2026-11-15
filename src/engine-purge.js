// A note that a project was deleted, so the next engine start can compact the
// engine's database before opening it.
//
// The engine deletes a session's chat rows through its API, but SQLite keeps the
// pages those rows used for reuse. A VACUUM rewrites the file and drops them; it
// cannot run while the engine has the database open, so the work waits for the
// one moment it is closed: the next start. Only the count is kept here — no
// project name, folder or session id — because this file lives outside the
// project and is itself a trace until the next start clears it.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const ENGINE_PURGE_FILE = path.join(DATA_DIR, 'engine-purge.json');

/** Read the pending note. A missing or malformed file means nothing is pending. */
export function readPending(file = ENGINE_PURGE_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const deletes = Number(raw?.deletes);
    return { deletes: Number.isFinite(deletes) && deletes > 0 ? Math.floor(deletes) : 0 };
  } catch {
    // A missing or unreadable note is the same as no note.
    return { deletes: 0 };
  }
}

/** Record one more deleted project. Returns the new count. */
export function noteDeletedProject(file = ENGINE_PURGE_FILE) {
  const { deletes } = readPending(file);
  const next = { version: 1, deletes: deletes + 1, at: Date.now() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return next.deletes;
}

/** Forget the note once the store has been cleaned. */
export function clearPending(file = ENGINE_PURGE_FILE) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // A note that cannot be removed is retried; it does not fail a boot.
  }
}
