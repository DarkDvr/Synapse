// The chat's one movement: a fold opens and closes over 250ms instead of snapping.
//
// The chat redraws as a string of markup, so a `<details>` cannot be animated by CSS alone:
// while it is closed its content is not rendered at all, and the height has to be driven by
// hand. Opening sets `open` first and grows the body from zero; closing keeps it open, shrinks
// the body, and closes it on the last frame — otherwise the text vanishes before anything can
// move. The wrapper `.fold-wrap` is what has a height to animate; it is in `web/transcript.js`.
//
// Two things make the animation survive a live turn:
//
// - the fold's state is recorded the moment it is clicked, not when the animation ends, so any
//   draw that does land shows the fold the operator asked for rather than the old one;
// - the page holds its redraws for the length of the animation, because a redraw replaces the
//   element being animated. Without that, a fold could not be closed at all while the thinking
//   pane was writing: every delta drew it back open (19 Nov).
//
// A page that asks for reduced motion gets the browser's own snap: this module does nothing.

/** How long a fold takes. The operator asked for twice as fast as the first 500ms. */
export const FOLD_MS = 250;

const motionOff = () => {
  try {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
};

/**
 * Grow or shrink one fold's body, then put the element back the way it was.
 *
 * Returns false when the fold was not animated — reduced motion, or a body that is not there
 * — so the caller knows to let the browser do its own thing.
 */
export function animateFold(details, body) {
  if (!details || !body || motionOff()) return false;
  const opening = !details.open;
  const start = opening ? 0 : body.getBoundingClientRect().height;
  if (opening) details.open = true;
  body.style.overflow = 'hidden';
  body.style.height = `${start}px`;
  // One frame between the two heights, or the browser has nothing to interpolate.
  body.getBoundingClientRect();
  const end = opening ? body.scrollHeight : 0;
  body.style.transition = `height ${FOLD_MS}ms ease-out`;
  body.style.height = `${end}px`;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    body.style.transition = '';
    body.style.height = '';
    body.style.overflow = '';
    if (!opening) details.open = false;
  };
  body.addEventListener('transitionend', done, { once: true });
  setTimeout(done, FOLD_MS + 80);
  return true;
}

/**
 * Grow or shrink any element to a height, over the same 250ms, and say when it is done.
 *
 * Used for the thinking pane, which is a different shape on each side of its toggle and so
 * cannot use `animateFold`: this one only moves a box. `from` is the height to start at when
 * the element is already at its full size and has to come in from nothing.
 */
export function animateHeight(el, to, done, from = null) {
  if (!el || motionOff()) {
    if (done) done();
    return false;
  }
  const start = from === null ? el.getBoundingClientRect().height : Math.max(0, Number(from) || 0);
  el.style.overflow = 'hidden';
  el.style.height = `${start}px`;
  el.getBoundingClientRect();
  el.style.transition = `height ${FOLD_MS}ms ease-out`;
  el.style.height = `${Math.max(0, Number(to) || 0)}px`;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    el.style.transition = '';
    el.style.height = '';
    el.style.overflow = '';
    if (done) done();
  };
  el.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, FOLD_MS + 80);
  return true;
}

/**
 * Teach one container to animate its reasoning folds.
 *
 * The listener is on the container, not on each fold, because the chat's markup is replaced
 * on every redraw — one listener survives a hundred of them.
 *
 * `wired.onToggle(key, open)` records the operator's choice; `wired.hold(ms)` keeps redraws
 * off the markup until the animation is done. Both are the page's, not this module's.
 */
export function installFoldMotion(root, wired = {}) {
  if (!root || typeof root.addEventListener !== 'function') return;
  root.addEventListener('click', (event) => {
    const summary = event.target?.closest?.('summary');
    if (!summary) return;
    const details = summary.parentElement;
    if (!details || details.tagName !== 'DETAILS' || !details.classList.contains('reasoning')) return;
    const body = details.querySelector('.fold-wrap');
    const opening = !details.open;
    if (typeof wired.onToggle === 'function') wired.onToggle(String(details.dataset.k || ''), opening);
    if (typeof wired.hold === 'function') wired.hold(FOLD_MS + 80);
    // `preventDefault` is what stops `<details>` toggling instantly under the animation.
    if (animateFold(details, body)) event.preventDefault();
  });
}
