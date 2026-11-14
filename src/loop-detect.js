// Is this a loop, or is it work?
//
// A loop has one of two shapes, and both are cheap to see from the transcript that is
// already in hand:
//
//   1. **the same call, again** — the same tool on the same target, four times in a
//      window. The target includes an offset and a limit, so paging a long file is a
//      different target each time and stays quiet.
//   2. **the same answer, again** — the same tool returning byte-identical output three
//      times, whatever was asked. This is the case the target rule misses: a model that
//      re-reads one slice with `offset 34, limit 11`, then `offset 35, limit 10`, gets the
//      same paragraphs back and learns nothing. The digest is taken from the output, which
//      is the engine's own copy of the result — no extra call, no guessing.
//
// Both thresholds are deliberately high: a strike is a nudge into a live turn, so a false
// one costs the model a sentence, and the operator's rule was "do not cry wolf". Measured
// against the runs of 12–13 Nov: the 27B's re-read of one README slice (5 times, identical
// output) is caught by the digest rule; ordinary paging through a document is not.
//
// The window is 12 calls rather than 8: a model that loops every other call — read, grep,
// read, edit — slid out of the shorter window before the fourth repeat (13 Nov).

export const LOOP_WINDOW = 12;
export const SAME_TARGET_STRIKES = 4;
export const SAME_OUTPUT_STRIKES = 3;
// An output shorter than this proves nothing: "No files found" three times is a model
// trying three patterns, not a loop.
export const SAME_OUTPUT_MIN_CHARS = 240;

/** The tool calls that only read: a repeated answer from these is waste, not work. */
const READ_ONLY = new Set(['read', 'glob', 'grep', 'list', 'ls', 'search', 'webfetch', 'fetch', 'tree']);

/**
 * The tools that change a file. Their *target* is never evidence of a loop: a coder that
 * writes the same file five times is iterating — write, run the tests, fix, write again —
 * and that is the work, not a loop (13 Nov: five writes of one ANSWER.md struck a guard
 * that should have watched the model, not the file).
 */
const MUTATING = new Set(['edit', 'write', 'patch', 'create', 'applypatch', 'apply_patch', 'write_file', 'str_replace']);

/**
 * A command that returns byte-identical output every time it runs is a loop — polling a
 * build gives different text, re-running the same failing command gives the same text.
 */
const REPEATABLE = new Set([...READ_ONLY, 'shell', 'bash', 'cmd', 'powershell', 'pwsh']);

/**
 * The tools whose call means "move", not "ask for this again". A scroll with the same
 * delta from a new position lands somewhere else, so the same arguments are not the same
 * question: a model walking a long thread scrolls 400px five times and that is reading,
 * not looping (14 Nov: the guard struck on the fourth screenshot-and-scroll pair in
 * ornith-test-web-reddit). The signature carries the *result* as well, so a page that
 * cannot move — the same position back every time — still strikes.
 */
const MOVING = new Set(['scroll']);

/** A cheap, stable digest: enough to compare two answers, not a hash to store. */
export function digestOf(text) {
  const value = String(text ?? '');
  if (value.length < SAME_OUTPUT_MIN_CHARS) return '';
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  return `${value.length}:${h}`;
}

/**
 * One tool call as the guard sees it.
 *
 * `sig` is what was asked, `digest` is what came back. Both are plain strings so a window
 * is a list of small objects and a test can build one by hand.
 */
export function toolSignature({ name, target, output, input } = {}) {
  const tool = String(name || '');
  const where = String(target ?? '');
  const moving = MOVING.has(tool.split('_').pop());
  return {
    sig: `${tool}\u0000${moving ? `${where}\u0000${String(output ?? '').slice(0, 400)}` : where}`,
    digest: REPEATABLE.has(tool) ? digestOf(output ?? input ?? '') : '',
    mutating: MUTATING.has(tool),
    moving,
  };
}

/**
 * Does this window hold a loop? Returns the shape that matched, or null.
 *
 * Pure: it takes the window, it does not keep one. The runner and the turn guard each keep
 * their own, so a worker's guard and the Architect's cannot see each other's calls.
 */
export function loopStrike(window, { sameTarget = SAME_TARGET_STRIKES, sameOutput = SAME_OUTPUT_STRIKES } = {}) {
  const calls = Array.isArray(window) ? window.filter(Boolean) : [];
  if (!calls.length) return null;
  const reached = (pick, threshold, skipMutating = false) => {
    const tally = new Map();
    for (const call of calls) {
      // A repeated write is iteration; a repeated read is a question asked twice.
      if (skipMutating && call.mutating) continue;
      const key = pick(call);
      if (!key) continue;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    for (const [key, times] of tally) if (times >= threshold) return { key, times };
    return null;
  };
  const same = reached((c) => c.sig, sameTarget, true);
  if (same) return { kind: 'target', ...same };
  const digest = reached((c) => c.digest, sameOutput);
  if (digest) return { kind: 'output', ...digest };
  return null;
}

/**
 * What the model is told when it is nudged.
 *
 * It names the fault and says what not to do, because "try again" reads as "start over"
 * and a model that starts over wastes the turn it already paid for.
 */
export const LOOP_NUDGE =
  'You are repeating yourself: the same call, or the same answer, is coming back without ' +
  'making progress. Do not repeat it and do not start over — use what you already have and ' +
  'do the next real step now.';
