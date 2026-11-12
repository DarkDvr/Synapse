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

Everything lives in `F:\dev\Synapse`; nothing is written outside it but the engine binary it locates.
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
   model provider. Fonts are vendored locally. No CDN links, ever. The exceptions
   are the two update feeds (`src/engine-update.js`, `src/synapse-update.js`):
   they answer the operator's update chip, cache their answers, and download only
   when Update is pressed.
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
   `src/permissions.js` decides and the engine enforces: outside the project it
   asks, inside the harness it refuses, and credential stores are refused. The
   prohibited list outranks every rule here (`docs/notes/protection.md`). Do not
   widen a zone in a brief or a config — change the policy and its tests.
9. **Edge or headless, never Brave.** Windows' default browser here is Brave; touching
   it — opening it, reading or copying its profile — resets extensions, cookies and
   settings. Open links in Edge by its full path, take pictures with `skills/visual-review`,
   and leave the seeded Brave entry in the prohibited list (Write and Read cleared) alone.

### Palette (do not break this)

- **Violet** = fills and surfaces. **Orange** = accents only (text, borders,
  dot-ants). **Never orange text on a violet fill** — use white.
- Green / amber / red are semantic only, never decorative.
- Affordances: `+` green, `✕` red, edit/settings icons yellow. The composer's
  **Stop is red** whether or not it is hovered, and Settings' **Revert** is red
  too — they are the two controls that throw work away.
- **The live path is one colour: a yellow arrow with yellow ants.** Orange is the accent
  (text, borders); the beads used to be orange too, and a different hue on a 2.5px line read
  as a colour bug rather than as beads, so they are separated by their glow. Delegation cards
  wear the same **yellow** while in flight, and **red means blocked and nothing else**.
- **All button labels are Title Case.**
  This applies to buttons only — not headings, body text, labels or tooltips.

### Working style rules

- **The review pane is how the operator is shown anything.** A screenshot in the chat
  reaches only you; `browser.preview` puts it on their screen (measured 2 Nov 2026).
- **Use Edge, but surgically** — one session, reused; few screenshots.
- **Stage the delivery.** Each stage is reviewed before the next starts.
- **Every change answers the mode question: Single, Multi, or both?** Multi adds *runs*, and
  anything hanging off one (`state.runs`, `currentRun()`, `traceForSession()`) is invisible in
  Single. Say which in the commit; detail in `docs/notes/project-chat.md`, "One code path, two modes".

### Version control

- **Commit before every important change** — a stage, a refactor, a risky fix, and
  again when it works. Small commits; the message says what changed and why.
- **`data/`, `logs/` and the projects root stay out of git** — PIDs, probe output,
  session logs and scratch projects, all local and regenerable.
- **Check `git status` before and after**; no build junk, no filled-in config.
- **Remote: `origin` → `github.com/DarkDvr/Synapse` (private).** Push `main`; never force-push or rewrite history. The suite, and the run it triggers there, is `docs/notes/tests.md`.

### Versioning: commit, bump, tag, push

`package.json` holds `major.minor.patch` (fix = patch, feature = minor, break = major).
**Finished work is delivered, not left local**: when it passes the suite and no real run
is live, bump, commit, tag `vX.Y.Z`, and push `main` and the tag — do not wait to be
asked; the version is how the operator knows which build is answering. **A GitHub
release is their call** (`docs/notes/releases.md`): the zip, `SHA256SUMS` and the
release page happen only when they ask. The push is not the release. Once a
release is published with notes, **the local note is deleted** — the release page
is the record.

**Then restart the whole app**: stop it, launch `Synapse.exe` — window, tray and server. A
server-only restart leaves the page on the old build; check the version. **Read
`/api/runs` and `/api/pending` immediately before the stop** — a reading from earlier
in the session is stale; a run can start in between (8 Nov: a t5 died that way).

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
2. **Dry-run first.** Run the *selection* alone, print what it matched — count it,
   read the paths — and only then act. It costs seconds; skipping it cost days.
3. **Make the selector narrow and provable.** `*node_modules\@opencode\cli*`
   matches only the engine. `*@opencode*` matches the operator's editor.
4. **Guard anything that must never be touched** with an explicit denylist
   (`@opencodedesktop`, `ai.opencode.desktop`, `BraveSoftware`).
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
| `docs/notes/web-reading.md` | before promising to read a signed-in site, or touching any browser — every cookie route was measured, one destroyed the operator's browser data, and Brave is never touched |
| `docs/notes/browser.md` | before touching `src/browser/`, `src/mcp/browser-server.js` or the Browser tab — SynaBrowse's flags, its profile, the Sites record and the hand-off |
| `docs/notes/project-chat.md` | before changing how a project, a chat or a compaction works — the one-chat-per-project scope, its phases and what is still open |
| `docs/notes/protection.md` | before touching `src/protection.js`, the prohibited list, or the Brave rule — what is refused without asking, and what the fence cannot see |

