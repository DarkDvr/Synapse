# Synapse

A self-contained Windows harness for talking to agent engines — today the genuine
**OpenCode** engine and its free models, tomorrow anything else that implements the
engine contract (LM Studio, Bionic, another service).

Everything lives in this folder. The only things reused from outside are standard
Windows tooling (`node`) and the engine binary itself.

## Run it

```
start.bat        # starts Synapse (UI on 8700, engine on 8720)
stop.bat         # reads data\synapse.pid
restart.ps1      # dev restart — stops the engine by PID, never by name
```

**Never restart by matching process names.** The desktop app installs to
`...\Programs\@opencodedesktop\OpenCode.exe`, whose path contains `@opencode`,
so a name filter such as `Get-Process -Name opencode | Where Path -like
'*@opencode*'` kills the operator's editor as well as the engine. That mistake
caused a string of "the desktop app keeps crashing" reports. `restart.ps1` reads
`data\synapse.pid` and `data\engine.pid`, and refuses anything under
`@opencodedesktop`.

`server.openBrowser` is off by default: a restart should not hijack a browser
tab. Turn it on in Settings if you want one opened for you.

Double-click **`start.bat`** (or run `node src\index.js`). Synapse will:

1. read `config\synapse.config.json`,
2. launch the engine in an isolated home under `data\engine\opencode` (it never
   touches your machine-wide `~/.config/opencode`),
3. serve the UI and open it in your browser at <http://127.0.0.1:8700>.

Stop with **`stop.bat`**, or `Ctrl+C` in the start window.

## Layout

```
F:\dev\Synapse
├─ start.bat / stop.bat        launcher + stopper
├─ config\synapse.config.json  ← the config file (settings UI edits this)
├─ src\                        backend
│  ├─ index.js                 boot: config → projects → engine → server
│  ├─ config.js                load / validate / save the config file
│  ├─ logger.js                per-channel rotating logs
│  ├─ paths.js                 all filesystem locations
│  ├─ projects.js              the project registry (data\projects.json)
│  ├─ titler.js                names a session after its first answer
│  ├─ toolstats.js             the tool-call census (data\tool-stats.json)
│  ├─ probe.js                 the tool probe: one turn per tool
│  ├─ search.js                dependency-free DuckDuckGo search
│  ├─ mcp/search-server.js     stdio MCP server exposing websearch to the engine
│  ├─ titles.js                the shared "TBD" placeholder
│  ├─ api.js                   stable engine-agnostic API
│  ├─ server.js                HTTP + static UI + SSE relay
│  └─ engines\                 ← swap this folder to change engines
│     ├─ base.js               the engine contract (+ normalizers)
│     ├─ opencode.js           OpenCode adapter
│     └─ index.js              engine registry
├─ web\                        the UI (no build step, no dependencies)
│  ├─ index.html               shell: sidebar · stage · inspector
│  ├─ vendor\summit.css        locked design baseline (see Design system)
│  ├─ vendor\fonts.css         local @font-face declarations
│  ├─ vendor\fonts\            DM Sans + Manrope, variable, latin subset
│  ├─ synapse.css              theme tokens + control-room shell
│  └─ app.js                   talks only to the Synapse API
├─ data\                       runtime state (engine home, pid file)
└─ logs\                       app.log, engine.log, session.log, tools.log
```

## Modularity

The UI only ever talks to the Synapse API (`/api/status`, `/api/models`,
`/api/sessions`, `/api/stream`, …). The engine adapter translates that to a
concrete backend. To replace OpenCode:

1. add `src/engines/<name>.js` implementing the contract in `base.js`,
2. register it in `src/engines/index.js`,
3. set `"engine": { "type": "<name>" }` in the config.

Nothing else changes. No OpenCode specifics leak outside its adapter.

## Design system

Two layers, the same pattern the shipping reference app uses:

| Layer | File | Rule |
| --- | --- | --- |
| Locked baseline | `web\vendor\summit.css` | the design library, byte-for-byte |
| Shell + theme | `web\synapse.css` | Synapse's tokens, layout and components |

