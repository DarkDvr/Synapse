// Messages waiting for a local model server, kept across a restart.
//
// The queue itself lives in the running server (src/local-lease.js), and its waiting
// posts are drawn from it. A message in that queue had not reached the engine yet, so
// a restart erased it without a trace: the operator pressed Send, went away, and came
// back to nothing (confirmed 21 Nov). This file is the small ledger that lets the next
// boot send them: text and attachments, the session they belong to, and nothing else.
//
// It is data, not configuration: one JSON array in `data`, replaced atomically, and
// pruned to nothing as each message starts. A message leaves this file only after the
// engine has taken it, so a crash between the two costs a duplicate (visible) rather
// than a silence (not).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const QUEUED_SENDS_FILE = path.join(DATA_DIR, 'queued-sends.json');

/** Every message still waiting, oldest first. A missing or broken file is empty. */
export function loadQueued(file = QUEUED_SENDS_FILE) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list.filter((e) => e && e.sessionId && typeof e.text === 'string') : [];
  } catch {
    /* no ledger yet, or unreadable: nothing is waiting for the server */
    return [];
  }
}

/** Replace the whole ledger. Silent: a full disk is not a reason to fail a send. */
export function saveQueued(list, file = QUEUED_SENDS_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(list)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* the queue still works in memory for this boot */ }
  return list;
}

/** One message for this session (a session has at most one waiting). */
export function putQueued(entry, file = QUEUED_SENDS_FILE) {
  const list = loadQueued(file).filter((e) => e.sessionId !== entry.sessionId);
  list.push(entry);
  return saveQueued(list, file);
}

/** The message started (or was cancelled): it is no longer waiting. */
export function dropQueued(sessionId, file = QUEUED_SENDS_FILE) {
  const list = loadQueued(file);
  const left = list.filter((e) => e.sessionId !== sessionId);
  if (left.length !== list.length) saveQueued(left, file);
  return left;
}

/** A project was renamed: its waiting message follows the folder, and so does the
 *  label the waiting post shows. */
export function renameQueuedDir(from, to, file = QUEUED_SENDS_FILE) {
  const list = loadQueued(file);
  const key = String(from || '').replace(/[\\/]+$/, '').toLowerCase();
  const base = String(to || '').split(/[\\/]/).filter(Boolean).pop() || '';
  let changed = 0;
  for (const entry of list) {
    if (String(entry.dir || '').replace(/[\\/]+$/, '').toLowerCase() !== key) continue;
    const tail = String(entry.label || '').split(' - ').slice(1).join(' - ') || 'your message';
    entry.dir = to;
    entry.label = `${base} - ${tail}`;
    changed += 1;
  }
  if (changed) saveQueued(list, file);
  return changed;
}
