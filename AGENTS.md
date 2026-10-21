# AGENTS.md — working notes for Synapse

This file is for any agent (or human) picking Synapse up cold. It records what
the project is, the rules that are not negotiable, how to run it, and the engine
traps that cost real time to discover. Read this before changing anything — and
read the one `docs/notes/` file that matches the thing you are about to touch
(the index is below).

---

## What Synapse is

A self-contained Windows agent-build harness: pick models in the UI, discuss a
plan, approve it, let workers execute, watch it happen live. It is **not** a
wrapper around the OpenCode desktop app — it drives the genuine `opencode.exe`
over its HTTP + SSE API and rebuilds the interface from scratch.

Everything lives in `F:\dev\Synapse`. Nothing is written outside it except the
recycled engine binary it locates.

**It is a harness for any project, and any model.** No project, product or model
may be named in its code, its briefs or its config: the briefs are sent to every
project this harness will ever run, so a rule shaped around one project's incident
is wrong for the next one. Write the general rule here and the incident that
earned it in `docs/notes/` — the incident explains the rule, it is not the rule.
The same goes for numbers: never bake in one model's context window, token budget
or speed.

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

```powershell
cd F:\dev\Synapse
.\restart.ps1
```

It stops Synapse and its engine by reading `data\synapse.pid` and
`data\engine.pid`, and refuses to stop anything under `@opencodedesktop` or
`ai.opencode.desktop` whatever the pid file says.

`server.openBrowser` is off by default here: a restart should not hijack a
browser tab. Turn it on in Settings if you want one opened for you.

Gotchas:
- **The desktop app also shows as process name `opencode`, and its install path
  is `...\Programs\@opencodedesktop\OpenCode.exe` — which contains `@opencode`**,
  so `Get-Process -Name opencode | Where Path -like '*@opencode*'` force-kills
  the operator's editor along with the engine. That one mistake caused a string
  of "the desktop app keeps crashing" reports — it was being killed, which is
  also why it left no crash dump. This is why nothing here matches on a name.
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
  providers.js        provider types, ids, and "ask a server what it serves"
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
docs/                 design mockups (*.pdf), clock-test-2.md and shift-test-1.md
                      (the runs the briefs were rewritten around), and the detail
                      behind this file
  notes/              engine-notes, models-and-tools, ui-lessons, runbook
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

**The engine is 2.1.0 (20 Oct 2026).** The table below was measured on 2.0.30
unless it says otherwise, and the upgrade was re-verified on the routes Synapse
depends on. **The model catalog ships inside the engine binary, not in Synapse** —
so a stale model list means a stale *binary*, never a stale cache. The console
prints `catalog: N model(s) from engine X` at every boot, which is the check; the
update dialog (see `docs/notes/models-and-tools.md`) is the fix.

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

- **3.4 — the live per-session Tools-in-Use feed.** The main pane's napkin with its
  live path is done; what is left is the per-session tool feed the rail shows.
- **3.5 — housekeeping**: `engine.type` is a dropdown in Settings now and only
  `opencode` is registered; **Browse Folder** / **Cmd Here** are still `data-soon`
  for stage 4, and the stored probe results are not zeroed if the panel should
  start blank.
- **The census double-counts after a restart** — known, reproduced, not yet fixed;
  the detail and the near-miss in testing are in `docs/notes/engine-notes.md`.
- The composer has **no target picker**: every message goes to the Architect, and
  per-role model and effort live on the cards. If direct worker addressing is ever
  wanted, make the card itself the affordance rather than reintroducing a
  dropdown.
- Adding skills later is just files in `%USERPROFILE%\.agents\skills` — they are
  already wired in.
