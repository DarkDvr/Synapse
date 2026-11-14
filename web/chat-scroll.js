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
import { newStream } from './stream-view.js';
import { paneAdd, paneEnded, paneAfterRender } from './thinking-pane.js';
import { turnLive } from './turn-live.js';

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
// The pane lives in ./thinking-pane.js — the text tail, the slide, the two states.
// This file keeps only what a pane cannot know: which trace the newest words belong
// to, what happens when a thought's step ends (a fold, posted to the server, so a
// reload keeps the record), and speech, which never takes the thinking pane.

// Is the chat still being carried along by the writing?
//
// A distance test alone cannot answer that. Within any slack at all, every written
// frame snapped the chat back to the end, so a reader who scrolled up fought the page
// for the width of the slack — and the wheel always lost, because the snap runs sixty
// times a second. So the rule is a hand-off: an upward gesture lets go at once and
// stays let go, and only the reader sending it back to the end picks it up again.
//
// The subtlety that took four tries, and the reason the two flags below are both here:
// **geometry is not a gesture.** Chromium animates a wheel and fires a scroll event per
// animation frame, so every step of an upward wheel still measures "two lines from the
// end" — arming on that re-pinned the reader on the very next frame. The arm may only
// be restored by an explicit downward intent, or by the scrollbar landing at the end.
let chatFollowArmed = true;
let lastChatTop = 0;
export const CHAT_FOLLOW_SLACK = 48; // two lines
// The last time the operator themselves moved the conversation: a wheel, a key, a
// finger. A scroll *event* cannot tell their move from ours.
let chatUserMovedAt = 0;
const CHAT_USER_WINDOW_MS = 1500;
// Which way the last gesture went: +1 towards the end, -1 away, 0 nothing yet.
let chatUserIntent = 0;

/**
 * The follow's decision after a scroll event, as a pure function.
 *
 * Apart from the DOM so it can be tested without a page, a run or a growing pane —
 * this rule was wrong three times in one day and every version looked right
 * (tests/chat-follow.test.mjs writes the failing case down).
 *
 * - A reader's upward move always releases it.
 * - Only an explicit downward intent, or the scrollbar landing exactly at the end,
 *   re-arms it. `fromEnd <= slack` alone is not evidence: our own pin makes it true.
 * - Our own writes (`byReader` false) never change it.
 */
export function followAfterScroll({
  armed = true,
  byReader = false,
  movedUp = false,
  intent = 0,
  fromEnd = 0,
  slack = CHAT_FOLLOW_SLACK,
} = {}) {
  if (byReader && movedUp) return false;
  if (byReader && fromEnd <= slack && (Number(intent) > 0 || (Number(intent) === 0 && fromEnd <= 1))) return true;
  return Boolean(armed);
}

export function noteChatScroll() {
  const el = chatScroller();
  if (!el) return;
  const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
  const byReader = Date.now() - chatUserMovedAt < CHAT_USER_WINDOW_MS;
  chatFollowArmed = followAfterScroll({
    armed: chatFollowArmed,
    byReader,
    movedUp: el.scrollTop < lastChatTop - 4,
    intent: chatUserIntent,
    fromEnd,
  });
  lastChatTop = el.scrollTop;
  // The reader's place, kept from the end of the conversation: the one value that
  // survives the box changing size under them (see restoreChatSlack). Only when the
  // *reader* put the conversation there: our own writes fire this event too, after
  // the frame's layout, by which time the box has changed again.
  const ours = chatScrollWritten !== null && Math.abs(el.scrollTop - chatScrollWritten) <= 1;
  chatScrollWritten = null;
  if (!ours) chatSlack = fromEnd;
}

/** The offset our own last write landed on, so a scroll event it caused is not
 *  mistaken for the reader moving. */
let chatScrollWritten = null;

/** Stop following the writing. The question post calls this. */
export function stopFollowingChat() {
  chatFollowArmed = false;
}

/**
 * Is the chat still following the writing?
 *
 * Every automatic pin asks this first — the frame loop that grows the thinking pane,
 * and the render that follows a message. Geometry alone was the old rule, and it put a
 * reader inside two lines of the end back there every frame however hard they scrolled.
 */
export function chatFollows() {
  return chatFollowArmed;
}

/** The operator moved the conversation. Only this may release the follow. */
export function noteUserScrollIntent(deltaY) {
  chatUserMovedAt = Date.now();
  if (deltaY > 0) {
    chatUserIntent = 1;
    // A wheel down at the end is them coming back, not leaving.
    if (chatAtBottom(CHAT_FOLLOW_SLACK)) chatFollowArmed = true;
    return;
  }
  if (deltaY < 0) {
    // Released here, on the gesture, and not left to a scroll event: the event can
    // arrive after a frame has already re-pinned the box.
    chatUserIntent = -1;
    chatFollowArmed = false;
  }
}

/**
 * The trace the newest writing belongs to: a delegated run's while one is live, and
 * otherwise the open session's own step.
 */
function liveTrace() {
  const run = wired.traceOf(wired.currentRun());
  // A finished run keeps its trace for the report, but new words do not go there:
  // the Architect's own step starts right after the report (9 Nov).
  if (run && !run.finishedAt) return run;
  const own = state.sessionTrace;
  if (!own) return null;
  if (!own.key && state.sessionId) own.key = `sess:${state.sessionId}`;
  return own.key ? own : null;
}

