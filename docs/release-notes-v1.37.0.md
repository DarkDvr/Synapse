# Synapse v1.37.0

This is the roll-up of everything since **v1.36.0** (10 November): fourteen patches and
one minor. The app behaves the same way it did; what changed is how honestly it
behaves, and how much of its own noise it produces.

## The plan and the harness

- **The harness writes `doing`.** A worker starting a task sets the row to `doing`, and
  the harness releases it to `todo` when the run ends, whatever the outcome. The
  Architect keeps the judgement (`todo`/`done`/`blocked`/`failed`); the harness keeps
  the mechanics. No more "1 running" on a stopped project.
- **A done row owes a result.** `done` with no `result` is a plan problem, and the
  brief has a size ceiling (15,500 characters for the Architect), so a new rule has to
  be paid for by removing another.
- **Evidence has one home.** A task that produces a proof, a log or a capture names
  `.synapse/reports/`; `bin/` is for what the project ships. The folder is shared by
  every role, and the stray-write check no longer blames a worker for writing exactly
  where its brief told it to.
- **A row whose role is the Architect is its own work.** Delegating it used to spawn a
  second Architect — the page drew a delegation from the card back into its own edge.
  It is refused now, journalled, and handed back: *do it here with your own tools.*

## The rules about processes and Windows

- **A pid read from a file may be stopped** — `Stop-Process -Id $p`, `taskkill /PID $pid`
  — even when the same command also reads the process list. A sweep, a family name, a
  wildcard or an id the command discovered is still refused.
- **A program a launcher names is a run, not a write.** `Start-Process …\powershell.exe`
  is allowed; it used to be refused as a write into Windows.
- **Elevation is refused as itself.** `-Verb RunAs` asks Windows for administrator
  rights, and an unattended run cannot answer the UAC prompt. The refusal now says that
  instead of "Windows is on the protected list".
- **Kills reached by another route are still kills**: `.Kill()`, WMI, `wmic`, `taskkill
  /FI`, `?` and `[]` wildcards, nested shells and a `.ps1` that sweeps.

## The page

- **One warning is one line.** The alarm line ends in "…" and never wraps; its detail
  is in the tooltip and the log.
- **A turn is never invisible.** The Architect's post opens when its turn starts and
  says `Thinking…` until reasoning or a tool arrives.
- **A steer's "You" sits on the sentence's centre line**, beside the `STEER:` tag.
- **A shipped render started from a `file:///` URL** no longer raises a second
  "named Synapse" alarm for the toolbox being used correctly.
- **The report hands the judgement back in its own paragraph**: the facts, then
  *"You are the only writer of the plan…"*.

## Housekeeping

- **The suite cleans up after itself.** Every fixture folder goes through `tmpdir()` and
  is emptied on process exit: a full run adds **0** folders, where it used to leave
  about 145. (15,638 folders and 61 MB had accumulated before this.)
- **The tool census has a test** for the restart it used to double-count.
- **Two coders, not three**: the removed role is gone from the defaults, the code and
  the tests, and a saved config that still names it is dropped on load.
- **The notes tell the truth about the build**: `ui-lessons.md` ends with the layout as
  measured (two columns, the 360 rail, six cards, eleven Settings tabs), `engine-notes`
  describes the census and the refusal list as they are, and the README no longer lists
  a session per project.

## Upgrading

Extract over the existing folder; `config\`, `data\`, `logs\` and the projects folder
are not in the zip and cannot be overwritten. The version in the rail is the build that
is answering — check it before blaming a rule.

Suite: **635 tests, 634 pass, 1 skipped by design** (the live-engine contract test).
