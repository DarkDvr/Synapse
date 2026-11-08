// The chat as a moving thing: where it is scrolled, whether it follows the writing,
// and the panel that shows a worker's words arriving.
//
// These are one file because they are one mechanism. A frame that appends text has
// to know whether the reader is at the end before it grows the block (that is the
// difference between a chat that follows and one that yanks); a scroll event has to
// be told apart from our own write; and the panel's slide has to be capped so the
// newest line stays readable. Split any one of those out and the other two have to
// reach back for it.
import { state } from './state.js';
import { api } from './api.js';
import { $ } from './dom.js';
import { newStream, pushStream, slideTarget, nextOffset, takePending, freezeStream, adoptStream } from './stream-view.js';

// Four things this file needs from app.js: a redraw of the transcript, the trace a
// piece of writing belongs to, the run on screen, and the question post (which is a
// jump target). Wired at boot; a missing one throws rather than doing nothing, so a
// forgotten wire shows up in the page instead of in a silent no-op.
const missing = (name) => () => {
  throw new Error(`chat-scroll.js: ${name} was not wired at boot`);
};
const wired = {
  renderTranscript: missing('renderTranscript'),
  traceOf: missing('traceOf'),
  currentRun: missing('currentRun'),
  askHost: missing('askHost'),
};

/** Hand this module the four things that live in app.js. Called once, at boot. */
export function chatScrollWiring(fns) {
  Object.assign(wired, fns);
}

// The worker's own words, streamed.
//
// The engine sends `session.text.delta` and `session.reasoning.delta` with the
// piece of text in `data.delta` (measured, 21 Oct), so there is nothing to guess
// and nothing to poll: the page accumulates what arrives and shows the tail. The
// block is dropped when its step ends — a text block ending, or the next tool
// call — because a chat cannot be a transcript of every sentence every worker
// thought. The one-line note of the tool call is what survives.
// Streaming text, inside a panel that slides.
//
// Two costs had to stay out of this. It must not rebuild the transcript — that is
// an innerHTML of every message. And it must not rewrite the text each frame: the
// old window replaced the *front* of the paragraph sixty times a second, which
// re-broke every line and forced a layout of the whole chat. So the text node is
// written once per delta and never touched in between, and a frame does one thing
// only — move the block by a few pixels with `transform`, which the compositor
// handles without laying anything out. Frames stop as soon as the slide settles.
//
// The travel itself is `nextOffset` in ./stream-view.js: a damped spring, so the
// text is dragged along by the writing and eases to a stop when the model pauses.
let streamRaf = 0;
let streamEl = null; // { mask, view, body, node, scrolling } once the panel is on screen
let streamFrameAt = 0; // performance.now() of the last frame, for the real dt
// How much of the newest line the damped slide may hide while the chat follows.
// Under a line's height, so nothing readable is ever behind the edge.
const STREAM_MAX_LAG = 8;
const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

// Is the chat still being carried along by the writing?
//
// A distance test alone cannot answer that. Within any slack at all, every written
// frame snapped the chat back to the end, so a reader who scrolled up was fighting
// the page for the width of the slack — and the wheel always lost, because the snap
// ran sixty times a second. So the rule is now: two lines from the end is "following",
// and an upward scroll is a reader who has taken over — the follow lets go at once
// and stays let go until they are back at the end. Nothing is disabled; it is a
// hand-off, and the hand comes back.
let chatFollowArmed = true;
let lastChatTop = 0;
const CHAT_FOLLOW_SLACK = 48; // two lines
// The last time the operator themselves moved the conversation: a wheel, a key, a
// finger. A scroll *event* cannot tell their move from ours, and that was the bug:
// a rebuild resets the scroller and our own follow fires an event, so a declining
// scrollTop read as "the reader took over" and the follow let go in the middle of a
// stream. It came back when the block folded and the next render re-armed it, which
// is why it looked intermittent and why it only happened while thinking streamed.
let chatUserMovedAt = 0;
const CHAT_USER_WINDOW_MS = 1500;

