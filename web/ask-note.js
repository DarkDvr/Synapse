// The line beside a question's title: who asked it, and what happens if the
// operator does nothing.
//
// It used to read "another chat is waiting on you · full auto answers on its next
// check". Two problems, both reported on 2 Nov while running Multi in Full auto:
// the first half is false when Full auto is on (nobody is waiting on the operator,
// the run answers itself), and "check" is engine vocabulary for a poll the
// operator never sees. One sentence now, and it says which of the two is true.
//
// Kept apart from app.js so the wording is testable without a page: the file has
// no DOM and no state, and tests/ask-note.test.mjs calls it directly.

/**
 * @param {{ here?: boolean, fullAuto?: boolean, wait?: number }} [input]
 *   `here` is true when the question belongs to the chat on screen.
 *   `wait` is the Full auto wait in seconds; 0 means the run answers at once.
 * @returns {string} the note, ready to render (no markup, no escaping needed).
 */
export function askHeadNote({ here = true, fullAuto = false, wait = 0 } = {}) {
  const seconds = Math.max(0, Math.floor(Number(wait) || 0));
  if (!fullAuto) {
    return here ? 'waiting for your answer' : 'asked in another chat — open that chat to answer';
  }
  if (!here) {
    return `asked in another chat — Full auto answers ${seconds > 0 ? `in ${seconds}s` : 'at once'}`;
  }
  return seconds > 0 ? `Full auto answers in ${seconds}s unless you answer first` : 'Full auto answers at once';
}
