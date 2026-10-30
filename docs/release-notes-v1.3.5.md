# Synapse v1.3.5

A stopped project stays stopped across a restart, and the Architect's red line
clears when it starts working again.

## Fixed

- **Stop survives a restart.** The hold that says "the operator stopped this" was
  in memory, so a restart erased it. On the next boot the lost-report replay could
  find the stopped run's result and tell the Architect to judge it, which started
  the work again — the run that "resurrected itself" in Test3. Boot now:
  - restores the hold from the latest result's `stoppedBy: operator`, unless a
    user message has arrived since;
  - never replays a stopped or interrupted result as a lost report.

  The operator's next message lifts the hold, as it did before.
- **The Architect's red provider line clears when its turn starts.** The card kept
  "Retrying at …" through the turn that proved the retry had worked; the card is
  cleared on `session.execution.started` for the open Architect session, not only
  after a successful wake.

## Notes

- Stop still says nothing to the model, and still wakes nobody.
- Full suite: 274 tests, including a boot check that a stopped result is not
  replayed and the hold is restored.
