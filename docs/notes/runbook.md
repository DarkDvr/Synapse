# Runbook

Restarting the app, protecting the harness's own files, and the housekeeping nobody
should have to remember.

## Is a turn live? — the check before a restart

`/api/runs` lists **delegations**, not the Architect reading, thinking or calling a tool.
On 11 Nov a restart with `runs: 0` killed the operator's own turn mid-sentence: the run
list was empty because it is not a run, and `/api/pending` said `active: []` because
there was no card to show. The turn was still live.

**Use the script, not a hand-written check** (added 12 Nov after a second turn was
killed):

```
bin\node\node.exe scripts\wait-for-idle.mjs          # exits 0 when idle, 1 when not
bin\node\node.exe scripts\wait-for-idle.mjs --timeout 300
```

It asks three questions and needs all three idle, because each earlier check was right
about one thing and blind to another:

1. **the engine's `/api/session/active`** — workers included; the authority, and it
   survives a page reload;
2. **`/api/pending`** — a card, a question, or a stop in progress;
3. **every chat's transcript** — an assistant message with no `completed` is a live turn,
   and **any** such message counts, not only the last: a steer can arrive after it.

## Protecting the harness's own files

The engine's `edit`, `write` and `shell` tools are **not confined to a session's
directory**. A role told to work in its project can write anywhere the operator can, so
three mechanisms exist, because they fail differently:

- **The projects root is a sibling of the harness.** This is the foundation: with
  projects *inside* the harness, "outside the project" and "inside the harness" overlap
  and no path rule can tell them apart.
- **Every tool call is a permission request.** `rulesFor()` makes `edit`, `write`,
  `shell`, `execute` and `read` ask; the gate answers from `decide()`. The project and its
  scratch are allowed, another project is refused, a write inside the harness is refused,
  an outside path asks. The engine still has the last word — the last matching rule wins
  — which is why the broad asks come first and the credential-store denies after them.
- **A watchdog**, because a ruleset cannot see what a shell *command* will do.
  `createHarnessGuard()` in `src/harness.js` has two layers: `checkTurn()` reads the
  transcript Synapse already fetched and reports any write or edit naming a harness path;
  and around each worker run `state()`/`changed()` compare `git status --porcelain`, so
  anything new is reported as *changed during a worker run* however it happened. Both go
  out as a log `ERROR` and an SSE `alarm`.

  Two exclusions, both learned the loud way: a command that only names `skills/` is the
  harness's own toolbox being used, and is not reported (eleven alarms in one run were the
  Architect running `skills\visual-review\shot.mjs`); a command shaped like a write is
  still reported, and so is anything naming the rest of the harness. A change to
  `config\synapse.config.json` is excused when `configSavedAt()` falls inside the run —
  that is the Settings dialog saving.

- **The restore point is HEAD, not a generated commit.** `snapshot()` used to commit
  before every delegation and swept three half-finished edits into a commit named after a
  task (7 Nov), so it no longer commits. Nothing here repairs a file automatically: an
  auto-revert would clobber the operator's work in progress.

**Not doing: a separate Windows user for the engine.** It is the only boundary a shell
cannot talk its way around, but with the projects moved out, the policy live and the
watchdog in place it is overkill on this machine — the operator's call.

## Restarting

A restart is **the app's job**; two exit codes carry it (`docs/notes/desktop-app.md`):
**2** means "restart me" and the shell respawns, **3** means "close the whole app" for a
staged update, **0** stays stopped, anything else is a crash and is **not** retried.

Run by hand (`bin\node\node.exe src\index.js`), the restart button says plainly that
restarting is the app's job.

**A pid file can lie, and then a restart changes nothing.** Measured 22 Oct: a second
copy started while the first held 8700, died on `EADDRINUSE`, and left *its* pid behind.
The symptom is a restart that reports success while the UI behaves like the old build.
The app never stops things by pid file — it holds a handle to the process it started —
but the files are worth checking: `GET /api/status` → `engine.home`, and the pid in
`data\synapse.pid`, should describe the process that is actually listening.

## Where the logs are