export function noteChatScroll() {
  const el = chatScroller();
  if (!el) return;
  const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
  const byReader = Date.now() - chatUserMovedAt < CHAT_USER_WINDOW_MS;
  if (byReader && el.scrollTop < lastChatTop - 4) chatFollowArmed = false;
  else if (fromEnd <= CHAT_FOLLOW_SLACK) chatFollowArmed = true;
  lastChatTop = el.scrollTop;
  // The reader's place, kept from the end of the conversation: the one value that
  // survives the box changing size under them (see restoreChatSlack).
  //
  // Only when the *reader* put the conversation there. Our own writes fire this
  // event too, and a scroll event is dispatched after the frame's layout: by then the
  // box has already changed size again, so measuring here records the next frame's
  // height against this frame's offset. Every such reading is a little bigger than
  // the last, and one switch compounded 300px into 496px that way.
  const ours = chatScrollWritten !== null && Math.abs(el.scrollTop - chatScrollWritten) <= 1;
  chatScrollWritten = null;
  if (!ours) chatSlack = fromEnd;
}

/** The offset our own last write landed on, so a scroll event it caused is not
 *  mistaken for the reader moving. */
let chatScrollWritten = null;

/** Stop following the writing. The question post calls this: it moves the chat to
 *  the top on purpose, and a follow that was armed would drag the reader back down. */
export function stopFollowingChat() {
  chatFollowArmed = false;
}

/** The operator moved the conversation. Only this may release the follow. */
export function noteUserScrollIntent(deltaY) {
  // A wheel down at the end is them coming back, not leaving.
  if (deltaY > 0 && chatAtBottom(CHAT_FOLLOW_SLACK)) chatFollowArmed = true;
  else chatUserMovedAt = Date.now();
}

/** The panel's parts, or null if it is not on screen yet. */
function findStreamEl(key) {
  const mask = document.querySelector(`.trace.is-live[data-trace="${CSS.escape(key)}"] .trace-flow`);
  const view = mask?.querySelector('.trace-flow-view');
  const body = view?.firstElementChild;
  const node = body?.firstChild;
  if (!body || !node || node.nodeType !== Node.TEXT_NODE) return null;
  return { mask, view, body, node, scrolling: null };
}

/** How far the text has to move up for its last line to sit at the bottom edge. */
function measureStream(s) {
  if (!streamEl) return 0;
  s.target = slideTarget(streamEl.body.offsetHeight, streamEl.view.clientHeight);
  return s.target;
}

/**
 * The trace the newest writing belongs to: a delegated run's while one is live,
 * and otherwise the open session's own step.
 *
 * The Architect had no trace at all, which is why its reasoning panel stayed empty
 * until the step ended and then showed the entire wall at once: the deltas were
 * arriving and being dropped, because only a run had somewhere to put them.
 */
function liveTrace() {
  const run = wired.traceOf(wired.currentRun());
  if (run) return run;
  const own = state.sessionTrace;
  if (!own) return null;
  if (!own.key && state.sessionId) own.key = `sess:${state.sessionId}`;
  return own.key ? own : null;
}

export function appendStream(kind, delta) {
  const trace = liveTrace();
  if (!trace || !delta) return;
  if (!trace.stream || trace.stream.kind !== kind || trace.stream.ended) {
    // A new block (thinking, then speech). Its class differs, so the panel is
    // replaced on the next frame rather than patched; nothing is on screen between
    // the two, because the previous block was frozen when its step ended.
    trace.stream = newStream(kind);
    streamEl = null;
    // A new block is a fresh start: whatever the reader did with the last one does
    // not hold this one hostage.
    chatFollowArmed = true;
    lastChatTop = chatScroller()?.scrollTop || 0;
  }
  pushStream(trace.stream, delta);
  if (!streamRaf) {
    streamFrameAt = 0;
    streamRaf = requestAnimationFrame(pumpStream);
  }
}

