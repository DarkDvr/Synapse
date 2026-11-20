// The live pane: one text node, one slide, two states.
//
// Rewritten on 9 Nov, after four rounds of patches on the old pump. The old code
// carried a feed-forward spring, an adoption pass that re-anchored the node to its
// newest line, a height reservation that rebuilt the transcript from *inside* the
// animation frame (and dropped the node that frame was holding), and a fade class
// with a threshold the spring could settle on and flap. Each of those could stop the
// slide or move the chat; together they made the pane untrustworthy.
//
// This one is deliberately small. The text is a tail, cut on a line boundary. One
// frame moves `offset` toward the end of the text with an exponential ease, so a
// jump in the target becomes a slide of about half a second. Classes (`is-idle`,
// `is-reserved`, `is-scrolling`) are set by that frame, never by a render, so no
// frame is ever thrown away mid-flight. The transcript is rebuilt only when the
// pane appears, is collapsed, or the trace around it changes.
//
// The pure parts — `paneEase` and `paneTrim` — are tested in
// `tests/thinking-pane.test.mjs`; the rest is DOM, and is looked at in the page.
import { esc } from './format.js';
import { state } from './state.js';

/** The trace a pane belongs to: the open session's own step, or a worker's. */
const traceFor = (key) => (state.sessionTrace?.key === key ? state.sessionTrace : state.traces.get(key)) || null;

const TAU = 0.12; // seconds for ~63% of the remaining distance
const SNAP = 0.5; // px: closer than this and it has arrived
// A tail, not a record: the visible window is eleven lines, so ten times that is
// plenty of context and cuts the top three times less often than the first guess —
// every trim is one discontinuity, however small (9 Nov).
export const PANE_MAX = 12000;
export const PANE_KEEP = 9000;

let wired = { renderTranscript: () => {} };
/** Hand this module the one thing that lives in app.js. Called once, at boot. */
export function paneWiring(fns) {
  Object.assign(wired, fns);
}

let raf = 0;
let frameAt = 0;
let active = null; // the trace whose pane is on screen

/** One step of the ease. Arrives exactly, so the frame loop can stop. */
export const paneEase = (offset, target, dt) => {
  const from = Number(offset) || 0;
  const to = Number(target) || 0;
  const step = 1 - Math.exp(-Math.max(0, Number(dt) || 0) / TAU);
  const next = from + (to - from) * step;
  return Math.abs(to - next) < SNAP ? to : next;
};

/** The tail of a thinking log: cut on a line boundary so no half line sits on top. */
export function paneTrim(text) {
  const s = String(text ?? '');
  if (s.length <= PANE_MAX) return s;
  let at = s.length - PANE_KEEP;
  const nl = s.indexOf('\n', at);
  if (nl >= 0) at = nl + 1;
  return s.slice(at);
}

const nodeFor = (key) => document.querySelector(`.trace-flow[data-pane="${CSS.escape(key)}"]`);

/** The pane's markup: the log while open, one breathing line while collapsed. */
export function paneMarkup(trace) {
  const s = trace.stream;
  if (!s || !s.text) return '';
  const key = esc(trace.key);
  if (trace.thinkCollapsed && s.kind === 'think') {
    return `<div class="think-line"><span class="status-dot live" role="img" aria-label="thinking"></span><button type="button" class="think-toggle" data-think-toggle="${key}" title="Show what it is thinking">Thinking…</button></div>`;
  }
  const cls = `trace-flow${s.kind === 'think' ? ' is-think' : ''}${s.ended ? ' is-idle' : ''}${trace.reserved ? ' is-reserved' : ''}`;
  // The box is full height from its first word (synapse.css), so nothing below it moves while
  // it is written to. The chip is the way back after the operator has scrolled up inside it.
  return (
    `<div class="think-wrap${s.scrolled ? ' is-reading' : ''}">` +
    `<div class="${cls}" data-pane="${key}"><div class="trace-flow-view"><div class="trace-flow-body">${esc(s.text)}</div></div></div>` +
    `<button type="button" class="think-new" data-think-new="${key}"${s.scrolled ? '' : ' hidden'}>new content ↓</button>` +
    `<button type="button" class="think-toggle" data-think-toggle="${key}" title="Hide the thinking" aria-label="Hide the thinking">▾</button>` +
    `</div>`
  );
}

/** New words. The frame loop picks them up; nothing is rendered here. */
export function paneAdd(trace, text) {
  if (!trace?.stream) return;
  const s = trace.stream;
  const before = s.text.length;
  s.text = paneTrim(s.text + String(text ?? ''));
  // The block's own words, for the fold. The log keeps everything since the pane
  // appeared; a fold that read the log would repeat the same first sentence on
  // every step (9 Nov).
  s.block = (String(s.block || '') + String(text ?? '')).slice(-PANE_MAX);
  // A trim cut the top away, so the offset is past the end of the text and the pane
  // would look empty while it slid back. Snap once instead.
  if (s.text.length < before) s.snap = true;
  trace.stream.ended = false;
  active = trace;
  schedule();
}

