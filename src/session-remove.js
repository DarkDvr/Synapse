// The one message deletion Synapse offers: remove the operator's last prompt and
// everything the engine wrote after it.
//
// The engine has no "delete this message" route. It has a revert boundary: stage a
// message id, then commit, and every message at or after that id is deleted. A
// boundary in the middle would take every later message with it, so the UI's only
// safe unit is the suffix that starts at the last operator prompt.
//
// This helper is deliberately pure: the server and its tests both call it with the
// transcript the engine returned. It decides what a "last exchange" is, not whether
// the session is idle — that is the API's job before it stages anything.

const STEER_OR_HARNESS = /^\s*\[(?:steer|harness)\]/i;

/** A user message the operator typed, not a steer or a harness note. */
function operatorPrompt(message) {
  return (
    message?.type === 'user' &&
    Boolean(message.id) &&
    !STEER_OR_HARNESS.test(String(message.text || '')) &&
    !String(message.id).startsWith('local-')
  );
}

/**
 * The suffix that "remove last exchange" would delete, or why it cannot.
 *
 * Returns `{ ok: true, messageID, count }`, or `{ ok: false, reason }`.
 * `count` is every engine message at/after the boundary, including idle markers:
 * that is what the engine's commit removes.
 */
export function lastExchange(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let at = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (operatorPrompt(list[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) return { ok: false, reason: 'there is no exchange to remove' };

  const prompt = list[at];
  const after = list.slice(at + 1);
  // A steer is a second user message inside the same turn. Removing from the
  // original prompt would also take the steer and the work it guided, which is not
  // the one prompt the operator is looking at.
  if (after.some((m) => m?.type === 'user')) {
    return { ok: false, reason: 'the last turn has a steer after its prompt' };
  }
  // A synthetic message is the harness speaking (a worker's report, a refusal, a
  // compaction). Deleting one silently would remove something the operator did not
  // write, so the button is not offered for a turn that contains one.
  if (after.some((m) => m?.type === 'synthetic' || m?.type === 'compaction')) {
    return { ok: false, reason: 'the last turn contains a harness message' };
  }
  if (after.some((m) => m?.type === 'assistant' && (m.completed === false || m.completed == null))) {
    return { ok: false, reason: 'the last turn is still being written' };
  }
  if (after.some((m) => String(m?.id || '').startsWith('local-'))) {
    return { ok: false, reason: 'the last turn has a message that has not reached the engine' };
  }

  return {
    ok: true,
    messageID: String(prompt.id),
    count: list.length - at,
  };
}
