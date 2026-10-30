# Synapse v1.3.0

The operator can talk to work while it is happening, and the Architect is told
what happened when a run is stopped.

## Added

- **Steer.** While a project is busy, every view keeps a live composer. The Send
  button becomes **Steer**, with the live path's yellow border, and the message
  joins the running turn at the next step — the worker if a delegation is in
  flight, otherwise the Architect's own turn — instead of being refused. A steer
  is marked `[steer]` in the transcript, so the model reads it as guidance for the
  task in hand and not as a new request. The worker's report quotes every steer,
  and the Architect judges against the instruction that was in force at the end.
- **The composer says where the message goes:** “Message Coder 1 — seen at its
  next step” or “Message the Architect — seen mid-turn”.
- **The chat marks a steer** with the same purple **You** and a yellow
  **STEER:** prefix, so it is visibly the operator speaking mid-run.
- **The run trace shows the steer** while the run is live, under the worker's
  tool calls, so the chat does not look unchanged at the moment the task changed.
- **The plan follows the steer.** The report tells the Architect to put the change
  in the task note and the plan, and to ask the operator a question when a steer
  changes the task materially instead of quietly reshaping the work.

## Fixed

- **A stopped run now tells the Architect.** Stop used to write the result and
  wake nobody: the Architect kept waiting for a report that was already on disk,
  and learned what happened only when the operator next spoke. It now receives the
  same report as any other run, with the project held so the wake cannot restart
  the work, and the report says plainly: *the operator stopped it on purpose — do
  not delegate this task again unless they say so.*
- **The briefs explain the two ways the operator interrupts.** A `[steer]` message
  mid-turn is guidance, not a new task; a turn ending in “Step interrupted” was
  the operator pressing Stop, not a provider failure to retry. The worker is told
  the same for a steer.
- **A message sent after a Stop explains the cut.** It carries a `[after a stop]`
  note the UI hides and the model reads: the operator stopped the previous turn on
  purpose, this is the next instruction. Measured 30 Oct: without it an Architect
  described its stopped essay as “cut off mid-sentence” and did not know the
  operator had done it; with it, “You stopped my previous turn before I had
  written the essay.”

## Measured

- 30 Oct, engine 2.2.3: a delegated coder writing 400 numbered lines was steered
  with “put `STEERED` at the top”; the file came back 401 lines with `STEERED`
  first, and the Architect's verdict said “the steer is satisfied”.
- The same day an Architect mid-essay was steered to answer one sentence instead,
  and did, in the same turn.
- Full suite: 269 tests, including `tests/steer.test.mjs`.

## Notes

- A steer lands at a step boundary: after the tool call in flight, not inside a
  token being generated. A long shell command or a long answer delays it. Stop
  remains the hard interrupt.
- A steer during a permission card or a provider backoff is refused; answer the
  card or wait/stop first.
