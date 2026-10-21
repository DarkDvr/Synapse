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

A restart is **`start.bat` in a new console**, not a hidden process: this is a
console application and the operator watches the engine in that window.

```
cmd /c start "" /D <root> start.bat restart
```

- `start.bat restart` waits ~3 s (`ping`, not `timeout`, which needs a console) so
  the old process can release the port before the new one binds it.
- The old process stops its engine, removes its pid file and exits **with code 2**.
  `start.bat` reads that as "another console is taking over" and closes instead of
  hitting `pause`, so there is exactly one window, one engine and one server.
- `cmd /c start` is the only hand-off that works here: a `detached: true` child of
  the server **never ran** (measured, three ways), and a plain child dies with the
  parent.

`restart.ps1` is still the right thing for a restart from a terminal — it reads
both pid files and refuses anything under the desktop app's folder. The app no
longer uses it, because it starts node hidden with output in `%TEMP%\synapse.out`,
and the operator wants the window.

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
with no npm and no `@opencode/cli` still works. With the copy in place the folder
is the app: copy `F:\dev\Synapse` to the new machine, run `start.bat`, and it
starts. Nothing is written outside it, and the engine's home (`data\engine\opencode`)
is created fresh on first boot.

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

At boot (`src/npm-check.js`):

| situation | what happens |
|---|---|
| npm on PATH | nothing is printed |
| npm missing, `bin\opencode` present | offered: install Node.js LTS with winget. Declined → starts anyway, one line says the update button will not work |
| npm missing, no runtime anywhere | offered: install Node.js LTS with winget. Declined → explains that nothing here can run a turn, and exits |

Started hidden (restart.ps1, a shortcut), nobody can answer the question, so the
same split applies without the prompt. The install is `winget install -e --id
OpenJS.NodeJS.LTS`, printed before it runs — it is the only moment the app fetches
something other than a model, and only after a yes.

**Updates on the vendored copy** use npm too: Settings > Runtime > Check for
Updates stops the runtime, installs `@opencode/cli@latest`, copies the new binary
over `bin\opencode\opencode.exe` (keeping `opencode.exe.bak`) and restarts. The
copy is what makes the update visible — without it the app would keep starting
the old file.
