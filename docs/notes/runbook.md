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
