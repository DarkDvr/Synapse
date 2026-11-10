// What Synapse wrote itself, so its own writes are never blamed on a model.
//
// The tamper check compares `.synapse` before and after a worker's turn and reports
// whatever appeared. That is right for a worker's writes and wrong for ours: the
// operator's kept attachment and their answer to a question both land in that
// folder while the worker is running, and on 10 Nov both were reported as "the
// worker wrote outside its folder" — twice in one evening, about the operator's own
// two clicks, with the harness itself as the author.
//
// Exempting the file *names* would have been three lines and a hole in the check: a
// worker could then write `project.md` or into `attachments/` and never be told. So
// the harness says when it wrote something, and only that write is excused.
import path from 'node:path';

const marks = new Map(); // resolved path -> when it was written
const KEEP_MS = 30 * 60 * 1000;
const MAX = 400;

/** Say that Synapse wrote this file, now. Called by its writers, never by a model. */
export function markWritten(file) {
  const key = String(file || '');
  if (!key) return;
  // A `.tmp` beside the real file is not worth a mark of its own: the rename lands
  // on the target, and the target is what the fingerprint sees.
  marks.set(path.resolve(key), Date.now());
  if (marks.size <= MAX) return;
  // Bounded: a long project keeps hundreds of attachments, and this map is per
  // process. The oldest quarter goes, which is far longer than any turn.
  const oldest = [...marks.entries()].sort((a, b) => a[1] - b[1]).slice(0, Math.ceil(MAX / 4));
  for (const [old] of oldest) marks.delete(old);
}

/**
 * Did Synapse write this path at or after `since`?
 *
 * `since` is when the turn being judged started, so a mark from an hour ago cannot
 * excuse a worker's write now, and the mark expires on its own as well.
 */
export function wroteIt(file, since = 0) {
  const key = String(file || '');
  if (!key) return false;
  const resolved = path.resolve(key);
  const at = marks.get(resolved) || 0;
  if (!at) return false;
  if (Date.now() - at > KEEP_MS) {
    marks.delete(resolved);
    return false;
  }
  return at >= Number(since || 0);
}

/** Test seam: forget every mark. */
export function forgetWrites() {
  marks.clear();
}
