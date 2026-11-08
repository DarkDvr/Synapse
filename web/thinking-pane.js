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

const TAU = 0.12; // seconds for ~63% of the remaining distance
const SNAP = 0.5; // px: closer than this and it has arrived
export const PANE_MAX = 4000; // characters kept; the pane is a tail, not a record
export const PANE_KEEP = 2500;

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
  return `<div class="think-wrap"><div class="${cls}" data-pane="${key}"><div class="trace-flow-view"><div class="trace-flow-body">${esc(s.text)}</div></div></div><button type="button" class="think-toggle" data-think-toggle="${key}" title="Hide the thinking" aria-label="Hide the thinking">▾</button></div>`;
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

/** After any transcript render: re-point at the new node and keep sliding. */
export function paneAfterRender() {
  const trace = active;
  if (!trace?.stream || trace.thinkCollapsed || !trace.stream.text) return;
  const node = nodeFor(trace.key);
  const body = node?.querySelector('.trace-flow-body');
  if (!body) return;
  body.style.transform = `translate3d(0, ${-(Number(trace.stream.offset) || 0)}px, 0)`;
  schedule();
}

/** Collapse or open the pane. The choice lives on the trace, until the next pane. */
export function paneToggle(trace) {
  if (!trace?.stream) return;
  trace.thinkCollapsed = !trace.thinkCollapsed;
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
  const trace = active;
  const s = trace?.stream;
  if (!trace || !s || !s.text || trace.thinkCollapsed) return;
  const panel = nodeFor(trace.key);
  const body = panel?.querySelector('.trace-flow-body');
  if (!body) return; // a render will bring it back; this frame draws nothing
  const node = body.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  // Append only what is missing: rewriting the whole text re-breaks every line.
  if (node.data !== s.text) {
    if (s.text.startsWith(node.data)) node.data += s.text.slice(node.data.length);
    else node.data = s.text;
  }
  const view = body.parentElement;
  const target = Math.max(0, body.offsetHeight - view.clientHeight);
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
  panel.classList.toggle('is-idle', Boolean(s.ended));
  panel.classList.toggle('is-scrolling', target > 0.5);
  if (target > 0.5 && !trace.reserved) {
    trace.reserved = true;
    panel.classList.add('is-reserved');
  }
  if (Math.abs(target - (Number(s.offset) || 0)) > SNAP) schedule();
}
