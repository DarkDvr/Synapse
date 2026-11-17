# Runbook

Restarting the app, protecting the harness's own files, and how to look at the UI
without breaking anything else. Split out of `AGENTS.md`.

### Is a turn live? — the check before a restart

`/api/runs` lists **delegations**, not the Architect reading, thinking or calling a tool.
On 11 Nov a restart was done with `runs: 0` and killed the operator's own turn mid-sentence:
the run list was empty because it is not a run, and `/api/pending` said `active: []` because
there was no card to show. The turn was still live.

**Use the script, not a hand-written check** (added 12 Nov after a second turn was killed):

```
bin\node\node.exe scripts\wait-for-idle.mjs          # exits 0 when idle, 1 when not
bin\node\node.exe scripts\wait-for-idle.mjs --timeout 300
```

It asks three questions and needs all three to say idle, because each of the previous
checks was right about one thing and blind to another:

1. **the engine's own `/api/session/active`** — workers included; this is the authority, and
   it survives a page reload;
2. **`/api/pending`** — a card waiting for the operator, a question, or a stop in progress;
3. **every chat's transcript** — an assistant message with no `completed` is a live turn, and
   **any** such message counts, not only the last one: a steer can arrive after it, and the
   last message is then the operator's.

The hand-written version I used twice asked only the last of those, and once read
`active: []` from a poll taken between two steps. It was wrong, and a turn paid for it.

## Protecting the harness's own files

The engine's `edit`, `write` and `shell` tools are **not confined to a session's
directory**. A role told to work in its project folder can write anywhere the
operator can, and sooner or later a model will decide the harness itself needs
"fixing". Three mechanisms, because they fail differently:

