# Synapse v1.13.0

A question no longer covers the answer it is about, and the Architect's reasoning
streams in the same panel the workers get.

## Changed

- **The question is now the chat's last post**, not a panel painted over the chat. The
  overlay was bright and unmissable, and it hid the reply the question was asking
  about — the operator had to answer without seeing what had been said. As a post it
  sits at the bottom in the chat's own colours with an orange border, and the reply is
  one scroll up.

  The node is **moved**, never rebuilt: the transcript's markup is replaced on every
  change, so a panel living inside it would lose its radios, its page and its focus to
  the first poll. `mountAskPost()` appends the same element after each render, which
  keeps the polling rule (an unchanged form is never rebuilt) working.

  The panel is **sized to the chat**, not to its content: measured on the first live
  question it was 319px inside a 294px chat, which put **Submit Answer below the
  fold**. `fitAskPanel()` caps it at the transcript's height; the fields scroll inside
  and the action row stays at its bottom edge.

  **A pending question takes the whole composer**: the text box says "Answer the
  question to continue", and Send, Attach, the mode switch and the run menu are off.
  Stop stays live — it is the way out of a question nobody can answer. A new question
  also arms the chat's follow and scrolls to it.

## Fixed

- **The Architect's reasoning streamed nowhere.** Its panel sat empty for a whole step
  and then showed the entire wall at once. The cause was one line: `appendStream()`
  found its trace with `traceOf(currentRun())`, and the Architect's own turn has no
  run, so every `session.reasoning.delta` was dropped. Workers looked fine because a
  delegation *is* a run.

  `liveTrace()` now answers "whose writing is this" — the run's trace if one is live,
  otherwise the open session's own — and the same `.trace-flow` panel is drawn and fed
  by the same pump. Measured during a long reasoning turn: the panel held 76
  characters at the first sample and 424 at the second, in one DOM node. The panel
  disappears when the step's own message carries the same words, and the session's
  stream is cleared on `session.execution.ended`, so a new turn never inherits the
  last one's text.

Full suite: 358 tests.
