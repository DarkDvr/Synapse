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

### Version control

- **Commit before every important change** — before starting a stage, a refactor,
  or a risky fix, and again when it works. Small scoped commits, message says
  what changed and why.
- **`data/`, `logs/` and `workspace/` stay out of git** (already in
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
  md.js               the markdown renderer (escape-first, no dependencies;
                        fenced code, headings, GFM tables, task lists, images)
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
| `PATCH /api/session/{id}` | accepts only `title`, `metadata`, `permissions`. **Not `agent`.** Returns **204 with an empty body** — do not try to parse it. `permissions: []` clears the ruleset; that is how Single→Multi is applied to an open session. |
| `POST /api/session/{id}/model` | switches model and thinking effort for later turns. Body `{model:{providerID,id,variant?}}`; **204, empty body**. Omitting `variant` makes the engine store `"default"` — see "Context windows and thinking effort". |
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

### Context windows and thinking effort

`GET /api/model` reports `limit.context`, `limit.output` and `variants`; each
variant sets a `reasoningEffort`. Synapse surfaces all of it (`normalizeModel`)
and stores the operator's choice per role.

- **Omitting a variant is not "no effort".** The engine stores
  `variant:"default"`, which is not one of the advertised variants. Measured
  reasoning tokens on the same task: `low` 70, default 228, `max` 719 (r/opencode
  boundary test, Oct 2026).
- **The catalog is conservative.** DeepSeek V4.1 Flash Free advertises 200k
  context, but the backend serves **1,048,576** — boundary-tested: ~1.037M OK,
  ~1.107M HTTP 400. MiMo-V2.6-Flash and Big Pickle are still genuinely 200k, so
  **never raise a limit without testing that model**.
- Synapse writes overrides from `engine.opencode.modelLimits` (config file) into
  `providers.opencode.models.<id>.limit` in the isolated engine config on every
  boot. That changes only the engine's local budgeting ceiling; the provider's
  own limit still applies. Output limits were *not* tested — only context.

### The model cache (`data\model-cache.json`)

Models come and go; what we learned about one should outlive it leaving the
catalog. `src/modelcache.js` is a small JSON store **keyed by the full
`provider/id` ref**, because the same model can exist in more than one category
— `opencode/deepseek-v4.1-flash-free` and a future `opencode-go/…` are different
entries with different backends, and local runtimes will be more. Each record
holds name, provider, context/output, variants (`{id, label}` — label is the
provider's own `reasoningEffort`), capabilities, `firstSeen`/`lastSeen` and the
discovered toolset. `engine.listModels()` is recorded on every boot and every
`GET /api/models`, so the file stays current for free.

- **Each model is asked at most N times, ever** (default 3). The first selection
  fires `POST /api/models/inspect`; the server answers from cache when a *valid*
  (non-empty) tool list exists, refuses to stack a duplicate run, and serialises
  runs one at a time (`inspectChain`). A completed run increments `timesAsked`
  even when the answer is empty — an empty answer is only eligible for a retry
  while `timesAsked < modelChecks.maxAsks` (Settings, 1–20). At the cap the
  model is `exhausted` and is never asked again. The count is per model, so the
  attempts spread across selections and restarts. Synapse re-asks on boot for
  any **role's** current model that is still missing a valid list. Settings has
  **Reset Ask Counters**, which zeroes every model's count (valid results are
  kept). Verified: seeded one model at 3 asks → `{started:false, exhausted:true}`;
  another at 1 ask → asked again on restart and locked in; reset returned 11 and
  left `timesAsked` at 0 everywhere.
- The discovery prompt asks the model to list its tools; `parseToolNames` takes
  the last dotted segment (`tools["opencode"].list_mcp_resources` →
  `list_mcp_resources`) then keeps `[a-z0-9_-]` (MCP names contain hyphens — an
  earlier parser dropped them and turned `synapse-search_websearch` into
  `synapsesearch_websearch`).
- When the check finishes, `model.probed` goes out over SSE and the picker/effort
  tooltips gain a `· N tools` suffix. The picker menu itself shows a source chip
  (`OPENCODE`, `OPENCODE GO`, later a local provider) so two entries with the
  same display name can never be confused.
- `GET /api/models/cache` exposes the raw store for debugging.

### The probe (`Run Tool Probe`)

Drives one turn per tool in a disposable scratch session
(`workspace\_probe`), records the tool's own execution time, and labels a
failure "not offered by this model" when the tool was never in its list.

- It **interrupts a timed-out case** before starting the next. Without that, the
  wedge is inherited and every later case fails too.
- **The scratch session is invisible.** Probe and model-check sessions live in
  `workspace\_probe`; the API filters that directory out of project/session
  lists, so they never appear in the rail, and `probe.sweep()` deletes any
  leftover at boot (a killed process cannot leave a ghost). They are real
  engine sessions behind the scenes, not fake turns.
- Results persist to `data\probe.json` so a restart does not blank the panel.
  The run records **which model** it was against (captured after the toolset
  discovery turn — a fresh session reports no model before its first turn), and
  the panel names it above the results: tool timings and toolset are
  model-specific, so a result without a model is unreadable. The toolset list
  itself is **not** printed any more — the per-case table underneath is the
  useful view.

---

## Git on a session's first successful turn

Beside the auto-namer in `afterTurn`, Synapse checks the session's directory for
a repository (`git rev-parse --git-dir`) and runs `git init` if there is none.
This is once per directory per process and needs no config.

- `rev-parse` succeeds inside any **parent** repo, so a project folder under an
  existing repository is left alone — Synapse never creates a nested repo. That
  also covers `workspace\`, which lives inside Synapse's own repository.
- `git` missing or the command failing is logged and skipped; a turn never
  fails because of it. Verified the commands in an isolated temp folder:
  exit 128 before `git init`, `.git` and exit 0 after.
- The name and the repo are independent side effects of the same succeeded turn;
  the title is still the model's call through the one-shot `generate` route.

---

## UI lessons

- **Scrollbar stability.** A scroll container must never change the width of its
  contents. `scrollbar-gutter: stable` is set on `html` and on `.chat-scroll`.
  Without it, expanding a tool made the page taller, the page scrollbar
  appeared, and the whole app shifted ~15px. Also: any grid column holding prose
  is `minmax(0, 1fr)`, never `auto`, so content cannot stretch it.
- **`.chat-scroll` scrolls internally in the wide layout; the page scrolls in the
  stacked one.** Above 1460px `.stage` has a definite height (set from the
  measured viewport via `--stage-h`, minus any horizontal scrollbar), so the
  composer sits at the bottom of the window. Below 1460px the rail flows under
  the chat and the page scrolls by design. Every scroll helper goes through
  `chatScroller()`, which returns the transcript when it scrolls and `null`
  otherwise.
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
- **The working area is left-anchored and capped.** `.content-wrap` is a column
  flex item; `margin: 0 auto` on it was a real bug — auto cross-axis margins make
  a flex item **shrink-to-fit** instead of filling, so the whole `.room` sized
  itself to its content. Multi (wide topology) looked fine while Single (one
  card) collapsed to ~380px and drifted right. Fixed with `width: 100%;
  margin: 0` and `--work-w: 1240px` as the room's max-width: sidebar → cards+chat
  (1fr, left-anchored) → rail → empty space at the window's right edge. Both
  modes now measure the same room width (verified at 1680 and 1200).
- The full three-column layout is kept at every width: with the rail and the
  sidebar it needs **1460px**, and narrower windows scroll horizontally rather
  than stacking the rail. Stacking made the page taller than the viewport, and
  scrolling it carried the Architect card away.
- **Every role owns its model and effort — there is no "default model".** The
  Architect's choice lives in `roles.architect` like every other role, and is
  persisted in `config\synapse.config.json`; `defaults` holds only the working
  directory now. An older `defaults.model` is folded into `roles.architect` once
  by `normalize()` and the key is deleted. Changing the Architect card switches
  the open session immediately (`POST /api/session/{id}/model`); worker picks are
  stored for the orchestration layer, which is not built yet.
- **The thinking-effort button** shows 1–3 stacked **green** chevrons — dot =
  engine default, chevrons = the three highest variants a model allows. The
  chevrons are **one inline SVG per level** with integer-spaced paths: three
  separate SVGs and fractional negative margins rounded unevenly, so the gaps
  looked different. They are strokes with round caps, not a font and not rotated
  bordered boxes (those alias into odd shapes at 22px). Click cycles
  default → lowest → … → highest → default; the tooltip is
  `Current thinking effort: <label>` where `<label>` is the provider's own
  `reasoningEffort` value, never our id. Models with 2/1 variants get 2/1
  chevrons; a model with none gets a disabled button. The glyph is the Adamant
  assistant oracle chevron *redrawn at 22px*
  (`F:\dev\Obsidian.Adamant\...\adamant-assistant`) — shape only, no code copied,
  and that folder is read-only.
- **The Architect card is always visible; Multi reveals the workers.** The cards
  live in `#topologyWrap`, whose `max-height` animates between the Architect's
  height (Single) and the full topology (Multi). Worker children are hidden by
  `body[data-view="session"] .topology > *:not(.topo-architect):not(.path-layer)`
  and shown by the `workers-on` body class; on Multi→Single the class is removed
  only after the height animation, so the workers do not vanish mid-slide.
  **Single never trusts a measurement for its resting state.** The measured
  height drives only the 320ms collapse animation; afterwards `--reveal-h` is
  `none`, so the wrapper is exactly the Architect card by construction — a stale
  measure can never clip the card or grow a scrollbar. And `overflow: clip` (not
  auto, not hidden) on the Single wrapper means it is never a scroller at all:
  no scrollbar, no wheel/keyboard/script scrolling, while mid-flight content
  still clips correctly. Verified: wrap 60.27 = topology 60.27, `max-height:
  none`, round-trip Multi→Single settles exact.
  **The height cap is the part that bit twice.** Below 1460px the stage is
  content-sized, so `stageBudget()` tests the *breakpoint* (`matchMedia`), not
  the stage's used height — `getComputedStyle().height` reports the used height,
  never `auto`, and capping against it collapsed the reveal to the 48px
  Architect, leaving the workers clipped behind the chat while Multi appeared to
  do nothing. Measure with `scrollHeight` (integer-rounded, so no half-pixel
  scrollbar), cap by the stage only in the wide layout, and cap by the viewport
  otherwise. **And measure from the topology's top, not the card's height**: the
  absolute `.path-layer` is the first child, so `.topology > * + *` gives the
  Architect's row a 12px top margin — using the card height alone clipped
  exactly that margin, cut the card's bottom border and grew a scrollbar.
  Both mode switches slide through numbers: the collapse shrinks the measured
  height, the reveal pins the current height first (a straight set out of
  `max-height: none` would snap — `none` does not interpolate), forces a
  reflow, then grows to the target. Measured mid-flight: 61→241px in ~300ms
  and 241→61px back, both smooth.
  Re-measure on the topology's `ResizeObserver` and on `document.fonts.ready`:
  the card height changes after the font swap, and a stale `--reveal-h` looked
  like a one-pixel clip.
- **Cards have a hard minimum width** (`--card-min: 360px`): below that the
  select, the chevron and the edit button start colliding and the name is
  ellipsised away. Two columns + the 66px spine need ~790px of stage, so the
  full three-column layout needs **1460px** (256 sidebar + 48 padding + 790
  stage + 20 gap + 330 rail = 1444, rounded up). Below that the rail flows under
  the chat (single-column `.room`, `body { min-width: 1100px }` so the stage
  alone still fits two columns); narrower than 1100 the window scrolls
  horizontally rather than squeezing the cards. The baseline's ≤950px sidebar
  drawer behaviour is overridden for the same reason.
  Below the chat the rail itself is two equal halves: **Project above Project
  plan on the left**, **Tools in use on the right** spanning the full height.
  The left pair lives in a `.rail-col` wrapper that is `display: contents` in
  the wide layout — so the two panels are ordinary grid rows there — and becomes
  its own grid column when stacked. Without that wrapper the tall tools panel
  spans both rows and stretches the row heights, opening a 300px hole between
  Project and Project plan. Both halves are start-aligned so a short "No plan
  yet" never stretches.
  The glyph measurements that matter: both button glyphs are centred on the 22px
  button to within 0.01px, with ~1.5px of margin left top and bottom at three
  chevrons — if the glyph or border size changes, re-measure with
  `browser_get_element` rather than eyeballing it.
- **Model pickers are searchable.** Each `.role-model` `<select>` stays in the
  DOM as the source of truth — every handler still works — but is hidden
  (`display: none`) and driven by a `.model-search` input plus one shared
  `#modelMenu` (fixed-position, so it escapes the wrapper's overflow clip).
  Typing only filters (name or ref substring); a model can be set **only** by
  choosing an option, `Enter` on the active one, or Escape to revert. Do not
  make the typed text the value. Rows are compact (22px) and carry a source chip
  — the provider id is part of a model's identity, so `OpenCode` and
  `OpenCode Go` entries read differently, and local providers will slot into the
  same chip.
- **The chat dock fills the stage row in a session.** It stretches from directly
  under the role cards (one 14px grid gap) to the composer at the bottom of the
  window; the transcript scrolls inside it. The transcript is `display: none`
  while empty (`is-empty`), and there is no empty-state copy inside a session:
  a fresh session shows the composer alone — `has-history` (toggled by
  renderTranscript on every render) is absent, so the dock is bottom-pinned and
  exactly one composer row tall. It keeps the same panel surface, border and
  radius as the full dock: the composer lives in a panel, never as a bare bar
  floating on the stage (only its own top divider is suppressed, so it does not
  double the panel's top border). The moment history exists the dock gains the
  class and stretches from the cards to the composer.
- **The transcript shows user and assistant turns only.** System prompts,
  scaffolding and context dumps from the engine are not chat — rendering them
  once leaked AGENTS.md prose and diff hunks into the transcript above the
  user's own message. Errors still show, whatever type carries them.
- **Mode colours:** Multi is orange, Single is violet, both with white text and
  a white dot; both are filled pills, so the mode is readable at a glance. The
  composer placeholder is `Message` in Single, `Message the Architect…` in Multi.
- **The composer has no target picker, deliberately.** One interface, one lead:
  every message goes to the Architect. Per-role model/effort are card controls.
- **The UI is live-only.** The `Design preview` entry, every `SAMPLE` badge, the
  sample plan list, the sample tools table and the role cards' mock activity
  were all removed before live testing. Do not put invented content back; label
  unimplemented affordances with `data-soon` instead.
- **There is no Home nav.** The button did nothing; sessions live in the project
  tree and the stage shows the welcome screen when nothing is open. Do not add
  nav items that do not change the view.

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

## Open items

- **Per-role instructions and per-role skills.** The role-card edit button
  should open a picker for which skills that role may use, alongside its
  instructions. The engine takes skills globally (`skills.paths`); per-role
  gating would go through each agent's own permission rules. Decide this
  together with role instructions.
- **Stage 3 onward**: the Architect's real dev plan in the right pane
  (green/amber/red, red = hard-blocked), the status model, then the main-pane
  napkin, then the Tools-in-Use feed.
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