Two rules: **a new lesson goes in `docs/notes/`, not here**; and a rule you move out
leaves its invariant behind in one line. Deferred work lives in the note that owns it.
**A past session's constraint is history, not a rule**: this file wins a disagreement.

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

Gotchas:
- **Auto-Shutdown must be off before any test, build or restart.** It powers the PC off
  when every plan is done and nothing is running; on 11 Nov it shut this machine down
  twice mid-session. The switch is the project's cog, not the number in Settings.
- **Nothing here matches on a process name** (see "Destructive commands"): the app
  stops the process it holds, and `Kill(entireProcessTree)` is the fallback after 8s.
- The console is in the window: stdout is captured into `logs\console.log` and served,
  so it works when the server is stopped; `logger` mirrors `app`, warnings and errors.
- Ports: **UI 8700, engine 8720**; 1174–1273 belong to Hyper-V/WSL — do not pick one.

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
  app.js              boot, the event stream and the wiring (modules beside it)
  md.js               the markdown renderer (escape-first, fenced code, GFM tables)
  rate.js             tokens per second, measured from the stream
  synapse.css         theme + shell; panel.css the main-panel grid
  vendor/             fonts (offline) and the baseline stylesheet
  favicon.ico         the same, packed as a multi-size icon
skills/               shipped WITH Synapse, always on the engine's skill path
  visual-review/      render a page to PNG, then read it (the agents' eyes)
  app-check/          launch a desktop app, photograph its window, report if it lived
  win-app/            the Windows shell (WPF + WebView2) and its build steps
  ui-design/ frontend-design/ aesthetic-foundations/ code-craft/ web-guidelines/
                      the craft briefs: direction, tokens, states, colour, hierarchy
data/                 runtime state (projects, census, probe results, engine home)
logs/                 one file per channel: app, engine, session, tools
bin/opencode/         a copy of the runtime that travels with the app (not in git;
                      vendor-engine.ps1 puts it there, ~210 MB, with its licence)
docs/notes/           the detail behind this file; the index is in "Where the rest lives"
```

**`web/vendor/summit.css` is a locked baseline.** The only edit ever made to it
is line 1: the Google Fonts `@import` was replaced with a comment, because
fonts must be local. Do not restyle it — put changes in `synapse.css` (theme and
components) or `panel.css` (the main panel's grid).

---

## Engine API: the things that cost time

**The schema dump is a starting point, not the truth. The running engine is the
truth.** `%LOCALAPPDATA%\Temp\opencode\openapi.json` is a snapshot
of some earlier engine, and on 25 Oct it described an attachment shape that 2.1.2
refuses outright (`Missing key at ["files"][0]["uri"]` — it wants `{uri}`, not
`{data, mime, source}`). Read the dump to know what to try, then **probe the live
engine once before building on it**: send the body you expect and read the 400.

**The engine is 2.2.6.** The table below was measured on 2.0.30 unless it says
otherwise; each upgrade is re-verified on the routes Synapse depends on. **The model
catalog ships inside the engine binary, not in Synapse** — so a stale model list means
a stale *binary*, never a stale cache. The console prints `catalog: N model(s) from
engine X` at every boot, which is the check; the update dialog (see
`docs/notes/models-and-tools.md`) is the fix.

| Thing | Reality |
|---|---|
| `POST /api/session` | accepts `location:{directory}`. **A session cannot run in a directory that does not exist** — the engine throws `LocationNotFoundError` on prompt. Synapse creates the folder when a project is added. |
| `PATCH /api/session/{id}` | accepts only `title`, `metadata`, `permissions`. **Not `agent`.** Returns **204 with an empty body** — do not try to parse it. `permissions: []` clears the ruleset; that is how Single→Multi is applied to an open session. |
| `POST /api/session/{id}/model` | switches model and thinking effort for later turns. Body `{model:{providerID,id,variant?}}`; **204, empty body**. Omitting `variant` makes the engine store `"default"` — see "Context windows and thinking effort". |
| `POST /api/session/{id}/generate` | one-shot completion in the session's context. Returns `{data:{text}}`. **Adds nothing to the transcript** — this is how sessions get named. |
| `POST /api/session/{id}/prompt` | accepts `text`, `files`, `agents`, `skills`, `metadata`, `delivery`, `resume`. **`delivery: "steer"` is the default and joins the running turn at its next step; `"queue"` waits for it to end.** An `agents:[{name}]` attachment does **not** change the acting agent. **A file is `{uri, name}`, and a `data:` URI is accepted** — measured on 2.1.2, see the dump warning above. |
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
