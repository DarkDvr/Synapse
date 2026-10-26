// Which sessions a Stop must reach.
//
// Stop used to interrupt the session on screen. That is usually the Architect,
// and it is usually idle while a worker works — so the worker carried on, the
// Architect was woken by its report, and the operator watched a run that would
// not stop. The run record is not a reliable list either: a worker can outlive a
// run that has already reported or been cancelled.
//
// The engine's own list of active sessions is the authority. This picks the ones
// in the same project as the session whose Stop was pressed, plus that session,
// so a stale active list cannot leave the asked session un-interrupted.
export function stopTargets({ sessionId, directory, active = [], sessions = [] }) {
  const norm = (value) =>
    String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();

  const targets = new Set();
  if (sessionId) targets.add(sessionId);
  if (!directory) return [...targets];

  const byId = new Map((sessions || []).map((s) => [s.id, s]));
  for (const id of active || []) {
    if (!id || id === sessionId) continue;
    const session = byId.get(id);
    // A session the engine could not describe is left alone: interrupting a
    // different project's work because its directory is unknown is worse than
    // missing it.
    if (!session?.directory) continue;
    if (norm(session.directory) !== norm(directory)) continue;
    targets.add(id);
  }
  return [...targets];
}
