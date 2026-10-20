# AGENTS.md — working notes for Synapse

This file is for any agent (or human) picking Synapse up cold. It records what
the project is, the rules that are not negotiable, and the things that cost real
time to discover. Read this before changing anything.

---

## What Synapse is

A self-contained Windows agent-build harness: pick models in the UI, discuss a
plan, approve it, let workers execute, watch it happen live. It is **not** a
wrapper around the OpenCode desktop app — it drives the genuine `opencode.exe`
over its HTTP + SSE API and rebuilds the interface from scratch.

Everything lives in `F:\dev\Synapse`. Nothing is written outside it except the
recycled engine binary it locates.

---

## Hard rules

1. **Zero npm dependencies.** Plain Node: `http`, global `fetch`,
   `child_process`, `fs`. No build step, no bundler, no framework. If a problem
   looks like it needs a package, solve it in the standard library instead —
   web search, MCP, markdown rendering and the UI are all hand-rolled here.
2. **Self-contained and offline.** Nothing may be fetched at runtime except the
   model provider. Fonts are vendored locally. No CDN links, ever. The one
   exception is the engine update check (`src/engine-update.js`), and only because
   the operator asks for it: npm is contacted when the update dialog opens, never
   at boot, and the answer is cached in `data\engine-update.json`.