/** The step ended: dim the pane, keep its height and its words. */
export function paneEnded(trace) {
  if (!trace?.stream) return;
  trace.stream.ended = true;
  active = trace;
  schedule();
}

/**
 * The reader takes the pane: the wheel moves the text, and the slide stops chasing the end.
 *
 * The slide is a transform and a transform cannot be scrolled, so the two modes show the same
 * pixels in different ways: while following, the body is one block moved up by `offset`; while
 * reading, the body stays put and the view scrolls to the same place (`scrollTop = offset`).
 * The switch is exact, which is what keeps it from jumping.
 */
function takeOver(trace, event) {
  const s = trace.stream;
  const node = nodeFor(trace.key);
  const view = node?.querySelector('.trace-flow-view');
  const body = node?.querySelector('.trace-flow-body');
  if (!s || !view || !body) return false;
  const max = Math.max(0, body.offsetHeight - view.clientHeight);
  if (max <= 2) return false; // nothing to read back: the wheel belongs to the chat
  const delta = event ? Number(event.deltaY) || 0 : 0;
  const from = s.scrolled ? view.scrollTop : Math.max(0, Math.min(Number(s.offset) || 0, max));
  const to = Math.max(0, Math.min(from + delta, max));
  if (event && Math.abs(to - from) < 1) {
    // The pane is at its last line (or its first) and the wheel pushes past it.
    // At the end the wheel is swallowed: there is nothing to read back, and taking
    // the pane anyway flipped it into "reading" and put the new-words chip up on a
    // wheel it could not use, with the chat fighting the follow several times a
    // second (reported 21 Nov). At the top, upward is the chat's: it reads as
    // scrolling back through the conversation, so it is left to bubble.
    if (delta > 0) {
      event.preventDefault();
      event.stopPropagation();
    }
    return false;
  }
  // The frame loop follows `active`: taking the pane makes this trace the one it watches.
  active = trace;
  if (!s.scrolled) {
    s.scrolled = true;
    node.parentElement?.classList.add('is-reading');
    view.style.overflowY = 'auto';
    body.style.transform = 'none';
    view.scrollTop = from;
  }
  if (event) {
    view.scrollTop = to;
    event.preventDefault();
    event.stopPropagation();
  }
  schedule();
  return true;
}

/** Back to the newest words: the slide resumes from the end. */
function dropBack(trace) {
  const s = trace.stream;
  if (!s) return;
  const node = nodeFor(trace.key);
  const view = node?.querySelector('.trace-flow-view');
  const body = node?.querySelector('.trace-flow-body');
  const max = view && body ? Math.max(0, body.offsetHeight - view.clientHeight) : 0;
  s.scrolled = false;
  s.snap = true;
  s.offset = max;
  node?.parentElement?.classList.remove('is-reading');
  const chip = node?.parentElement?.querySelector('.think-new');
  if (chip) chip.hidden = true;
  if (view) {
    view.style.overflowY = '';
    view.scrollTop = 0;
  }
  if (body) body.style.transform = `translate3d(0, ${-max}px, 0)`;
  schedule();
}

/** Wire one drawn pane: the wheel that takes it, the chip that gives it back, its place. */
function wirePane(node, trace) {
  const view = node.querySelector('.trace-flow-view');
  const write = node.querySelector('.trace-flow-body');
  const chip = node.parentElement?.querySelector('.think-new');
  if (view && !view._paneWired) {
    view._paneWired = true;
    view.addEventListener('wheel', (event) => { takeOver(trace, event); }, { passive: false });
  }
  if (chip && !chip._paneWired) {
    chip._paneWired = true;
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropBack(trace);
    });
  }
  if (!view || !write) return;
  if (trace.stream?.scrolled) {
    // A draw put the text back at the top: put the reader back where they were.
    view.style.overflowY = 'auto';
    write.style.transform = 'none';
    view.scrollTop = Math.max(0, Number(trace.stream.offset) || 0);
    if (chip) chip.hidden = false;
  }
}

