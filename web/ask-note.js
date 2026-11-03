// The line beside a question's title: who asked it, and what happens if the
// operator does nothing.
//
// It used to read "another chat is waiting on you · full auto answers on its next
// check" — two clauses answering different questions, the first one false when the
// run answers for itself. It now names the switch and counts down to the moment it
// acts, because "in 30s" that never moves is a claim the operator cannot check
// (3 Nov).
//
// Kept apart from app.js so the wording is testable without a page: the file has
// no DOM and no state, and tests/ask-note.test.mjs calls it directly.

/**
 * @param {{ here?: boolean, autoAnswer?: boolean, wait?: number, dueAt?: number|null, now?: number }} [input]
 *   `here` is true when the question belongs to the chat on screen.
 *   `wait` is the Auto-Answer wait in seconds; 0 means it answers at once.
 *   `dueAt` is when the server will answer, in epoch ms — the countdown source.
 *   `now` is the clock to measure against (a test passes its own).
 * @returns {string} the note, ready to render (no markup, no escaping needed).
 */
export function askHeadNote({ here = true, autoAnswer = false, wait = 0, dueAt = null, questions = 1, now = Date.now() } = {}) {
  if (!autoAnswer) {
    return here ? 'waiting for your answer' : 'asked in another chat — open that chat to answer';
  }
  const seconds =
    dueAt === null || dueAt === undefined
      ? Math.max(0, Math.floor(Number(wait) || 0))
      : Math.max(0, Math.ceil((Number(dueAt) - Number(now)) / 1000));
  const when = seconds > 0 ? `in ${seconds}s…` : 'now…';
  const place = here ? '' : 'another chat — ';
  // "answering with recommended options" for one question; the count when the
  // form holds several, because Auto-Answer answers them all in one reply and the
  // operator is entitled to see how many that is.
  const many = Number(questions) > 1 ? `${Number(questions)} questions ` : '';
  return `${place}Auto-Answering enabled, answering ${many}with recommended options ${when}`;
}

/** The seconds left, for anyone who needs the number rather than the sentence. */
export function askHeadSeconds({ wait = 0, dueAt = null, now = Date.now() } = {}) {
  if (dueAt === null || dueAt === undefined) return Math.max(0, Math.floor(Number(wait) || 0));
  return Math.max(0, Math.ceil((Number(dueAt) - Number(now)) / 1000));
}
