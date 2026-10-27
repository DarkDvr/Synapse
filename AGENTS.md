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

## How to write

Plain English first, then the detail: the operator reads the console, the logs,
the cards and the commits, not the code. One reason per sentence, not a chain.

- The everyday word: "the server is down", not "the listener is unreachable";
  "the run stopped because the worker asked twice", not "the guard tripped on a
  repeat signature". Names that are real stay: `engine`, `session`, `plan`, `run`.
- It covers comments, logs, commits, docs and UI text. Code keeps its own names:
  `guardQuestions` says more than `checkStuff`.

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
3. **A good tenant.** Whatever Synapse needs, it installs itself and silently,
   inside this folder — `bin\node`, `bin\opencode`, `vendor\`. Never `winget`, a
   global install, a PATH edit, the registry or `%APPDATA%`. The machine is
   borrowed; the folder is ours. See `docs/notes/desktop-app.md`.
4. **The engine home is isolated.** `data\engine\opencode` is set via
   `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `TMPDIR`. The
   machine-wide `~/.config/opencode` must never be touched.
5. **Engine-agnostic core.** Nothing OpenCode-specific outside
   `src/engines/opencode.js`. Swapping engines means writing one file that
   implements the contract in `src/engines/base.js`.
6. **Config is a file, the UI is a GUI over it.** `config\synapse.config.json`
   is the source of truth. No hidden state in the UI.
7. **No code-crutches.** Do not fake capability. If something cannot be done,
   say so rather than drawing a mock that implies it works. Never print secrets
   or tokens.
8. **A model touches its project, reads the harness, and asks for the rest.**
   `src/permissions.js` decides and the engine enforces: writes and commands
   outside the project directory ask the operator, writes inside the harness
   never happen, and credential stores are refused. Do not widen a zone in a
   brief or a config — change the policy and its tests.

### Palette (do not break this)

- **Violet** = fills and surfaces. **Orange** = accents only (text, borders,
  dot-ants). **Never orange text on a violet fill** — use white.
- Green / amber / red are semantic only, never decorative.
- Affordances: `+` green, `✕` red, edit/settings icons yellow. The composer's
  **Stop is red** whether or not it is hovered, and Settings' **Revert** is red
  too — they are the two controls that throw work away.
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
| `docs/notes/engine-notes.md` | changing `src/api.js`, `src/runs.js`, `src/plans.js` or `src/engines/opencode.js` — the work-list file contract (it was called the plan; the name is the only thing the rename changed), delegation and its ladder, instruction entries, what a permission rule really does |
| `docs/notes/models-and-tools.md` | touching model choice, the catalog cache, the probe or the engine update — context limits, variants, marks, ask counters |
| `docs/notes/runtime-scope.md` | before starting work on Synapse's own runtime (independence from OpenCode) — what the runtime does, what a replacement costs, the staged path |
| `docs/notes/ui-lessons.md` | touching `web/` — layout invariants, the chat dock, the ask panel, the cards and the picker, with the measurements that prove them |
| `docs/notes/runbook.md` | running, restarting or debugging it; anything that kills a process |
| `docs/notes/desktop-app.md` | touching `shell\`, `Synapse.exe`, `bin\node`, npm or any dependency — the good-tenant rule, the process model, exit codes, where the console lives |
| `docs/notes/remote-access.md` | the LAN switch, the token or the login page, or changing what the HTTP listener binds |
| `docs/notes/multi-user.md` | two views at once — what "busy" means, who may send, Stop as the takeover, and the Settings lock |
| `docs/notes/todo.md` | picking up work the operator deferred — the changes that need a decision first, and why they are not small |
| `docs/notes/project-chat.md` | before changing how a project, a chat or a compaction works — the one-chat-per-project scope, its phases and what is still open |

Two rules for this file. **A new lesson goes in `docs/notes/`, not here** — this
file changes when a rule changes, not when something is learned. And if you move
a section out, leave its invariant behind in one line, with the pointer.

## Running it

```
Synapse.exe        # the app: window, tray icon, and the server it starts
.\shell\build.ps1  # build it — one lean exe at the root, needs the .NET 10 runtime
vendor-node.ps1    # copies Node into bin\node so the folder travels
vendor-engine.ps1  # copies the runtime into bin\opencode so it travels with the app
```

`Synapse.exe` is the only thing launched. Close hides the window to the tray; the
tray is where the server is stopped and started, and Exit is the only way to stop
both. To work on the server on its own: `bin\node\node.exe src\index.js`.

`server.openBrowser` is off by default here: a restart should not hijack a browser
tab. It is ignored when the app starts the server.

Gotchas:
- **Nothing here matches on a process name** — the desktop app, the rule and the
  incident that earned it are in "Destructive commands" above. The app stops the
  process it holds a handle to, and `Kill(entireProcessTree)` is the fallback.
- The console is a first-class output, and it lives in the window now: the app
  captures the server's stdout into `logs\console.log` and serves it to the page, so
  it still works when the server is stopped. `logger` mirrors the `app` channel
  **and every warning or error from any channel** into that stream, and the runner
  writes its milestones to the app channel too. The `tools` channel's *info* lines
  are not mirrored on purpose — it carries the tool census, which would drown it.
- Ports: **UI 8700, engine 8720**. Ports 1174–1273 are reserved by
  Hyper-V/WSL on this machine — do not pick one (1235 and 1240 both fail with
  `EACCES`; 8701 and 4343 are fine).

---

## Layout

```
Synapse.exe           the app — window, tray, server supervisor (build output)
shell/                the WPF frame behind it: App, MainWindow, ServerHost, ConsoleStore
src/
  index.js            boot wiring: config → projects → engine → probe → server
  paths.js            every filesystem path, derived from the project root
  config.js           DEFAULTS, merge, normalize, load/save
  logger.js           per-channel logs, rotation, cleanup
  server.js           HTTP routes + SSE broadcast
  api.js              engine-agnostic operations the routes call
  projects.js         the project registry (a project IS a directory)
  project-doc.js      the project's living document (current, handover, log)
  toolstats.js        the tool-call census (data\tool-stats.json)
  probe.js            the tool probe: one turn per tool
  providers.js        provider types, ids, and "ask a server what it serves"
  secrets.js          provider keys in data\provider-keys.json, never the config
  engine-update.js    is there a newer engine, and stop/install/start
  mcp/search-server.js stdio MCP server exposing websearch to the engine
  engines/base.js     engine contract + message normalisation
  engines/opencode.js the OpenCode adapter