function pumpStream(now) {
  streamRaf = 0;
  const trace = liveTrace();
  const s = trace?.stream;
  if (!s || !s.text) {
    streamEl = null;
    return;
  }
  if (!streamEl || !streamEl.mask.isConnected) {
    streamEl = findStreamEl(trace.key);
    if (!streamEl) {
      // Not on screen — the first delta of a run, or a rebuild in between. One
      // render puts it there; the next frame finds it.
      wired.renderTranscript();
      return;
    }
    // The node may hold the previous block's words, or exactly what this block has
    // already shown. Reconcile before measuring: appending the whole block into the
    // old one was the "teleports to the beginning, then scrolls to the bottom"
    // report, and a transform left over from the last block was the empty panel
    // that grew with nothing in it (8 Nov).
    const adopted = adoptStream(s, streamEl.node.data);
    if (adopted.reset) streamEl.node.data = adopted.text;
    else if (adopted.text) streamEl.node.data += adopted.text;
    s.velocity = 0;
    s.offset = measureStream(s);
    // Start where the words already are: the newest line, not the block's first.
    streamEl.body.style.transform = `translate3d(0, ${-s.offset}px, 0)`;
    streamEl.scrolling = (Number(s.target) || 0) > 0.5;
    streamEl.mask.classList.toggle('is-scrolling', streamEl.scrolling);
  }
  let follow = false;
  if (s.dirty) {
    // Read the chat's position *before* the text grows, the same rule the
    // transcript uses for new messages, and only on a frame that writes.
    const scroller = chatScroller();
    follow = Boolean(scroller && chatFollowArmed && chatAtBottom(CHAT_FOLLOW_SLACK));
    // Append, never rewrite: the block can be twenty thousand characters and
    // replacing its text re-breaks every line of it, once per frame.
    const piece = takePending(s);
    if (piece.reset) streamEl.node.data = piece.text;
    else if (piece.text) streamEl.node.data += piece.text;
    s.dirty = false;
    measureStream(s);
  }
  const scrolling = (s.target || 0) > 0.5;
  if (scrolling !== streamEl.scrolling) {
    // The fade at the top edge only belongs there while text is leaving through
    // it; a short block sits in the same panel unclipped.
    streamEl.scrolling = scrolling;
    streamEl.mask.classList.toggle('is-scrolling', scrolling);
  }
  const dt = streamFrameAt ? (now - streamFrameAt) / 1000 : 1 / 60;
  streamFrameAt = now;
  const was = s.offset;
  const offset = nextOffset(s, s.target || 0, dt, {
    reduced: reducedMotion,
    // While the chat follows, the newest line may not sit more than a sliver below
    // the edge. That cap is closed over frames by the slide itself, so a fast model
    // reads as a steady scroll instead of a line landing and the panel jumping by
    // that line (the stutter the operator heard as choppiness, 7 Nov).
    maxLag: follow ? STREAM_MAX_LAG : 0,
  });
  if (offset !== was) {
    s.offset = offset;
    streamEl.body.style.transform = `translate3d(0, ${-offset}px, 0)`;
  }
  if (follow) {
    const scroller = chatScroller();
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      // The follow's own move is not the reader scrolling: keep the comparison
      // baseline in step, or the next frame reads it as an upward scroll.
      chatScrollWritten = scroller.scrollTop;
      lastChatTop = scroller.scrollTop;
    }
  }
  if (!s.settled || s.dirty) streamRaf = requestAnimationFrame(pumpStream);
}

export function endStream() {
  const trace = liveTrace();
  if (!trace || !trace.stream) return;
  const stream = trace.stream;
  // A worker's completed thinking becomes a fold line in its trace. That trace is
  // the only record of what the worker thought — its session never reaches the
  // chat — and a frozen eleven-line panel was both a lie (it read as still
  // arriving) and the reason a new block started inside the old one's node (8 Nov).
  // The Architect's own step is different: its message will carry the words as
  // folds of its own, so the panel waits, frozen, until that message lands.
  if (stream.kind === 'think' && trace !== state.sessionTrace) {
    const text = String(stream.text || '').trim();
    if (text) {
      // Kept whole for the run: the trace draws the newest ten and folds the rest into
      // one line, so the count in that line stays true (8 Nov).
      trace.reasons = [...(trace.reasons || []), { text, at: Date.now() }];
      // Kept server-side too, so a reload and a second view show the same steps.
      api('POST', '/api/runs/reason', {
        dir: trace.dir,
        task: trace.task,
        startedAt: trace.startedAt,
        text,
      }).catch(() => {});
    }
    trace.stream = null;
  } else {
    freezeStream(stream);
  }
  streamEl = null;
  wired.renderTranscript();
}

/**
 * Put the panel back where its slide left it, after `renderTranscript()` rebuilt it.
 *
 * The slide is a `transform` on the text node, and a rebuild is new markup: the old
 * node, and its offset, are gone. Every render therefore has to re-apply it, not
 * just the frames that are writing.
 */
export function restoreStreamView() {
  const trace = liveTrace();
  const s = trace?.stream;
  if (!trace || !s || !s.text) return;
  const el = findStreamEl(trace.key);
  if (!el) return;
  streamEl = el;
  streamEl.body.style.transform = `translate3d(0, ${-(Number(s.offset) || 0)}px, 0)`;
  const scrolling = (Number(s.target) || 0) > 0.5;
  streamEl.scrolling = scrolling;
  streamEl.mask.classList.toggle('is-scrolling', scrolling);
}

