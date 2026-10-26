// Which permission decision belongs to which tool call.
//
// The chip on a tool call needs a record that outlives the request: the engine
// forgets a permission once it is answered, and the transcript is read long
// after. This keeps the last few hundred decisions, per session, keyed by the
// tool call the request came from.
//
// Memory only. A restart loses the chips, not the work; the card and the
// transcript are unaffected. Persisting it would mean another file to rotate for
// a decoration.
export function createPermissionLog({ limit = 300 } = {}) {
  const byRequest = new Map();
  const order = [];

  /** Add or update a decision. A later record for the same request wins. */
  function record(entry) {
    if (!entry?.requestId) return null;
    const previous = byRequest.get(entry.requestId);
    const merged = { ...(previous || {}), ...entry };
    if (!previous) order.push(entry.requestId);
    byRequest.set(entry.requestId, merged);
    while (order.length > limit) {
      const oldest = order.shift();
      byRequest.delete(oldest);
    }
    return merged;
  }

  /** The operator's answer to a request the policy left to them. */
  function answer(requestId, decision) {
    const entry = byRequest.get(requestId);
    if (!entry) return null;
    const allowed = decision === 'once' || decision === 'always';
    return record({
      ...entry,
      effect: allowed ? 'allow' : 'deny',
      asked: true,
      decided: true,
      decidedBy: 'operator',
      answeredAt: Date.now(),
    });
  }

  /** Decided entries for one session, oldest first. Pending asks are not chips. */
  function list(sessionId) {
    return order
      .map((id) => byRequest.get(id))
      .filter((entry) => entry && entry.sessionId === sessionId && entry.decided && entry.toolCallId);
  }

  /** One entry, settled or pending. Used when the operator's answer arrives. */
  function get(requestId) {
    return byRequest.get(requestId) || null;
  }

  return { record, answer, list, get };
}