- **The projects root is a sibling of the harness** (`..\Synapse.Projects`, resolved
  from the harness root, so the drive letter is nobody's business). This is the
  foundation: with projects *inside* the harness, "outside the project" and "inside
  the harness" overlap and no path rule can tell them apart.
- **Every tool call is a permission request** — `rulesFor()` in `src/permissions.js`
  makes `edit`, `write`, `shell`, `execute` and `read` ask; `src/permission-gate.js`
  answers from `decide()`. The project and its scratch folder are allowed, another
  project is refused, a write inside the harness is refused, and an outside path
  asks. The engine still has the last word — the last matching rule wins — which is
  why the broad asks come first and the credential-store denies after them.
- **A watchdog**, because a ruleset cannot see what a shell *command* will do —
  `pwsh -c "Set-Content …"` is a string, not a path. `createHarnessGuard()` in
  `src/harness.js` has two layers, both cheap: `checkTurn()` reads the transcript
  Synapse has already fetched and reports any write or edit that names a harness
  path (attributed, and no extra engine calls, so it cannot slow a turn down); and
  around each worker run `state()`/`changed()` compare `git status --porcelain`, so
  anything the repository shows afterwards that it did not show before is reported
  as *changed during a worker run* however it happened. Both go out as a log `ERROR`
  and an SSE `alarm`, which the UI shows as a toast and the error dialog with the
  paths.

  Two exclusions, both learned the loud way. A **shell command** that only names
  `skills/` is the harness's own toolbox being used and is not reported at all —
  eleven alarms in one run were the Architect running
  `skills\visual-review\shot.mjs` before judging a report, which is the feature
  working as designed. Anything naming the rest of the harness is still reported,
  and so is a command shaped like a write even when it names `skills/` (a redirect
  with a real target, `Set-Content`, `rm`, `mv`, …). And a change to
  `config\synapse.config.json` is excused when `configSavedAt()` falls inside the
  run: that is the Settings dialog saving, which tripped the alarm once at 12:03.
- **The restore point is HEAD, not a generated commit.** `snapshot()` used to run
  `git add -u` and commit before every delegation; on 7 Nov that swept three
  half-finished edits into a commit named after a task, so it no longer commits. It
  checks the tree and says when HEAD cannot be the restore point because the tree is
  dirty. Nothing here repairs a file automatically: an auto-revert would clobber the
  operator's own work in progress, which is worse than the failure it prevents.

**Not doing: a separate Windows user for the engine.** It is the only boundary a
shell cannot talk its way around, but with the projects moved out, the policy live
and the watchdog in place it is overkill on this machine — the operator's call.

---

## Restarting from inside the app

Settings > Save Changes offers **Restart Now** — but only when the saved values
include something the engine or the server reads at start. Everything else
(roles, worker timers, logging, the provider key) applies the moment Save returns,
and the dialog would be noise.

## Where the logs are, and what to open first

`logs\` holds one file per channel — `app`, `engine`, `session`, `tools` — with
**error, warn and info** in them. That is the readable story of what Synapse did,
and it is the file to open first: a boot is about fifteen lines, a whole turn is
one or two.

The chatter lives apart. **`logs\debug.log`** holds every debug line from every
channel in one timeline, each line naming its channel, because debugging a run
means following one thing across the harness and the engine at once. It is **on by
default** (Settings → Logging → *Also enable Debug log*): the evidence you want
when a tricky bug happens has to exist before the bug does. Untick it and the file
is neither written nor created.

The split is deliberate and it was measured (6 Nov): one day of `app.log` was
13,480 lines, 9,131 of them "permission allow", and one day of `session.log` was
36,255 lines, 24,381 of them reasoning deltas. A file where the normal case is 95%
of the text is a file nobody reads, and the failure that matters is the line you
have to find.

Both files rotate on their own numbers, both set in Settings → Logging: a channel
file at `logging.maxFileMb` (5 MB) into `.1.log`, and `debug.log` at
`logging.debug.maxFileMb` (20 MB) into its own `.1.log`. Cleanup deletes a channel
file older than `logging.retentionDays` (7 by default) and a debug file older than
`logging.debug.retentionDays` (2 by default), every six hours and at boot.

To catch a problem: reproduce it, then open `debug.log`. The channel files keep the
story; the deep file keeps the detail.

A restart is **the app's job**: the window, the tray icon and the page all survive,
because none of them was ever part of the server.

Under `Synapse.exe` the server stops its engine, removes its pid file and exits
**with code 2**; the app reads that as "start a new one" and reopens the page when
the new server says `UI ready at`. That is the whole contract, and it is why there
is no script to run:

| exit | means | the app |
|---|---|---|
| 2 | restart me | starts a new server and reopens the page |
| 0 | stopped on purpose | stays stopped until Start Server |
| anything else | it died | shows the last useful line and the console, and does **not** retry |

Run by hand (`bin\node\node.exe src\index.js`) the restart button says so plainly:
restarting is the app's job.

**A pid file can lie, and then a restart changes nothing.** Measured on 22 Oct: a
second copy was started while the first still held 8700, it died on `EADDRINUSE`,
and it left *its* pid in `data\synapse.pid`. The symptom is a restart that reports
success while the UI still behaves like the old build. The app never stops things
by pid file — it holds a handle to the process it started — but the files are still
worth checking: `GET /api/status` → `engine.home`, and the pid in
`data\synapse.pid`, should describe the process that is actually listening.

---

## Browsers

There is no browser MCP any more. The harness has its own browser — SynaBrowse,
`src/browser/`, driven by `open`, `read`, `click`, `type`, `screenshot` — and it
is documented in `docs/notes/browser.md`. It is for *models*: it is hidden, it
keeps its own profile, and its screenshots land in the project's `.project\browser\`.

To look at the running UI yourself, use the renderer in `skills\visual-review`
(it drives headless Edge, measures the layout and writes PNGs to
`.project\shots`), or open Edge at `http://127.0.0.1:8700` by its full path. Brave
and Firefox are the operator's and are never touched.

What still holds, whatever the tool:

- **Look at the result, not only the DOM.** Reading code is not testing: a layout
  was shipped twice with the role cards clipped behind the chat because only the
  widths I chose to measure were measured.
- **Assert the composition with numbers**, not an opinion: `archCard.bottom <=
  wrap.bottom`, `dock.top >= wrap.bottom`, `wrap.height ≈ topology.scrollHeight`,
  and page `scrollHeight <= innerHeight` in the wide layout.
- **Two widths at least** — the stage changes at 1460px, and a bug there is
  invisible at 1600px. Click the thing the operator will click, then re-measure.
- **Show the operator through the chat**: put the picture in the project and write
  it as markdown, `![what it shows](.project/shots/shot.png)`. A screenshot that
  stays in your own context is not shown to anyone.

---

## Moving to another PC

Synapse is self-contained except for the .NET 10 Desktop Runtime (below). Node and
the engine travel with the folder.

```
.\vendor-engine.ps1        # copies the engine from the npm global install into bin\opencode
```

`bin\opencode\opencode.exe` (about 210 MB, `bin/` is not in git) is what the app
runs when it is present — it is checked *before* any global install, so a machine
with no npm and no `@opencode/cli` still works. With the copies in place the folder
is the app: copy `F:\dev\Synapse` to the new machine, double-click `Synapse.exe`,
and it starts. A copy writes only inside its own folder and the projects root
beside it, and its engine home (`data\engine\opencode`) is created fresh on first
boot.

- **The one thing it does not install for itself is the .NET 10 Desktop Runtime.**
  The exe is framework-dependent, so a PC without it says so in a Windows dialog
  before Synapse runs a line. Everything else — Node, the engine, npm — is inside
  `bin\`.
- **A copied folder's config still names the machine it came from**, so paths whose
  drive is absent are cleared at boot and the copy that travels is used; a project
  whose folder is gone is dropped from the registry, silently. That is section 6 of
  `desktop-app.md`, and `tests/portable-paths.test.mjs` guards it.
- Node travels too: `vendor-node.ps1` puts it in `bin\node`, and the app prefers it
  over anything on `PATH`.
- Keep the licence. It is MIT, so the copy must carry the notice:
  `vendor-engine.ps1` writes `bin\opencode\LICENSE` from the project.
- `VERSION.txt` beside it records what the copy is and where it came from.
- To use the machine's own install instead, delete `bin\opencode` — auto-detect
  falls back to the npm path.
- **Settings > Check for Updates** still works on a vendored copy: it
  installs the newest from npm and copies it over this one, keeping the previous
  binary as `opencode.exe.bak`.
- The model catalog lives inside that binary, so a stale model list means a stale
  copy — not a stale cache.

---

## npm, and what happens without it

Synapse uses npm for exactly one thing: **updating the engine**. The app itself
is plain Node, and the engine travels in `bin\opencode`, so a machine with no
toolchain can still run projects.

Which npm matters. The app installs nothing machine-wide (AGENTS.md rule 3), so it
prefers the copy beside its own `node.exe` in `bin\node`, and fetches the missing
`node_modules\npm` into that folder when it is not usable. Because that npm's global
prefix *is* `bin\node`, `npm install -g` lands inside the folder — the update is
local by construction. See `docs/notes/desktop-app.md`.

At boot (`src/npm-check.js`):

| situation | what happens |
|---|---|
| ours in `bin\node` is usable | nothing is printed |
| only this machine's npm on PATH | used for this session, and one line says so |
| none, and `bin\node\node.exe` exists | fetched into `bin\node` in the background, silently |
| the fetch fails | one warning; the app runs, engine updates wait |

The fetch is the one download that happens without a click, and it is bounded: a
failure is recorded in `data\npm-attempt.json` and not retried for six hours, so a
machine with no network does not spend every launch on it. There is no prompt — the
app starts the server hidden, so a question would sit unanswered forever.

**Updates use the same npm**: Settings > Check for Updates stops the
engine, installs `@opencode/cli@latest`, copies the new binary over
`bin\opencode\opencode.exe` (keeping `opencode.exe.bak`) and restarts. The copy is
what makes the update visible — without it the app would keep starting the old file.

---

## A worker that asks the same question twice

A question is answered once by the operator, and the engine records the answer as
the tool result. If the identical question comes back, the worker is looping, not
gathering information — measured on Shift Test 2, where one question arrived four
times with every answer stored and ignored (`src/question-loop.js`).

| ask | what happens |
|---|---|
| first | shown to the operator, as usual |
| second | answered automatically with the operator's own earlier answer, not shown; logged as a warning |
| third | the run is **stopped**, `runs.stopWithReason()`, and the report says the worker was looping, what it asked, and what it was told |

The third is a deliberate show stopper: it is a model problem the operator wants
to see, not to be asked again. The reason travels into the run result, so the
Architect is told not to re-delegate the task as it is.

## A process a model owns (15 Nov)

The shell can start a server, but nothing owns it afterwards: that is why the
cleanup code exists and why the brief says "stop what you started by its id". The
`process` tool is the missing half. One tool, three actions:

```
start  — run a command in the project; answer an id (p1), its pid and a log
logs   — the end of that process's log, from .project/processes/p1.log
stop   — kill the tree of that pid, never a name
```

The registry is `.project/processes.json` inside the project, so a project's
deletion takes it and the logs with it. The command is judged by the same shell
policy as any other before anything runs: a command that reaches outside, or is
protected, is refused with the reason instead of starting. At most five are live
at once; a sixth is refused until one is stopped.

It is deliberately not a service manager: no restart, no start-on-boot, and no
automatic sweep at the end of a run. The existing cleanup still handles what a
worker forgets when the plan finishes; the registry and the logs are ordinary
project evidence, not debris.

## There is no 'cleaning up' to remember any more

Two test runs left static web servers running for hours — ` python -m http.server
8765 ` from Timer Test 1 and ` qc-serve.js ` on 8321 from Shift Test 6 — because a
worker needed an http origin to test localStorage and nothing owned the process when
the run ended. Both were found by hand, by making the port speak.

Synapse sweeps them now, in two places, with a narrow proved selection
(`src/cleanup.js`):

| when | what | proof it may stop it |
|---|---|---|
| a project's plan reaches all-done | anything still running for that project | the command line names the project folder, **or** a listening port serves a file from it byte for byte |
| at boot | MCP helpers under `src/mcp/` whose parent is gone | our own script path, and a parent that is not running |

A dry run happens first in the log — `cleanup: 2 process(es) still running …, pid 1 (…), pid 2 (…) ` — and only then are they stopped, followed by `cleanup: stopped 2 (…) `. Both halves can be turned off in the config file under `cleanup.onFinish` / `cleanup.onBoot`.

What it will never do:

- **match a process by name.** `opencode` is also the operator's editor;
- stop anything under `@opencodedesktop` or `ai.opencode.desktop`;
- stop a runtime it cannot prove is serving this project. **Two projects with a
  `bin/` and an `index.html` have identical directory listings**, which is why
  the proof is a file served byte for byte and not a name in a listing — the first
  version swept a neighbour's server off the machine in testing;
- touch the engine's own MCP children: they belong to a live engine and die with it.

If a server you *wanted* is gone, the log says which pid went and why. Start it
again — nothing on disk was touched.

## Housekeeping: the disk, not the processes

`src/housekeeping.js` runs once at boot, after the page is up, and by hand:

```
bin\node\node.exe src\housekeeping.js --dry-run
```

Both paths use the same keep list, read from `data\projects.json`: where each project's
scratch is now, and the shared-root name it had before a private project moved inside.
The hand run omitted it until 17 Nov, so it would have treated a project's working set as
debris. A folder another process holds is skipped and named in the log; it used to throw,
and because the sweep runs in name order, one locked engine temp folder near the top
(`bobe1t4p`, EPERM on every boot) aborted every pass before it reached the rest.

It removes only what it can prove is dead:

| what | when | why it is safe |
|---|---|---|
| an applied update's staging: the zip, the extracted tree, the helper copies | `data\update\last.json` says `ok`, and it is more than a minute old | the update has copied the files out and Synapse is running; the helper starts Synapse *before* it writes that record, which is why the minute matters. A failed update is left alone — its staging is the diagnosis. The newest `data\backups` folder is kept; older ones go. "Newest" is its timestamp, and a tie — two folders written in the same breath — is settled by the version and the clock in the name, never by whichever one the directory listed first. |
| old release zips in `dist` | more than one exists | one release is enough; the code is in git and the asset is on GitHub. `SHA256SUMS` is rewritten for the one that stayed. `make-release.ps1` does the same when it builds. |
| spent render profiles in `..\Synapse.Projects\_scratch` | a `visual-review-*` folder is more than a day old | each is Chrome's throwaway profile for one render (~12 MB), not work. The renderer deletes its own, but Windows often keeps a file locked, so they pile up. |
| a scratch folder whose project is gone (`<project>-<hash>`) | no registered project claims the name, it is a week old, and it matches the harness's own naming shape | deleting a project in Synapse removes its scratch with it, so this only catches folders whose project folder was moved or removed outside Synapse. One project's scratch alone reached 12 GB (4 Nov). The rest of `_scratch` is the engine's temp and is not pruned by name. |

The engine's own store is not in this pass, because it must be deleted while the
engine is down:

- **`data\engine\opencode\data\opencode\snapshot\global`** (347 MB by 30 Oct) is
  the engine's undo history — its copy of every file a model has edited. Synapse
  never uses the engine's revert, so `reclaimSnapshotStore()` empties `global`'s
  children **just before every engine start**, in the OpenCode adapter
  (`src/engines/opencode.js`). The `global` folder itself stays so the engine finds
  the shape it expects; chats, the database and the project files are untouched.
  The cost is the engine's undo across restarts, which nothing here depends on. It
  is best-effort: a failed reclaim never blocks a start.

The first run of this freed 3.03 GB by hand (30 Oct): 16 release zips, the
staging of two updates, a pre-migration `webview2` profile, five build/test
folders and my own probe screenshots.

**Deliberately not touched:**

- **A live project's scratch** (`..\Synapse.Projects\_scratch\<project>-<hash>`) —
  where a model may leave work it is told to keep, and the operator may resume a
  project days later. No age-based deletion applies to it. A project's scratch now
  goes when the project is deleted (the folder is outside the project, so the
  Recycle Bin never sees it), and an orphan nobody claims is swept after a week;
  nothing clears it on compaction, because compaction happens mid-run and the
  scratch is often the working set of the worker being compacted.
- **The engine's `snapshot` store** (`data\engine\opencode\data\opencode\snapshot`,
  347 MB and growing) — it is the engine's own undo history. Deleting it needs the
  engine stopped and is a separate, explicit action, not a boot sweep.

## Keeping the PC awake

`src/power.js` holds a Windows wake lock while Settings → Automation says so. It is
a PowerShell child that calls `SetThreadExecutionState` every twenty seconds with
`ES_SYSTEM_REQUIRED` — the same API PowerToys Awake uses — so the machine does not
idle into sleep or hibernate. The amplified half (`keepDisplay`) adds
`ES_DISPLAY_REQUIRED`, which keeps the monitor on; without it the screen follows the
operator's own turn-off time and the machine stays awake behind it.

The lock belongs to the child process: if the server dies, the child notices at its
next twenty-second tick and exits, and Windows drops the request with it. `shutdown()`
stops it explicitly as well. The child also writes `data\wakelock.txt` each tick, so
the app's own disk is not idle either.

It is a wake lock, not a power-plan edit: it does not keep a *second* disk spinning
down (that is the drive's own idle timer), and it does not stop the operator pressing
Sleep. Settings owns both halves; the cog in the chat toggles only the master
(`automation.keepAwake`), because the PC is one PC and the four switches beside it
are per project.

## The debris rules (10 Nov)

The operator's decision: this is automatic. A cleanup task at the end of a plan spends a
worker run on files the harness can name by rule, and the model that made the mess is the
one deciding what the mess is.

**A finished task's scratch goes.** `<project>-<hash>\<task>` under
`F:\dev\Synapse.Projects\_scratch` is where the work was built; nobody reopens it. One
task folder measured 1.3 GB. A task that **failed or was stopped** keeps its folder: the
wreckage is evidence. (`src/cleanup.js`, `removeTaskScratch`.)

**Anything in the scratch root that no live project claims is deleted — now.** Not after
a week: the folder is Synapse's own, so a folder in it that is not a project's is debris.
What was there on the day: 494 MB a worker wrote at the root, 258 MB of dotnet temp,
240 MB of an editor download, 29 MB under a name with no hash. Two exceptions, both
named rather than guessed: `opencode` (the engine's temp root, in use while the engine
runs) and anything written in the last ten minutes (a render or a download may be inside
it). It runs at boot and every half hour, because this app stays up for days.
(`src/housekeeping.js`, `sweepUnclaimedScratch`.)

**Deleting a project deletes its scratch**, already: `api.deleteProject` removes
`scratchDir(dir)` after the folder goes to the Recycle Bin.

**A stray file in the project root is moved, never deleted.** Only names the harness can
prove are debris: its own files at the wrong level (`plan.json`, `features.json`,
`project.md`, `runs.jsonl`), a log, or a proof file. They go to
`.project\reports\<date>\`, one line in the log, and a second one of the same name gets
`-2` rather than overwriting a proof. The project root is where a real deliverable lives,
and a rule that guesses would move one. (`src/cleanup.js`, `tidyProjectRoot`, called at
the end of every run.)

**The brief sends evidence to `.project/reports/`**, so most of that move is empty by
construction: a worker that writes there keeps its own place.

**The .NET toolchain keeps its temp inside `data\toolchain\dotnet`** (`DOTNET_CLI_HOME`,
plus `NUGET_PACKAGES` pointed at `vendor\nuget-packages` when it exists). Unset, a
worker's `dotnet build` wrote a 258 MB `.net` tree wherever HOME pointed. The operator
expects more .NET projects, so this is the normal case rather than an edge one.

## Before restarting the model server, ask who is using it (17 Nov)

A live run was in flight - a coder step with a 132k prompt - when the model server was
restarted to register a new profile. Nothing was lost only because the harness retried,
but the restart was avoidable: the run was visible in three places, and none of them was
checked.

- `GET /api/runs` and `GET /api/pending` - `active` names the sessions working right now;
- `logs\app.log` - `run <task> (<role>) started` without a matching `completed` is a live
  run;
- the server's own console - `reading the prompt`, or any line after `ready`, means a
  request is in flight.

A profile only has to be registered once, and `switch_on_request` loads a model on demand:
adding a profile is never urgent enough to interrupt a run. Register it, tell the
operator it is ready, and let them restart between tasks.