/** A worker's step, as opposed to the Architect's own turn. */
const isWorker = (trace) => trace !== state.sessionTrace;

/**
 * New writing. Thinking continues the pane's log; speech is collected and becomes a
 * paragraph when its block ends.
 */
export function appendStream(kind, delta) {
  const trace = liveTrace();
  if (!trace || !delta) return;
  // The Architect's pane exists only while its turn does. A delta for a turn that is
  // over — a queued event, a step the page never saw start — used to open a one-line
  // pane under a finished post, and nothing would ever close it (13 Nov).
  if (!isWorker(trace) && !turnLive()) return;
  // Speech never takes the thinking pane — not a worker's (it becomes the paragraph
  // when the block ends) and not the Architect's either: its words land with the
  // message, and showing them in the pane cleared the thoughts above (9 Nov).
  if (kind === 'word') {
    if (isWorker(trace)) trace.proseBuf = String(trace.proseBuf || '') + delta;
    return;
  }
  if (kind === 'think' && trace.stream?.kind === 'think') {
    if (trace.stream.ended) {
      trace.stream.ended = false;
      trace.stream.folded = false;
      paneAdd(trace, '\n\n');
    }
    paneAdd(trace, delta);
    return;
  }
  // The first block of a turn, or the Architect speaking: a new pane, drawn open.
  foldStream(trace);
  trace.stream = newStream(kind);
  trace.thinkCollapsed = false;
  // "Full" belongs to the turn that filled it. A new pane grows from its own height
  // again, and once it fills it stays until this turn ends (14 Nov).
  trace.reserved = false;
  chatFollowArmed = true;
  lastChatTop = chatScroller()?.scrollTop || 0;
  // The first words go in BEFORE the render. A pane is only markup once it has text
  // to draw (`paneMarkup` returns nothing for an empty stream), so rendering first
  // opened a post with no panel in it — and this is the only render the block gets:
  // the deltas after it just append, by design, for the frame loop to paint. The
  // Architect's opening reasoning therefore landed nowhere and the chat sat on its
  // placeholder until a tool call forced a render (10 Nov, the second report of it).
  // A worker's trace was saved by its tool events re-rendering every few seconds.
  paneAdd(trace, delta);
  wired.renderTranscript();
}

/**
 * The ended block becomes a fold, once, and is kept. A worker's fold is posted to
 * the server too: the trace is the only record of what it thought.
 */
export function foldStream(trace) {
  const stream = trace?.stream;
  if (!stream || stream.folded || stream.kind !== 'think') return;
  // The Architect's message carries its folds; there is no reason list to fill.
  if (!isWorker(trace)) return;
  stream.folded = true;
  // The block's own words, not the log: the log holds every step since the pane
  // appeared, so reading it repeated the same first sentence on every fold (9 Nov).
  const text = String(stream.block || stream.text || '').trim();
  if (!text) return;
  trace.reasons = [...(trace.reasons || []), { text, at: Date.now() }];
  stream.block = '';
}

export function endStream() {
  const trace = liveTrace();
  if (!trace) return;
  if (!trace.stream) {
    // A speech block that never took the pane: only a worker's is drawn back, as a
    // paragraph. The Architect's words arrive with its message (9 Nov).
    if (isWorker(trace)) flushProse(trace);
    return;
  }
  if (trace.stream.kind === 'think' && isWorker(trace)) {
    const text = String(trace.stream.text || '').trim();
    if (text) {
      api('POST', '/api/runs/reason', {
        dir: trace.dir,
        task: trace.task,
        startedAt: trace.startedAt,
        text,
      }).catch(() => {});
    }
    foldStream(trace);
    trace.stream.folded = false;
  }
  paneEnded(trace);
  wired.renderTranscript();
}

/** The words a worker said between tools: a paragraph, once, when the block ends. */
function flushProse(trace) {
  const text = String(trace.proseBuf || '').trim();
  trace.proseBuf = '';
  if (!text) return;
  trace.notes.push({ at: Date.now(), text, prose: true });
  if (trace.notes.length > 60) trace.notes.splice(0, trace.notes.length - 60);
  wired.renderTranscript();
}

/** After any transcript render: hand the new node to the pane. */
export function restoreStreamView() {
  paneAfterRender();
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
  // "Within two lines is at the end" only while the chat is following. Once the reader
  // has taken over, their two lines are two lines: snapping them flush would be the
  // same pin under another name, and a dock that changes height mid-turn would do it
  // to them (10 Nov).
  const slack = chatSlack <= CHAT_FOLLOW_SLACK && chatFollowArmed ? 0 : chatSlack;
  const want = el.scrollHeight - el.clientHeight - slack;
  if (Math.abs(el.scrollTop - want) < 0.5) return;
  el.scrollTop = Math.max(0, want);
  // Our own move is not the reader scrolling: recorded so the scroll event it causes
  // is not mistaken for one (see noteChatScroll), and not read back as the place to
  // keep.
  chatScrollWritten = el.scrollTop;
  lastChatTop = el.scrollTop;
}