**One deliberate change to the baseline:** its first line was an
`@import` that fetched DM Sans and Manrope from `fonts.googleapis.com`.
That breaks the offline requirement, so it is replaced with a comment.
Both families are now vendored as variable fonts in `web\vendor\fonts\`
(60 KB for every weight) and declared in `web\vendor\fonts.css`.

**Palette rule — violet fills, orange accents:**

- violet (`#625bf6`, soft `#302d59`) comes from the design spec and drives
  every fill: primary buttons, the active nav item, the current tree row,
  the active role cards, the user message, the active plan step.
- orange (`#ff7d1a`) is reserved for accents only: accent text, borders
  (connector rails, the lit arrowhead) and dot-ants.
- green / amber / red are semantic only — never decorative.

Affordance colours: `+` add is green, `✕` delete is red, `⚙`/`✎` are yellow.

**Sample vs. live.** Anything the app cannot really do yet is labelled
`SAMPLE` on the panel and its controls carry `data-soon`, which raises a
toast naming the stage that will wire it. The `calendar` and `resume-tailor`
projects are design previews; the `General` project and its sessions are real.

**Left rail is two-tier.** A project is a panel with its own surface, a
chevron, and its sessions indented on a guide line inside it. Sessions never
carry a background, so the two tiers never read alike.

**Connectors.** The idle structure is small round dots at 75% opacity with no
arrowheads. The one live connection is drawn as a solid orange path from the
requester, down the spine and into the worker, ending in an arrowhead that
touches the card edge, with pale glowing ants travelling it. `web\app.js`
computes that path from the real card and connector-cell boxes
(`drawActivePath`) at full precision — the spine's exact centreline and the
dotted band's exact centre — so the orange covers the dots with no sub-pixel
step, and it survives any layout change.

**No topbar.** The main pane starts at the top edge. Breadcrumbs were dropped
(the tree highlights the current project and session) and the default model /
mode moved into Settings, where they are now populated selects rather than
free-text. The last engine event is a row in the sidebar's STATUS block.

**Row highlighting is one token.** The baseline paints table rows `#fcfcff`
on hover in every theme; Synapse overrides that globally to `--hover-bg`
(`#24262b`), and the tree, nav, plan and table rows all share it.

**Status dots need a display.** They are `inline-block` on purpose: as inline
spans `width`/`height` are ignored, the dot collapses to zero and only its 4px
ring paints — which renders as a square. In the dense tools table the ring is
switched off so the dots stay bare circles.

**Error affordance.** `.err-btn` is the small borderless red **Error** button
(faint red fill, matching the reference app); it is used for both the plan's
blocked step and the tools table's failed call. Modal closes use `.close-x`
instead — a plain ✕ that is deliberately not the error button.

**Settings** is a two-column grouped form (`.set-group` / `.set-grid`, with a
`.cols-3` variant) that fits without scrolling; the checkbox leads its label
rather than sitting beneath it.

**Role cards are a fixed size.** `--card-h` pins every card; the action text
clamps to two lines and footer chips ellipsis. Content never resizes a card —
new fields need a deliberate design pass instead of silently stretching rows.

## Configuration

`config\synapse.config.json` is the single source of truth. The in-app
**Settings** drawer is just a GUI over it. Key settings:

