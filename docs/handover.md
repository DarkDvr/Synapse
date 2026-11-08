# Handover — 7 November 2026

Where the build stands tonight, what is unfinished, and the few things that cost
time and are not already in `AGENTS.md` or `docs/notes/`. Those hold the rules;
this holds the state.

## The build

- **Synapse 1.31.0**, released 8 Nov: tag `v1.31.0`, zip and `SHA256SUMS` on the
  GitHub release. What changed and why is `docs/release-notes-v1.31.0.md`.
- **568 tests: 567 pass, 1 skipped.** The skip is
  `tests/engine-contract.test.mjs` — it talks to the installed engine and only runs
  with `SYNAPSE_E2E=1`.
- **`web/app.js` is a spine again, not the whole page** — about 2,300 lines of boot,
  event stream and wiring; everything else is a module under `web/`.
  `scripts/check-imports.mjs` is what keeps the imports honest: run it after any
  move, and it will name the module and the name.
- Running from `Synapse.exe` at the root; the server is
  `bin\node\node.exe src\index.js` on 8700, the engine on 8720 (2.2.6).

## Changed tonight

One line each; the release notes have the detail.

- Attachments are one chip everywhere, and a steer to a worker can carry one.
- The streamed slide tracks a fast model instead of jumping a line at a time.
- A provider's own `limit: { context, output }` is read, and the config outranks
  the engine's catalog for both numbers.
- The finished-work chime means "finished" and nothing else.

## The operator's config is not in git any more

`config/synapse.config.json` is ignored now. It is created from
`config.default.json` on first launch and it is one machine's answers — providers,
roles, measured windows. A clone starts from the seed.

## Open work

1. **SysMoninor is mid-build.** t1 (design) is done; t2 (the widget shell) finished
   twice and was never judged — the operator stopped the run. `bin\app\dist\SysMonitor.exe`
   builds and starts, and the plan still says t2 is todo. The t5 designer run was
   stopped by the operator on 8 Nov; the project is quiet, nothing is queued.
2. **Known issues: nothing open.**

## Done since this handover

- **The cleanup ran** (8 Nov). The four plans and the audit, 39 old release notes,
  the `stage-*.pdf` mockups, the root `.synapse` (old smoke scripts and two copies
  of `app.js`), the old updater backups, `data\shots`, the travel-copy scripts and
  their test all moved to `staged for deletion\`, with `MANIFEST.md` saying what
  each one was and why it went. `data\backups`, `.github\workflows`,
  `make-release.ps1` and `update-apply.*` stayed, for reasons in the manifest.
- **A copy out of `skills/` is allowed** (8 Nov). The fence treats a copy whose
  sources are under `skills/` and whose destination is outside Synapse as a read,
  so a coder can take the Windows-app scaffold instead of reading every file and
  writing it again. A move, a source that climbs out of `skills/`, a destination
  inside Synapse and a second statement that deletes the skill are all still
  refused. The rule is in `docs/notes/protection.md`; the tests are in
  `tests/permissions.test.mjs`.

## Things that cost time and are not in the notes

- **The engine's catalog can be older than the provider.** Measured tonight:
  oc-go's `deepseek-v4.1-flash` is 1M in / 384K out at the provider and 200K / 32K
  in the shipped binary. `POST /api/providers/models` is how to ask; the answer is
  written to the config, and the config is what the corner and the budget read.
- **A refused tool call ends the turn.** The engine reports
  `session.execution.interrupted` and the worker stops; the runner has to wake it
  again. A wrong permission rule costs minutes of work, not just one card.
