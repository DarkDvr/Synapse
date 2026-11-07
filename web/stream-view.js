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

export const STREAM_BUFFER = 20000; // characters allowed before a trim
// What is kept when the guard fires. Trimming to exactly the cap means the *next*
// character trims again, so a block that has reached the cap rewrites its whole
// text on every frame — the one cost this panel exists to avoid, and one long
// reasoning block reaches in under a minute on a fast model. Dropping a quarter
// of it at a time turns thousands of rewrites into one every few seconds.
export const STREAM_KEEP = 15000;
// A damped spring, not a straight line to the target: the text is dragged along by
// the writing rather than commanded by it, which is what makes it look like a
// scroll instead of a page refilling. Stiffness 90 and damping 18 give ζ ≈ 0.95 —
// it takes about half a second to arrive, with no measurable overshoot.
const STIFFNESS = 90; // pull toward the target, 1/s²
const DAMPING = 18; // resistance, 1/s
const SUB_STEP = 0.008; // s; the integrator never takes a longer step than this
const SNAP_PX = 0.35; // closer than this, and slow, is arrived
const SNAP_V = 6; // px/s
// How long the slide takes to believe that the writing changed speed. A line
// landing is a step, not a speed: eased, it becomes an acceleration over a third of
// a second instead of a jump. This is the whole of "smooth when the model is fast",
// and it is deliberately slower than a frame: one chunk of text must not look like
// a change of pace.
const SPEED_EASE = 0.35; // s
// The fastest the text may travel, whatever the model does: about a line every
// 12ms, which is faster than any model writes. Past this the newest lines are
// unreadable anyway, and a burst of text would be thrown at the panel as a jump.
const MAX_SPEED = 1400; // px/s
// How quickly a lagging slide may close a gap: at least a line every 70ms, and at
// most a line every 19ms. A cap that is jumped to in one frame is the stutter this
// replaces; a cap that is never reached is a line sitting out of sight.
const CATCH_UP_MIN = 240; // px/s
const CATCH_UP_MAX = 900; // px/s
// How close the slide must be for the writing's speed to be fed forward, in px:
// about four lines. Inside it the slide tracks the writing; outside it is catching
// up, and a catch-up is the spring's job, not the writing's speed.
const FEED_RANGE = 64; // px
// The fastest a single frame may report as a speed, in px/s: about two lines at
// 60fps. Above it the text arrived in a chunk, which is not a pace.
const MAX_STEP_SPEED = 2000; // px/s

/** A fresh block: nothing written, nothing scrolled. */
export function newStream(kind) {
  return {
    kind, text: '', total: 0,
    // How much of `text` the panel has already been given. The text node is
    // appended to, never rewritten: rewriting it re-breaks every line of a block
    // that can be twenty thousand characters long, once per frame.
    shown: 0,
    // A trim moves the start of the text, so the panel has to be rewritten once.
    trimmed: false,
    // The block has stopped (its step ended) but its last window is still on
    // screen. The next block starts a fresh stream.
    ended: false,
    offset: 0, velocity: 0, dirty: false, settled: true,
    // Where the target was last frame, and how fast it is moving, in px/s. The
    // speed is eased and fed forward into the spring, so a model writing steadily
    // is tracked instead of dragged behind.
    goal: 0, goalSpeed: 0,
  };
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
  if (s.text.length > STREAM_BUFFER) {
    s.text = s.text.slice(-STREAM_KEEP);
    s.trimmed = true;
  }
  s.dirty = true;
  s.settled = false;
  return s;
}

/**
 * What the panel has not been given yet.
 *
 * `reset` means the text starts somewhere else than last time (a trim), so the
 * whole thing is written once. Otherwise `text` is only the new tail, and the
 * panel appends it — the line breaking above the change is left alone.
 */
export function takePending(s) {
  if (s.trimmed || s.shown > s.text.length) {
    s.trimmed = false;
    s.shown = s.text.length;
    return { text: s.text, reset: true };
  }
  if (s.shown === s.text.length) return { text: '', reset: false };
  const text = s.text.slice(s.shown);
  s.shown = s.text.length;
  return { text, reset: false };
}

/** The step ended. The words stay where they are; nothing new is added. */
export function freezeStream(s) {
  if (!s) return s;
  s.ended = true;
  s.dirty = false;
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
export function nextOffset(s, target, dt, { reduced = false, maxLag = 0 } = {}) {
  const goal = Math.max(0, Number(target) || 0);
  if (reduced) {
    s.offset = goal;
    s.velocity = 0;
    s.goal = goal;
    s.goalSpeed = 0;
    s.settled = true;
    return s.offset;
  }
  // A tab that was hidden comes back with seconds of debt. Never integrate it: the
  // slide is a look, not a simulation, and arriving is the honest answer.
  const left = Math.min(0.25, Math.max(0, Number(dt) || 0));
  // The speed the writing is moving the target at, eased, fed forward into the
  // spring. Without it a spring sits a fixed distance behind a moving target
  // (velocity × damping ÷ stiffness) and that lag is what a fast model turns into
  // a stutter: every line arrives late, all at once.
  const before = Number(s.goal) || 0;
  s.goal = goal;
  // One frame cannot report a speed faster than this: anything above it is a chunk
  // of text arriving at once, not the pace the writing is moving at. Without the
  // cap a burst (or a tab that was hidden for twelve seconds) reads as a model
  // writing at thousands of pixels a second, and the slide is thrown at the wall.
  const raw = left > 0 ? Math.max(-MAX_STEP_SPEED, Math.min(MAX_STEP_SPEED, (goal - before) / left)) : 0;
  const eased = Number(s.goalSpeed) || 0;
  s.goalSpeed = Math.max(
    -MAX_SPEED,
    Math.min(MAX_SPEED, eased + (raw - eased) * (1 - Math.exp(-left / SPEED_EASE))),
  );
  const startOffset = s.offset;
  // Fed forward into the spring: it cancels the lag a moving target always leaves
  // behind (velocity × damping ÷ stiffness). Eased over a third of a second, so a
  // chunk of text that lands at once is not mistaken for a change of pace.
  const feed = s.goalSpeed;
  for (let t = left; t > 0; t -= SUB_STEP) {
    const h = Math.min(SUB_STEP, t);
    const accel = (goal - s.offset) * STIFFNESS - (s.velocity - feed) * DAMPING;
    s.velocity += accel * h;
    s.offset += s.velocity * h;
  }
  // How far behind the newest line may sit while the chat is following. Closed
  // over frames, not in one: jumping to the cap was the visible stutter whenever
  // the model was fastest, because the cap moved a whole line the moment the text
  // did. The frame's whole movement is capped, spring included — adding a catch-up
  // on top of the spring is how a burst moved two lines in one frame.
  if (maxLag > 0 && s.offset < goal - maxLag) {
    const rate = Math.min(CATCH_UP_MAX, Math.max(CATCH_UP_MIN, Math.abs(s.goalSpeed)));
    const room = Math.max(0, rate * left - (s.offset - startOffset));
    const step = Math.min(goal - maxLag - s.offset, room);
    if (step > 0) {
      s.offset += step;
      s.velocity = Math.max(s.velocity, (s.offset - startOffset) / Math.max(left, 1e-3));
    }
  }
  // Never past the last line: the spring leads a target that is still moving, and
  // an offset ahead of it would show blank space under the newest words.
  if (s.offset > goal) {
    s.offset = goal;
    s.velocity = Math.min(s.velocity, 0);
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