3. **The engine home is isolated.** `data\engine\opencode` is set via
   `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `TMPDIR`. The
   machine-wide `~/.config/opencode` must never be touched.
4. **Engine-agnostic core.** Nothing OpenCode-specific outside
   `src/engines/opencode.js`. Swapping engines means writing one file that
   implements the contract in `src/engines/base.js`.
5. **Config is a file, the UI is a GUI over it.** `config\synapse.config.json`
   is the source of truth. No hidden state in the UI.
6. **No code-crutches.** Do not fake capability. If something cannot be done,
   say so rather than drawing a mock that implies it works. Never print secrets
   or tokens.

### Palette (do not break this)

- **Violet** = fills and surfaces. **Orange** = accents only (text, borders,
  dot-ants). **Never orange text on a violet fill** — use white.
- Green / amber / red are semantic only, never decorative.
- Affordances: `+` green, `✕` red, edit/settings icons yellow. The composer's
  **Stop turns red on hover** — it is the one destructive control in that row.
- **The live path is one colour: a yellow arrow with yellow ants.** Orange is this
  palette's accent (text, borders), and it used to be the dot-ant colour too — the
  operator changed that: a different hue on a 2.5px line read as one object with a
  colour bug rather than a line with beads on it, so the beads are separated by
  their glow instead. The two delegation cards wear the same **yellow** as a border
  while a delegation is in flight, and **red means blocked and nothing else** (it
  carried two meanings for one day: requester green / worker red borders, which
  collided with the blocked dot).
- **All button labels are Title Case** (see `references\UI UX\DESIGN.md` §8).
  This applies to buttons only — not headings, body text, labels or tooltips.

### Working style rules

- **Never open the OpenCode review pane** (`browser.preview`, and the whole
  `browser.*` namespace). It is broken and the operator does not use it. To show
  something, write a file and give the **full path**.
- **Use the browser, but surgically.** `browser-control` is registered again so
  you can look at the UI and check your own work before handing it over. One
  session, reused; few screenshots. See "Browsers" below.
- **Stage the delivery.** Each stage is reviewed before the next starts.

### Version control

- **Commit before every important change** — before starting a stage, a refactor,
  or a risky fix, and again when it works. Small scoped commits, message says
  what changed and why.
- **`data/`, `logs/` and the projects root stay out of git** (already in
  `.gitignore`): they hold PIDs, probe output, session logs and scratch projects,
  all local and regenerable.
- **Check `git status` before and after.** Do not commit build junk or secrets;
  `config/synapse.config.json` is source of truth and safe (its password field is
  empty by default), but never commit a filled-in one.
- **No remote.** This is a local repository; never force-push or rewrite history.

### Destructive commands — verify before you act

This machine is shared and busy: the desktop app, a browser running hundreds of
processes, games, other agents. A command that "cleans up" broadly is not a
shortcut, it is collateral damage.

**Never match processes by name or by a loose path fragment.** The specific
disaster: `Get-Process -Name opencode` is case-insensitive, so it also matches
`OpenCode` — the desktop app, five processes — and the desktop installs to
`...\Programs\@opencodedesktop\OpenCode.exe`, whose path **contains `@opencode`**.
So `Get-Process -Name opencode | Where-Object { $_.Path -like '*@opencode*' }`
force-killed the operator's editor alongside the engine — on every restart, for
several rounds, while I blamed Puppeteer.

Rules:

1. **Prefer an identity you own.** Stop processes by PID from a file Synapse
   wrote (`data\synapse.pid`, `data\engine.pid`), never by name.
2. **Dry-run first.** Before any destructive command, run the *selection* alone
   and print what it matched — count it, read the paths — and only then act. It
   costs seconds. Skipping it cost days.
3. **Make the selector narrow and provable.** `*node_modules\@opencode\cli*`
   matches only the engine. `*@opencode*` matches the operator's editor.
4. **Guard anything that must never be touched** with an explicit denylist
   (`@opencodedesktop`, `ai.opencode.desktop`).
5. **When something breaks repeatedly and the evidence does not fit, suspect your
   own tooling first.** An empty crash-dump folder was the tell: the app was not
   crashing, it was being killed. I saw that clue and moved past it twice.

---

## Where the rest lives

This file is the map: what must not be broken, how to run it, and the traps that
cost time. The detail is in `docs/notes/` and is read **on demand** — a document
an agent does not know to open is a document that does not exist:

| Read this | before |
|---|---|
| `docs/notes/engine-notes.md` | changing `src/api.js`, `src/runs.js`, `src/plans.js` or `src/engines/opencode.js` — the plan-file contract, delegation and its ladder, instruction entries, what a permission rule really does |
| `docs/notes/models-and-tools.md` | touching model choice, the catalog cache, the probe or the engine update — context limits, variants, marks, ask counters |
| `docs/notes/ui-lessons.md` | touching `web/` — layout invariants, the chat dock, the ask panel, the cards and the picker, with the measurements that prove them |
| `docs/notes/runbook.md` | running, restarting or debugging it; anything that kills a process |

Two rules for this file. **A new lesson goes in `docs/notes/`, not here** — this
file changes when a rule changes, not when something is learned. And if you move
a section out, leave its invariant behind in one line, with the pointer.

## Running it

```
start.bat        # starts Synapse (UI on 8700, engine on 8720)
stop.bat         # reads data\synapse.pid
restart.ps1      # dev restart — stops the engine by PID, never by name
```

**Never restart by matching process names.** The desktop app installs to
`...\Programs\@opencodedesktop\OpenCode.exe`, whose path contains `@opencode`,
so a name filter such as `Get-Process -Name opencode | Where Path -like
'*@opencode*'` kills the operator's editor as well as the engine. That mistake
caused a string of "the desktop app keeps crashing" reports. `restart.ps1`
reads `data\synapse.pid` and `data\engine.pid`, and refuses anything under
`@opencodedesktop`.

`server.openBrowser` is off by default here: a restart should not hijack a
browser tab. Turn it on in Settings if you want one opened for you.

Restarting during development — **use the script**:

```powershell
cd F:\dev\Synapse
.\restart.ps1
```

It stops Synapse and its engine by reading `data\synapse.pid` and
`data\engine.pid`, and refuses to stop anything under `@opencodedesktop` or
`ai.opencode.desktop` whatever the pid file says.

**Do not kill these processes by name.** See the first gotcha below — that is
exactly how the desktop app kept "crashing".

Gotchas:
- The desktop app also shows as process name `opencode` — and **this is
  dangerous**. Its install path is `...\Programs\@opencodedesktop\OpenCode.exe`,
  which **contains `@opencode`**, so
  `Get-Process -Name opencode | Where-Object { $_.Path -like '*@opencode*' }`
  force-kills the operator's editor along with the engine. That single mistake
  caused a string of "the desktop app keeps crashing" reports — it was being
  killed, which is also why it left no crash dump.
  **Use `restart.ps1`, which reads `data\synapse.pid` and `data\engine.pid`.**
  Never match on a process name.
- `stop.bat` must not use `$pid` as a variable — it is read-only in PowerShell.
- The console is a first-class output. `start.bat` leaves a window open all day, so
  `logger` mirrors the `app` channel **and every warning or error from any channel**
  to stdout, and the runner writes its milestones (run started, outcome, stopped) to
  the app channel too. A retry or a stall therefore shows up in that window without
  opening a file. The `tools` channel's *info* lines are not mirrored on purpose —
  it carries the tool census, which would drown the window.
- Ports: **UI 8700, engine 8720**. Ports 1174–1273 are reserved by
  Hyper-V/WSL on this machine — do not pick one (1235 and 1240 both fail with
  `EACCES`; 8701 and 4343 are fine).

---

## Layout

```
src/
  index.js            boot wiring: config → projects → engine → titler → probe → server
  paths.js            every filesystem path, derived from the project root
  config.js           DEFAULTS, merge, normalize, load/save
  logger.js           per-channel logs, rotation, cleanup
  server.js           HTTP routes + SSE broadcast
  api.js              engine-agnostic operations the routes call
  projects.js         the project registry (a project IS a directory)
  titler.js           names a session after its first answer
  titles.js           the shared "TBD" placeholder
  toolstats.js        the tool-call census (data\tool-stats.json)
  probe.js            the tool probe: one turn per tool
  engine-update.js    is there a newer engine, and stop/install/start
  search.js           dependency-free DuckDuckGo search
  mcp/search-server.js stdio MCP server exposing websearch to the engine
  engines/base.js     engine contract + message normalisation
  engines/opencode.js the OpenCode adapter
