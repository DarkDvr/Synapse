// The visible window of a streaming text block, and how it moves.
//
// A worker's words arrive as `session.text.delta` and are shown in one grey line.
// The line cannot grow for ever, so a window of the last few hundred characters
// is kept — and the *front* of that window has to leave slowly. Writing
// `text.slice(-600)` dropped whatever had arrived since the last frame off the top
// in one go, so after a burst of words the line lurched and, at speed, the text
// looked like it vanished a word at a time.
//
// So the window's start chases its target instead of jumping to it: each frame it
// gives up a fraction of its backlog, never less than one character. That is called
// once per animation frame by the UI, so the slide runs at the monitor's own
// refresh rate. It is a plain function over plain numbers, so it is tested in
// `tests/stream-view.test.mjs` rather than trusted.

export const STREAM_VIEW = 600; // characters kept on screen; the rest has scrolled by
export const STREAM_BUFFER = 4000; // what is kept in memory, so the slide has room to ease
const EASE = 0.22; // share of the backlog given up per frame

/**
 * The visible tail of a stream, after one frame of easing.
 *
 * `s` is `{ text, total, viewStart }`: `text` is the buffer (the last
 * `STREAM_BUFFER` characters), `total` counts every character ever written so the
 * window's position survives the buffer being trimmed, and `viewStart` is where the
 * window starts in those same absolute terms. `viewStart` is created here on the
 * first frame, at the target, so a re-render does not slide text that was never
 * on screen.
 *
 * Returns `{ text, moving }`: what to show, and whether the front is still
 * behind — the caller keeps asking for frames until it is not.
 */
export function streamView(s) {
  const target = Math.max(0, s.total - STREAM_VIEW);
  if (typeof s.viewStart !== 'number' || !Number.isFinite(s.viewStart)) s.viewStart = target;
  const cut = target - s.viewStart;
  if (cut >= 1) {
    s.viewStart = Math.min(target, s.viewStart + Math.max(1, Math.ceil(cut * EASE)));
  }
  const bufferStart = s.total - s.text.length;
  const from = Math.max(0, Math.floor(s.viewStart) - bufferStart);
  return {
    text: (s.viewStart > 0 ? '…' : '') + s.text.slice(from),
    // Still behind: keep winding, so a burst finishes leaving even if the model
    // has paused between two of them.
    moving: s.viewStart < target,
  };
}

/** A fresh block's state: nothing written yet, nothing scrolled off. */
export function newStream(kind) {
  return { kind, text: '', total: 0, viewStart: 0 };
}

/** Append a delta, trimming the buffer and counting every character written. */
export function pushStream(s, delta) {
  const piece = String(delta ?? '');
  if (!piece) return s;
  s.text += piece;
  s.total += piece.length;
  if (s.text.length > STREAM_BUFFER) s.text = s.text.slice(-STREAM_BUFFER);
  return s;
}
