# Synapse v1.0.1

A correctness patch: what the record says when a run is stopped, and what happens
to a report whose delivery was interrupted. No behaviour change to the plan, the
models or the permission policy.

## Fixed

- **A Stop is no longer recorded as the previous provider failure.** A run that
  the operator stopped now writes `outcome: "stopped"`, `stoppedBy: "operator"`
  and `lastTurnError` (what the last finished turn had said) instead of leaving
  the earlier `Free usage limit reached…` sentence in `error`. The Architect's
  report says who stopped the run, and quotes the earlier sentence only as
  "before the stop, the last turn had ended with…". This is what made a free
  model's cap look like the cause of a run that the operator had stopped five
  minutes after the cap cleared.
- **A report whose wake never landed is delivered at the next boot.** The result
  line is written before the Architect is woken; a restart between the two left a
  finished run that nobody was told about (plan `todo`, no message, the page on
  "Waiting on you"). Boot now replays that report once, writes a `wake` marker,
  and leaves already-delivered reports alone.
- **The running version is visible.** `package.json` is the single source;
  `/api/status` carries it, the boot line says `Synapse 1.0.1 starting`, and the
  status rail shows it. The exe's file properties mirror it.

## Verified

- The coder ladder, end to end: a refused model walks coder-1 → coder-2 →
  coder-3 inside one delegation; a re-delegation starts one rung down; an
  operator Stop stays on the same coder. `tests/ladder.test.mjs` drives the real
  runner with a stubbed engine. A usage cap is still retried in place for its
  ten-minute grace, because it can clear — and then the next rung takes over.
- Full suite: 247 tests.

## Notes

- Versioning is `major.minor.patch` from now on: a fix is a patch, a feature is
  minor, a break is major. The checklist is in `docs/notes/releases.md`.
- The travel copy's README and zip are stamped from `package.json`, so this
  folder and a released copy cannot disagree about the version.
