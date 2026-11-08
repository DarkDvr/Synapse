# Synapse v1.31.0

The model's context window is measured where it is used, the reasoning in a long
turn reads as ten lines instead of a wall, and the harness can finally copy a shipped
skill's files into a project. A compaction says how full the window was while it
runs, and the docs now say when work is delivered.

## Changed

- **One owner for the context window.** `src/windows.js` decides and remembers it:
  what a local server has loaded beats your override, which beats the provider
  entry, which beats the engine catalog. The four copies that used to disagree are
  gone. A model you pick is measured at the pick moment, at boot, once more when the
  page is up, and once a minute after that — so a model reloaded in LM Studio shows
  its real window without anyone re-picking it. Measured on a 128k local model that
  the card had been showing as 60k: 60160 → 128000, one second after the restart.

- **A skill can copy its assets into a project.** `Copy-Item` from `skills/` was
  refused as a change to the harness, so a coder had to read every file of the
  Windows-app scaffold and write it again. A copy whose sources are all under
  `skills/` and whose destination is outside Synapse is now a read. A move, a source
  that climbs out of `skills/`, a destination inside Synapse, and a second statement
  that deletes a skill are all still refused.

- **A long turn's reasoning folds.** The newest ten blocks keep their own folds;
  everything older is one "N earlier reasoning" fold. Each fold carries its first
  sentence, clipped to a line — "Reasoning · The menu is drawn by MainWindow."
  instead of ten identical "Reasoning" lines.

- **A compaction says how full the window was while it runs.** "⏳ Compacting ×3 ·
  context at 47K/205K" instead of only the count, which used to arrive only after the
  summary was written.

- **A reasoning panel keeps its place across a rebuild.** The slide is a transform on
  a node the transcript replaces, so every rebuild snapped the text back to its
  first line — that was the sudden scroll at the moment a step ended.

## Fixed

- The docs budget counted a trailing newline as a line, so a 300-line `AGENTS.md`
  read as 301 and the ceiling meant 299.
- The `web/` block in `AGENTS.md` said `app.js` was all the UI; it is the spine now.

## Notes

- `AGENTS.md` has a versioning rule with a trigger: finished work is bumped, tagged,
  pushed and released, not left local. A past session's constraint is history, not a
  rule — `docs/refactor-plan.md` said "no push until the operator says so", which was
  true in early November and is now marked as history.
