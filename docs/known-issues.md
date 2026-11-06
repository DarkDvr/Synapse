# Known issues

Bugs found while doing something else. Each one says where it is, how it shows, and
what it would take. They are not fixed on the way past: a bug fixed inside an
unrelated change has two causes and one commit.

Newest first. When one is fixed, delete it here and say so in the commit.

---

## The page knows two engine provider ids by name

`ENGINE_PROVIDERS` in `web/app.js` hardcodes `opencode` and `opencode-go`, with the
badge and the note each one shows ("OC Zen", "OC Go"). That is engine-specific
knowledge in the page, and the pillar says the OpenCode adapter is the only place
that should have it: a second engine, or a renamed provider, leaves the page
labelling the wrong thing — or nothing.

Where: `web/app.js`, `ENGINE_PROVIDERS` and `providerLabel`.
Fix: the server knows its providers (`/api/providers`), so the label and the note
could come from there. Not urgent while there is one engine.

## A stopped run can still be reported as completed if the cut lands before its first token

Seen 6 Nov while testing Stop: a run cut at the very first step of a worker that had
not produced a token yet ends with `outcome: stopped`, but the report's body is the
generic "ended with reasoning only" sentence, which reads like a failure. It is not
wrong, it is just confusing next to "stopped by the operator".

Where: `src/runs.js`, the `if (!stopReason && !text && !files.length)` branch.
Fix: when `gracefulStop` is set, say the turn was cut before it produced anything.

## The engine home never shrinks below its snapshots

`data/engine/opencode` is 574 MB after three weeks. `src/housekeeping.js` reclaims
snapshots at boot, but only the ones it knows about; the engine keeps its own
storage. Worth a look at what the 574 MB actually is before deleting anything.

Where: `src/housekeeping.js`, `data/engine/opencode`.
Fix: measure first — a listing by subfolder, then a retention rule.

## The Updates page still calls the engine "Runtime" in one place

The page says "Runtime" everywhere, but the engine update dialog's title says
"Engine update". Two names for one thing in the same panel.

Where: `web/app.js`, the update card.
Fix: one word, decided by the operator.

## `data/chaos-test-plan.md` is the only copy of a record

It is the pass record of the chaos run, it is 23 KB of good evidence, and it lives
in `data/`, which is gitignored and regenerable by definition. A clean install loses
it.

Where: `data/chaos-test-plan.md`.
Fix: move it to `docs/` (it is a record, like the release notes) or delete it and
accept the loss.