`logs\` holds one file per channel — `app`, `engine`, `session`, `tools` — with **error,
warn and info**. That is the readable story of what Synapse did, and the file to open
first: a boot is about fifteen lines, a whole turn one or two.

**`logs\debug.log`** holds every debug line from every channel in one timeline, each line
naming its channel. It is **on by default** (Settings → Logging): the evidence you want
when a tricky bug happens has to exist before the bug does.

The split was measured (6 Nov): one day of `app.log` was 13,480 lines, 9,131 of them
"permission allow"; one day of `session.log` was 36,255 lines, 24,381 reasoning deltas. A
file where the normal case is 95% of the text is a file nobody reads.

Both rotate on their own numbers (5 MB per channel into `.1.log`, 20 MB for debug) and are
cleaned by age (7 and 2 days) every six hours and at boot. To catch a problem: reproduce
it, then open `debug.log`.

The **console** is in the window, served by the shell from `logs\console.log` and a ring
buffer, so it works when the server is stopped (`docs/notes/desktop-app.md`).

## Browsers

There is no browser MCP any more. The harness has its own — SynaBrowse, `src/browser/` —
documented in `docs/notes/browser.md`. To look at the running UI yourself, use
`skills\visual-review` (headless Edge; it measures the layout and writes PNGs to
`.project\shots`), or open Edge at `http://127.0.0.1:8700` by its full path. Brave and
Firefox are the operator's and are never touched.

What still holds, whatever the tool:

- **Look at the result, not only the DOM.** A layout was shipped twice with the role
  cards clipped behind the chat because only the widths I chose to measure were measured.
- **Assert the composition with numbers**, not an opinion: `archCard.bottom <=
  wrap.bottom`, `dock.top >= wrap.bottom`, `wrap.height ≈ topology.scrollHeight`, and
  page `scrollHeight <= innerHeight` in the wide layout.
- **Two widths at least** — the stage changes at 1460px, and a bug there is invisible at
  1600px. Click the thing the operator will click, then re-measure.
- **Show the operator through the chat**: put the picture in the project and write it as
  markdown, `![what it shows](.project/shots/shot.png)`.

## A worker that asks the same question twice

A question is answered once by the operator, and the engine records the answer as the
tool result. If the identical question comes back, the worker is looping, not gathering
information — measured on Shift Test 2, where one question arrived four times with every
answer stored and ignored (`src/question-loop.js`).

| ask | what happens |
|---|---|
| first | shown to the operator |
| second | answered automatically with the operator's own earlier answer, not shown; logged as a warning |
| third | the run is **stopped** and the report says the worker was looping, what it asked and what it was told |

The third is a deliberate show stopper: a model problem the operator wants to see, not to
be asked again. The reason travels into the run result so the Architect does not
re-delegate the task as it is.

## A process a model owns

The shell can start a server, but nothing owns it afterwards. The `process` tool is the
missing half, with three actions:

```
start  — run a command in the project; answer an id (p1), its pid and a log
logs   — the end of that log, from .project/processes/p1.log
stop   — kill the tree of that pid, never a name
```

The registry is `.project/processes.json`, so a project's deletion takes it and the logs
with it. The command is judged by the shell policy before anything runs; at most five are
live at once. It is deliberately not a service manager: no restart, no start-on-boot, no
sweep at the end of a run.

## Cleaning up

Two test runs left static web servers running for hours because a worker needed an http
origin to test localStorage and nothing owned the process. Synapse sweeps them now
(`src/cleanup.js`), with a narrow proved selection:

| when | what | proof it may stop it |
|---|---|---|
| a project's plan reaches all-done | anything still running for that project | the command line names the project folder, **or** a listening port serves a file from it byte for byte |
| at boot | MCP helpers under `src/mcp/` whose parent is gone | our own script path, and a parent that is not running |

A dry run goes into the log first, then the stop. Both halves can be turned off
(`cleanup.onFinish` / `cleanup.onBoot`).

