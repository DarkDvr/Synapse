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
│  ├─ plans.js                 the project plan file (read/validate/brief)
│  ├─ modelcache.js            per-model knowledge (data\model-cache.json)
│  ├─ probe.js                 the tool probe + one-off model toolset checks
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
  the user message, and the Single mode toggle.
- orange (`#ff7d1a`) is reserved for accents only: accent text, borders
  (connector rails, the lit arrowhead) and dot-ants.
- green / amber / red are semantic only — never decorative.

Affordance colours: `+` add is green, `✕` delete is red, `⚙`/`✎` are yellow.

**Sample vs. live.** The UI is live-only: the design-preview entry and the
`SAMPLE` badges were removed before live testing, so nothing shows invented
content. What is not wired yet carries `data-soon`, which raises a toast naming
the stage that will wire it. The role cards' per-role instructions (the ✎
button) are the remaining stub; their model, effort and live activity are real.

**Left sidebar is two-tier.** A project is a panel with its own surface, a
chevron, and everything inside it — its two shortcuts, the **Sessions:** label
and the sessions themselves — lined up to the right of one vertical yellow rule,
so the block reads as belonging to that project. Sessions never carry a
background, so the two tiers never read alike. Under each project's header sit
its two shortcuts: **Browse** (Explorer) and **Cmd** (a command prompt at that
folder), because those belong with the project they act on, not in a rail panel.
There is no Project panel and no path label anywhere: the tree already names the
project, and the path was never what you looked at.

**Role cards are live.** Each card carries a subtitle while its role has
something to show: a worker shows the task it was handed with its newest tool
call in brackets — "Implement calendar script (writing calendar.py)" — and the
Architect shows who it is waiting on, or what its own turn is doing
("editing plan.json", "asking the operator"). The task id and the destination are
deliberately absent: the arrow already says who and where.

**The subtitle slot is three lines tall whether it is used or not.** A card that
grew when work started pushed the chat down every time an agent began — the
mechanic was right but it read as the whole UI jumping. Reserving the space once
means nothing moves, ever; the text is clamped to the slot (all worker cards
measure 106px) and the full text is the tooltip. `--task-lines` is the one number
to change, and it drops to 2 on a window shorter than 820px so the reserve is not
paid for out of a chat that is already tight.

The stage's second row is still `minmax(0, 1fr)` under a definite height, so
anything that *does* grow — a raised `--task-lines`, a font swap — comes out of
the transcript's top edge and never moves the composer.

Below the 1460px breakpoint the chat is **bottom-anchored**: its height is the room
between where the cards will settle and the window's bottom, so the composer sits
on the window's bottom edge in both modes and only the chat's top edge moves when
you switch. It moves with them too — the dock transitions its cap with the same
260ms ease as the card reveal, so the bottom does not move by a pixel.

