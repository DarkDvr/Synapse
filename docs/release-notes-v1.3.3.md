# Synapse v1.3.3

The Steer button now appears when a coder starts, not only after its first tool
call.

## Fixed

- **The worker session is broadcast as soon as it exists.** `run.started` is sent
  before the worker session is created, so its `workerId` is null. The first
  `run.progress` that carried the id was only sent on a tool change or a context
  update — a model that was thinking or writing showed nothing, the page never
  learned a worker existed, and Send stayed disabled instead of becoming Steer.
  The runner now sends a progress event immediately after `spawnWorker()`.
- **The composer follows the run, not the worker id.** The Steer target is the
  live run itself (the server holds the worker session); a page that has the run
  but not its `workerId` still offers Steer. The server refuses only while the
  worker is still starting.
- **Run events repaint the composer.** `run.started`, `run.progress` and
  `run.finished` now re-render the Send/Steer face, so the button changes on the
  run boundary rather than waiting for the next busy poll.

## Notes

- If a page was open before this version, reload it once; the old page has the old
  composer code.
- Full suite: 273 tests, including the regression that the worker id is broadcast
  in a `run.progress` event.
