// How fast a model was writing, measured from the stream it actually sent.
//
// The engine's per-turn timestamps cannot answer this. `time.created` is stamped
// before the engine assembles the request, so the window between it and the last
// streamed piece carries the prompt: on 27 Oct a turn the model server clocked at
// 72.8 tok/s read 28 once the transcript was 97k tokens, and the error grew as the
// run did. What is left, once both ends are pieces the model itself sent, is the
// writing.
//
// One step is a noisy sample (a small tool-call step is mostly overhead), so the
// card shows the run's average: every measured step's written tokens over the sum
// of those steps' streaming windows. Kept here rather than inline so the rule is
// testable without a browser.

/** Add one step to a run's tally. A step with no window, or that wrote nothing,
 *  is not a sample — it must not drag the average down with a fixed cost. */
export function addSample(tally, { written, ms }) {
  if (!Number.isFinite(written) || written <= 0) return tally;
  if (!Number.isFinite(ms) || ms < 400) return tally;
  const base = tally || { tokens: 0, ms: 0 };
  return { tokens: base.tokens + written, ms: base.ms + ms };
}

/** Tokens per second for a tally, or 0 while it is too small to mean anything. */
export function rateOf(tally, { minMs = 1000, minTokens = 40 } = {}) {
  if (!tally || tally.ms < minMs || tally.tokens < minTokens) return 0;
  return Math.round((tally.tokens / tally.ms) * 1000);
}
