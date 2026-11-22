# AGENTS.md — working notes for Synapse

For any agent picking Synapse up cold: what it is, the rules that are not negotiable,
how to run it, and the engine traps that cost real time. Read this, then the one
`docs/notes/` file that matches what you are about to touch (the index is below).

---

## What Synapse is

A self-contained Windows agent-build harness: pick models in the UI, discuss the work,
let the Architect keep a Project Plan, and watch workers execute it live. It is **not** a
wrapper around the OpenCode desktop app — it drives the genuine `opencode.exe` over its
HTTP + SSE API and rebuilds the interface from scratch.

Everything lives in `F:\dev\Synapse`; its projects folder is the sibling
`F:\dev\Synapse.Projects`, and nothing is written into the user's profile. **It is a
harness for any project, and any model.** No project, product or model may be named in
its code, its briefs or its config: a rule shaped around one project's incident is wrong
for the next one. Write the general rule here and the incident that earned it in
`docs/notes/`. The same goes for numbers: never bake in one model's context window, token
budget or speed.

## How to write

Plain English first, then the detail: the operator reads the console, the logs, the cards
and the commits, not the code. One reason per sentence.

- The everyday word: "the server is down", not "the listener is unreachable". Names that
  are real stay: `engine`, `session`, `plan`, `run`.
- It covers comments, logs, commits, docs and UI text. Code keeps its own names:
  `guardQuestions` says more than `checkStuff`.

---

## Hard rules

1. **Zero npm dependencies.** Plain Node: `http`, global `fetch`, `child_process`, `fs`.
   No build step, no bundler, no framework. If a problem looks like it needs a package,
   solve it in the standard library — web search, MCP, markdown and the UI are hand-rolled.
