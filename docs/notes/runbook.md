# Runbook

Restarting the app, protecting the harness's own files, and how to look at the UI
without breaking anything else. Split out of `AGENTS.md` verbatim.

## Protecting the harness's own files

The engine's `edit`, `write` and `shell` tools are **not confined to a session's
directory**. A role told to work in its project folder can write anywhere the
operator can, and sooner or later a model will decide the harness itself needs
"fixing". Three mechanisms, because they fail differently (verified live on 2.0.30):

- **The projects root is a sibling of the harness** (`..\Synapse.Projects`, resolved
  from the harness root, so the drive letter is nobody's business). This is the
  foundation: with projects *inside* the harness, "outside the project" and "inside
  the harness" overlap and no path rule can tell them apart.
- **A permission ruleset on every session** — `src/harness.js` `rules()`:
  `[{action:'*', resource:'*', effect:'allow'}, {action:'*', resource:'<harness>/**', effect:'deny'}]`.
  The engine evaluates it *before* a tool runs, so this is prevention. Two engine
  facts make it work: an effect may be `allow`/`deny`/**`ask`**, and **the last
  matching rule wins** — which is why the broad allow comes first and the harness
  deny after it. Measured on a fresh session: `edit` and `bash` on `src/`, `web/`
  and `AGENTS.md` all come back `deny`; the project folder and a temp path `allow`
  (a temp write must not ask, or every scratch file becomes a question). It is
  **appended** to whatever the mode rules are, so Single's `subagent` deny and this
  guard never fight, and worker sessions carry it too.
- **A watchdog**, because a ruleset cannot see a shell *command* — `pwsh -c
  "Set-Content …"` is a string, not a path. Two layers, both cheap: `checkTurn()`
  reads the transcript Synapse has already fetched and reports any write or edit
  that names a harness path (attributed, and no extra engine calls, so it cannot
  slow a turn down); and around each worker run the runner compares
  `git status --porcelain` before and after, so anything the repository shows
  afterwards that it did not show before is reported as *changed during a worker
  run* however it happened. Both go out as a log `ERROR` and an SSE `alarm`, which
  the UI shows as a toast and the error dialog with the paths.

  Two exclusions, both learned the loud way on the clock run. A **shell command**
  that only names `skills/` is the harness's own toolbox being used and is not
  reported at all — eleven of that run's alarms were the Architect running
  `skills\visual-review\shot.mjs` before judging a report, which is the feature
  working as designed. Anything naming the rest of the harness is still reported,
  and so is a command shaped like a write even when it names `skills/` (a redirect
  with a real target, `Set-Content`, `rm`, `mv`, …). And a change to
  `config\synapse.config.json` is excused when `configSavedAt()` falls inside the
  run: that is the Settings dialog saving, which tripped the alarm once at 12:03.
- **A restore point before each delegation** — `snapshot()` runs `git add -u`
  (tracked files only: never `-A`, so an untracked file of the operator's is never
  swept into a commit) and commits `snapshot: before <task> (<role>)`. Nothing to
  commit is the normal case. This is the recovery half: the watchdog reports, the
  commits make it undoable, and because a project is outside the repository a
  snapshot can never stage a project's deliverables.

**Nothing here repairs a file automatically.** An auto-revert would clobber the
operator's own work in progress, which is a worse failure than the one it prevents;
the evidence plus the commits are the answer.

**Not doing: a separate Windows user for the engine.** It is the only boundary a
shell cannot talk its way around, but with the projects moved out, the ruleset live
and the snapshots in place it is overkill on this machine — the operator's call.

---

## Restarting from inside the app

Settings > Save Changes offers **Restart Now** — but only when the saved values
include something the engine or the server reads at start. Everything else
(roles, worker timers, logging, the provider key) applies the moment Save returns,
and the dialog would be noise.

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

`browser-control-mcp-server` is registered in the machine-wide
`~/.config/opencode/opencode.json`. It is how you can actually look at the UI,
click through it and check your own work before handing it over. Use it — and
look at the result rather than only asserting against the DOM.

- **One session, reused.** `browser_navigate` **without a `sessionId` creates a
  whole new browser.** Pass the `sessionId` from the first call to every later
  call. This is mostly about not accumulating session records — see the measured
  note below.
- **A session cannot be closed.** The MCP refuses to close the last tab
  (`LAST_TAB: Cannot close the last tab`), so a session lives as long as the MCP
  server does. Another reason to reuse one rather than make many.
- **Screenshots are heavy in the transcript.** A base64 screenshot is hundreds of
  KB and the renderer holds every one. Prefer a small `browser_execute` that
  returns a few fields of JSON, and screenshot when the visual result is the
  point — which, for UI work, it often is.
- **One navigation per round where you can**, then drive the page from that
  session. Changing viewport width needs a new session; batch those deliberately
  instead of looping over widths.
- **Never use the `browser.*` namespace** — that is the desktop browser, and it
  opens the review pane.
- **Look at the deliverable, and assert geometry.** Reading code is not testing:
  I shipped a layout twice where the role cards were clipped behind the chat
  because I only measured widths I had chosen to measure. The habit that catches
  it: (1) screenshot the actual state and *look at it*; (2) assert the
  composition with numbers — `archCard.bottom <= wrap.bottom`, `dock.top >=
  wrap.bottom`, `wrap.height ≈ topology.scrollHeight`, page `scrollHeight <=
  innerHeight` in the wide layout; (3) test **at two viewport widths** — the
  1460px breakpoint changes the whole stage layout, and a bug there is invisible
  at 1600px; (4) click the thing the operator will click (the mode toggle, a
  dropdown) and re-measure after it. If a claim is structural, prove it with a
  bounding box, not an opinion.

### Two wrong conclusions, corrected

Recorded because both were asserted with confidence and neither held up:

1. **"This MCP crashes the desktop app."** It did not. The crashes were my own
   restart command (see "Destructive commands"). The MCP was removed for a round
   on a false diagnosis.
2. **"It leaked 29 browsers and consumed gigabytes."** Measured afterwards:
   **0 Chromium processes**, and the MCP server itself is ~30 MB. Those 29 were
   *session records*, not running browsers. The real memory pressure on this
   machine was Brave (13.9 GB across 224 processes) and a game (8.5 GB).

What *is* real: MCP server processes accumulate — six were running at one point,
one per desktop-app restart, because nothing reaps the old ones. That is ~180 MB,
not gigabytes. Worth knowing; not worth panicking about.

---

---

## Moving to another PC

Synapse is self-contained except for two things: Node itself, and the runtime.
The runtime can travel with the folder.

```
.\vendor-engine.ps1        # copies the engine from the npm global install into bin\opencode
```

`bin\opencode\opencode.exe` (about 210 MB, `bin/` is not in git) is what the app
runs when it is present — it is checked *before* any global install, so a machine
with no npm and no `@opencode/cli` still works. With the copies in place the folder
is the app: copy `F:\dev\Synapse` to the new machine, double-click `Synapse.exe`,
and it starts. Nothing is written outside it, and the engine's home
(`data\engine\opencode`) is created fresh on first boot.

- **The one thing it does not install for itself is the .NET 10 Desktop Runtime.**
  The exe is framework-dependent, so a PC without it says so in a Windows dialog
  before Synapse runs a line. Everything else — Node, the runtime, npm — is inside
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
- **Settings > Runtime > Check for Updates** still works on a vendored copy: it
  installs the newest from npm and copies it over this one, keeping the previous
  binary as `opencode.exe.bak`.
- The model catalog lives inside that binary, so a stale model list means a stale
  copy — not a stale cache.

---

## npm, and what happens without it

Synapse uses npm for exactly one thing: **updating the runtime**. The app itself
is plain Node, and the runtime travels in `bin\opencode`, so a machine with no
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
| the fetch fails | one warning; the app runs, runtime updates wait |

The fetch is the one download that happens without a click, and it is bounded: a
failure is recorded in `data\npm-attempt.json` and not retried for six hours, so a
machine with no network does not spend every launch on it. There is no prompt — the
app starts the server hidden, so a question would sit unanswered forever.

**Updates use the same npm**: Settings > Runtime > Check for Updates stops the
runtime, installs `@opencode/cli@latest`, copies the new binary over
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
