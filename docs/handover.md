# Handover — 7 November 2026

Where the build stands tonight, what is unfinished, and the few things that cost
time and are not already in `AGENTS.md` or `docs/notes/`. Those hold the rules;
this holds the state.

## The build

- **Synapse 1.30.0**, released tonight: tag `v1.30.0`, zip and `SHA256SUMS` on the
  GitHub release. What changed and why is `docs/release-notes-v1.30.0.md`.
- **551 tests: 550 pass, 1 skipped.** The skip is
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

1. **A copy out of `skills/` is still refused.** The carve-out is written up in
   `docs/notes/todo.md`. It changes the fence, so it waits for a quiet run and for
   the permission tests — not for a moment in the middle of one.
2. **The debris cleanup has not happened.** The operator wants an inventory first,
   then a decision per file: archive, recycle, or delete. Candidates:
   `docs/refactor-plan.md`, `docs/pipeline-plan.md`, `docs/chaos-test-plan.md`,
   `docs/audit-2026-11-06.md`, the `stage-*.pdf` mockups, and the old projects and
   `_scratch` folders under `..\Synapse.Projects`. Already gone: the empty
   `templates/` folder and the 1.29.2 release zip.
3. **SysMoninor is mid-build.** t1 (design) is done; t2 (the widget shell) finished
   twice and was never judged — the operator stopped the run. `bin\app\dist\SysMonitor.exe`
   builds and starts, and the plan still says t2 is todo.
4. **Known issues: nothing open.**

## Things that cost time and are not in the notes

- **The engine's catalog can be older than the provider.** Measured tonight:
  oc-go's `deepseek-v4.1-flash` is 1M in / 384K out at the provider and 200K / 32K
  in the shipped binary. `POST /api/providers/models` is how to ask; the answer is
  written to the config, and the config is what the corner and the budget read.
- **A refused tool call ends the turn.** The engine reports
  `session.execution.interrupted` and the worker stops; the runner has to wake it
  again. A wrong permission rule costs minutes of work, not just one card.
