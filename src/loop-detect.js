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
  return {
    sig: `${tool}\u0000${where}`,
    digest: READ_ONLY.has(tool) ? digestOf(output ?? input ?? '') : '',
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
  const reached = (pick, threshold) => {
    const tally = new Map();
    for (const call of calls) {
      const key = pick(call);
      if (!key) continue;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    for (const [key, times] of tally) if (times >= threshold) return { key, times };
    return null;
  };
  const same = reached((c) => c.sig, sameTarget);
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