**The two roles in a delegation are the only cards that change appearance.** The
requester takes green (the Architect's own colour) and the worker red; colour
only, because a width change would shift every card below it.

**Connectors.** The idle structure is small round dots at 75% opacity with no
arrowheads. When a delegation runs, one solid **yellow arrow** is drawn from the
requester's bottom edge down the spine and across into the worker, with **orange
ants** travelling it — the direction of the work, not a decoration. It is
measured from the real boxes at full precision (the connector cell's exact
centreline, the dotted band's exact centre) so the arrow covers the dots it
replaces; verified live as `M 445 80.938 L 445 125.406 L 478 125.406`, where 445
is the spine, 80.94 the Architect's bottom, 125.41 the band's centre and 478 the
worker's own edge. The ant count and speed are derived from the path length, so
the beads read as one dotted line whatever the distance. The shape is
`docs\stage-1-mockup-rev6.pdf`.

**No topbar.** The main pane starts at the top edge. Breadcrumbs were dropped
(the tree highlights the current project and session); model and effort choices
live on the role cards, where they belong, not in Settings. The last engine
event is a row in the sidebar's STATUS block. The working area is left-anchored
and capped (`--work-w`, 1240px): sidebar → role cards + chat → rail → empty
space at the window's right edge, with the same geometry in Single and Multi.
Role cards have a **360px floor**, so the full three-column layout needs
**1460px** of window. Below that the rail flows under the chat (the stage keeps
its full width so the cards never squeeze); down there the rail is two equal
halves — the Project plan on the left, Tools in use on the right.
Below 1100px the window scrolls horizontally.

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
| `defaults.directory` | working directory for sessions that belong to no project |
| `roles.<id>` | per-role model choice: `{ "ref", "variant" }` — the Architect included |
| `logging.retentionDays` | logs older than this are deleted (default 7) |

There is deliberately **no "default model"**: every role, the Architect
included, owns its own `{ ref, variant }` under `roles`, and those choices are
what persist across reloads. An old `defaults.model` from an earlier version is
migrated into `roles.architect` once and removed.

## Models, thinking effort and context

Model pickers are **searchable comboboxes**: type `deep` and the menu narrows to
DeepSeek. The typed text only filters — a model can be set only by choosing it
(click or Enter), so a typo can never become the selection. Rows are compact and
carry a **source chip** (`OpenCode`, `OpenCode Go`, later a local runtime): the
provider is part of a model's identity, so two entries with the same display
name can never be confused, and local LLMs will slot into the same list. The
Architect card is always on screen, in both modes, because its model and effort
are yours to change at any time.

Next to every model picker is a chevron button: a dot means the engine's own
default, one to three chevrons show the three highest efforts that model allows
(e.g. Cat Jam Free is `high → xhigh → max`; DeepSeek is `low → high → max`), and
a left click cycles through them. The tooltip states the current effort **using
the name the provider reports** — `xhigh`, `max`, `turbo`, whatever that model
actually calls it — and appends `· N tools` once the model's toolset is known.
A model with two variants gets two chevrons, one gets one, none gets a disabled
button.

- **Every role persists its own choice.** The Architect card is the main
  session: changing it switches the open session immediately; worker cards store
  their pick for the orchestration layer (stage 3+). Both live side by side in
  `config\synapse.config.json` as `roles.<id> = { "ref", "variant" }` — there is
  no default model anywhere.
- **Each model is asked at most three times, ever** (configurable in Settings:
  `modelChecks.maxAsks`, 1–20; **Reset Ask Counters** zeroes every model's count
  without discarding valid results). Selecting a model fires a background check
  that asks it what tools it has; the answer, together with its context, output
  and effort variants, is stored in `data\model-cache.json` keyed by the full
  `provider/id` ref. The same model under a different provider (`opencode` vs
  `opencode-go`, or a future local runtime) is a separate record. A silent or
  failed answer earns a retry — on the next selection or the next Synapse start —
  but only up to the cap; after that the model is left alone. The catalog itself
  is re-recorded for free on every boot, and models that leave keep their record.
- **DeepSeek V4.1 Flash Free serves 1M context, not 200k.** The engine's catalog
  is conservative; the backend serves 1,048,576 tokens (boundary-tested, ~1.037M
  OK / ~1.107M HTTP 400). Synapse writes the override from
  `engine.opencode.modelLimits` into the engine's isolated config on boot. Only
  the engine's local budgeting ceiling changes — the provider still enforces its
  own. MiMo-V2.6-Flash and Big Pickle are left at 200k because that is what they
  actually serve.
- Omitting an effort is not "no effort": the engine records `variant:"default"`,
  which maps to the provider's own behaviour. The chevron's dot state keeps that
  reachable.

## Projects and sessions

A **project is a directory**. The engine scopes every session to a working
directory, so Synapse does not invent a parallel concept: `data\projects.json`
just remembers which directories the operator added. Sessions are assigned to
the project whose directory they run in.

- **General** is always present, first and undeletable, and owns its own folder
  (`workspace\general`, created on boot when missing, so it starts with no
  sessions). It is deliberately *not* the workspace root — sharing that folder
  with the projects directory would make General's sessions indistinguishable
  from sessions in a folder nobody registered.
- **Adding a project** creates the folder when it is missing (the engine
  refuses to run a session in a directory that does not exist).
- **Removing a project** only forgets the registry entry. Nothing on disk is
  touched. Synapse refuses while sessions still live in it, so a session is
  never left without a project.
- **Session names** start as `TBD`. When the first turn succeeds, Synapse asks
  the model for a short title through the engine's one-shot `generate` route —
  which does **not** add anything to the transcript — and renames the session.
  One attempt per session, never for a session you have named yourself.
- **Git on the first successful turn.** The same moment also checks the
  session's folder for a repository and runs `git init` if there is none. A
  folder inside an existing repo (Synapse's own `workspace\`, for example) is
  left alone, so no nested repos are ever created.
- **The role cards are live controls, not status.** They carry the per-role
  model and thinking-effort pickers; per-role activity (what each worker is
  doing) arrives with the orchestration layer in stages 3–6.

## The project plan

The plan is a **file the Architect owns**, inside the project it plans:

```text
<project>\.synapse\plan.json
{
  "version": 1,
  "goal": "Print this month's calendar in the console with Python and rich.",
  "tasks": [
    { "id": "t1", "title": "Visual design for the output", "role": "designer",
      "status": "todo", "detail": "layout, colours, highlight style",
      "dependsOn": [], "result": null, "note": null }
  ]
}
```

`status` is `todo · doing · done · blocked · failed`. `blocked` is the one that
matters: the work cannot proceed without the operator, and it is the only red
the pane paints. Roles are the cards the topology already has (`architect,
critic, coder-1, designer, coder-2, auditor, coder-3`), so a task already says
which model and effort will run it. Task ids are required because delegation
refers to them (`run t2`) and a rewritten file must not lose that thread.

- **The file is the source of truth.** There is no store in Synapse and no tool
  for this: the Architect writes it with the ordinary `read`/`write`/`edit`
  tools it already has, and Synapse only **reads** it. A plan edited by hand
  reads exactly like one the model wrote.
- **One writer.** The Architect owns the file; every other role is told it is
  read-only, and the harness fingerprints it around a worker turn so a stray
  edit is visible rather than silent.
- **It survives sessions.** It belongs to the project, not to the conversation,
  so a new chat in the same project continues the same plan, and the pane shows
  the same plan whichever session is open.
- **Synapse never repairs it.** If the file is malformed, the pane names the
  exact problem and the brief carries that same sentence into the Architect's
  next turn — so the model fixes its own document. This is not theoretical: the
  very first plan Synapse generated came back unreadable, because the brief
  itself contained `bin\` and the model copied that lone backslash into a JSON
  string. The loop closed on its own within one turn, prompted by nothing but
  the harness's error message.
- **Nothing forces a plan** out of a simple question. The pane is explicit about
  that, and about which file it is reading.

Every session is **briefed** through the engine's own instruction entries
(`PUT /api/experimental/session/{id}/instructions/entries/{key}`, key
`synapse.plan`) rather than by prefixing text onto your message — a prefix would
join the conversation and read as if you had typed it. The brief is short: which
project, where the plan file is, who may write it, what the current plan says,
the format, and that deliverables go in `bin/`. It is re-sent only when its text
changes.

## Delegation

The Architect does not do the work itself. It **asks**, with a tool:

```text
delegate { task: "t1", note?: "constraints, files, what done looks like" }
```

The tool is stateless — it cannot run anything and cannot see which session
called it — so its reply is just a receipt ("Queued: t1"), and the request is
read back out of the transcript on the turn boundary, the same way the census
reads tool calls. The harness then does what a harness is for
(`src/runs.js`):

1. Creates a **real session** for that task's role, in the project directory, on
   that role's own model and thinking effort — the per-role pickers finally mean
   something. The session is marked `metadata.synapse.internal`, so it never
   appears in the rail: it runs in the project's directory, and only that mark
   tells Synapse it is scaffolding.
2. Briefs it with the project and the plan, and gives it **only its own task**.
   It is told the plan is read-only and is never shown the whole file.
3. Runs it and waits for the engine's own end-of-turn `idle` — never a timer.
4. Records what actually happened in `.synapse\runs.jsonl` (append-only,
   harness-owned: the request, the role, the model, the duration, the outcome,
   and the files it actually wrote).
5. Wakes the Architect with a **synthetic message** — the harness speaking, not
   you, and not the Architect. Nobody has to type "go on" for the loop to
   continue.

```
[harness] t1 (designer) finished in 42s.
Files written: none.
Reported:
...
You are the only writer of the plan: judge this yourself.
```

Three rules hold the whole thing together:

- **The Architect is the only writer of the plan.** The harness never writes it,
  so it never marks a task done; a worker's "done" is a claim, not a verdict.
  If the plan file changes during a worker's turn, that is logged and reported as
  suspicious.
- **The evidence is always stated.** `Files written: none.` is not decoration: on
  the very first delegated run the Designer reported a file path it had never
  written, and that line is what made the claim obvious — the Architect checked
  the disk, kept the task `todo`, wrote the reason into the task's `note`, and
  sent it back. Attempt two produced the real file.
- **A task is attempted at most three times**, then the harness refuses and tells
  the Architect to break it down, change the role or model, or mark it blocked
  for you. It never decides a task is hopeless by itself.
- **Each task has a time ceiling** (`worker.timeoutSec`, Settings → Workers,
  default 300s). Hitting it interrupts the session and reports a timeout — but a
  timeout is a *report*, not a failed task: whatever the worker produced up to
  that point is still gathered and handed over as evidence, which is how an
  interrupted audit was still judged and accepted. A role that genuinely needs
  longer overrides it on its own entry (`roles.<id>.timeoutSec`) — the auditor,
  which reads and runs things, is the one that hit the ceiling in practice.

**Single mode refuses delegation.** The engine offers the tool either way, so the
harness enforces the promise: in Single the request is refused out loud and the
Architect is told to ask for Multi. New sessions start Single; the calendar
session here is Multi.

### Keep building

Between **Stop** and **Send** there is a finish-line flag. It is the switch that
decides how far the Architect goes on its own:

- **On (green)** — after each worker report it judges the task and delegates the
  next one whose dependencies are done, and keeps going until the plan is
  finished or a task is **blocked**. Nobody has to say "go on".
- **Off (grey, like Stop)** — one task per report. It judges, stops, and waits.

It is a property of the session, not of the app: it is stored in the session's
own metadata (`synapse.auto`), so it survives a restart, and the Architect is
told about it twice — in its brief for each message, and again in every worker
report, so flipping it mid-run takes effect on the next judgement. It is hidden
in **Single** mode, where delegation is refused and the switch would be a lie.

Verified end to end on the calendar project: switched on, told the Architect to
continue, and the remaining three tasks (implement → test → deliver) ran
themselves to completion in 12.8 minutes with no further input — five worker runs
recorded, two files in `bin/`, and `python bin/calendar.py` printing the month.

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

**The census describes *now*, not history, so it clears itself.** It starts empty on every boot (`tools.resetOnBoot`, on by default — untick *Clear the tool census on every start* in Settings to keep it across restarts), and Settings has a **Clear Tool Census** button for a mid-session reset. `POST /api/tools/reset`. Left to accumulate it stops describing the current environment, which is exactly what happened after a few days of testing: 184 calls from sessions that no longer existed.

**Tool probe.** The census says what has happened; the probe finds out on purpose. **Run Tool Probe** in the *Tools in use* panel drives one turn per tool in the engine's real toolset - `shell` (pass and fail), `read`, `write`, `edit`, `glob`, `grep`, `question`, `webfetch` (good host and bad host), `websearch`, `subagent`, `execute`, `skill` - each in a disposable scratch session (`workspace\_probe`). Per case it records whether the turn closed, which tool actually ran, whether it failed, and **the tool's own execution time** (not the turn time, which is mostly the model thinking). The scratch session is hidden from the rail and swept at boot; the panel names the model the run used. Results stream into the panel live; `GET /api/tools/probe`, `POST /api/tools/probe/run`.

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

The composer's toggle sits left of the message box. **Both modes have the full
toolset** — that is the point of them.

- **Every new session starts in Single.** One Architect, all tools, delegation
  denied. The Architect card stays on screen (its model and effort controls are
  always useful); the workers are hidden. The chat panel is content-sized and
  pinned to the bottom: empty, it is just the composer; it grows upward as the
  conversation fills, to a maximum of `80vh`.
- **Switching to Multi** (the toggle turns **orange**; Single is **violet**,
  white text on both) slides the chat down and reveals the **workers** at their
  full measured height — they are never cut off mid-card — and clears the
  delegation deny, so the Architect can hand work to subagents.
- **Switching back to Single** slides the workers away and restores the deny. The
  same session keeps its transcript — the mode is a live property of the open
  session, not something chosen at creation.
- The composer placeholder reads `Message` in Single and
  `Message the Architect…` in Multi.

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

`PATCH /api/session/{id}` accepts `permissions`, and that is how the toggle
flips an open session: `[]` clears the deny, the ruleset reinstates it. There is
no target picker in the composer — every message goes to the Architect; each
role's model and thinking effort are set on its own card.

**Delegation is real, verified live.** In Multi the Architect called `subagent`
(general, `completed`) and answered with the worker's reply. The cards
themselves still show no per-role activity — that arrives with the
orchestration layer; what exists today is the model/effort choice per role, the
delegation permission, and the reveal.

## Speakers, and markdown

Three things speak in the transcript, and they **share one format**: a coloured
name, a 2px rule down the left of what they said, and a hairline between turns
with room above and below it. Only the colour differs.

| Speaker | Colour | Says |
|---|---|---|
| **You** | bright purple (`--violet-bright`) | what you typed |
| **Architect** | green (`--green`) | its reasoning, its tool calls, its answer |
| **Synapse** | yellow (`--yellow`) | a worker's report, or something the harness needs the Architect to know |

Nothing carries a fill. The Architect's answer used to sit in a tinted panel and
Synapse's reports in another, with both colours configurable in Settings; that
was dropped once the shared format made it unnecessary — a panel colour said
"this is different" while the speaker's name already said *who*, and two
exceptions to the palette rule in one screen is two too many. Synapse is the
product's name; *harness* is what it is, and never appears on screen.

A worker's report is prose with headings, lists and code in it, so it is rendered
as markdown in the same body class as the Architect's answer. `web/md.js` is
hand-rolled (no dependencies) and **escape-first**: the source is HTML-escaped
before any markdown rule runs, so a model cannot inject markup through its
answer. It covers fenced code, headings, GFM tables (alignment included, pipes
inside `code` don't split cells), blockquotes, ordered and unordered lists
(including `- [ ]` task lists), images, rules and paragraphs, plus inline code,
bold, italic, strikethrough and links — the range these models actually produce.
Link targets are restricted to `http(s)`, `mailto`, `/` and `#` (images
additionally allow `data:image/`).

## Questions

When a model needs a decision, it calls the `question` tool and the session
**blocks** — none of this is chat. Synapse renders the engine's form as a panel
painted over the chat, anchored just above the composer:

- **It cannot change the chat's size.** The panel is absolutely positioned inside
  the dock, so it only ever covers what is already there; measured with it shown
  and hidden on the same transcript, every box is identical. That was the whole
  requirement: no reflow, no jumping transcript.
- **Radios for a single choice, checkboxes for a multiple one**, a checkbox for a
  boolean, a number box for a number, and a text box for free text. Each option
  shows its label *and* its description, because the description is the model's
  reasoning about that choice.
- **"Something Else…"** is always offered on a choice question, with its text box
  disabled until you pick that row — your own words become the answer.
- **Submit is pinned** to the panel's bottom edge, so a six-field form never
  hides the one button you need. Required fields keep it disabled and say why.
- **"Recommended" is a chip.** These models mark their recommendation by putting
  that option first and ending its label with "(Recommended)" — the panel takes
  the suffix out of the sentence and shows a chip, and the role brief tells both
  roles to write it that way.
- **The whole panel is orange** — border, title, dot, option accents and the
  Submit fill — because it is the one thing on screen that is waiting for you.
- **The composer is disabled while a question waits** (`Answer the question
  above`): the turn cannot read a message, so it does not pretend otherwise. That
  applies to the open session's own question — a **worker** can ask one too, and
  its question is shown with `another session is waiting on you` without locking
  the message box you are using.
- **The transcript keeps one line about it** — `question · Index colour scheme ·
  running` — with the raw payload one click away and the answer in it once you
  have replied. The panel is the interface; the card is the record.

The answer goes back through the engine's form reply, and the model continues in
the same turn. Verified live on the `field-notes` project: the Architect asked
which colour scheme the index should use, the answer "Fixed palette" was
submitted, and it closed the blocked task and unblocked the next one.


Separate channels for easy bug-tracking:

- `logs\app.log` — server lifecycle and config
- `logs\engine.log` — engine process output and stream health
- `logs\session.log` — session creation, prompts, session events
- `logs\tools.log` — tool calls and permission requests (raw payloads)

Files rotate at `logging.maxFileMb` and are auto-deleted past
`logging.retentionDays`.