2. **Self-contained and offline.** No CDN links, fonts and assets vendored. The network is
   used for the work — the provider, a page a model fetches — for the two update feeds
   (`src/engine-update.js`, `src/synapse-update.js`), and to provision a runtime into
   `bin\` (rule 3). The feeds cache their answers and download only when Update is pressed.
3. **A good tenant.** Whatever Synapse needs it installs itself, silently, inside this
   folder — `bin\node`, `bin\opencode`, `vendor\`. Never `winget`, a global install, a PATH
   edit, the registry or `%APPDATA%`. The machine is borrowed; the folder is ours. See
   `docs/notes/desktop-app.md`.
4. **The engine home is isolated.** `data\engine\opencode` is set via `XDG_CONFIG_HOME` /
   `XDG_DATA_HOME` / `XDG_STATE_HOME` / `TMPDIR`. The machine-wide `~/.config/opencode`
   must never be touched.
5. **Engine-agnostic core.** Nothing OpenCode-specific outside `src/engines/opencode.js`.
   A new engine is one file implementing `src/engines/base.js`.
6. **Config is a file, the UI is a GUI over it.** `config\synapse.config.json` is the source
   of truth. No hidden state in the UI.
7. **No code-crutches.** Do not fake capability. If something cannot be done, say so rather
   than drawing a mock that implies it works. Never print secrets or tokens.
8. **A model touches its project, reads the harness, and asks for the rest.**
   `src/permissions.js` decides and the engine enforces: outside the project it asks,
   another project is refused, inside the harness writes are refused, credential stores are
   refused. The prohibited list outranks every rule here (`docs/notes/protection.md`). Do
   not widen a zone in a brief or a config — change the policy and its tests.
9. **Edge or headless, never Brave.** Touching Brave resets its extensions, cookies and
   settings. Open links in Edge by full path, take pictures with `skills/visual-review`,
   and leave the seeded Brave entry in the prohibited list alone.
10. **Auto-Shutdown is the operator's switch alone.** Only the Synapse window may turn it
    on. `scripts\checks.mjs` turns it off before a run and leaves it off — a test or a
    script may never arm the power-off.

### Palette (do not break this)

- **Violet** = fills and surfaces. **Orange** = accents only (text, borders, dot-ants).
  **Never orange text on a violet fill** — use white.
- Green / amber / red are semantic only, never decorative.
- Affordances: `+` green, `✕` red, edit/settings yellow. The composer's **Stop is red**
  whether or not hovered, and Settings' **Revert** is red too — the two controls that throw
  work away.
- **The live path is one colour: a yellow arrow with yellow ants**, separated from the
  orange accent by their glow. Delegation cards wear the same **yellow** while in flight,
  and **red means blocked and nothing else**.
- **All button labels are Title Case.** Buttons only — not headings, body text or tooltips.

### Working style

- **The chat is how the operator is shown anything.** A screenshot you take reaches only
  you; put it in the project (`.project/shots/`) and write it into a message as markdown —
  `![what it shows](.project/shots/shot.png)`.
- **Use Edge, but surgically** — one session, reused; few screenshots.
- **Stage the delivery.** Each stage is reviewed before the next starts.
- **Every change answers the mode question: Single, Multi, or both?** Multi adds *runs*,
  invisible in Single; say which in the commit (`project-chat.md`, "One code path, two
  modes").
- **A card, a question and a stop belong to their chat**, not to the page.

### Version control

- **Commit before every important change** — a stage, a refactor, a risky fix, and again
  when it works. Small commits; the message says what changed and why.
- **`data/`, `logs/` and the projects root stay out of git.**
- **Check `git status` before and after**; no build junk, and no keys in the config.
- **Remote: `origin` → `github.com/DarkDvr/Synapse` (private).** Push `main`; never
  force-push or rewrite history. The suite and its GitHub run: `docs/notes/tests.md`.

### Versioning: commit, bump, tag, push

`package.json` holds `major.minor.patch` (fix = patch, feature = minor, break = major) and
**is the single source**: `shell/Synapse.csproj` `<Version>` and the line under the README
title move in the same commit, and `tests/version.test.mjs` fails when the three disagree.

**Finished work is delivered, not left local**: when it passes the suite and no real run is
live, bump, commit, tag `vX.Y.Z`, and push `main` and the tag. **A GitHub release is the
operator's call** (`docs/notes/releases.md`): the zip, `SHA256SUMS` and the release page
happen only when they ask. A docs-only change is a commit, not a release.

**Then restart the whole app**: stop it, launch `Synapse.exe` — window, tray and server. A
server-only restart leaves the page on the old build; check the version. **Read `/api/runs`
and `/api/pending` immediately before the stop** — an earlier reading is stale. The last
word on a live turn is `scripts\wait-for-idle.mjs` (`docs/notes/runbook.md`).

### Destructive commands — verify before you act

This machine is shared: the desktop app, a browser with hundreds of processes, games,
other agents. A broad "cleanup" is collateral damage.

**Never match processes by name or by a loose path fragment.** `Get-Process -Name
opencode` also matches `OpenCode`, the desktop app, whose path contains `@opencode`; that
filter force-killed the operator's editor on every restart for several rounds.

1. **Prefer an identity you own** — a pid from a file Synapse wrote (`data\synapse.pid`,
   `data\engine.pid`), never a name.
2. **Dry-run first.** Print what the selection matched, then act.
3. **Make the selector narrow and provable.** `*node_modules\@opencode\cli*` matches only
   the engine; `*@opencode*` matches the operator's editor.
4. **Denylist what must never be touched** (`@opencodedesktop`, `ai.opencode.desktop`,
   `BraveSoftware`).
5. **When something breaks repeatedly and the evidence does not fit, suspect your own
   tooling first.**

---

## Where the rest lives

The detail is in `docs/notes/`, read **on demand** — a document an agent does not know to
open is a document that does not exist:

| Read this | before |
|---|---|
| `docs/notes/engine-notes.md` | changing `src/api.js`, `src/runs.js`, `src/plans.js` or `src/engines/opencode.js` — the plan contract, delegation and its ladder, instruction entries, permission rules |
| `docs/notes/models-and-tools.md` | touching model choice, the catalog cache, the probe or the engine update — context windows, variants, marks |
| `docs/notes/runtime-scope.md` | work on Synapse's own runtime — what a replacement costs, the staged path |
| `docs/notes/ui-lessons.md` | touching `web/` — layout invariants, the chat dock, the ask panel, cards and picker, with measurements |
| `docs/notes/chat-inventory.md` | changing a chat behaviour rather than guessing it — every thing the conversation can show, and the defect each row still has |
| `docs/notes/runbook.md` | running, restarting or debugging it; anything that kills a process |
| `docs/notes/desktop-app.md` | touching `shell\`, `Synapse.exe`, `bin\node`, npm or a dependency — the good-tenant rule, the process model, exit codes |
| `docs/notes/remote-access.md` | the LAN switch, the token or the login page |
| `docs/notes/multi-user.md` | two views at once — what "busy" means, Stop as the takeover, the Settings lock |
| `docs/notes/web-reading.md` | reading a signed-in site, or touching any browser — every cookie route was measured, one destroyed browser data, Brave is never touched |
| `docs/notes/browser.md` | `src/browser/`, `src/mcp/browser-server.js` or the Browser tab — SynaBrowse's flags, profile, sites record, hand-off |
| `docs/notes/project-chat.md` | how a project, a chat or a compaction works — one chat per project, the project document, scratch, Private |
| `docs/notes/protection.md` | `src/protection.js`, the prohibited list or the Brave rule — what is refused without asking, and what the fence cannot see |
| `docs/notes/tests.md` | adding a test, or when CI is red — the one rule a test must keep |
| `docs/notes/git.md` | git, the diff or a checkpoint — who commits, what the private MinGit installs |
| `docs/notes/backlog.md` | choosing what to build next; parked defects live in `docs/notes/findings.md` |
| `docs/notes/releases.md` | bumping, tagging or building a release — the three places the version lives |

Two rules: **a new lesson goes in `docs/notes/`, not here**; and a rule you move out leaves
its invariant behind in one line. **A past session's constraint is history, not a rule**:
this file wins a disagreement.

## Running it

```
Synapse.exe        # the app: window, tray icon, and the server it starts
.\shell\build.ps1  # build it — one lean exe at the root, needs the .NET 10 runtime
vendor-node.ps1    # copies Node into bin\node so the folder travels
vendor-engine.ps1  # copies the engine into bin\opencode so it travels with the app
```

`Synapse.exe` is the only thing launched. Close hides the window to the tray; the tray
stops and starts the server, and Exit is the only way to stop both. The server alone:
`bin\node\node.exe src\index.js`.

- **Run the checks through `bin\node\node.exe scripts\checks.mjs`.** A test run looks like
  "nothing to do" to the app, so Auto-Shutdown can power the PC off under it — it did on 11
  and 15 Nov. The script turns every project's Auto-Shutdown off, proves it, runs the
  suite and leaves them off.
- **Nothing here matches on a process name**: the app stops the process it holds, and
  `Kill(entireProcessTree)` is the fallback after 8s.
- The console is in the window: stdout is captured into `logs\console.log` and served, so
  it works when the server is stopped.
- Ports: **UI 8700, engine 8720**; 1174–1273 belong to Hyper-V/WSL — do not pick one.

## Layout

```
Synapse.exe     the app — window, tray, server supervisor (build output)
shell/          the WPF frame: App, MainWindow, ServerHost, ConsoleStore
src/            index.js boots it; server.js the routes, api.js the operations; runs.js
                delegation, plans.js the plan and briefs, permissions.js the policy,
                protection.js the prohibited list, engines/ (base + opencode), mcp/,
                browser/ (hidden desktop, agent-browser, refs)