// ── scrolling: the transcript when it scrolls, the page when it does not ──
// In the wide layout the stage has a definite height and the transcript scrolls
// inside itself; in the stacked layout the page scrolls instead. Every scroll
// helper goes through here so both behave the same.
export function chatScroller() {
  const el = $('transcript');
  return el && el.scrollHeight > el.clientHeight + 2 ? el : null;
}

function chatScrollTop() {
  const el = chatScroller();
  return el ? el.scrollTop : window.scrollY;
}

/** Is the reader at the end of the conversation — close enough to be followed?
 *
 *  The window is two lines (48px), not four. Four was enough room to be "at the
 *  bottom" while reading the last thing said, so a new message arriving pulled the
 *  page out from under a reader who had not finished it. Two lines still forgives
 *  the odd stray pixel of sub-pixel layout, and forgiving any more than that is not
 *  forgiveness, it is being yanked.
 */
export function chatAtBottom(slack = 48) {
  const el = chatScroller();
  if (el) return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
  // No internal scroller: the whole conversation fits its box. "At the bottom"
  // then means the chat's own bottom edge is in view — not that the *page* has
  // reached its end. In the narrow layout the page continues past the chat into the
  // plan and the rail, so the document's bottom is hundreds of pixels below the
  // conversation and asking about it always answered "scrolled up".
  const box = $('transcript');
  if (!box) return true;
  return box.getBoundingClientRect().bottom <= window.innerHeight + slack;
}

export function scrollChatToBottom(behavior = 'auto') {
  const el = chatScroller();
  if (el) { el.scrollTo({ top: el.scrollHeight, behavior }); chatScrollWritten = el.scrollTop; return; }
  // The transcript already fits its box: the newest message is laid out and
  // there is nothing to scroll to. This used to fall through to the WINDOW and
  // jump to `documentElement.scrollHeight` — past the chat, to the very bottom
  // of the page, which in the stacked layout is the rail. That is the "the
  // central panel scrolled itself" report, and it only happened while the
  // conversation was still short enough not to scroll inside its own box; once
  // it grew, the branch above took over and the jump stopped. The page is moved
  // deliberately in exactly two places (Send and opening a session), never by a
  // render.
}

/**
 * What the jump buttons step through.
 *
 * Every turn, and the question post — the question is the last thing in the chat
 * and the operator must be able to land on it. It was not a jump target at all, so
 * "next message" stepped past it and the only way to read it was to drag the chat
 * (reported 2 Nov).
 */
const navMessages = () => {
  const list = [...document.querySelectorAll('#transcript .msg[data-msg]')];
  const ask = wired.askHost();
  if (ask && !ask.hidden && ask.parentElement && ask.parentElement.id === 'transcript') list.push(ask);
  return list;
};

function myMessageTops() {
  const el = chatScroller();
  if (el) {
    const sRect = el.getBoundingClientRect();
    return navMessages().map((n) => n.getBoundingClientRect().top - sRect.top + el.scrollTop);
  }
  return navMessages().map((n) => n.getBoundingClientRect().top + window.scrollY);
}

/**
 * Which message currently owns the top of the viewport. `cur` is the last
 * message whose top is at or above the fold; -1 means the view sits above every
 * message. Comparing raw scroll offsets is not enough: the first message often
 * sits ~10px below the content top, so a "first one below the fold" test kept
 * re-selecting it and the DOWN button never advanced past message one.
 *
 * Anchors are every turn, including Synapse's own reports: the rule between
 * speakers is the only structure the transcript has, so the bars are the anchors
 * and a chat with two of them has somewhere to jump.
 */
function navAnchors() {
  const tops = myMessageTops();
  const at = chatScrollTop();
  let cur = -1;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= at + 12) cur = i;
  return { tops, at, cur };
}

