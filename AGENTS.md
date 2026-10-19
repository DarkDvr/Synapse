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
skills/               shipped WITH Synapse, always on the engine's skill path
  visual-review/      render a page to PNG, then read it (the agents' eyes)
  ui-design/          the Designer's craft brief: direction, tokens, states, spec
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
  "mcp": { "servers": {
    "synapse-search": {
      "type": "local",
      "command": ["<node>", "F:\\dev\\Synapse\\src\\mcp\\search-server.js"],
      "codemode": false
    }
  } },
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

**A tool with per-session state belongs in the transcript, not in a server.** An
MCP server has no idea which session called it, so it cannot keep per-session
state on its own. It does not have to: the engine records **every tool call, with
its full input**, in the transcript, which Synapse reads back on each turn the
way the census does. That is how the plan tool worked before the plan became a
file — and `src/plans.js` still reads the tool calls the same way for anything
else that needs them.

Also: `engine.opencode.localSearch: false` used to `return` from the whole of
`ensureEngineConfig`, which silently cost the model-limit overrides too. The
guard now wraps only the search server.

**Keep it to what is needed.** A `time` tool was added here as a special case
for one question the operator asked while testing search, and he asked for it to
be removed — it was not a real capability the product needed, and it was bloat.
Ask before adding a special-case tool; add it only if it is genuinely useful for
real agentic development work.

---

## Briefing a session: the engine's instruction entries

The engine has a standing-context channel that is **not** the transcript:

```text
PUT    /api/experimental/session/{sessionID}/instructions/entries/{key}   { value }
GET    /api/experimental/session/{sessionID}/instructions/entries
DELETE /api/experimental/session/{sessionID}/instructions/entries/{key}
```

`key` matches `^[a-z0-9][a-z0-9._-]*$`; the reply is **204 with an empty body**;
the value is any JSON value (a string is fine) and there is a size cap that
answers **413** (`InstructionEntryValueTooLargeError`). The route's own summary
says changes "announce as updates at the next step boundary". Verified live on
2.0.30: PUT returned 204 and GET read the value back.

This is how Synapse briefs a role — which project, where the plan file is, who
may write it, what the plan currently says, and how work is expected to be
delivered. It is the right channel for three reasons:

- **It is per session**, so the Architect and each worker can be told different
  things without any of them knowing the others exist.
- **It is durable**, so it is sent once and re-sent only when its text changes,
  instead of riding on every message.
- **It does not appear in the transcript.** `POST /api/session/{id}/prompt`
  accepts only `text, files, agents, skills, metadata, delivery, resume` — there
  is **no system field**, and `agents:[{name}]` does not switch the acting agent.
  So the alternative would be prefixing the operator's message, which joins the
  conversation and reads as if the operator had typed it.

**Never put a lone backslash in text a model reads.** The first plan Synapse
generated came back as invalid JSON because the brief said `bin\` and the model
copied it verbatim into a JSON string, where `\ ` is an invalid escape. Model-
facing paths use forward slashes (`bin/`, `.synapse/plan.json`).

---

## The project plan: a file the Architect owns

`<project>\.synapse\plan.json` — goal + tasks (`id`, `title`, `role`, `status`,
`detail`, `dependsOn`, `result`, `note`). The Architect writes it with the
ordinary file tools; there is no tool and no store for it.

- **One writer.** The Architect owns it. Workers are told it is read-only and
  are handed their own task instead, so they never need to open it. The harness
  fingerprints the file around a worker turn so a stray edit is visible.
- **Synapse only reads it — it never repairs it.** Reading is tolerant and never
  throws: a bad file becomes `error` (unparseable) or `problems` (it parsed but
  breaks the shape), and the pane shows exactly what is wrong. The same sentence
  goes into the Architect's brief, so **the model fixes its own document**;
  verified live — one bare "Continue." closed the loop, because the brief was the
  only thing that could have told it the file was broken.
- **It belongs to the project, not the conversation**, so a new session
  continues the same plan. It is created empty (`{"version":1,"goal":"","tasks":[]}`)
  when a project is added and at boot for any project missing one.
- **`id` is required.** Delegation refers to tasks by id, and the Architect may
  rewrite the file at any time; a task without one is flagged and skipped.
- **Titles over 80 characters are a `problem`, not a silent trim.** The pane
  clamps a title to two lines with the full text on hover, and the brief carries
  the complaint so the Architect shortens its own title. Clamping the grid item
  directly is fine in Chromium (measured: 34px visible of 84px) even though
  `getComputedStyle` reports its display as `flow-root` — do not wrap it in
  another span on that reading, it clips either way.
- **A title is the plan's human index: what the work *is*, not which file it lands
  in.** The pane is read at a glance and by someone who has not read the project,
  so `Write bin/wordfreq.py and bin/NOTES.md` is a `problem` and `Build the
  word-frequency report` is not — the brief says so ("no file paths and no code
  identifiers in a title: put them in detail") and `readPlan` enforces it in the
  same `problems` channel the Architect already repairs a malformed file from.
  The patterns are deliberately narrow: `FILEISH_TITLE`
  (`/[A-Za-z0-9_-]+\.[A-Za-z]{1,5}\b/`) and `PATHISH_TITLE` (a leading
  `bin|src|web|docs|config` + separator). A bare slash is a perfectly good title —
  **`Audit the UI/UX` must not be flagged**, and is the test that proves it. Note
  the flip side: an existing plan written before this rule shows the complaint in
  the pane until the Architect rewrites its own titles.
- **One line is loud: the step in hand.** Every title is muted (`#9aa0a8`, 600);
  only a `doing` task is white and 700. A finished or blocked step is announced by
  its dot and its border, not by brightness, so a four-line plan has exactly one
  place to look. **The row's border is the dot's colour, at 2px** — at 1px and 0.34
  alpha the operator's word for it was "too faint" — and the `tN` id carries the
  same colour in text, which is what makes a plan readable without counting dots.
  **Every dot is filled**: the step in hand used to be a yellow *ring* on a
  transparent centre, which on a dark row reads as a black dot inside a ring —
  two styles at once. Grey = not started, green = done, yellow = in hand, red =
  blocked/failed.
- **The step in hand is the run, not the file.** The Architect only writes the plan
  when it *judges*, so during a worker run the file still says `todo` and the pane
  showed the live step as a grey row. `renderPlan` overlays the runner's live run:
  a task whose id is running renders as `doing` — yellow dot, yellow border, white
  bold title — while the file stays the plan. Counts in the footer stay the file's
  (they are the plan's truth); only the row is live.
- **A result with a status that has not caught up is a `problem`.** test-project-3's
  t1 got a full `result` and was left `todo`, so the pane showed a finished task as
  untouched while the Architect's own message said it was marked done. `readPlan`
  now flags "has a result but its status is \"todo\"" — a `blocked` or `failed` task
  may legitimately carry a result (a timed-out worker still produced something), so
  only `todo` and `doing` are flagged. It goes through the same `problems` channel,
  so the Architect repairs its own file on its next turn.
- **Plan problems are a labelled list, not a filled block.** They were an amber
  panel with the complaints as amber paragraphs, and on a finished plan that read
  as a rendering fault rather than a note — the operator's word for it was
  "unexpected yellow artifacts". They are a left amber rule, a heading
  ("`2 plan notes for the Architect`") and one bullet per problem now: unmistakably
  deliberate, quiet enough to sit under a finished plan. The *brief* still carries
  them in the same `problems` channel either way — this is only what the pane looks
  like.
- **A finished plan owes a customer-facing summary.** `summary` is a plan field the
  Architect writes when it marks the last task done: one sentence a customer would
  understand, with no file paths, tool names or code. The Architect's card shows it
  under the **Done** chip (two lines, clamped, full text in the tooltip — it shares
  the fixed three-line slot with the chip, so the card's height is unchanged:
  measured 106.3px before and after). `readPlan` flags a finished plan with no
  summary in the same `problems` channel, so the Architect writes its own.
  **Why the Architect and not the harness:** it has the plan's context and it owns
  the file; a `generate` call from Synapse would also work but would leave the text
  nowhere to live that survives a restart.
- **A task's `result` is not printed under its title.** One line per task keeps
  the pane scannable; the result rides the title's tooltip. A `note` is the
  exception and stays visible — a blocked task is the one case where the operator
  is being asked for something, so the reason must not be behind a hover — **and
  only while it is that reason**: on a `done` or `todo` task the text stays in the
  file and in the tooltip, because the Architect moving on without clearing its own
  note made a finished plan look like it was still asking.
- **A finished project's folder can be deleted while Synapse runs — the engine has
  to be told to let go.** The engine keeps a *location* loaded once it has served a
  turn there, and that handle makes the directory undeletable: `Remove-Item` reports
  "being used by another process" on the folder even after its sessions are gone and
  the project is unregistered. The release is
  `DELETE /api/debug/location?location[directory]=<dir>` (the parameter is a
  **deepObject**, so the query is `location%5Bdirectory%5D=…`, not a bare
  `location=`; a bare one answers 400 `Expected object`). Two facts measured: it
  **works**, and it is **asynchronous** — an immediate delete after the call still
  failed while the same delete a second later succeeded, so `evictLocation()` polls
  `GET /api/debug/location` until the directory is gone (30 × 100ms) instead of
  sleeping. `deleteProject` evicts and waits (281ms measured), and
  `wipeProjectDir` evicts then retries `fs.rmSync` before failing with 423. The
  operator's flow is now: delete the project in Synapse → take what you want out of
  `bin/` → delete the folder. Nothing to stop first.
- **There is no Project panel, and no path label anywhere.** The rail is Project
  plan + Tools in use; each project in the sidebar owns a `.tree-project-body`
  with one vertical yellow rule on its left, and the two shortcuts, the
  **Sessions:** label and the sessions all line up to the right of it (verified
  aligned at the same left edge). `POST /api/projects/{id}/open` spawns a
  detached GUI process (array args, never a shell string), and both branches are
  validated before anything is spawned.
- **A command prompt needs `start`.** `spawn('cmd.exe', ['/K', 'cd', '/d', dir])`
  exits with code 0 within a second and no window ever appears: a console
  spawned directly by a process that has none has no console to inherit. The
  working form is `cmd.exe /c start "" cmd.exe /K cd /d <dir>` — verified by
  finding the new window's title, then closing it by PID.
- **Explorer takes about a second to show a window**, and that is Explorer, not
  us: `POST /open` answers in ~57ms. Because the delay is real but not ours, the
  button carries an `:active` state so the click is acknowledged immediately.
- **Speaker headers are yellow, and every turn has a hairline above it.** The
  label is the speaker (`You` / `Architect` / `Synapse · …`), so a Synapse report
  no longer repeats `[harness]` in its own text — and old messages are stripped
  at render time. The three colours are `--violet-bright` (you), `--green`
  (Architect) and `--yellow` (Synapse), and all three use the same block: no
  panel fills exist any more. **`ui.answerBg` / `ui.harnessBg` and the Settings
  → Chat group are gone** — `normalize()` deletes a `ui` block so an old config
  does not carry a dead key.
- **The product's name is Synapse; "harness" is what it is, not what it is
  called.** Anything user-facing says Synapse. The code still says harness in
  places (the `.msg.harness` class, `src/runs.js`), which is fine internally.
- **A polled reader must not log on every poll.** `logPlanState` keys on a
  signature of the state (issues + every task's id and status) and speaks only
  when it changes; the pane reads the plan every few seconds, so anything dumber
  writes the same sentence into app.log forever. Called from two places: the
  plan route (a hand edit is noticed while a pane is open) and `afterTurn` (the
  Architect writes during a turn, and that is the only place that notices with no
  UI open). A session with no directory is not logged at all.
- **Deliverables go in `bin/`** inside the project; everything else there is
  scratch. It is in the brief so every role knows where work lands.

---

## Questions: a panel over the chat, never in it

A model asking the operator something is not a chat message — it is a blocked
session. The engine raises a form (see "Tools and models"), and Synapse renders
it as a panel **painted over the chat, anchored just above the composer**.

- **It cannot change the chat's size, and that is structural, not careful.** The
  host is `position: absolute` inside `.chat-dock` (`position: relative`), and
  `placeAskPanel()` sets its `bottom` and `max-height` from the composer's and
  the dock's measured heights — the composer grows with the textarea, so CSS
  alone cannot express it. Measured with the panel shown and hidden on the same
  transcript: dock 269/619/888, composer top 829, transcript 559 — identical in
  both states, and page overflow 0.
- **The panel is polled, so it must never rebuild for nothing.** `refreshPending`
  runs every 8s; rebuilding the panel's HTML threw away answers the operator had
  already given (reproduced: pick a radio, wait for a poll, the radio cleared and
  Submit disabled itself again). `state.askSig` is the form's id plus its fields
  and option values — nothing about the answers — and an unchanged signature only
  re-places the panel. Same lesson as `renderSig` for the transcript.
- **The action row is the panel's last column row, not a sticky one.** A six-field
  form is taller than the chat, so Submit is pinned to the panel's bottom edge
  rather than something to scroll to. It was `position: sticky; bottom: 0` first,
  which only holds while the content is taller than the panel: on a short form the
  row sat where the content ended and the panel went on being empty underneath it —
  a strip that reads as the chat showing through. The panel is now a flex column,
  the fields take the room and scroll inside it, and the row ends at the panel's
  bottom edge either way (measured: `stripBelowSubmit: 0` in both cases).
- **Choice questions get radios, `multiselect` gets checkboxes**, `boolean` a
  single checkbox, numbers a number input, `external` a link. Every option shows
  its label and its description — the descriptions are the model's own reasoning
  about each choice and are most of the value.
- **`custom: true` becomes "Something Else…"**: a radio/checkbox row with a text
  input that stays disabled until that row is picked, and whose text becomes the
  answer. That is how these models phrase an escape hatch, and the engine's
  question tool always sets it.
- **Required fields gate Submit**, with "Answer every required question to send."
  next to the button rather than an error after the click.
- **The composer is disabled while a question waits** (the operator's call): the
  turn is blocked, so a message typed into it would go nowhere. The placeholder
  becomes `Answer the question above`.
- **The `question` tool card stays, as one line.** It is the record, not the
  interface: `renderTool` gives it `questionSummary(part)` (the first question's
  `header`), and the raw payload is one click away like any other tool. On
  answer the engine's own output ("User has answered your questions: …") shows in
  the expanded card.
- **A worker can ask too.** The panel is not limited to the open session: any
  pending form is shown, with the head saying `another session is waiting on you`.
  A worker has the same toolset, and without this its question would be invisible
  and the run would die at the timeout with nothing to look at. **Any** pending
  question blocks the composer, whoever asked it: the operator's attention is what
  the run is waiting for, and a worker's question is no different from the
  Architect's in that.
- **Orange marks the panel; it does not fill it.** The top rule, the QUESTIONS
  heading, the waiting dot, the Recommended chip, the control accents, each option
  row's outline and the Submit fill are orange — nothing else is: the panel
  surface, the row backgrounds and the question text are the ordinary colours. The
  first version was orange all the way down and the operator pulled it back the
  same day ("was too much orange" for something read line by line). Every option is
  an answer and carries the rule; the row you picked is marked by a lifted
  background and a white label, never an orange wash.
- **The panel covers the whole chat, including the composer.** It is the dock's own
  child at `inset: -3px` — 2px past the dock's *border box*, so the chat's border,
  its radius, its jump buttons and the composer (textbox, Stop, Send, the mode
  toggle) are all underneath it. The dock drops its clipping while a question is up
  (`.chat-dock.has-ask { overflow: visible }`), which is what lets the panel be the
  larger box; nothing else escapes, because the transcript clips its own content
  and the composer is behind the panel anyway.
  **Being the dock's child is the point, not a detail.** Measuring the chat from
  outside and copying its rect onto a body-level panel was tried first: it looked
  right at rest but drifted up to **34px** off the chat during a mode switch, every
  frame, because a style written from a measurement is painted a frame after the
  layout it measured. As a child it moves with the dock in the same layout pass —
  traced through a switch, the offset stayed at exactly 2px on all four sides on
  every frame.
- **Question text and option labels are bold** (700); the option descriptions stay
  regular and muted, which is what keeps the bold from being a wall. The question
  itself is the one thing read standing up, so it is **16px** while the option
  labels stay 12.5px and the descriptions 11px — the operator asked for "larger by
  three points" and 3pt is 4px in CSS, which is what took 12px to 16px.
- **"Something Else…" gets its own line for the box.** Sharing one line, the box
  raced the label to the right edge (and wrapped badly when it did not fit), so the
  row is a column and the box is indented 21px to line up with the option labels
  above it.
- **"(Recommended)" becomes a chip.** The question tool's own convention is to
  put the recommendation first and end its label with " (Recommended)". The panel
  strips the suffix and shows a chip beside the label, and the role brief tells
  both roles to write it that way — verified live: the worker's next question came
  back as `Number of notes (Recommended)`.
- **The engine's `header` is a heading only when it separates questions.** It is a
  short label for telling several questions apart; with a single question it just
  sat above the real question, and models often write a slug there ("--reverse
  meaning"). A one-field form drops it and leads with the question text.
- **Verified end to end** on the `field-notes` project: the Architect asked
  "Index colour scheme" through the tool, the panel appeared over the chat while
  its card read `asking the operator`, the answer "Fixed palette" was submitted,
  the tool call completed with that answer, and the Architect carried on in the
  same turn — closed t4 and unblocked t3.

---

## Delegation: the Architect asks, the harness runs

`delegate { task }` is a stateless MCP tool (src/mcp/delegate-server.js). The
request is read out of the transcript on the turn boundary, exactly like the
census, and answered once — the call id is written to `.synapse\runs.jsonl`
**before** the worker starts, so a restart or a re-scan cannot run it twice.
`src/runs.js` then creates a real session for the task's role, on that role's
model and effort, briefs it with its own task, runs it, records the evidence, and
wakes the Architect.

Non-obvious, all verified on 2.0.30:

- **`POST /api/session/{id}/synthetic`** — "durably admit synthetic session input
  and schedule execution". This is how the Architect is woken with nobody
  typing: the message is its own transcript type (`synthetic`), which the UI
  renders as **Harness · \<description\>** with an amber edge, never as the
  operator. `sessionLog` records each one.
- **`metadata` is accepted on `POST /api/session`** and is free-form, so
  `metadata.synapse.internal` marks a worker session. `normalizeSession` exposes
  it as `internal`, and the API filters those out of the rail *and* the project
  session counts. The engine still lists them, so a worker transcript stays
  inspectable at `/api/session` — that is how you audit a run.
- **A worker's claim is not evidence.** The first delegated run reported writing
  `bin/calendar_design.md`; no such file existed and `runs.jsonl` recorded
  `files: []` from its own tool calls. The Architect checked the disk, kept the
  task `todo`, wrote the reason into `note`, and re-delegated — attempt two wrote
  the real file. This is why the report always prints `Files written: none.`
  rather than omitting the line, and why the harness never moves a task.
- **Retry cap: 3 attempts per task**, then the harness refuses with a report
  telling the Architect to break the task down, change the role/model, or mark it
  blocked. Refusals are logged with an `outcome` and no `attempt` number, so they
  do not count against the cap. A refusal is a real answer, not a silent retry.
- **A coder that cannot do the job hands it down the line.** The three coder roles
  are peers (`worker.ladder`, default `coder-1 → coder-2 → coder-3`), and the
  harness moves the *same task* between them — the Architect cannot, because the
  first thing it learns about a refused model is a report saying nothing happened.
  `candidatesFor()` decides the rungs for an attempt, on two rules: **a provider
  refusal moves to the next peer inside the same delegation** (same task, same
  attempt, and retrying a retired model would only spend the Architect's turn), and
  **an attempt after the first starts one rung further down**, because the Architect
  re-delegating the same task *is* its verdict that the previous coder did not
  deliver — the only verdict the harness can see. It starts at the **role's own
  rung**: `ladder.slice(skip)` sliced from the ladder's start, so a task written for
  coder-2 began on coder-1 and the report said "ran on coder-1, not coder-2" with
  nothing having failed (caught in test-project-1's f-string run, fixed to
  `slice(at + skip)`). A role whose model carries a
  provider mark is skipped from the start. A timeout does not loop: the worker may
  still have produced something, and the attempt counter moves that case next time.
  The plan's `role` is never rewritten (the Architect owns the file); the report says
  *"this attempt ran on coder-2, not coder-1 — the plan still says coder-1, judge the
  work on its merits"*, and `runs.jsonl` records `role`, `plannedRole` and `ladder`.
  Verified through the real runner with a stubbed engine (19/19): a refusal moves,
  attempt 2 starts a rung down, a marked model is skipped, a clean turn stays on
  coder-1, and a role outside the ladder still reports a plain `error`.
  **The reason is visible in three places**, because "why is Coder 1 idle?" is the
  question a card invites: the report carries the provider's own sentence
  (`coder-1's model was refused: Model space-bunny-free has been deprecated…`), the
  run state carries `skipped: [{ role, message }]` so the skipped role's card reads
  `Skipped — <reason>` for as long as the run is live, and the model keeps its
  badge in the picker. The first production run of this (`test-project-2`, t1) went
  exactly that way: 1.8s refusal → `coder-2` in 87s, with the move written into
  `runs.jsonl` as `role=coder-2 plannedRole=coder-1`.
- **Single mode refuses.** Tool rulesets cannot hide an MCP tool, so the promise
  is kept in the runner: a delegation request in a Single session is refused out
  loud and the Architect is told to ask for Multi.
- **One worker per project at a time** (`busy` set keyed by directory) — two
  Architects editing one plan file is the one thing that can actually corrupt it.
- **"Keep building" is a session switch, not a setting.** `metadata.synapse.auto`
  (normalizeSession exposes it as `auto`) is toggled by the finish-line flag
  between Stop and Send, and read in three places: the brief tells the Architect
  its mode for the next message, every worker report repeats it so a mid-run flip
  lands on the next judgement, and the runner itself reads it at report time.
  Hidden in Single via `body[data-mode="single"] .keep-toggle`. Verified live:
  switched on, the remaining three tasks ran themselves in 12.8 minutes.
  **The flag is enforced, not just asked.** A free model read "Keep building is
  OFF: stop after judging this one" three times and delegated the next task anyway
  (test-project-1's f-string run: all three tasks, no operator input, `auto: false`).
  The runner now refuses a delegation when keep-building is off **and the operator
  has not spoken since the last report** — `operatorSpokeSince()` compares the
  newest `user` timestamp with the newest `synthetic` one, so nothing is stored —
  unless the delegation is for **the task that was just reported**, which is a retry
  and therefore the Architect's judgement. The refusal is logged, recorded in
  `runs.jsonl` as `outcome: 'keep-building-off'`, and shown as a toast; it does
  **not** wake the Architect, because waking it to say "stop" starts another turn
  it can delegate in again.
- **A stalled worker cannot hang the loop:** the wait is on the engine's `idle`
  message, with a ceiling that interrupts the session and reports a timeout. The
  ceiling is `worker.timeoutSec` (Settings → Workers, default 300s) and a role
  overrides it on its own entry (`roles.<id>.timeoutSec`) — one number for every
  role was wrong within a day: the auditor hit 240s and needed more. A timeout is
  not a failed task: the calendar auditor was interrupted and still left a useful
  result, and the Architect judged from what it *had* produced rather than from
  the worker's word.
  **A turn the provider refuses is not a success either.** The engine appends
  `idle` whatever the step did, so reading idle alone as "completed" reported a
  dead model as a finished task with no output — twice, and the Architect had to
  guess why. A retired model answers **HTTP 410** in about two seconds and both the
  assistant message and the idle one carry the reason, so `turnErrorOf()` reads the
  new messages for an error and the run is `outcome: "error"`: the report quotes the
  provider's own sentence, says plainly that the worker never got to work, and
  points at the role's model. Measured on the live case: `space-bunny-free` was
  retired mid-run, every worker turn died in 1.8s, and the plan went `blocked`
  because nothing said why. **The catalog can advertise a model the inference
  endpoint has already retired** — `space-bunny-free` was still listed, still
  pickable, and still the one the provider told us to stop using.
  **One exception: a worker waiting on an answer is not stalled.** While the
  transcript shows a `question` tool part still running, `waitForIdle` pushes the
  deadline out on every poll, so the operator can take as long as they like.
  Without that, every worker that asked anything was guaranteed to be interrupted
  for asking — and the panel would have shown a question for a run that had
  already been killed.
- **The worker's poll is also the UI's source of live activity.** `waitForIdle`
  already fetches the worker's transcript on a timer, so the newest tool call
  costs nothing extra: the runner reads its name and target (the input field
  differs per tool, so file, shell, search, fetch, skill and subagent targets are
  all read in one place) and emits `run.progress` only when it changes. The same
  run is in a map keyed by directory, served at `GET /api/runs` — the SSE events
  are the fast path, and this is what a page reloaded mid-run reopens from.
  Nothing invented, no extra turn, no polling of the engine from the UI.

---

## The pipeline: ideas, design, a build, and an adversary

The seven cards are `architect, inventor, coder-1, designer, coder-2, hacker,
coder-3`. `auditor` and `critic` are retired: the Architect verifies its own
delegations against the disk, so a second confirmation was redundant, and the two
slots are better spent on an idea generator and an adversary. A config written
before the rename is migrated once (`normalize()` folds `auditor`→`inventor`,
`critic`→`hacker`), so a saved model choice is never lost.

The pipeline is a **menu**, not a checklist: the Architect picks the phases per
project and records them in the plan's `phases`. A clock pays for invent → design
→ build the shell → wire it → hack → fix → re-hack; a word-count CLI pays for two
tasks. Roles are identities plus one mandate each (`ROLE_MANDATES` in
`plans.js`), and each owns one folder:

| role | may write | produces |
|---|---|---|
| inventor | `.synapse/ideas/` | `ideas-1.md`, ranked, with a one-line why and effort |
| designer | `.synapse/design/` | `design.md` (the spec) + `mock-N.html` |
| hacker | `.synapse/reports/` | `hack-N.md`: ids `H1…`, severity, exact repro |
| coders | the project | `bin/` |

**The file contract is the point.** `.synapse/` holds `requirement.md` (written by
the harness from the operator's own message, append-only — never a model's
paraphrase), `plan.json`, `features.json` (confirmed + rejected, every confirmed
item naming the task that delivers it), `ideas/`, `design/`, `reports/` and
`runs.jsonl`. Each brief is assembled from those files, so a worker receives the
operator's words and the confirmed features verbatim, and the rejected ones are
never passed on.

### What the engine actually does with a permission rule (measured, 2.0.30)

This cost an afternoon and is not guessable:

- **The rule matches the path as the model wrote it.** A relative rule
  (`.synapse/**`) refuses a relative write; an **absolute** rule does *not*
  refuse a relative path. Emit both forms.
- **`edit` is the action for both the `write` and the `edit` tools.** `write` is
  not an action name at all — a rule on it denies nothing, which looks exactly
  like a working rule until you test it.
- **`read` is an action**, so reads can be denied separately.
- **`action:'*'` with a path denies reads too**, which is why the harness guard
  uses it and why `.synapse` cannot (the plan and the contract are meant to be
  read).
- **`shell` and `execute` are not path-matched.** They take a command, so a
  worker can go around any path rule with a redirect. Hence
  `synapseFingerprint`/`fingerprintDiff`: the runner compares every file under
  `.synapse` before and after a worker turn and reports anything changed outside
  that role's folder as an alarm — prevention for the file tools, detection for
  the rest, the same split as the harness watchdog. **Verified live:** a coder
  rule refused `.synapse/probe/x.txt` twice (`write:error`, no file), while the
  same write with an absolute path in the prompt got through — which is exactly
  why the detection layer exists.

**Skills are per role, and enforced.** `roles.<id>.skills` is an allowlist; the
session gets `{action:'skill', resource:'*', deny}` plus one allow per name (the
last matching rule wins), and the brief names them. Measured: a denied skill
answers "Permission denied: skill (type: permission.rejected)" while an allowed
one loads. No list means no restriction; an empty list means none. The picker is
the ✎ button on the role card, which now holds three things:

- **Skills** — ticked = allowed. Ticking every skill stores *no* list, because
  that is the same thing and it lets a skill added later reach the role.
- **Focus** (the Hacker only) — `app` by default, `security` when needed.
- **Instructions** — free text appended to the role's brief on every turn
  (`roles.<id>.instructions`, capped at 2000 characters).

**The Hacker has a volume dial, and it starts low.** `roles.hacker.focus` is
`app` unless it is set to `security`. In `app` the mandate is what a *person*
does: empty and whitespace input, text in a number field, a negative or enormous
number, accented letters, a missing or wrong file, a path with spaces, a flag
that does not exist, starting from the wrong folder, Enter twice, a window closed
half-way — and it is told, in those words, not to build hostile environments, run
locale or interpreter matrices, or fuzz in loops. `security` is the same role
with the gloves off. Both carry a proportion rule ("the cases with the best
chance of happening beat a complete matrix"), because the 197-second
locale-matrix run was technically correct and useless for a small tool.

**Ideas are hidden from coders.** `roleReadRules` denies `read` on
`.synapse/ideas/**` for `coder-*` only: the ideas file is the one place rejected
options live, and a coder that reads it can quietly build one. Everything else in
`.synapse` stays readable, because the brief and the contract are there to be
read.

**Synapse ships the skills it needs, and says what it cannot find.** `skills\`
next to `src\`, `web\` and `config\` is put on the engine's `skills.paths` on every
boot, ahead of any configured folder and independent of the config — that is the
difference between "the pipeline works on a new PC" and "the Architect silently
has no eyes". Move the folder with the app and everything Synapse needs travels
with it:

| shipped | why |
|---|---|
| `visual-review` | renders a mock and reads the PNG — the only way these agents see |
| `ui-design` | the Designer's craft: direction, tokens, every state, a spec table |

The operator's own folders are extra paths on top (`engine.opencode.skillPaths`,
one `;`-separated line in Settings → Skills). Nothing is downloaded at runtime — the
offline rule makes "install" mean "carry the folder", and a third-party skill stays
where its licence lives.

The failure this guards is silent: a role's skill list survives a move to another
machine, the folder does not, and the ruleset still *allows* a name that can never
load. Nothing errors; the capability just vanishes. `GET /api/skills` therefore
returns `missing` (names a role expects, and which roles) and `paths` (each
configured folder, and whether it exists). The UI says it once at boot as a toast
and lists it in Settings → Skills; the role picker shows such a name as *"not
installed on this machine — the reference is kept, but nothing loads"*, so
unticking it is deliberate rather than a silent loss. Verified live: a role set to
`nope-skill` produced the toast, named the role, and Settings read
`not installed: nope-skill (coder-3)`.

**Eyes are a skill, not a tool, and it ships with Synapse.** `visual-review`
(`skills\visual-review`, `bin\shot.mjs`) renders a file or URL with the machine's
own
Edge (`--headless=new`, a throwaway `--user-data-dir`, ~1.2s) and writes the PNG
into the project; the model then **reads the PNG**, which works on deepseek and
not just on a vision model (measured: it named a made-up word and its background
colour correctly). Two widths at most — each image is roughly a thousand tokens.
The SKILL.md carries the honesty rules: say what is measurable, say what a still
cannot show, never invent a label. Without it, "the Architect checked the design"
is a sentence about HTML rather than pixels.

---

## Tools and models

- **The toolset is per-model, per-agent, and even per-call.** One run reported
  `execute`, the next did not. Never hardcode an assumption about which tools
  exist — the probe asks the model and reports it.
- Observed toolset: `edit, glob, grep, question, read, shell, skill, subagent,
  webfetch, websearch, write, execute`. There is **no `list`** and **no
  `todowrite`**; asked for `list` the model used `read`, asked for `task` it
  used `subagent`.
- **`question` is the form mechanism, and the form is the interface.** The tool
  call blocks the session, and the engine raises a **form** for it:
  `GET /api/session/{id}/form` lists it, `POST .../form/{formId}/reply` with
  `{answer:{<key>: value}}` settles it, and the tool call then completes with the
  answers in its output. A form is a schema, not a question: fields are
  `string` (with `options` → a choice, `custom: true` → an escape hatch),
  `multiselect` (checkboxes), `boolean`, `number`/`integer`, `external`, with
  `required`, `hidden` and `when` (eq/neq on another key). Missing one stalls a
  session forever.
  **The global form list is location-scoped and will not show a project's form.**
  `GET /api/form` only lists forms in the engine's own location (the projects
  root), so a question asked in a project subfolder is invisible there — which is
  exactly why the first real question showed up as a raw JSON tool card while the
  session sat blocked. Ask the session, not the world: a session waiting on a
  form is a session `GET /api/session/active` reports as active, and the open
  session is asked for by name too (`GET /api/pending?session=<id>`).
  **Forms live in the engine's memory.** A Synapse restart restarts the engine,
  and every pending form dies with it: the transcript is left with a tool part
  stuck at `running` and the turn never resumes. Interrupt the session (Stop)
  before a restart if a question is open; a stranded part is the one visible
  symptom.
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
- **A model can be marked, and only the operator unmarks it.** A provider refusal
  during a worker run (`outcome: "error"`) writes the provider's own sentence into
  the model's record (`issues: [{ at, kind, message }]`, newest first, de-duplicated
  by message) and broadcasts `kind: 'model'` so the picker re-reads the catalog
  without a reload. The picker row grows an orange **ISSUES** chip whose tooltip is
  the sentence and its date, the closed picker's border goes amber, and **clicking
  the chip clears it**: no turn, no question, nothing written to the plan and
  nothing said to any model — "UI-only, only me", in the operator's words. The mark
  survives a restart until it is cleared, which is the point: a retired model is
  still advertised by the catalog, so without this the picker shows a dead model as
  perfectly healthy (that is exactly what happened to `space-bunny-free`).
  **The record never becomes policy:** the badge does not block a selection and is
  never mentioned in a brief. Deliberately, because a model can come back and
  because the operator is the one who checks.
- **The probe marks a model that cannot drive tools, and clears its own mark.** A
  probe run counts its *real* failures — a case whose tool the model was never
  offered does not count (`offered === false`), since the case list asks about
  tools a model may simply not have — and **3 or more** writes a `kind: 'tools'`
  issue naming the tools. The threshold is 3 because a probe is one turn per case
  against a flaky free provider, and two could be an afternoon. A later probe with
  fewer than 3 clears that *kind* by itself (`clearIssueKind`), because a clean run
  is the same evidence pointing the other way; a `provider` mark is never cleared
  automatically — that one is the operator's.
- `GET /api/models/cache` exposes the raw store for debugging.

### The probe (`Run Tool Probe`)

Drives one turn per tool in a disposable scratch session
(`<projects root>\_probe`), records the tool's own execution time, and labels a
failure "not offered by this model" when the tool was never in its list.

- It **interrupts a timed-out case** before starting the next. Without that, the
  wedge is inherited and every later case fails too.
- **The scratch session is invisible.** Probe and model-check sessions live in
  `<projects root>\_probe`; the API filters that directory out of project/session
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

## Git on a session's first successful turn

Beside the auto-namer in `afterTurn`, Synapse checks the session's directory for
a repository (`git rev-parse --git-dir`) and runs `git init` if there is none.
This is once per directory per process and needs no config.

- `rev-parse` succeeds inside any **parent** repo, so a project folder under an
  existing repository is left alone — Synapse never creates a nested repo. Since
  the projects root is now a *sibling* of the harness, a project is no longer
  inside Synapse's own repository at all, which is also what keeps a project's
  files out of the harness's `git add -u` snapshots.
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
- **Scrollbars are ours now.** `::-webkit-scrollbar` (+ `scrollbar-width`/
  `scrollbar-color` for the standard path) is styled thin and dark: Chromium stops
  drawing its native bar as soon as that pseudo-element is styled, which is what
  removes the Windows stepper arrows — a tool card's 200px output box was showing
  two of them and read like a spreadsheet. Tool output also never scrolls
  sideways: `white-space: pre-wrap` + `overflow-wrap: anywhere` + `overflow-x:
  hidden` on `.tool-body pre`, so a wide monospace table wraps instead of growing a
  horizontal bar (measured: 0 of 82 output blocks scrolling sideways on a real
  four-round transcript).
- **Sending puts the newest message in view — and the cards above it.** Two
  scrollers can be live at once: the transcript scrolls itself, and below 1460px the
  page scrolls too. `send()` runs `scrollChatToEnd()`, which sends the transcript to
  its end **and** the page to the top of `#topologyWrap` (8px margin), but only when
  each actually scrolls — in the wide layout the page does not, so nothing moves
  there. The first version made it either/or, which did nothing at all on a window
  where the transcript scrolls *and* the page does.
- **The transcript follows a turn while it streams — and the measurement has to
  happen first.** `renderTranscript()` decides "was the reader at the bottom?"
  *before* `fitChatHeight()` runs: that call resizes the dock, and a shrunken dock
  makes the transcript read as scrolled-up, so reasoning and tool lines arrived
  without the chat following them. While `state.streaming || state.busy` it follows
  unconditionally — the operator's words were "to make sure I always see any new
  info in chat being added" — so reading history mid-turn is pulled back to the end
  by the next part. That is the trade they asked for.
- **Opening a session starts at its end.** `openSession()` puts the transcript at
  its bottom once after `loadMessages()` — a session is opened to read where it got
  to. It does not move the page (unlike Send), because the cards are right there.
- **The two rail tables share one geometry.** They are lists before they are
  tables: 2px cells, `line-height: 15px`, `tbody tr { height: 21px }`, and anything
  that lives in a cell is capped to that height — the probe's Error is a real
  `.btn` (22px min-height) and its own `td` rule set 3px, so one table had 29px rows
  beside 22px ones. Measured after the fix: 8 rows and 14 rows, every one 21px.
- **Adding a project can adopt a folder that already has a plan.** Deleting a
  project only unregisters it (documented, and right: the folder is the operator's),
  so a reused name like `Test Project 1` resolves to the same slug on disk and the
  new project inherits the old plan — the pane opened onto a finished 4/4 plan and
  the Architect card said DONE before anything was typed. That is now a three-way
  question (see the next bullet) rather than a toast, and `createProject` also
  reports `existingPlan` for API callers. It never wipes the plan by itself:
  re-adding a real project must continue its work.
- **A reused folder is a decision, not a toast.** Adding a project to a directory
  that already holds a plan now asks, in a **non-dismissable dialog with a red
  frame**: *cancel and pick another name*, *delete that folder and start fresh*, or
  *re-use it and carry on*. It shows what is at stake, because all three answers are
  about a folder on disk: the path in mono, the **numbers as chips** (`3 tasks`,
  `3 done`, `35 files`, `last touched 4 min ago`), and the old goal as a
  **quotation with a left rule**, clamped to three lines *with an ellipsis* and
  carried in its tooltip. The goal used to be sliced to 160 characters by the
  server, which cut it mid-sentence with no ellipsis and read as a rendering fault.
  `POST /api/projects/inspect` answers without side effects;
  `POST /api/projects/wipe` refuses anything outside the projects root (and the root
  itself), evicts the location first, then deletes with retries. The dialog is the
  one place `openDialog` takes `dismissable: false`, an `extra` button and a
  `tone: 'clash'`; the generic dialog's Cancel/OK pair is unchanged elsewhere.
- **`.chat-scroll` scrolls internally in the wide layout; the page scrolls in the
  stacked one.** Above 1460px `.stage` has a definite height (set from the
  measured viewport via `--stage-h`, minus any horizontal scrollbar), so the
  composer sits at the bottom of the window. Below 1460px the rail flows under
  the chat and the page scrolls by design. Every scroll helper goes through
  `chatScroller()`, which returns the transcript when it scrolls and `null`
  otherwise.
- **Jump buttons live inside the chat pane.** `.chat-nav` is `position:
  absolute` in the dock (which is `position: relative; overflow: hidden`), so it
  can never drift out over the rail, and it does not reserve a gutter — it
  floats over the transcript's right edge, keeping the conversation's padding
  symmetric (13px each side). It sits at `right: 22px` so it clears the
  transcript's ~15px scrollbar (verified: 7px clear). An earlier
  `position: fixed` version anchored by JS escaped the pane when the dock was
  short.
- **The jump animation is hand-rolled.** `animateScroll()` runs a 280ms
  ease-out rAF scroll instead of `behavior: 'smooth'`, whose duration the
  browser owns and cannot be tuned — roughly 30% quicker than the browser's own
  smooth scroll over these distances (measured ~289ms end to end).
- **The jump buttons step message-by-message from an anchor, not from the raw
  scroll offset.** `navAnchors()` picks the message that owns the fold (last top
  at or above `scrollTop + 12`), and the buttons move `cur ± 1`. A raw
  "first message below the fold" test got stuck: the first message sits ~11px
  below the content top, so UP kept re-selecting it and DOWN never advanced.
  Verified both directions at 1200 and 1680: 0 → 1 → 2 with NEXT disabling at
  the last message, and back with PREV disabling at the first.
- **The stacked layout caps the chat panel** at `min(70vh, 720px)`
  (`body[data-view="session"] .chat-dock.has-history`). Below 1460px the stage
  is content-sized, so without a cap a long conversation would stretch the page
  forever. The cap is where the panel stops growing and its transcript starts
  scrolling internally — verified 630px at 900px viewport height.
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
  measure can never clip the card or grow a scrollbar.
  **The role-card wrapper is `overflow: clip` in every mode — never `auto`.** It
  must never scroll: not by wheel, keyboard, drag or script, and no scrollbar
  may ever appear beside the cards. `auto` was wrong twice over: it made the
  section scrollable, and a 241.06px topology under a 241px cap grew a hairline
  scrollbar during the Multi→Single switch (scrollHeight rounds down, so the
  overflow was invisible but real). `measureReveal()` now measures the real box
  and rounds UP (`Math.ceil`) so the cap clears the content, and `clip` makes
  any attempt to scroll a no-op (`scrollTop` stays 0). Verified across 41
  frames of a Multi→Single switch at 1680px and at 1200px: every frame
  `overflow: clip`, `scrollTop` forced to 50/60 stayed 0, gutter 0.
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
- **The subtitle slot is a fixed three lines, so the chat never moves.** The
  first version let a card grow when its task appeared, which took its room from
  the transcript's top edge (correct mechanically, 269 → 306px top with the
  bottom pinned at 888) — and read as the whole UI jumping every time an agent
  started. Now every card reserves `--task-lines` (3) of subtitle space whether it
  has anything to say or not, clamped with `-webkit-line-clamp`, so filling it
  changes no height at all (measured: all worker cards 98.28px, Architect 102.28
  because its name is 15px). The full text rides the `title`. The trade is real:
  the topology is ~200px taller for ever, which comes out of the chat. `--task-lines`
  is the one number to change.
  The stage's second row is still `minmax(0, 1fr)` under a definite height, so
  *anything* that does grow (a raised `--task-lines`, a font swap) squeezes the
  transcript and never moves the composer — `applyRoleCardsLayout({ from })` still
  takes the pre-change height so it slides. And a poll that learned nothing must
  not re-measure at all: `state.roleSig` is a signature of every card's role,
  state and text, and an unchanged signature returns early.
- **The live path is measured from the connector cell, not from the cards.** The
  spine is that cell's exact centreline and the band is its `.link-line`'s exact
  centre, both at three decimal places — the arrow has to *cover* the dots it
  replaces, and rounding to whole pixels left a visible step. The destination's
  own edge is the end point, so the arrowhead lands on the card. Which side the
  worker is on is decided by comparing its centre with the topology's, not by a
  hardcoded side. Ant count and duration come from the path length, so the beads
  read as one dotted line whether the run is one row away or three. A card hidden
  by Single mode has a zero-width box, which is the guard that stops a path being
  drawn to nothing.
- **The card's dot is a state, and the whole language is derived — nothing is
  stored.** Four states, all read from the plan file plus the runs the runner
  already serves plus the open session's turn: **grey** never taken part,
  **yellow breathing** taking part right now (`.status-dot.live`, `dot-breathe`,
  `--yellow` — the live path's colour, not amber, which stays the engine's
  "waiting" colour elsewhere), **red** a task of its role is `blocked` or
  `failed`, **green** idle but has taken part. Precedence is running → blocked →
  done → idle. A card whose role has never taken part is dimmed (see below: 55%,
  not the 80% it was first shipped at), which is how "who has actually worked here"
  is readable at a glance; a role goes solid the instant it is running, not when its
  task's status changes. **The dim is 0.55, not 0.8** — at 80% the operator could not
  see it at all — and hovering restores the card to full, so a dimmed picker is never
  unreadable. **A skipped role looks blocked**: red border, red label, and its
  **picker goes red** (border and model name, background unchanged) because the
  model is what failed and swapping it is the fix. The mark is driven by *two*
  sources and survives the run: the live run's `skipped[]` while it lasts, and
  afterwards the role's current model carrying a `provider` issue — so the card
  stays red until the role points at another model or the operator clears the badge,
  which is exactly when the problem is gone. **Participation is per session, not
  per plan** — the operator's rule: a non-Architect card starts dim and goes solid
  the first time that role is used for anything in *this session*, and stays solid
  for the rest of it. A plan rewrite does not reset it; a new session does. The plan
  route returns `used`, computed from `runs.jsonl` by `architect` = the open session
  (every delegate line carries it), and it counts both the role the task was written
  for and the role that actually ran it — which is how coder-2 is solid after the
  ladder handed it coder-1's task. Deriving it from the run log rather than from
  memory is what makes it survive a reload and a restart.
  The Architect has two **chips** for its two resting states, in
  the same slot the task line uses — a green **`Done`** when there is a plan and
  every task is `done`, and a yellow **`Waiting on you`** when nothing is in
  flight and work is outstanding. Both also put the card in `is-settled`, which is
  the **green border**: yellow border means a delegation is in flight, green means
  nothing of ours is and the move is the operator's. Because a chip is the size of
  a line of text it still cannot change a card's height.
  **Because it is all derived, "a new plan resets participation" needs no code:**
  a rewritten plan is all `todo` again, so every card goes back to 80% on its own,
  and a reload or a restart shows the same picture.
  Two consequences worth keeping. The chip replaces the subtitle *text in the same
  slot*, so it cannot change a card's height (measured: all seven cards 106.28px
  with and without it, at 1680 and at 1200). And `state.roleSig` must include the
  dot class, the dim and the done flag, or a poll that changed only a status
  returns early and the dot never repaints — which is also why `loadPlan()` calls
  `renderRoleActivity()`: the plan poll (30s, plus every message event) is the
  only thing that learns a task changed.
  **The known gap:** participation is "a task of that role is not `todo`". A
  worker that ran and was interrupted, whose task the Architect left `todo`, dims
  again — its card is solid while it runs and loses that afterwards. Closing it
  needs `runs.jsonl` as a second source *and* a marker for which plan those runs
  belong to (task ids repeat between plans), which is real machinery for a small
  visual; the honest reading of the file we have was preferred.
- **A chip inside a text slot inherits its line-height, and that is what
  de-centres it.** The `Done` chip sits in the card's subtitle slot, whose
  `line-height` is 1.45 — so the chip's box was the *line box* (13.775px) plus its
  padding, while its text is 9.5px. `line-height: 1` gives the chip a box the size
  of its own text. The rest is optical, not geometric: **uppercase has no
  descenders, so centring the em box still reads half a pixel high.** The answer is
  one pixel more padding above than below (`.role-done`/`.role-waiting`
  `3.75px 7px 1.25px`, `.ask-rec` `2.5px 6px 0.5px`) — and the way to settle it is a
  **4x render with a 1px line drawn at 50% of the pill**, which is exactly what the
  eye compares. Two earlier attempts were "measured" as centred by two different
  metrics and both still looked high; the operator's red line was right and the
  arithmetic was not.
- **A repro page needs the palette's own context.** `--green`, `--amber` and the
  rest are declared under `body.dark`, and the font comes from
  `web/vendor/summit.css` — a repro that links only `synapse.css` renders in Times
  with transparent pills, and every measurement taken from it is wrong. Link both
  and set `class="dark"`, or measure in the app.
- **`browser_wait_for` can match stale text.** Waiting for "Waiting on" to
  confirm a delegation had started matched the *transcript's* own prose from an
  earlier run and returned immediately. For anything live, poll
  `GET /api/runs` from the Code Mode runtime (`fetch` works, and
  `browser_wait_for` with a text that cannot exist is a usable sleep) and assert
  on the API's own answer.
- **A session can be deleted under the UI's feet.** Synapse deletes its own
  scaffolding, and another tab can delete one too. The UI used to keep the dead
  session open, and every control on it answered 404 — which is exactly how a mode
  switch reported `Could Not Switch Mode … 404 Session not found`. Now
  `deleteSession` broadcasts `session.deleted`, `loadProjects()` closes the view
  when the open session is no longer in the project list (guarded on the engine
  being ready — with the engine down that list is empty for reasons that have
  nothing to do with this session), and a 404 from an action re-reads the projects
  instead of reporting a failure the operator can do nothing about.
- **`body { min-width: 1100px }` is the source of the horizontal bar on a narrow
  window.** Below 1100 the page is deliberately wider than the window (the cards
  need ~790px of stage, so the alternative was squeezing them), and the browser
  shows a horizontal scrollbar. At 900px it is 200px of scrolling; at the operator's
  842px window it was 258px, and that is what made the panel look cut off on the
  right and left a bar across the bottom of it. **Not yet decided**: whether the
  floor should come down (stack the card columns below some width instead of
  scrolling) — it is the last layout question open.
- **A ceiling is not a height.** `fitChatHeight` used to set `max-height`, which
  only ever takes room away: a conversation shorter than the ceiling left the chat
  ending above the window's bottom with the rail showing underneath — exactly the
  "not anchored any more" report. It sets a definite `height` now (and clears it in
  the wide layout and on an empty dock), and the dock transitions `height`, not
  `max-height`.
- **The panel needs `overflow: hidden`.** Its action row has a square background
  and sits flush against the panel's bottom edge, so without clipping it painted
  over the 16px radius and hid the orange border's curve at both bottom corners.
- **`.ask-input`'s `width: 100%` beat the custom-answer override.** The "Something
  Else…" box is indented 21px, so 100% of the *row* made it 12px wider than the
  space it had, which gave the fields a horizontal scrollbar. `.ask-opt
  .ask-other-text { width: calc(100% - 21px) }` — two classes beat one.
- **`display: revert` does not mean "back to my stylesheet".** The Multi reveal
  used it to un-hide the worker cards, and `revert` rolls back to the USER-AGENT
  value — `block` for `<article>` — so every worker card silently stopped being a
  grid item. The visible symptom was the missing gap between the name row and the
  task line (`gap: 8px` had never applied to them; measured 0). Worse, the
  show-rule written to replace it lost to the hide-rule's `:not()` specificity,
  so Multi showed no worker cards at all. Hide conditionally instead
  (`body[data-view="session"]:not(.workers-on) …`) and let each element keep its
  own display. Check the *computed* display, not the class list.
- **Below the breakpoint the chat is bottom-anchored.** `fitChatHeight()` caps the
  dock to the room between where the cards *will settle* (`--reveal-h`, the
  reveal's target — never the live position) and the window's bottom, so the
  composer sits on the window's bottom edge in both modes and only the chat's top
  moves as the cards collapse or reveal. There is no `70vh`/`720px` ceiling: a
  ceiling is what left the chat floating short of the bottom with the rail showing
  underneath it. Measured at 900x880, traced frame by frame: the dock's bottom
  held at 868px for the whole slide in both directions while the top moved
  501 ↔ 146.
  Two things make it hold. `.chat-dock` transitions `max-height` with the same
  260ms ease as the card reveal (narrow layout only), so the shrinking height and
  the moving top cancel out; and a **re-measure must not land mid-slide**
  (`revealUntil`): the ResizeObserver fires exactly then — adding `workers-on`
  resizes the topology — and re-driving the layout restarts the wrapper's
  transition while the chat's own curve keeps going, which showed up as a 29px
  bounce of the composer. The observer and the render-time re-measure wait for the
  slide; a mode switch never does. A frame-by-frame correction loop was tried
  first and was worse: the height lags the moving top by a frame, which overshot
  the window by 40px.
- **The subtitle reserve shrinks on a short window**
  (`@media (max-height: 820px) { --task-lines: 2 }`): three lines of empty card is
  a luxury paid out of the chat. It is fixed *within* a window size, so the
  no-shift rule still holds; only a resize across the breakpoint moves anything.
  The ask panel is no longer a floating card at all — it covers the chat's
  transcript area edge to edge, so there is no `max-height` to floor; its fields
  scroll inside it and the action row is pinned to its bottom row.
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
- **One assistant block per turn, not per step.** The engine emits an assistant
  message per step (reasoning, tool call, reasoning…), so rendering them raw gave
  a three-question chat fourteen "Architect" headers. `groupTurns()` merges
  consecutive assistant messages: one header, the steps in order, the answer
  panels amongst them. Three questions now render as three blocks.
- **Tool rows are deliberately small.** `.tool-head` is 22px high: 7px flat
  status dot (no ring), 10.5px mono, `2px 7px` padding, 5px-radius pill at 9px.
  A busy turn emits dozens of them, so a `2px` margin keeps the transcript
  readable where a `5px` margin plus the standard 9px ringed dot read as noise.
- **Expanded state lives outside the DOM.** The transcript is rebuilt on every
  poll, so an open Reasoning block or tool card used to snap shut whenever the
  next render landed. Two things fix it: every part is tagged with a stable key
  (`<message id>:<index>`) and `state.open` holds the open keys, restored on
  render (`data-k` on `<details>`, `data-tool-card` uses the key directly); and
  `renderTranscript()` computes a signature of the conversation and returns
  early when it has not changed, so a poll that learned nothing new does not
  touch the DOM at all. Verified live: a Reasoning block and a tool card opened
  during turn 1 were still open after turn 2 rebuilt the transcript.
- **Nothing in the transcript has a fill any more.** The three speakers share one
  block (coloured name + 2px rule, see "Speaker headers" above); the Architect's
  answer and Synapse's report are the same markdown body. An earlier design gave
  each a tinted panel with an operator-chosen colour, and it was removed: the
  speaker's name already says who is talking, so the fill was decoration that
  needed a palette exception to justify itself.
- **Mode colours:** Multi is orange, Single is violet, both with white text and
  a white dot; both are filled pills, so the mode is readable at a glance. The
  composer placeholder is `Message` in Single, `Message the Architect…` in Multi.
- **The composer has no target picker, deliberately.** One interface, one lead:
  every message goes to the Architect. Per-role model/effort are card controls.
- **`Ctrl+Enter` sends; `Enter` is a newline.** The operator asked for it once the
  prompts became multi-paragraph: Enter and Shift+Enter insert a line, Ctrl+Enter
  (or the Send button) sends. The textarea's title says so.
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
