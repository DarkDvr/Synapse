// Purging what a project left outside its folder, when it is marked Private (15 Nov).
//
// The marker stops new traces; this removes the ones already written. Only text
// diaries are rewritten — the logs and the provider diary — because they are the
// records that name a project or a session in plain words. Binary stores (the engine's
// database) are not ours to edit, and the note in docs/notes/project-chat.md says so.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, LOGS_DIR } from './paths.js';

const fold = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();

/** Every spelling of the project and its sessions that a line might contain. */
function markers(dir, sessionIds) {
  const out = [];
  const folder = fold(dir).replace(/\/+$/, '');
  if (folder) out.push(folder);
  for (const id of sessionIds || []) if (id) out.push(String(id).toLowerCase());
  return out;
}

function scrub(file, needles) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // A file that vanished between listing and reading has nothing to purge.
    return 0;
  }
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => !needles.some((needle) => fold(line).includes(needle)));
  const removed = lines.length - kept.length;
  if (!removed) return 0;
  try {
    fs.writeFileSync(file, kept.join('\n'), 'utf8');
  } catch {
    // A locked log keeps its lines; the marker still stops new ones.
    return 0;
  }
  return removed;
}

/**
 * Remove every line that names a project or one of its sessions from the logs and the
 * provider diary. Answers how many files and lines were rewritten, for the note the
 * operator reads.
 */
export function purgePrivateTraces({ dir, sessionIds = [], dirs = [LOGS_DIR, DATA_DIR] } = {}) {
  const needles = markers(dir, sessionIds);
  if (!needles.length) return { files: 0, lines: 0 };
  let files = 0;
  let lines = 0;
  for (const folder of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      // A folder that is gone has no diary to rewrite.
      continue;
    }
    for (const name of names) {
      // Both folders keep their diaries as `.log`; nothing else in `data\` is one.
      if (!name.endsWith('.log')) continue;
      const removed = scrub(path.join(folder, name), needles);
      if (!removed) continue;
      files += 1;
      lines += removed;
    }
  }
  return { files, lines };
}

