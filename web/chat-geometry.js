// How tall the chat is, and what has to be held still while that changes.
//
// Two layouts, one rule: above the wide breakpoint CSS owns the height and the page
// does not scroll; below it the stage is content-sized and this module measures. The
// number that must not move is the reader's place in the conversation — the box
// changing size under them is the "the chat scrolled itself" family of bugs.
import { state } from './state.js';
import { $ } from './dom.js';
// Sizing the box and holding the reader's place are one job: every measurement here
// ends by putting the conversation back where it was.
import { restoreChatSlack } from './chat-scroll.js';

/** The one width where the layout changes, and the only place it is decided.
 *
 * Above it the stage is given a definite height, so CSS owns the chat's and the page
 * does not scroll. Below it the stage is content-sized, the page scrolls, and
 * `fitChatHeight` owns the height. `web/synapse.css` switches at 1359/1358 for exactly
 * this reason, and the two numbers must agree: while JS cut at 1461 the 1359–1460 band
 * was sized by the narrow rules while the wide layout was on screen.
 */
export const WIDE_LAYOUT = '(min-width: 1359px)';
export const wideLayout = () => window.matchMedia(WIDE_LAYOUT).matches;

// ── the question panel ──────────────────────────────────────────
// A model that asks the operator something blocks the session until it is
// answered, so the question is not a transcript decoration: it is a panel
// painted over the chat, anchored just above the composer. The engine raises a
// form for it, and the form is the interface — the `question` tool card in the
// transcript is only the record.
//
// It lives in an absolutely positioned host (see `.ask-host`), so however tall
// it grows it can never change the chat's size: it only ever covers what is
// already there.


/**
 * The chat's geometry, in one place and one rule.
 *
 * The dock sits between two edges that are not symmetrical: its **bottom** is the
 * window's bottom and must not move, its **top** is wherever the cards end and moves
 * whenever they do. So the height is not a number to guess at — it is `window bottom
 * − dock top`, both measured now. Every time anything above the chat changes size,
 * this runs once; the bottom lands exactly where it was and only the top edge has
 * moved. That is the whole contract.
 *
 * Measured *now* rather than predicted from the reveal's target (`--reveal-h`), for
 * two reasons: the target is rounded up (a cap must not clip a border), and during a
 * slide it describes a layout that does not exist yet. A height built from it left
 * the chat a pixel short in one mode and a pixel tall in the other, and the composer
 * stepped as a switch ended.
 *
 * The height carries a fraction on purpose. The top is on a fraction — a card row
 * really is 126.281px tall — so a whole-pixel height would put the bottom on a
 * fraction too, and the bottom is where the composer and every label in it live.
 */
export function fitChatHeight() {
  const dock = $('chatDock');
  if (!dock) return;
  // The wide layout gives the stage a definite height and CSS fills the dock from it.
  // An empty dock is just its composer row, in either layout: neither takes an
  // inline height.
  const inSession = state.view === 'session' && dock.classList.contains('has-history');
  if (wideLayout() || !inSession) {
    if (dock.style.height) dock.style.height = '';
    return;
  }
  // The page scrolls here, so the height has to come out the same at every scroll
  // position. It is the room under the cards in one screen, measured from the dock's
  // place in the *document* — which does not move — and never from its place in the
  // viewport, which does.
  //
  // Measured in the viewport, the plan could not be reached: the dock's top rises as
  // the operator scrolls, so `viewport bottom − dock top` grew by exactly the scroll
  // distance, the page grew by the same amount, and the plan stayed one screen below
  // the fold for ever. Measured at 1160x894, scrolling 0/120/…/600px gave a dock of
  // 349/469/…/949px with the plan's top pinned at 896 on every sample.
  const topInDoc = dock.getBoundingClientRect().top + window.scrollY;
  const room = window.innerHeight - 12 - Math.max(0, topInDoc);
  // The floor is the composer plus whatever the stylesheet says the transcript needs,
  // read from it rather than repeated here: on a short window the room left under the
  // cards can be less than that floor, and a chat held *taller* than its own row does
  // not grow the row — it slides down behind the composer, hiding the newest lines and
  // shifting them whenever the box changes size. The floor belongs in the height, so
  // the whole dock overflows the page instead of the transcript overflowing the dock.
  const composerH = $('composer')?.getBoundingClientRect().height ?? 58;
  const floor = composerH + (parseFloat(getComputedStyle($('transcript')).minHeight) || 0) + 2;
  const next = `${Math.max(floor, room)}px`;
  if (dock.style.height !== next) setChatHeight(dock, next);
}

/**
 * Set the chat's height, and hold the conversation still in the same breath.
 *
 * The height and the scroll offset are two halves of one change, so the offset is
 * settled synchronously — here, before the frame is painted, not a frame later in
 * the observer, where the error accumulates across an animation.
 */
export function setChatHeight(dock, value) {
  dock.style.height = value;
  settleChatBox();
}

/**
 * Put the transcript's top edge on a whole pixel, then hold the conversation still.
 *
 * A scroll offset is a whole pixel — measured: setting 15306.75 stores 15307 — and a
 * line sits at `box top + padding − offset`. If the box's top carries a fraction, the
 * two disagree by that fraction, and while the box's top is *moving* (a card sliding)
 * the disagreement changes every frame: the text drifts under a pixel and back, which
 * is what "the chat is dancing" is, once the large movements are gone. Lifting the
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


/**
 * Watch the chat's top edge, by the only means there is: look at it.
 *
 * ResizeObserver reports *sizes*, and the box above the chat can move without any
 * observed box changing size — a row that shifts, a margin, a font that re-breaks a
 * line elsewhere. Three separate attempts to watch "the things above the chat" each
 * found one more source and each missed the next one, the last of them a 6px jump
 * during a run that no size change accounted for. The geometry is the fact; so it is
 * read once per frame, and only when it is not where it was does anything run.
 *
 * Per frame, and not "when the observer says so", because a frame late is a frame
 * wrong: an observer reports after the layout that changed, so every frame of an
 * animation draws once at the old offset and is corrected afterwards. That is
 * invisible in the layout where the height is ours (we write it before the paint)
 * and visible in the other one, where the grid owns the height and there is nothing
 * to write — which is exactly the difference the operator reported between a narrow
 * window and a wide one.
 *
 * One rect read and a comparison per frame invalidates no layout, so a still frame
 * costs nothing measurable.
 */
let chatGeoRaf = 0;
let lastChatGeo = null;
export function watchChatGeometry() {
  if (chatGeoRaf) return;
  const tick = () => {
    chatGeoRaf = requestAnimationFrame(tick);
    const dock = $('chatDock');
    const el = $('transcript');
    if (!dock || !el || state.view !== 'session') { lastChatGeo = null; return; }
    const top = dock.getBoundingClientRect().top;
    const boxTop = el.getBoundingClientRect().top;
    const h = el.clientHeight;
    if (lastChatGeo
      && Math.abs(top - lastChatGeo.top) < 0.01
      && Math.abs(boxTop - lastChatGeo.boxTop) < 0.01
      && h === lastChatGeo.h) return;
    lastChatGeo = { top, boxTop, h };
    // Narrow layout: the height is ours to write, and writing it settles the content.
    // Wide layout: the grid owns the height, so only the content is settled — the
    // same work, one line earlier than an observer could do it.
    if (dock.style.height) fitChatHeight();
    else settleChatBox();
  };
  chatGeoRaf = requestAnimationFrame(tick);
}
