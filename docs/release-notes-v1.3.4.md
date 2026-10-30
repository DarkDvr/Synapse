# Synapse v1.3.4

A steer is now visible as a steer, and it survives a stopped run.

## Fixed

- **A worker steer shows in the chat with a yellow `STEER:` marker.** It was a
  plain grey `Operator: …` line in the run trace, which read like another tool
  note. It is now a distinct line — yellow marker, warmer text — on the worker's
  own run trace, which is where a steer to a coder belongs: the coder has its own
  session, so it is never a “You” message in the Architect's transcript.
- **The line survives a reload.** `/api/runs` carries the steer list, so a page
  opened or refreshed mid-run rebuilds the `STEER:` lines instead of losing them.

## The Architect and a steer

While a coder runs, the Architect is not woken — that was the decision for Stop
and it is the same for a steer. It reads the steer in the worker's **report** when
the run ends and is told to put it in the task note and the plan.

If the run is **stopped before that report**, the steer used to disappear with it.
The result line kept it, and now the next Architect brief carries it:

> The operator's steer to the last run still stands: “Use the US, not Canada.”
> Put it in the task note and the plan.

No wake, no extra turn; it is there the next time the Architect runs.

## Notes

- Full suite: 274 tests.
- A stopped run still says nothing to the model about the stop itself.
