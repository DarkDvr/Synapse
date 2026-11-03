// The line beside a question's title, and the clock Auto-Answer counts on.
//
// It read "another chat is waiting on you · full auto answers on its next check" —
// two clauses answering different questions, the first one false when the run
// answers for itself. It is now one short sentence that counts down: "Auto-Answering
// in 7 seconds…". The operator asked for that wording on 3 Nov, after a longer one
// ("answering with recommended options…") filled the head and still explained less.
//
// Kept apart from app.js so both are testable without a page: no DOM, no state.
// tests/ask-note.test.mjs calls them directly.

/**
 * Where the form is in its countdown.
 *
 * Auto-Answer works one *page* at a time: the wait belongs to the question on
 * screen, and when it runs out the panel moves to the next one, which gets its own
 * wait. A three-question form therefore takes three waits, and the reply goes to
 * the engine after the last one.
 *
 * @param {{ firstAt: number, wait?: number, pages?: number, now?: number }} input
 *   `firstAt` is when the first page appeared (epoch ms), `wait` is one page's wait
 *   in seconds, `pages` how many questions the form holds.
 * @returns {{ page: number, seconds: number }} the page the clock says is due, and
 *   the seconds left on it (never negative).
 */
export function answerTimeline({ firstAt, wait = 0, pages = 1, now = Date.now() } = {}) {
  const waitMs = Math.max(1, Math.floor(Number(wait) || 0)) * 1000;
  const count = Math.max(1, Math.floor(Number(pages) || 1));
  const started = Number(firstAt);
  const at = Number(now);
  const elapsed = Number.isFinite(started) ? at - started : 0;
  const page = Math.min(count - 1, Math.max(0, Math.floor(elapsed / waitMs)));
  const end = (Number.isFinite(started) ? started : at) + (page + 1) * waitMs;
  return { page, seconds: Math.max(0, Math.ceil((end - at) / 1000)) };
}

/**
 * @param {{ here?: boolean, autoAnswer?: boolean, seconds?: number }} [input]
 *   `here` is true when the question belongs to the chat on screen; `seconds` is
 *   the number left on this page (see answerTimeline).
 * @returns {string} the note, ready to render (no markup, no escaping needed).
 */
export function askHeadNote({ here = true, autoAnswer = false, seconds = 0 } = {}) {
  if (!autoAnswer) {
    return here ? 'waiting for your answer' : 'asked in another chat — open that chat to answer';
  }
  const left = Math.max(0, Math.ceil(Number(seconds) || 0));
  const place = here ? '' : 'another chat — ';
  return left > 0 ? `${place}Auto-Answering in ${left} seconds…` : `${place}Auto-Answering now…`;
}

/**
 * The same countdown on a permission card: "Auto-Permission: Allow Once will be
 * picked in 7 seconds…". `dueAt` is the server's clock for the gate's own timeout,
 * so the number is the wait that is really running, not a fixed setting.
 */
export function permissionNote(dueAt, now = Date.now()) {
  const left = Math.max(0, Math.ceil((Number(dueAt) - Number(now)) / 1000));
  return left > 0
    ? `Auto-Permission: Allow Once will be picked in ${left} seconds… `
    : 'Auto-Permission: Allow Once will be picked now… ';
}
