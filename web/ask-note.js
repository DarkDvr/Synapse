// The line beside a question's title: who asked it, and what happens if the
// operator does nothing.
//
// It used to read "another chat is waiting on you · full auto answers on its next
// check". Two problems, both reported on 2 Nov while running Multi in Full auto:
// the first half is false when the run answers for itself (nobody is waiting on
// the operator), and "check" is engine vocabulary for a poll the operator never
// sees. One sentence now, and it names the switch that will act: Auto-Answer.
//
// Kept apart from app.js so the wording is testable without a page: the file has
// no DOM and no state, and tests/ask-note.test.mjs calls it directly.

/**
 * @param {{ here?: boolean, autoAnswer?: boolean, wait?: number }} [input]
 *   `here` is true when the question belongs to the chat on screen.
 *   `wait` is the Auto-Answer wait in seconds; 0 means it answers at once.
 * @returns {string} the note, ready to render (no markup, no escaping needed).
 */
export function askHeadNote({ here = true, autoAnswer = false, wait = 0 } = {}) {
  const seconds = Math.max(0, Math.floor(Number(wait) || 0));
  if (!autoAnswer) {
    return here ? 'waiting for your answer' : 'asked in another chat — open that chat to answer';
  }
  if (!here) {
    return `asked in another chat — Auto-Answer replies ${seconds > 0 ? `in ${seconds}s` : 'at once'}`;
  }
  return seconds > 0
    ? `Auto-Answer replies in ${seconds}s unless you answer first`
    : 'Auto-Answer replies at once';
}
