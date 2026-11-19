// The chat's one movement: a fold opens and closes over 500ms instead of snapping.
//
// The chat redraws as a string of markup, so a `<details>` cannot be animated by CSS alone:
// while it is closed its content is not rendered at all, and the height has to be driven by
// hand. Opening sets `open` first and grows the body from zero; closing keeps it open, shrinks
// the body, and closes it on the last frame — otherwise the text vanishes before anything can
// move. The wrapper `.fold-wrap` is what has a height to animate; it is in `web/transcript.js`.
//
// A page that asks for reduced motion gets the browser's own snap: this module does nothing
// and the fold toggles exactly as it always did.

/** How long a fold takes. The operator asked for 500ms to judge it by (19 Nov). */
export const FOLD_MS = 500;

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
  const start = body.getBoundingClientRect().height;
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
 * Teach one container to animate its reasoning folds.
 *
 * The listener is on the container, not on each fold, because the chat's markup is replaced
 * on every redraw — one listener survives a hundred of them.
 */
export function installFoldMotion(root) {
  if (!root || typeof root.addEventListener !== 'function') return;
  root.addEventListener('click', (event) => {
    const summary = event.target?.closest?.('summary');
    if (!summary) return;
    const details = summary.parentElement;
    if (!details || details.tagName !== 'DETAILS' || !details.classList.contains('reasoning')) return;
    // `preventDefault` is what stops `<details>` toggling instantly under the animation.
    if (animateFold(details, details.querySelector('.fold-wrap'))) event.preventDefault();
  });
}
