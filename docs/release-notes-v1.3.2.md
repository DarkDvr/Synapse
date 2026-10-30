# Synapse v1.3.2

Stop is a stop. It says nothing to the model.

## Changed

- **No explanation is planted anywhere.** The brief line "the last run was stopped
  by the operator at 15:44, do not retry it unless they ask" is gone, and the
  `[after a stop]` note on the next message is gone. A plain **Continue** is an
  ordinary message; it carries no hidden permission test and no warning.
- **The graceful stop cuts at the step boundary, not with a message.** The
  assistant message open at the moment of Stop is allowed to finish; when the next
  assistant message begins, the runner interrupts there. The model sees a turn cut
  at a boundary — the same shape as a dropped connection. The 45-second cap still
  applies.
- **The operator still sees what is happening.** The upper-right notice and the
  fast red glow remain; a second Stop is immediate, in the middle of a token if
  that is where it is.

## Why

Most stops are "I need to change a setting" or "I am leaving", not "do not ever
retry this". Explaining the stop to the model made it hesitate over a plain
"continue", and the hesitation cost a turn. The stop is recorded for the operator
and the UI; the model is told nothing, and the operator's next words are just
words.

## Notes

- Task goes back to `todo`, project held; nothing is woken.
- Full suite: 273 tests.
