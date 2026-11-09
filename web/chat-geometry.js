// The reader's place, held while the transcript changes under them.
//
// This module used to own the chat's *height* as well: the dock was pinned to the
// window's bottom and its top tracked the cards, so every change above it had to be
// measured and the height written by hand, once per frame, with the conversation's
// scroll offset restored in the same breath. The redesign gave the chat a cell in
// the stage's grid — a definite box at every window size — and that whole apparatus
// went with it: `fitChatHeight`, `setChatHeight`, `watchChatGeometry` and their
// per-frame reading are deleted, not disabled.
//
// What is left is the half that was never about the height at all: when the
// transcript's *content* changes (a render, a stream, a question posted), the
// conversation must not move under the reader.
import { $ } from './dom.js';
import { restoreChatSlack } from './chat-scroll.js';

/**
 * Put the transcript's top edge on a whole pixel, then hold the conversation still.
 *
 * A scroll offset is a whole pixel — measured: setting 15306.75 stores 15307 — and a
 * line sits at `box top + padding − offset`. If the box's top carries a fraction,
 * the two disagree by that fraction, and the text drifts under a pixel. Lifting the
 * box's top onto the pixel with a margin of the leftover leaves nothing to disagree
 * about. The row is fixed, so the height gives the fraction back at the bottom edge,
 * where a sliver of the panel's own colour cannot be seen.
 *
 * Measured from where the box sits *without* the margin: reading the shifted top and
 * writing the difference back made this oscillate every frame and move nothing.
 */
function lockTranscriptTop() {
  const el = $('transcript');
  if (!el) return;
  const cur = parseFloat(el.style.marginTop) || 0;
  const base = el.getBoundingClientRect().top - cur;
  const lift = Math.ceil(base) - base;
  const want = lift > 0.02 && lift < 0.98 ? `${lift.toFixed(3)}px` : '';
  if ((el.style.marginTop || '') !== want) el.style.marginTop = want;
}

/** Both halves of one change: the box's edges, then the reader's place inside it. */
export function settleChatBox() {
  lockTranscriptTop();
  restoreChatSlack();
}