web/            index.html, app.js and its modules; md.js, synapse.css, panel.css, vendor/
skills/         shipped: visual-review, app-check, win-app, and the craft briefs
tests/          node --test, one file per subject; run through scripts\checks.mjs
scripts/        checks.mjs (the suite, Auto-Shutdown off); wait-for-idle.mjs
config/         synapse.config.json (this machine's answers); config.default.json ships
data/           runtime state: engine home, browser profile, caches, pids
logs/           one file per channel: app, engine, session, tools
bin/            Node, a private Git, the engine and agent-browser, vendored (not in git)
docs/notes/     the detail behind this file
```

**`web/vendor/summit.css` is a locked baseline.** Its only edit ever is line 1 (the Google
Fonts `@import` replaced with a comment, because fonts must be local). Put changes in
`synapse.css` (theme, components) or `panel.css` (the stage grid).

## Engine API: the things that cost time

**The schema dump is a starting point, not the truth. The running engine is the truth.**
`%LOCALAPPDATA%\Temp\opencode\openapi.json` is an old snapshot: it described an attachment
shape 2.1.2 refuses (`Missing key at ["files"][0]["uri"]`). Probe the live engine once.

**The engine is 2.2.6.** **The model catalog ships inside the binary, not in Synapse** — a
stale model list means a stale *binary*. The console prints `catalog: N model(s) from
engine X` at every boot, which is the check.

| Thing | Reality |
|---|---|
| `POST /api/session` | takes `location:{directory}`. **A session cannot run in a directory that does not exist** — the engine throws `LocationNotFoundError` on prompt. |
| `PATCH /api/session/{id}` | only `title`, `metadata`, `permissions`. **Not `agent`.** Returns **204 with an empty body** — do not parse it. `permissions: []` clears the ruleset; that is Single→Multi. |
| `POST /api/session/{id}/model` | body `{model:{providerID,id,variant?}}`; **204, empty**. Omitting `variant` stores `"default"`. |
| `POST /api/session/{id}/generate` | returns `{data:{text}}` and **adds nothing to the transcript**. |
| `POST /api/session/{id}/prompt` | takes `text`, `files`, `agents`, `skills`, `metadata`, `delivery`, `resume`. **`delivery:"steer"` is the default** and joins the running turn at its next step; `"queue"` waits. `agents:[{name}]` does **not** change the acting agent. **A file is `{uri, name}`.** |
| Turn boundaries | every turn ends with an **`idle` message** appended — the reliable end-of-turn signal. Do not invent a timer. |
| Shell exit codes | a non-zero exit is reported as `status=completed`. Synapse derives `failed` from the output. |
| `GET /api/session/active` | the authority on what is running; survives a restart. `GET /api/project` returns a bare array. |

## Lessons that cost a day each

- **A rule can be older than the thing it describes.** The plan was meant to be written once
  and executed; the record showed the Architect editing it daily. It is a work list now.
- **A brief change that lands while the server runs has not landed.** Check the boot line in
  `logs\app.log` before blaming the rule.
- **A rule must not contradict the pillar.** "Never re-render what a worker made" read as
  "trust its numbers", which inverts: a worker's output is a claim.
- **A watchdog that listens for one signal waits out its whole timeout.**
- **Measure the number, then believe it.** Most "slow model" reports were our arithmetic.
