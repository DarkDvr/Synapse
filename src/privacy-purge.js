// Purging what a project left outside its folder, when it is marked Private (15 Nov).
//
// The marker stops new traces; this removes the ones already written. Only text
// diaries are rewritten — the logs and the provider diary — because they are the
// records that name a project or a session in plain words. Binary stores (the engine's
// database) are not ours to edit, and the note in docs/notes/project-chat.md says so.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, LOGS_DIR } from './paths.js';

const fold = (value) =>
  String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase().replace(/\/+$/, '');

/** Every spelling of the project and its sessions that a line might contain. */
function markers(dir, sessionIds) {
  const out = [];
  const folder = fold(dir);
  if (folder) out.push(folder);
  for (const id of sessionIds || []) if (id) out.push(String(id).toLowerCase());
  return out;
}

/** The project's own name, as a whole word: `changes-test` matches its scratch
 *  folder `changes-test-071969f7`, and does not match `changes-test2`. */
function namePattern(dir) {
  const base = String(path.basename(String(dir || ''))).trim();
  if (!base) return null;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}\\b`, 'i');
}

function markerIn(text, marker) {
  let at = text.indexOf(marker);
  while (at >= 0) {
    const next = text[at + marker.length];
    if (next === undefined || !/[a-z0-9_-]/.test(next)) return true;
    at = text.indexOf(marker, at + 1);
  }
  return false;
}

function scrub(file, needles, nameRe) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // A file that vanished between listing and reading has nothing to purge.
    return 0;
  }
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const folded = fold(line);
    if (needles.some((needle) => markerIn(folded, needle))) return false;
    return !(nameRe && nameRe.test(line));
  });
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
  const nameRe = namePattern(dir);
  if (!needles.length && !nameRe) return { files: 0, lines: 0 };
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
      const removed = scrub(path.join(folder, name), needles, nameRe);
      if (!removed) continue;
      files += 1;
      lines += removed;
    }
  }
  return { files, lines };
}

/**
 * Ask the desktop shell to purge its console ring and `console.log`.
 *
 * The shell owns that file (it captures the server's stdout) and opens it without
 * write sharing, so the server cannot rewrite it. A one-line request on stdout is
 * the channel the shell already reads; the shell removes the matching lines and
 * does not print the request itself.
 */
export function requestConsolePurge(dir, sessionIds = []) {
  if (process.env.SYNAPSE_SUPERVISED !== '1') return false;
  const base = path.basename(String(dir || ''));
  const needles = [
    dir,
    base ? path.join(path.dirname(String(dir)), '_scratch', `${base}-`) : '',
    ...(sessionIds || []),
  ].filter(Boolean);
  if (!needles.length) return false;
  try {
    process.stdout.write(`[[purge-console]]${JSON.stringify(needles)}\n`);
    return true;
  } catch {
    // A closed stdout means the shell is gone; the next boot purges the file.
    return false;
  }
}

