// The traces a deleted project leaves inside the engine's own store.
//
// Deleting a project removes its chats through the engine's API, and that part
// works: measured 16 Nov, the session rows and every message are gone. Three
// things outlived it, and all three were recovered by hand afterwards:
//
//   - the engine's project row, which remembers the folder's path;
//   - the shell output files under data/opencode/shell/<project id>, which held
//     the tool output itself (an ASCII drawing, in that test);
//   - the project's own `.project\scratch`, which travelled to the Recycle Bin.
//
// This module removes the first two; the caller removes the third before the
// folder is recycled. The engine writes nothing here once its sessions are gone,
// so this is housekeeping, not a race.
//
// The engine keeps its store open while it runs. `moveProject` already writes to
// it this way, with a busy timeout, and the engine reads these rows per request
// rather than caching them.

import fs from 'node:fs';
import path from 'node:path';

/** The engine's way of writing a directory: forward slashes, no trailing one. */
export function engineDir(dir) {
  return String(dir || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

/**
 * The engine's id for a folder, or '' when it has never seen it.
 *
 * `worktree` is stored with forward slashes and the operator's casing, so the
 * comparison is done on a normalised form in SQL.
 */
export function projectIdForDir(db, dir) {
  const wanted = engineDir(dir).toLowerCase();
  if (!wanted) return '';
  const row = db
    .prepare("select id from project where replace(lower(worktree), '\\', '/') = ?")
    .get(wanted);
  return row?.id ? String(row.id) : '';
}

/**
 * Forget a project inside the engine's store: its worktrees, its project row and
 * the shell output written for it.
 *
 * `dataDir` is the engine's data home (the folder holding `opencode/opencode.db`).
 * Returns what was removed so a caller can log it and a test can prove it.
 * Anything missing is normal, not an error: a project the engine never saw.
 */
export async function purgeProjectTraces({ dataDir, dir, log = null } = {}) {
  const result = { projectId: '', projectRows: 0, worktreeRows: 0, shells: 0, briefs: 0 };
  if (!dataDir || !dir) return result;

  const store = path.join(dataDir, 'opencode');
  const dbFile = path.join(store, 'opencode.db');
  if (fs.existsSync(dbFile)) {
    let db = null;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(dbFile);
      db.exec('pragma busy_timeout = 5000');
      const id = projectIdForDir(db, dir);
      if (id) {
        result.projectId = id;
        const worktrees = db.prepare('delete from worktree where project_id = ?').run(id);
        result.worktreeRows = Number(worktrees?.changes || 0);
        const projects = db.prepare('delete from project where id = ?').run(id);
        result.projectRows = Number(projects?.changes || 0);
      }
      // The brief handed to a session is stored twice: once as the session's entry and
      // once as a content-addressed blob. The entry goes with the session; the blob has
      // no owner and outlived a delete on 16 Nov, still naming the folder. Blobs are
      // JSON, so their backslashes are escaped (once, twice, depending on the writer),
      // which rules out a LIKE on the path: candidates are found by the folder's name,
      // then compared on a flattened form.
      const base = path.basename(String(dir));
      if (base) {
        const folder = String(dir).replace(/\\+/g, '\\').replace(/\\/g, '/').toLowerCase();
        const rows = db
          .prepare('select hash, value from instruction_blob where value like ?')
          .all(`%${base}%`);
        const drop = db.prepare('delete from instruction_blob where hash = ?');
        for (const row of rows) {
          const flat = String(row.value).replace(/\\+/g, '\\').replace(/\\/g, '/').toLowerCase();
          if (flat.includes(folder)) {
            drop.run(row.hash);
            result.briefs += 1;
          }
        }
      }
    } catch (err) {
      log?.warn?.(`could not remove the deleted project's row from the engine store: ${err.message}`);
    } finally {
      try {
        db?.close();
      } catch {
        // A close that fails leaves the file to the engine's own next start.
      }
    }
  }

  if (result.projectId) {
    // The tool output lives per project id, and is plain files on disk.
    const shells = path.join(store, 'shell', result.projectId);
    try {
      if (fs.existsSync(shells)) {
        const files = fs.readdirSync(shells).length;
        fs.rmSync(shells, { recursive: true, force: true });
        result.shells = files;
      }
    } catch (err) {
      log?.warn?.(`could not remove the deleted project's shell output: ${err.message}`);
    }
  }
  return result;
}