What it will never do: **match a process by name**; stop anything under
`@opencodedesktop` or `ai.opencode.desktop`; stop a runtime it cannot prove is serving
this project (two projects with a `bin/` and an `index.html` have identical listings,
which is why the proof is a byte-for-byte file and not a name — the first version swept a
neighbour's server off the machine); touch the engine's own MCP children.

## Housekeeping: the disk, not the processes

`src/housekeeping.js` runs once at boot, after the page is up, and by hand:
`bin\node\node.exe src\housekeeping.js --dry-run`. Both paths use the same keep list from
`data\projects.json`.

It removes only what it can prove is dead:

| what | when | why it is safe |
|---|---|---|
| an applied update's staging | `data\update\last.json` says `ok`, and it is more than a minute old | the helper starts Synapse *before* it writes that record, which is why the minute matters. A failed update is left alone — its staging is the diagnosis. The newest `data\backups` folder is kept; older ones go |
| old release zips in `dist` | more than one exists | one release is enough; `SHA256SUMS` is rewritten for the one that stayed |
| spent render profiles and build debris in `data\temp` | more than six hours old | each is a throwaway browser profile or a compiler's intermediates, and a live render or build is always in use |

The engine's own snapshot store (`data\engine\opencode\data\opencode\snapshot\global`,
347 MB by 30 Oct) is its undo history. `reclaimSnapshotStore()` empties its **children**
just before every engine start, best-effort; the cost is undo across restarts, which
nothing here uses.

**Deliberately not touched:** a live project's `.project\scratch` (it is work), and the
engine's `snapshot` folder itself.

## The debris rules

The operator's decision: this is automatic. A cleanup task at the end of a plan spends a
worker run on files the harness can name by rule, and the model that made the mess is the
one deciding what the mess is.

- **A finished task's scratch goes** — `.project\scratch\<task>`, where the work was
  built and which nobody reopens (one measured 1.3 GB). A task that **failed or was
  stopped** keeps its folder: the wreckage is evidence.
- **`data\temp` is swept** of anything older than six hours (`sweepTemp`), at boot and
  every half hour. It is not a scratch: a model may not write there.
- **Deleting a project takes its scratch with it** — `.project\scratch` is emptied before
  the folder goes to the Recycle Bin.
- **The records have their own history.** `.project\.git` is a repository the harness
  commits to around every run (`docs/notes/git.md`); it is not debris, and `findScratch`,
  the temp sweep and `synapseFingerprint` all skip `.git`.
- **A stray file in the project root is moved, never deleted.** Only names the harness
  can prove are debris: its own files at the wrong level (`plan.json`, `features.json`,
  `project.md`, `runs.jsonl`), a log, or a proof file. They go to
  `.project\reports\<date>\`, and a second one of the same name gets `-2` rather than
  overwriting a proof.
- **The .NET toolchain keeps its temp inside `data\toolchain\dotnet`** (`DOTNET_CLI_HOME`,
  plus `NUGET_PACKAGES` pointed at `vendor\nuget-packages` when it exists). Unset, a
  worker's `dotnet build` wrote a 258 MB tree wherever HOME pointed.

## Keeping the PC awake

`src/power.js` holds a Windows wake lock while Settings → Automation says so: a PowerShell
child calling `SetThreadExecutionState` every twenty seconds with `ES_SYSTEM_REQUIRED` —
the API PowerToys Awake uses. `keepDisplay` adds `ES_DISPLAY_REQUIRED`.

The lock belongs to the child: if the server dies, the child notices at its next tick and
exits, and Windows drops the request. The child also writes `data\wakelock.txt` each tick.
It is a wake lock, not a power-plan edit: it does not stop a second disk spinning down,
and it does not stop the operator pressing Sleep.

## Before restarting the model server, ask who is using it

A live run was in flight — a coder step with a 132k prompt — when the model server was
restarted to register a new profile (17 Nov). Nothing was lost only because the harness
retried, and the restart was avoidable: the run was visible in three places.

- `GET /api/runs` and `GET /api/pending` — `active` names the sessions working now;
- `logs\app.log` — `run <task> (<role>) started` with no matching `completed`;
- the server's own console — `reading the prompt`, or any line after `ready`.

A profile only has to be registered once, and `switch_on_request` loads a model on demand:
adding a profile is never urgent enough to interrupt a run.