web/
  index.html          the shell
  app.js              all UI logic (ES module)
  md.js               the markdown renderer (escape-first, no dependencies;
                        fenced code, GFM tables, task lists)
  rate.js             tokens per second, measured from the stream (not per turn)
  synapse.css         theme + shell (Summit baseline stays locked)
  vendor/summit.css   LOCKED baseline — one deliberate edit, see below
  vendor/fonts.css    vendored DM Sans + Manrope (offline)
  favicon.ico         the same, packed as a multi-size icon
skills/               shipped WITH Synapse, always on the engine's skill path
  visual-review/      render a page to PNG, then read it (the agents' eyes)
  app-check/          launch a desktop app, photograph its window, report if it lived
  ui-design/ frontend-design/ aesthetic-foundations/ code-craft/ web-guidelines/
                      the craft briefs: direction, tokens, states, composition,
                      colour, hierarchy, and the coders' rules
templates/win-app/    the Windows shell a new app is copied from (WPF + WebView2)
data/                 runtime state (projects, census, probe results, engine home)
logs/                 one file per channel: app, engine, session, tools
bin/opencode/         a copy of the runtime that travels with the app (not in git;
                      vendor-engine.ps1 puts it there, ~210 MB, with its licence)
docs/                 the detail behind this file
  notes/              one per topic; the index is in "Where the rest lives"
```

**`web/vendor/summit.css` is a locked baseline.** The only edit ever made to it
is line 1: the Google Fonts `@import` was replaced with a comment, because
fonts must be local. Do not restyle it — put changes in `synapse.css`.

---

## Engine API: the things that cost time

**The schema dump is a starting point, not the truth. The running engine is the
truth.** `%LOCALAPPDATA%\Temp\opencode\openapi.json` is a snapshot
of some earlier engine, and on 25 Oct it described an attachment shape that 2.1.2
refuses outright (`Missing key at ["files"][0]["uri"]` — it wants `{uri}`, not
`{data, mime, source}`). Read the dump to know what to try, then **probe the live
engine once before building on it**: send the body you expect and read the 400.
Minutes spent probing beat a feature that only fails when the operator uses it.

**The engine is 2.1.2.** The table below was measured on 2.0.30
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
| `POST /api/session/{id}/prompt` | accepts `text`, `files`, `agents`, `skills`, `metadata`, `delivery`, `resume`. An `agents:[{name}]` attachment does **not** change the acting agent. **A file is `{uri, name}`, and a `data:` URI is accepted** — measured on 2.1.2, see the dump warning above. |
| Turn boundaries | every turn ends with an **`idle` message** appended. That is the reliable end-of-turn signal — do not invent a timer. |
| Shell exit codes | a shell command exiting non-zero is reported by the engine as `status=completed`. Synapse derives `failed` from the output. Never trust the raw status for shell. |
| `GET /api/session/active` | the authority on what is running; survives a restart. `GET /api/project` returns a bare array, not `{data:…}`. |

---

## Lessons that cost a day each

- **A rule can be older than the thing it describes.** The plan was designed to be
  written once and executed; the record showed the Architect inserting tasks,
  reopening finished ones and adding rows the next day. It is a work list now.
- **A brief change that lands while the server runs has not landed.** Check the
  boot line in `logs\app.log` before blaming the rule.
- **A rule must not contradict the pillar.** "Never re-render what a worker made"
  read as "trust its numbers", which inverts: a worker's output is a claim.
- **A watchdog that listens for one signal waits out its whole timeout.** An `idle`
  message a failed step never sends cost 30 of a 33-minute run.
- **Measure the number, then believe it.** Most "slow model" reports were our
  arithmetic; one "stall" was the provider's VRAM, in its own boot log.