/** After any transcript render: re-point at the new node and keep sliding. */
export function paneAfterRender() {
  // Every pane this draw produced is wired, whatever the frame loop is pointed at: on the
  // first draw of a turn `active` may not be set yet, and a pane the wheel cannot reach is a
  // pane the operator cannot read back.
  let adopted = null;
  for (const node of document.querySelectorAll('.trace-flow[data-pane]')) {
    const key = String(node.dataset.pane || '');
    const trace = traceFor(key) || (active && String(active.key) === key ? active : null);
    if (!trace) continue;
    wirePane(node, trace);
    // The open session's own pane is the one the loop should watch when nothing told it yet.
    if (trace === state.sessionTrace || !adopted) adopted = trace;
  }
  if (!active && adopted) active = adopted;
  const trace = active;
  if (!trace?.stream || trace.thinkCollapsed || !trace.stream.text) return;
  const node = nodeFor(trace.key);
  const view = node?.querySelector('.trace-flow-view');
  const write = node?.querySelector('.trace-flow-body');
  if (!view) return;
  if (!view._paneStarted) {
    view._paneStarted = true;
    // A pane that was just drawn starts at its end, not sliding in from the middle: the box
    // is full height from its first word, so the first paint is a placement, not a movement.
    trace.stream.snap = true;
  }
  if (!write) return;
  if (trace.stream.scrolled) {
    schedule();
    return;
  }
  write.style.transform = `translate3d(0, ${-(Number(trace.stream.offset) || 0)}px, 0)`;
  schedule();
}

/** Collapse or open the pane. The choice lives on the trace, until the next pane. */
export function paneToggle(trace) {
  if (!trace?.stream) return;
  trace.thinkCollapsed = !trace.thinkCollapsed;
  // Opening a pane starts at its newest words, not wherever the last reading stopped.
  trace.stream.scrolled = false;
  if (!trace.thinkCollapsed) trace.stream.snap = true;
  active = trace;
  wired.renderTranscript();
  schedule();
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(paneFrame);
}

function paneFrame(now) {
  raf = 0;
  // Is the reader at the end? Asked before the pane grows, so a growing pane is
  // followed down the page and a reader who scrolled up is left where they are
  // (9 Nov).
  const trace = active;
  const s = trace?.stream;
  if (!trace || !s || !s.text || trace.thinkCollapsed) return;
  const panel = nodeFor(trace.key);
  const body = panel?.querySelector('.trace-flow-body');
  if (!body) return; // a render will bring it back; this frame draws nothing
  const node = body.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const following = wired.atBottom ? wired.atBottom() : false;
  // Append only what is missing: rewriting the whole text re-breaks every line.
  if (node.data !== s.text) {
    if (s.text.startsWith(node.data)) node.data += s.text.slice(node.data.length);
    else node.data = s.text;
  }
  const view = body.parentElement;
  // The box is a fixed window now, so a short text has a negative reach: the body is pushed
  // down until its last line is the window's last line, and the words arrive at the bottom.
  const target = body.offsetHeight - view.clientHeight;
  panel.classList.toggle('is-idle', Boolean(s.ended));
  panel.classList.toggle('is-scrolling', target > 0.5);
  const chip = panel.parentElement?.querySelector('.think-new');
  if (s.scrolled) {
    // The reader has the pane: words are appended, their place is left alone, and the chip
    // says there is more below. Catching the end by hand puts the slide back.
    s.offset = Math.min(view.scrollTop, Math.max(0, target));
    const atEnd = view.scrollHeight - view.scrollTop - view.clientHeight <= 4;
    if (atEnd) {
      s.scrolled = false;
      panel.parentElement?.classList.remove('is-reading');
      view.style.overflowY = '';
      view.scrollTop = 0;
      if (chip) chip.hidden = true;
    } else {
      if (chip) chip.hidden = false;
      return;
    }
  }
  // Never be past the end. A trim cuts the top away and the old offset would point
  // beyond the new text, which draws an empty box for a frame (seen in a 40ms screen
  // recording: one frame blank, then the text back further along). The clamp makes
  // that impossible whatever the trim did (9 Nov).
  if ((Number(s.offset) || 0) > target) s.offset = target;
  const dt = frameAt ? (now - frameAt) / 1000 : 1 / 60;
  frameAt = now;
  if (s.snap) {
    s.snap = false;
    s.offset = target;
  }
  s.offset = paneEase(Number(s.offset) || 0, target, dt);
  body.style.transform = `translate3d(0, ${-s.offset}px, 0)`;
  // State on the node, never through a render: a rebuilt pane would restart the
  // slide and move the chat (9 Nov).
  if (target > 0.5 && !trace.reserved) {
    trace.reserved = true;
    panel.classList.add('is-reserved');
  }
  // The pane is the last thing in the chat: without this, its growth pushed the
  // newest lines under the composer and the chat looked stuck (9 Nov).
  if (following) wired.follow?.();
  if (Math.abs(target - (Number(s.offset) || 0)) > SNAP) schedule();
}
