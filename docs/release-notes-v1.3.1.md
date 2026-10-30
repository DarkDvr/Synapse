# Synapse v1.3.1

Stop is two-stage, and it means the system is idle.

## Changed

- **The first Stop is graceful.** The AI finishes the tool call it is in, writes
  its report, and ends the turn. A notice in the top-right corner says so, and the
  chat is ringed with a fast red glow — “stopping, wait”.
- **The second Stop is immediate.** It cuts the turn at once, in the middle of a
  token if that is where it is. Nothing is finished after that.
- **A Stop wakes nobody.** It used to send a report to the Architect, which was a
  new turn after the operator had asked for quiet. The stop is now recorded, the
  task goes back to `todo`, and the **next** Architect brief carries it: *the last
  run was stopped by the operator at 15:44, after it finished the step it was in;
  do not retry it unless they ask.* The next operator message still carries the
  `[after a stop]` note.
- **No queueing.** A message is a Send or a Steer; nothing is held for later.

## Notes

- The graceful stop waits up to 45 seconds for the report, then cuts the turn.
  A model that ignores the note cannot hold the project.
- A permission card or question still blocks the composer; Stop while a card is
  waiting is immediate, because there is no step to finish.
- Full suite: 273 tests.
