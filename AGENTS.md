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
   model provider. Fonts are vendored locally. No CDN links, ever.
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
- Affordances: `+` green, `✕` red, edit/settings icons yellow.
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
  search.js           dependency-free DuckDuckGo search
  mcp/search-server.js stdio MCP server exposing websearch to the engine
  engines/base.js     engine contract + message normalisation
  engines/opencode.js the OpenCode adapter
web/
  index.html          the shell
  app.js              all UI logic (ES module)
  md.js               the markdown renderer (escape-first, no dependencies)
  synapse.css         theme + shell (Summit baseline stays locked)
  vendor/summit.css   LOCKED baseline — one deliberate edit, see below
  vendor/fonts.css    vendored DM Sans + Manrope (offline)
data/                 runtime state (projects, census, probe results, engine home)
logs/                 one file per channel: app, engine, session, tools
```

**`web/vendor/summit.css` is a locked baseline.** The only edit ever made to it
is line 1: the Google Fonts `@import` was replaced with a comment, because
fonts must be local. Do not restyle it — put changes in `synapse.css`.

---

## Engine API: the things that cost time

Route and schema ground truth is the OpenAPI dump at
`%LOCALAPPDATA%\Temp\opencode\openapi.json`. Check it before
guessing.

| Thing | Reality |
|---|---|
| `POST /api/session` | accepts `location:{directory}`. **A session cannot run in a directory that does not exist** — the engine throws `LocationNotFoundError` on prompt. Synapse creates the folder when a project is added. |
| `PATCH /api/session/{id}` | accepts only `title`, `metadata`, `permissions`. **Not `agent`.** Returns **204 with an empty body** — do not try to parse it. |
| `POST /api/session/{id}/generate` | one-shot completion in the session's context. Returns `{data:{text}}`. **Adds nothing to the transcript** — this is how sessions get named. |
| `POST /api/session/{id}/prompt` | accepts `text`, `files`, `agents`, `skills`, `metadata`, `delivery`, `resume`. An `agents:[{name}]` attachment does **not** change the acting agent. |
| Turn boundaries | every turn ends with an **`idle` message** appended. That is the reliable end-of-turn signal — do not invent a timer. |
| Shell exit codes | a shell command exiting non-zero is reported by the engine as `status=completed`. Synapse derives `failed` from the output. Never trust the raw status for shell. |
| `GET /api/session/active` | the authority on what is running. Survives a Synapse restart. |
| `GET /api/project` | returns a bare array, not `{data:…}`. |

---

## MCP: how the engine exposes tools to models

Synapse registers its own MCP server in the engine's isolated config at
`data\engine\opencode\config\opencode\opencode.json`, which it rewrites on every
boot.

```json
{
  "mcp": { "servers": { "synapse-search": {
    "type": "local",
    "command": ["<node>", "F:\\dev\\Synapse\\src\\mcp\\search-server.js"],
    "codemode": false
  } } },
  "websearch": false,
    "skills": { "paths": ["C:\\Users\\Andrew\\.agents\\skills"] }
}
```

Two non-obvious things, both found by testing:

- **`codemode` must be `false`.** Left on, the engine exposes MCP tools through
  its code-mode tool as `tools["synapse-search"].websearch`, and the model tries
  to call that literal string as a tool name — which the engine rejects.
- **`websearch: false` matters.** The engine's built-in search needs a provider
  key and answers **HTTP 403** here. With both present the model picks the
  broken one by name familiarity; with only ours, it uses ours.

MCP tools arrive **namespaced** (`synapse-search_websearch`). Match
names by suffix, not equality.

**Keep it to what is needed.** A `time` tool was added here as a special case
for one question the operator asked while testing search, and he asked for it to
be removed — it was not a real capability the product needed, and it was bloat.
Ask before adding a special-case tool; add it only if it is genuinely useful for
real agentic development work.

---

## Tools and models

- **The toolset is per-model, per-agent, and even per-call.** One run reported
  `execute`, the next did not. Never hardcode an assumption about which tools
  exist — the probe asks the model and reports it.
- Observed toolset: `edit, glob, grep, question, read, shell, skill, subagent,
  webfetch, websearch, write, execute`. There is **no `list`** and **no
  `todowrite`**; asked for `list` the model used `read`, asked for `task` it
  used `subagent`.
- **`question` is the form mechanism.** It raises a schema-driven form and
  blocks the session until answered. Missing one stalls a session forever.
- **Tools are fast; models are slow.** Measured tool execution: file tools
  10–130ms, shell ~300ms, webfetch ~180–330ms, `execute` ~50ms. Turn times are
  3–80s because of model latency. Judge tools by their own `time.completed -
  time.created`, not by the turn.
- **The free tier throttles.** Under rapid requests the provider returns
  "OpenCode's free tier can only be used from within OpenCode." It is
  intermittent, not a ban. **Every test turn spends the operator's quota** —
  batch checks, and prefer a single turn that proves several things.

### The probe (`Run Tool Probe`)

Drives one turn per tool in a disposable scratch session
(`workspace\_probe`), records the tool's own execution time, and labels a
failure "not offered by this model" when the tool was never in its list.

- It **interrupts a timed-out case** before starting the next. Without that, the
  wedge is inherited and every later case fails too.
- Results persist to `data\probe.json` so a restart does not blank the panel.

---

## UI lessons

- **Scrollbar stability.** A scroll container must never change the width of its
  contents. `scrollbar-gutter: stable` is set on `html` and on `.chat-scroll`.
  Without it, expanding a tool made the page taller, the page scrollbar
  appeared, and the whole app shifted ~15px. Also: any grid column holding prose
  is `minmax(0, 1fr)`, never `auto`, so content cannot stretch it.
- **`.chat-scroll` scrolls internally; the page does not.** `.stage` has a
  definite `height: calc(100vh - 26px)` in the side-by-side layout, so the
  composer sits at the bottom of the window. In the stacked layout (below
  1180px) the stage is content-sized and the page scrolls again. Every scroll
  helper goes through `chatScroller()`, which returns the transcript when it
  scrolls and `null` otherwise.
- **Jump buttons are `position: fixed`**, anchored to the chat column by JS.
  Absolute positioning inside a content-sized dock put them in the middle of the
  log where they scrolled away and did nothing.
- **Status dots need `display: inline-block`** — as inline spans they ignore
  width/height and paint as a 4px square.
- **No duplicate status labels.** A failed tool card shows the `Failed` pill
  only; a failed probe row shows the `Error` button only.
- **Table cells must not be able to stretch the pane.** `.inspector .tool-table`
  is `table-layout: fixed` with ellipsised cells — a long MCP tool name like
  `synapse-search_websearch` otherwise blows the rail out to the right.
- The sidebar breakpoint is **1180px**. Below it the rail stacks under the chat,
  because the role cards need the width more than the rail needs to be beside.

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

## Open items

- **Per-role instructions and per-role skills.** The role-card edit button
  should open a picker for which skills that role may use, alongside its
  instructions. The engine takes skills globally (`skills.paths`); per-role
  gating would go through each agent's own permission rules. Decide this
  together with role instructions.
- **Stage 3 onward**: the Architect's real dev plan in the right pane
  (green/amber/red, red = hard-blocked), the status model, then the main-pane
  napkin, then the Tools-in-Use feed.
- **Multi vs Single mode.** The composer toggle picks one of two, and **both
  have the full toolset** — that is the whole point.
  - **Multi** — the Architect can hand work to workers (the multi-agent workflow
    still to be wired) and the role cards are shown.
  - **Single** — the same tools, but delegation denied, so the Architect answers
    everything itself in one chat, and the role cards do not appear.

  Single is a **permission ruleset on an ordinary session** that denies only
  `subagent`, not a custom agent and not a blanket deny. A dedicated `chat` agent
  (tools denied, `steps: 1`) is the obvious design and it does **not** work: the
  free tier rejected every request from a custom agent with a provider auth error
  (measured side by side — a custom-agent session failed at 20:45:37 while a
  default-agent session succeeded at 20:45:40). Denying everything also defeats
  the purpose, because Single is meant to have tools. `POST /api/session` accepts
  `permissions`, and `isSingleSession()` in `engines/base.js` reads it back.
  `PATCH /api/session/{id}` accepts only `title`, `metadata` and `permissions`.
- Adding skills later is just files in `%USERPROFILE%\.agents\skills` — they
  are already wired in.
