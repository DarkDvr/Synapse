// A task may belong to another task: `t2a` and `t2b` are the parts of `t2`.
//
// The Architect already reaches for this — "a fix to t2" comes out as `t2a` — and the
// only thing missing was that nobody put it *under* t2: rows are shown in the order the
// file lists them, so an appended `t2a` sat at the bottom, after the finished work,
// reading as an afterthought. This module is the ordering, and nothing else: the file
// stays exactly as the Architect wrote it, and no id is ever renumbered (an id lives in
// `runs.jsonl`, in notes and in the project document).
//
// The rule is one sentence: **a root keeps its own place, and its children follow it.**
//
// - A root is an id no other id owns (`t2`).
// - A child is a root's id followed by letters (`t2a`, `t2b`, `t2aa`). Letters only:
//   `t2-1` and `t2_1` are ordinary ids, not children.
// - A child of a child belongs to the same root (`t2ab` is shown under `t2`, one indent,
//   never two) — the pane has one level of indentation and a third would be a table.
// - An id whose root is missing (`t3a` with no `t3`) is an ordinary row and is reported
//   as a plan problem by `readPlan`, not quietly guessed into place.
//
// Imported by the page (the rail) and by `src/plans.js` (the brief and its problems).
// No DOM, no state: both runtimes get the same answer, which is the point.

/** The letters that make an id a child rather than a root. */
const CHILD_SUFFIX = /^[a-z]+$/;

/**
 * Who owns this id, among `ids`?
 *
 * The longest other id that is a prefix of it, with nothing but letters left over —
 * longest so `t2ab` belongs to `t2a` rather than to `t2` when both exist, and `ids` is
 * passed in because ownership is a fact about *this* plan, not about the shape of a
 * string: `t2a` is a child only while `t2` is in the list.
 */
export function parentOf(id, ids) {
  const self = String(id || '');
  if (!self) return null;
  let best = null;
  for (const other of ids || []) {
    const candidate = String(other || '');
    if (!candidate || candidate === self || candidate.length >= self.length) continue;
    if (!self.startsWith(candidate)) continue;
    if (!CHILD_SUFFIX.test(self.slice(candidate.length))) continue;
    if (!best || candidate.length > best.length) best = candidate;
  }
  return best;
}

/** The root an id hangs from, following owners up one level at a time. */
export function rootOf(id, ids) {
  let at = String(id || '');
  const seen = new Set();
  for (;;) {
    const owner = parentOf(at, ids);
    if (!owner || seen.has(owner)) return at;
    seen.add(at);
    at = owner;
  }
}

/**
 * The plan in the order it should be read: every root where the Architect put it, each
 * followed by its own children in id order.
 *
 * Stable by construction — the same tasks always come back in the same order — because
 * a list that reshuffles between renders reads as a list that is breaking.
 */
export function orderPlan(tasks) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const ids = list.map((t) => String(t.id || '')).filter(Boolean);
  const children = new Map();
  const roots = [];
  const stray = [];
  for (const t of list) {
    const id = String(t.id || '');
    if (!id) { stray.push(t); continue; }
    const owner = parentOf(id, ids);
    if (!owner) { roots.push(t); continue; }
    const root = rootOf(id, ids);
    if (root === id) { roots.push(t); continue; }
    if (!children.has(root)) children.set(root, []);
    children.get(root).push(t);
  }
  const ordered = [];
  for (const root of roots) {
    ordered.push(root);
    const kids = children.get(String(root.id || ''));
    if (!kids || !kids.length) continue;
    kids.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
    for (const kid of kids) ordered.push(kid);
  }
  // An id with no id of its own is not worth dropping on the floor: it keeps the place
  // the Architect gave it, at the end.
  for (const t of stray) ordered.push(t);
  return ordered;
}

/**
 * Is this task ready to run?
 *
 * `dependsOn` plus the one rule a child inherits: **a part is not ready before the
 * whole**. `t2a` names no dependency of its own and still waits for `t2`, which is what
 * makes the naming worth something — the Architect describes the shape of the work
 * instead of maintaining a second dependency list by hand.
 */
export function taskReady(task, tasks) {
  if (!task || task.status !== 'todo') return false;
  const list = Array.isArray(tasks) ? tasks : [];
  const doneIds = new Set(list.filter((t) => t && t.status === 'done').map((t) => String(t.id || '')));
  const ids = list.map((t) => String(t.id || '')).filter(Boolean);
  const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  if (!deps.every((d) => doneIds.has(String(d)))) return false;
  const owner = parentOf(task.id, ids);
  if (owner && !doneIds.has(owner)) return false;
  return true;
}

/** The first ready task in reading order, or null. What "Waiting on you — tX is ready" means. */
export function nextReady(tasks) {
  const ordered = orderPlan(tasks);
  return ordered.find((t) => taskReady(t, ordered)) || null;
}