| Key | Meaning |
| --- | --- |
| `server.port` | where the Synapse UI is served (default 8700) |
| `server.openBrowser` | open the browser automatically on start |
| `engine.type` | which engine adapter to use (`opencode`) |
| `engine.opencode.binary` | path to `opencode.exe` (`""` = auto-detect) |
| `engine.opencode.port` | engine port (default 8720) |
| `engine.opencode.password` | server password (`""` = generated once into `data\`) |
| `engine.opencode.home` | engine home (`""` = `data\engine\opencode`) |
| `defaults.model` | default model ref, e.g. `opencode/…-free` |
| `defaults.agent` | default agent |
| `defaults.directory` | default working directory for sessions |
| `logging.retentionDays` | logs older than this are deleted (default 7) |

## Projects and sessions

A **project is a directory**. The engine scopes every session to a working
directory, so Synapse does not invent a parallel concept: `data\projects.json`
just remembers which directories the operator added. Sessions are assigned to
the project whose directory they run in.

- **General** is always present, first, undeletable and is the workspace root —
  it holds sessions that belong to no project you are working on.
- **Adding a project** creates the folder when it is missing (the engine
  refuses to run a session in a directory that does not exist).
- **Removing a project** only forgets the registry entry. Nothing on disk is
  touched. Synapse refuses while sessions still live in it, so a session is
  never left without a project.
- **Session names** start as `TBD`. When the first turn succeeds, Synapse asks
  the model for a short title through the engine's one-shot `generate` route —
  which does **not** add anything to the transcript — and renames the session.
  One attempt per session, never for a session you have named yourself.
- **The design topology, plan and tools table are sample data.** They live
  behind the `Design preview` entry in the tree and are labelled wherever they
  appear; real orchestration is stages 3–6.

**Interaction rules.**
- **Button labels are Title Case**, always ("Browse Folder", "Allow Once", "Add Project"). Nothing else is forced to a case.
- **A tool call is one line** — name, what it is running, outcome — with a `›` chevron; the full input and output are one click away. A call that failed gets a red dot, an `exit N` pill and an **Error** button, because the engine reports a non-zero shell exit as `completed`; `normalizeMessage` derives the real outcome.
- **Destructive confirmations share one dialog** (`confirmDelete`): same title pattern, same consequence sentence, same `Delete` / `Cancel` pair.
- **A working session shows a yellow dot** next to its own name and next to its project's, so the rail says where work is happening without opening anything.
- **Timestamps** sit at the right of each message's first line (`HH:MM`, 24-hour).
- **Chat navigation** (↑/↓) appears at three or more of your own messages and rests when there is nothing to scroll to.

**Naming is self-healing.** A session left `TBD` because the engine returned a transient 503 keeps its attempt, retries with backoff, and a sweep at boot names anything still unnamed. Naming never spends an attempt on a session with no user message yet, and never overrides a name you set yourself.

**Never stall.** A session can block silently — the engine emits nothing at all while it waits, so it has to be polled for:
- **Permissions and forms** are both rendered and answerable. A *form* is an agent asking for structured input (string / number / boolean / multiselect); it blocks exactly like a permission does. `GET /api/pending` returns both, so a reload no longer strands a session that was waiting.
- **Stall detection.** A running session that emits nothing for 3 minutes is flagged: its dot in the rail turns red and clicking it interrupts. Measured caveat — a legitimately long tool emits nothing either (a 100s shell command logs one progress event, then silence), so an in-flight tool always counts as progress and is never flagged. The window is 3 minutes because first-token latency on the free models was measured at 69s on a cold start.
- **`/api/session/active` is the authority** on what is running; SSE keeps the rail snappy between polls and the poll corrects any drift (including across a Synapse restart).

**Tool census.** Every finished turn is scanned once and its tool calls recorded (keyed by part id, so re-reading a transcript never double-counts) into `data\tool-stats.json`: per tool and per model — calls, failures, exit codes, average execution time, and the last 20 error signatures. Read it at `GET /api/tools/stats`; the inspector's **Tools in use** panel shows the live summary. This is how we find out what these models actually reach for, instead of guessing.

**Tool probe.** The census says what has happened; the probe finds out on purpose. **Run Tool Probe** in the *Tools in use* panel drives one turn per tool in the engine's real toolset — `shell` (pass and fail), `read`, `write`, `edit`, `glob`, `grep`, `question`, `webfetch` (good host and bad host), `websearch`, `subagent`, `execute`, `skill` — each in a disposable scratch session (`workspace\_probe`). Per case it records whether the turn closed, which tool actually ran, whether it failed, and **the tool's own execution time** (not the turn time, which is mostly the model thinking). Results stream into the panel live; `GET /api/tools/probe`, `POST /api/tools/probe/run`.

Two things the first run of it proved, which is the point of having it:

- The model's real toolset is *not* what you would guess. It reports `edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch, write, execute`. There is no `list` and no `todowrite` here — asked for `list`, the model used `read`; asked for `task`, it used `subagent`.
- `question` raises a form and blocks the session until answered. The probe auto-answers it, which exercises the form path and keeps the run moving. A case that times out is interrupted before the next one starts, otherwise the wedge is inherited and every later case fails too.

**The toolset is per-model.** It changes between models, between agents, and even between calls — one run reported `execute`, the next did not. So the probe asks the model what it has before it starts, shows that list, and labels a failure "not offered by this model" instead of "not called" when the tool was never in the list. MCP tools arrive namespaced (`synapse-search_websearch`), so matching is suffix-based.

## Web search

The engine's built-in `websearch` needs a search provider key and answers **HTTP 403** on this machine, so the models had no working search at all. Rather than leave it broken, Synapse ships its own.

`src/search.js` queries DuckDuckGo's HTML endpoint and parses the results — no key, no package, no Python. (The same approach as the `ddgs` package used in BotChat's `classifier.py`, reimplemented so Synapse stays dependency-free.) Measured: HTTP 200 in ~850ms, ~40 result links per page.

`src/mcp/search-server.js` is a plain stdio MCP server exposing one tool, `websearch`. At engine start Synapse writes it into the engine's **isolated** config (`data\engine\opencode\config\opencode\opencode.json`) — the machine-wide `~/.config/opencode` is never touched — along with `websearch: false`, which switches the broken built-in off so the model cannot pick it by accident.

Two things that had to be right, both found by testing rather than reading:

- **`codemode: false` on the MCP server.** Left on, the engine exposes MCP tools through its code-mode tool as `tools["synapse-search"].websearch`, and the model tries to call that literal string as a tool name — which the engine rejects. Off, it is an ordinary tool: `synapse-search_websearch`.
- **`websearch: false`.** With both present the model chose the broken built-in by name familiarity. With only one, it uses ours.

Verified end to end: the model called `synapse-search_websearch` twice, got live results, and answered correctly.

## Multi vs Single mode

A small toggle sits in the composer, between the role picker and the message box.
**Both modes have the full toolset** — that is the point of them.

- **Multi** — the Architect can hand work to workers and the role cards are shown.
  (The multi-agent workflow itself lands with the orchestration layer.)
- **Single** — the same tools, but delegation is denied, so the Architect answers
  everything itself in one chat and the role cards do not appear.

Single is a **permission ruleset on an ordinary session** that denies only the
delegation tool:

```json
[{ "action": "subagent", "resource": "*", "effect": "deny" }]
```

Two designs that look right and are not:

- A dedicated `chat` agent (tools denied, `steps: 1`). The free tier rejected
  **every** request from a custom agent with a provider auth error — measured
  side by side, a custom-agent session failed at `20:45:37` while a
  default-agent session succeeded at `20:45:40`.
- Denying *all* tools. That gives a plain chat with no tools at all, which
  defeats the purpose: Single is meant to be a capable single agent.

The engine fixes a session's permissions at creation — `PATCH /api/session/{id}`
accepts only `title`, `metadata` and `permissions` — so:

- toggling with an **empty** session open swaps it for one in the right mode;
- toggling with a session that has **messages** keeps that session as it is and
  tells you so; the next new session uses the new mode, and sending continues in
  a fresh session.

The choice is remembered in `config\synapse.config.json` as `defaults.mode`.

## Markdown

The model's actual answer is rendered as markdown inside its own panel — a thin
border and a faint tint — so it reads separately from the reasoning and tool
noise around it.

`web/md.js` is hand-rolled (no dependencies) and **escape-first**: the source is
HTML-escaped before any markdown rule runs, so a model cannot inject markup
through its answer. It covers fenced code, headings, blockquotes, ordered and
unordered lists, rules and paragraphs, plus inline code, bold, italic,
strikethrough and links — the range these models actually produce. Link targets
are restricted to `http(s)`, `mailto`, `/` and `#`.

## Logs

Separate channels for easy bug-tracking:

- `logs\app.log` — server lifecycle and config
- `logs\engine.log` — engine process output and stream health
- `logs\session.log` — session creation, prompts, session events
- `logs\tools.log` — tool calls and permission requests (raw payloads)

Files rotate at `logging.maxFileMb` and are auto-deleted past
`logging.retentionDays`.
