// What the page should keep when the server answers "what is running".
//
// The stream is the fast path, and it was the only thing that ever *removed* a run:
// a page that missed `run.finished` — a dropped connection, a restart, a tab asleep
// through the event — kept the run in `state.runs` for ever. The chat then said
// "Working — Stop to take over" over an Architect that had already said it was
// waiting, and Stop stayed live on a project with nothing running (measured 5 Nov).
//
// So the poll and every reconnect ask `GET /api/runs` and reconcile both ways.
// `askedAt` guards the one race that matters: a run that started after the request
// left cannot be in its answer, so it is kept rather than dropped mid-paint.
export const STALE_GRACE_MS = 2000;

/**
 * @param {Map<string, {startedAt?: number}>} current what the page is painting
 * @param {Array<{key: string}>} live the server's answer, keyed the page's way
 * @param {number} askedAt when the request was sent
 * @returns {{drop: string[], add: Array<object>}}
 */
export function reconcileRuns(current, live, askedAt, graceMs = STALE_GRACE_MS) {
  const byKey = new Map((live || []).map((run) => [run.key, run]));
  const drop = [];
  for (const [key, run] of current || []) {
    if (byKey.has(key)) continue;
    if (Number(run?.startedAt) > Number(askedAt) - graceMs) continue;
    drop.push(key);
  }
  const add = (live || []).filter((run) => !(current || new Map()).has(run.key));
  return { drop, add };
}