export function renderChatNav() {
  const nav = $('chatNav');
  const dock = $('chatDock');
  if (!nav || !dock) return;
  // The transcript's only structure is the rule between speakers, so the bars
  // are what the buttons step through: two of them means there is something to
  // jump between. (Messages = bars + 1.)
  const count = navMessages().length;
  const show = count >= 3;
  nav.hidden = !show;
  if (!show) return;

  // No JS anchoring: the nav is absolutely positioned inside the dock, so it is
  // clipped to the chat pane and stays put when the window resizes.

  const { tops, cur } = navAnchors();
  // Never offer a jump that cannot happen: with nothing to scroll, all four rest.
  const el = chatScroller();
  const canScroll = el ? el.scrollHeight - el.clientHeight > 2 : document.documentElement.scrollHeight > window.innerHeight + 2;
  const at = el ? el.scrollTop : window.scrollY;
  const atEnd = el ? el.scrollHeight - el.clientHeight : document.documentElement.scrollHeight - window.innerHeight;
  const atBottom = at >= atEnd - 1;
  $('navTop').disabled = !canScroll || at <= 1;
  $('navPrev').disabled = !canScroll || cur <= 0;
  // At the bottom the last message is already in view, but its anchor can sit
  // below the fold — so `cur` still points at the one before it and Next looked
  // available with nowhere to go. The bottom button is the honest authority.
  $('navNext').disabled = !canScroll || atBottom || cur >= tops.length - 1;
  $('navBottom').disabled = !canScroll || atBottom;
}

/**
 * The jump buttons animate the transcript themselves. `behavior: 'smooth'`
 * hands the duration to the browser, where it cannot be tuned; 280ms here is
 * roughly 30% quicker than the browser's own smooth scroll over these
 * distances, with an ease-out so the arrival still reads as a landing.
 */
export function animateScroll(el, to, ms = 280) {
  const from = el ? el.scrollTop : window.scrollY;
  const delta = to - from;
  if (Math.abs(delta) < 1) return;
  const t0 = performance.now();
  const ease = (t) => 1 - (1 - t) ** 3;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const y = from + delta * ease(p);
    if (el) el.scrollTop = y;
    else window.scrollTo(0, y);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function jumpMessage(dir) {
  const { tops, cur } = navAnchors();
  // Move exactly one message from the one currently at the fold, in the asked
  // direction. Deriving the target from the scroll offset alone got stuck on
  // the first message (its top is not at 0), which is why DOWN did nothing.
  const next = dir < 0 ? cur - 1 : cur + 1;
  if (next < 0 || next >= tops.length) return;
  const top = Math.max(0, tops[next] - 10);
  animateScroll(chatScroller(), top);
}

/**
 * Where the reader is, expressed from the *end* of the conversation: the distance
 * from the last line to the bottom edge of the box.
 *
 * This is the whole of the chat's anchoring. A scroll offset is measured from the
 * top, so when the box grows upward every line moves down the screen unless the
 * offset moves with it; the slack, measured from the end, does not change when the
 * box does. Keeping it constant is therefore the same thing as "nothing inside the
 * chat moves — only the top edge does", for a reader at the end and for a reader
 * scrolled up into the history alike.
 *
 * It is also *idempotent*: restoring it twice, or three times, or from two different
 * callers, lands on the same offset. That matters more than it sounds. Two earlier
 * attempts tracked the height change and added it to the offset, which is correct
 * exactly once and double-counts the moment two paths see the same change — measured
 * as a 12px jump, then a 1px one, then a 1px one, each a different caller's share.
 */
let chatSlack = null;

/** Remember the reader's place. Call after anything that may move them. */
export function captureChatSlack() {
  const el = $('transcript');
  if (!el) return;
  chatSlack = el.scrollHeight - el.clientHeight - el.scrollTop;
}

/**
 * Put the conversation back where the reader had it, whatever the box has done
 * since. Safe to call at any time; does nothing if there is no place to keep.
 *
 * A reader within two lines of the end is *at* the end, and is held there as the
 * end rather than as a two-line gap. That is the same rule the follow uses
 * (`CHAT_FOLLOW_SLACK`), and it has to be the same rule: a chat that happened to sit
 * 12px short of the end keeps 12px of gap through a switch, and in Multi — a short box
 * with no spare room under the last line — that reads as "the chat ended up scrolled
 * up a bit", while the same 12px in Single's tall box is invisible. Being "at the
 * end" should mean the newest line is flush with the bottom, wherever it was before.
 */
export function restoreChatSlack() {
  const el = $('transcript');
  if (!el || chatSlack === null) return;
  const slack = chatSlack <= CHAT_FOLLOW_SLACK ? 0 : chatSlack;
  const want = el.scrollHeight - el.clientHeight - slack;
  if (Math.abs(el.scrollTop - want) < 0.5) return;
  el.scrollTop = Math.max(0, want);
  // Our own move is not the reader scrolling: recorded so the scroll event it causes
  // is not mistaken for one (see noteChatScroll), and not read back as the place to
  // keep.
  chatScrollWritten = el.scrollTop;
  lastChatTop = el.scrollTop;
}
