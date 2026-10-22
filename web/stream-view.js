// The panel a worker's streaming text slides through.
//
// The block keeps a fixed-height window and the text inside it moves up. Writing a
// window of characters instead (`text.slice(-600)`) re-broke every line each frame
// — changing the *front* of a paragraph re-wraps all of it — and the newest line
// was always pinned to the bottom edge, so each new line shoved the rest up by a
// line at a time. The panel is the other way round: the text is append-only, so
// line breaking is incremental and stable, and the whole block moves by pixels.
//
// Everything here is a plain function over plain numbers, so it is tested in
// `tests/stream-view.test.mjs` rather than taken on trust.

export const STREAM_BUFFER = 20000; // characters kept; a guard, not a window
// A damped spring, not a straight line to the target: the text is dragged along by
// the writing rather than commanded by it, which is what makes it look like a
// scroll instead of a page refilling. Stiffness 90 and damping 18 give ζ ≈ 0.95 —
// it takes about half a second to arrive, with no measurable overshoot.
const STIFFNESS = 90; // pull toward the target, 1/s²
const DAMPING = 18; // resistance, 1/s
const SUB_STEP = 0.008; // s; the integrator never takes a longer step than this
const SNAP_PX = 0.35; // closer than this, and slow, is arrived
const SNAP_V = 6; // px/s

/** A fresh block: nothing written, nothing scrolled. */
export function newStream(kind) {
  return { kind, text: '', total: 0, offset: 0, velocity: 0, dirty: false, settled: true };
}

/**
 * Append a delta. Text is only ever added, so the browser's line breaking is
 * incremental: nothing above the change re-wraps.
 */
export function pushStream(s, delta) {
  const piece = String(delta ?? '');
  if (!piece) return s;
  s.text += piece;
  s.total += piece.length;
  // The cap is a memory guard, not a window: it fires after twenty thousand
  // characters in one step, and the one re-wrap it causes is invisible next to a
  // frame-by-frame version of the same thing.
  if (s.text.length > STREAM_BUFFER) s.text = s.text.slice(-STREAM_BUFFER);
  s.dirty = true;
  s.settled = false;
  return s;
}

/** How far the text has to move up for its last line to sit at the bottom edge. */
export function slideTarget(contentHeight, viewHeight) {
  return Math.max(0, (Number(contentHeight) || 0) - (Number(viewHeight) || 0));
}

/**
 * One frame of the slide: where the text should be, given where it is.
 *
 * `dt` is the real time since the last frame, so a 144Hz screen and a 60Hz one
 * arrive at the same place at the same moment. `reduced` (the operator asks for
 * less motion) puts the text where it belongs with no travel at all.
 *
 * Returns the offset; `s.offset`, `s.velocity` and `s.settled` are updated.
 */
export function nextOffset(s, target, dt, { reduced = false } = {}) {
  const goal = Math.max(0, Number(target) || 0);
  if (reduced) {
    s.offset = goal;
    s.velocity = 0;
    s.settled = true;
    return s.offset;
  }
  // A tab that was hidden comes back with seconds of debt. Never integrate it: the
  // slide is a look, not a simulation, and arriving is the honest answer.
  const left = Math.min(0.25, Math.max(0, Number(dt) || 0));
  for (let t = left; t > 0; t -= SUB_STEP) {
    const h = Math.min(SUB_STEP, t);
    const accel = (goal - s.offset) * STIFFNESS - s.velocity * DAMPING;
    s.velocity += accel * h;
    s.offset += s.velocity * h;
  }
  if (Math.abs(goal - s.offset) < SNAP_PX && Math.abs(s.velocity) < SNAP_V) {
    s.offset = goal;
    s.velocity = 0;
    s.settled = true;
  } else {
    s.settled = false;
  }
  return s.offset;
}
