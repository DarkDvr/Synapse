// Private projects (15 Nov).
//
// The operator's rule: a project marked Private writes nothing to the logs and leaves
// no trace outside its own folder. The marker lives **inside** the project —
// `.synapse\private` — so the flag itself is part of the folder, not a record about it.
//
// This module is the one place that answers "is this private?": the logger asks before
// writing a line, the census and the trace store ask before recording, and the scratch
// folder asks before choosing a path outside the project.
import fs from 'node:fs';
import path from 'node:path';

/** The marker, relative to a project's folder. */
export const MARKER = path.join('.synapse', 'private');

const fold = (value) =>
  path.resolve(String(value || '')).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** Markers are matched against free text: one separator, no case, no trailing slash. */
const slash = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();

const dirs = new Set();
const sessions = new Map();

export function markerFile(dir) {
  return path.join(String(dir || ''), MARKER);
}

/** Is the marker in this folder? A project can be private before the harness knows it. */
export function hasMarker(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(markerFile(dir));
  } catch {
    // An unreadable folder is not a private one; the decision is the operator's.
    return false;
  }
}

/** Write or remove the marker. Only the folder is touched. */
export function setMarker(dir, on) {
  const target = String(dir || '');
  if (!target) return false;
  if (on) {
    const file = markerFile(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '', 'utf8');
    return true;
  }
  try {
    fs.rmSync(markerFile(target), { force: true });
  } catch {
    // Already gone is the wanted state.
  }
  return false;
}

/** Seed the set from the project store (boot, and after a toggle). */
export function setPrivateDirs(list) {
  dirs.clear();
  for (const dir of list || []) if (dir) dirs.add(fold(dir));
}

export function addPrivateDir(dir) {
  if (dir) dirs.add(fold(dir));
}

export function removePrivateDir(dir) {
  if (dir) dirs.delete(fold(dir));
}

export function isPrivateDir(dir) {
  if (!dir) return false;
  return dirs.has(fold(dir));
}

/** Remember which project a session belongs to; the logger filters by session id too. */
export function addSession(id, dir) {
  if (!id) return;
  sessions.set(String(id), fold(dir));
}

export function isPrivateSession(id) {
  const dir = sessions.get(String(id || ''));
  return Boolean(dir) && dirs.has(dir);
}

/**
 * Does this line name a private project — its folder or one of its sessions?
 *
 * The folder is matched with either separator, because log lines are written from
 * paths that arrive in both forms on Windows.
 */
export function isPrivateText(text) {
  const body = String(text || '');
  if (!body || !dirs.size) return false;
  const asSlashes = slash(body);
  for (const dir of dirs) {
    if (asSlashes.includes(dir.replace(/\\/g, '/'))) return true;
  }
  if (!sessions.size) return false;
  for (const id of sessions.keys()) if (body.includes(id)) return true;
  return false;
}

export function privateDirs() {
  return [...dirs];
}

/** Tests only: start from nothing. */
export function reset() {
  dirs.clear();
  sessions.clear();
}