web/
  index.html          the shell
  app.js              all UI logic (ES module)
  md.js               the markdown renderer (escape-first, no dependencies;
                        fenced code, headings, GFM tables, task lists, images)
  synapse.css         theme + shell (Summit baseline stays locked)
  vendor/summit.css   LOCKED baseline — one deliberate edit, see below
  vendor/fonts.css    vendored DM Sans + Manrope (offline)
  icon-16…256.png     the app icon, rendered from references\synapse_icon_full.png
  favicon.ico         the same, packed as a multi-size icon
skills/               shipped WITH Synapse, always on the engine's skill path
  visual-review/      render a page to PNG, then read it (the agents' eyes)
  ui-design/          the Designer's craft brief: direction, tokens, states, spec
  frontend-design/    taste and direction (Apache 2.0)
  aesthetic-foundations/  composition, colour, hierarchy, a critique protocol
  code-craft/         the coders' brief: small surface, fail loudly, prove it
data/                 runtime state (projects, census, probe results, engine home)
logs/                 one file per channel: app, engine, session, tools
docs/                 design mockups (stage-1-mockup-rev*.pdf, stage-2-*.pdf)
```

**The mockups are PDFs and there is no PDF renderer on this machine** (no
`pdftoppm`, `magick`, `gswin64c`, `mutool`). Chrome renders them: open
`file:///F:/dev/Synapse/docs/<name>.pdf` in a `browser-control` session. A
`#zoom=200` fragment works only on a *fresh* URL (add a query string to force
one) and the viewer cannot be scrolled from the page, so the page is only
readable top-left at a time. The right answer is that the mockup is a *shape*
record, not a pixel source: the numbers that matter (spine centre, band centre,
card boxes) are measured live and asserted against.

**`web/vendor/summit.css` is a locked baseline.** The only edit ever made to it
is line 1: the Google Fonts `@import` was replaced with a comment, because
fonts must be local. Do not restyle it — put changes in `synapse.css`.

---

## Engine API: the things that cost time

Route and schema ground truth is the OpenAPI dump at
`%LOCALAPPDATA%\Temp\opencode\openapi.json`. Check it before
guessing.

**The engine is 2.1.0 as of 20 Oct 2026.** Everything below was measured on
2.0.30 unless it says otherwise, and the upgrade was verified on the routes
Synapse actually depends on: session create, messages, the model switch, the
instruction entries (PUT 204 / GET / DELETE 204), `/api/session/active` (an object
keyed by session, which the adapter reads with `Object.keys`) and the session form
route. **The model catalog ships inside the engine binary, not in Synapse.** 2.0.30
listed 11 models including ones the provider had already retired (`space-bunny`,
`muse-spark`); 2.1.0 lists the current 10, with MiniMax M3.1 and GLM-5.3 in and the
retired ones gone — measured side by side, same account, same API. A stale model
list therefore means a stale *binary*, never a stale cache: the console prints
`catalog: N model(s) from engine X` at every boot so it is visible at a glance.
`@opencode/cli` is the thing to update; the engine data dir was backed up to
`data\engine\opencode-2.0.30-backup` before the switch.

| Thing | Reality |
|---|---|
| `POST /api/session` | accepts `location:{directory}`. **A session cannot run in a directory that does not exist** — the engine throws `LocationNotFoundError` on prompt. Synapse creates the folder when a project is added. |
| `PATCH /api/session/{id}` | accepts only `title`, `metadata`, `permissions`. **Not `agent`.** Returns **204 with an empty body** — do not try to parse it. `permissions: []` clears the ruleset; that is how Single→Multi is applied to an open session. |
| `POST /api/session/{id}/model` | switches model and thinking effort for later turns. Body `{model:{providerID,id,variant?}}`; **204, empty body**. Omitting `variant` makes the engine store `"default"` — see "Context windows and thinking effort". |
| `POST /api/session/{id}/generate` | one-shot completion in the session's context. Returns `{data:{text}}`. **Adds nothing to the transcript** — this is how sessions get named. |
| `POST /api/session/{id}/prompt` | accepts `text`, `files`, `agents`, `skills`, `metadata`, `delivery`, `resume`. An `agents:[{name}]` attachment does **not** change the acting agent. |
| Turn boundaries | every turn ends with an **`idle` message** appended. That is the reliable end-of-turn signal — do not invent a timer. |
| Shell exit codes | a shell command exiting non-zero is reported by the engine as `status=completed`. Synapse derives `failed` from the output. Never trust the raw status for shell. |
| `GET /api/session/active` | the authority on what is running. Survives a Synapse restart. |
| `GET /api/project` | returns a bare array, not `{data:…}`. |

---

## Open items

- **Per-role instructions.** The ✎ button's other half: per-role skills are done
  (`roles.<id>.skills`, enforced by the session ruleset, with the picker on the
  card), but a role cannot yet carry its own free-text instructions. That text
  belongs in the brief, and the brief is regenerated per session, so it is a
  small addition once we decide where it is stored.
- **Stage 3 — orchestration.** The dispatch decision is settled: **Synapse owns
  dispatch, not the engine's `subagent` tool.** The Architect cannot choose a
  subagent's model, so leaning on `subagent` would leave every per-role pick
  decorative and hide the orchestration inside a black box. Each step will run
  as a real engine session with that role's model and effort instead.
  - **3.1 done — the plan is a project file.** `.synapse\plan.json`, owned and
    written by the Architect (no tool, no store), read and rendered by Synapse,
    briefed into every session through the engine's instruction entries. Verified
    live on the `calendar` project: the Architect created a correct four-task
    plan with roles, the file's first version came back unparseable (a stray
    backslash copied out of the brief), the pane named the exact position, and
    one bare "Continue." made the Architect repair its own file.
  - **3.2 done — delegation, the chain, and its switch.** `delegate` tool,
    `src/runs.js`, hidden worker sessions, `.synapse\runs.jsonl`, the synthetic
    wake, the retry cap, and the **Keep building** flag between Stop and Send
    (`metadata.synapse.auto`). Verified live on `calendar`: with the flag off,
    t1 → Designer → the Architect caught a hallucinated file, sent it back, and
    stopped for the operator. With the flag **on** and one "continue", the
    remaining three tasks ran themselves — 12.8 minutes, five worker runs, two
    files in `bin/`, `python bin/calendar.py` printing the month. The Auditor hit
    the 240s ceiling yet its partial work was still judged and accepted.
  - **3.3 done (activity half) — the cards show the live work.** `src/runs.js`
    emits `run.started` / `run.progress` / `run.finished` over the SSE stream and
    keeps the same shape at `GET /api/runs`, so a page reloaded mid-run reopens
    onto the truth. Each card carries a subtitle while its role has something to
    show — a worker: the task title plus its newest tool call in brackets, no
    task id and no destination; the Architect: who it is waiting on, or what its
    own turn is doing — and the two participants are the only cards that change
    appearance (requester green, worker red *at the time*; both are yellow now,
    see the card-state bullet in UI lessons). Verified live on `calendar` with a
    deliberate repeat delegation of t4: the Architect's card went green and read
    `Waiting on Coder 1`, Coder 1 went red and read
    `Deliver final script (reading calendar_design.md)`, the yellow arrow was
    drawn exactly on the dots, and everything returned to idle when the worker
    stopped.
    **Still open here: the ✎ button's per-role instructions.** It settles skills
    gating: custom agents are dead here (the free tier rejected every
    custom-agent request), so instructions are prompt text on a default-agent
    session — which is what the brief already is. Card state was idle/working only
    as shipped here; it has since grown the full derived language (see "The card's
    dot is a state" in UI lessons): blocked and done are read from the *plan*,
    which is where the Architect's judgement already lives, so no "blocked" state
    had to be invented in the runner.
    **Elapsed time is not shown either**: a ticking number needs a repaint loop,
    and nothing in the card needs one.
  - **3.4 next — the live per-session Tools-in-Use feed.** The main-pane napkin
    with its live path is done (arrows and ants on the topology while a worker
    runs); what is left is the per-session tool feed the rail shows.
  - **3.5 — housekeeping**: `engine.type` as a dropdown (only `opencode` is
    registered), **Browse Folder** / **Cmd Here** still `data-soon` for stage 4,
    and zeroing the stored probe results if the panel should start blank.
- **Known issue: the census can double-count after a restart.** `recordMessages`
  is called with the **whole transcript** on every turn and de-duplicates with an
  in-memory `seen` set of tool-part ids — which is not persisted, while the
  aggregates are. So the first turn in a session that predates the restart
  re-adds that session's entire tool history. Reproduced: 2 calls → restart →
  re-scan the same transcript → 4. Note a naive test **looks clean**, because
  `flush()` is debounced by 2s; call `flush()` before "restarting", or the first
  run never reaches disk. Fix is small (persist the ids, or a per-session
  high-water mark); do it before trusting the census for anything.
- **Multi vs Single mode.** The composer toggle flips the **open session** live;
  new sessions always start Single. Both modes have the full toolset — that is
  the whole point.
  - **Single** — a permission ruleset on an ordinary session that denies only
    `subagent`, not a custom agent and not a blanket deny. The role cards stay
    collapsed (`max-height: 0`), so a Single session pays nothing for them.
  - **Multi** — the ruleset is cleared (`PATCH /api/session/{id}` with
    `permissions: []`), the wrapper animates open and the chat slides down.
    Verified live: the Architect called `subagent` (general, `completed`) and
    answered with the worker's reply; a subagent run does not leave a child
    session in the rail.

  The mode is a per-session property read from `isSingleSession()`
  (`engines/base.js`); nothing is stored in config — `defaults.mode` was removed
  once the toggle became live. A dedicated `chat` agent (tools denied,
  `steps: 1`) is the obvious design and it does **not** work: the free tier
  rejected every request from a custom agent with a provider auth error
  (measured side by side — a custom-agent session failed at 20:45:37 while a
  default-agent session succeeded at 20:45:40). Denying everything also defeats
  the purpose, because Single is meant to have tools. `POST /api/session`
  accepts `permissions`; `PATCH /api/session/{id}` replaces them.
- The composer has **no target picker**: every message goes to the Architect.
  Per-role model and thinking effort live on the role cards. If direct worker
  addressing is ever wanted, make the card itself the affordance rather than
  reintroducing a dropdown.
- Adding skills later is just files in `%USERPROFILE%\.agents\skills` — they
  are already wired in.
