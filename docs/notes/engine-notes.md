# Engine notes

How Synapse talks to the engine, and the things that cost real time to discover.
Split out of `AGENTS.md` verbatim; the file is read when work touches
`src/api.js`, `src/runs.js`, `src/plans.js` or `src/engines/opencode.js`.

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

## Why Synapse dispatches, and not the engine's `subagent` tool

Settled, and the reason is per-role models: **the Architect cannot choose a
subagent's model**, so leaning on `subagent` would leave every per-role pick
decorative and hide the orchestration in a black box. Each step runs as a real
engine session with that role's model and effort instead.

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
  A recoverable provider failure is not an attempt either: a task that was rate
  limited five times and then finished is on attempt 1, because nothing about the
  task failed.
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
- **Build tasks are planned for coder-1, and only coder-1.** The ladder is the
  harness's, not the Architect's, so a plan that names coder-2 or coder-3 starts on
  that rung immediately (`candidatesFor` slices from the role's own rung) and spends
  the fallback on work the first coder could have done — the operator pays for it. The
  brief's `build:` rule now says so in those words, and `validatePlan` reports any
  task written for coder-2 or coder-3 as a problem with the reason attached. Shift
  Test 4 was the evidence: the Architect spread six build tasks across all three
  coders while coder-1 was idle, and the cheap model was never tried.
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
- **A worker is never killed for taking a long time.** There is no wall-clock
  ceiling: a designer turn of forty minutes is normal on a busy evening, and a turn
  that is writing, reading or reasoning is working. What is stopped is a turn that
  produces *nothing at all* — `waitForIdle` compares a signature of the transcript
  (message and part counts, timestamps, text length) on every poll, and when it has
  not changed for `worker.stallSec` (Settings → Workers, default 600 s), the turn is
  interrupted and **resumed**, not failed: the session is told to continue from
  exactly where it stopped, up to `worker.resumeMax` times (default 4), then it is
  reported as a timeout. `roles.<id>.stallSec` overrides the window for one role.
  That is the operator's own recovery, performed for them — they had watched the
  desktop app sit on "Working…" for an hour with nothing behind it, and fixed it by
  saying "you got stuck, continue".
  **This is measured, and the old ceiling was the wrong shape.** On the clock run
  (19 Oct) three consecutive turns hit a 600 s ceiling *while working*: the designer
  made 48 tool calls and wrote a 447-line contract plus four mocks, the coder had a
  40 KB shell on disk. The Architect accepted that partial work afterwards; nothing
  was wrong except the number.
  **A question for the operator is not silence.** While the transcript shows a
  `question` tool part still running, the stall clock is paused, so the operator can
  take as long as they like — otherwise every worker that asks anything would be
  interrupted for asking.
- **Recoverable provider failures never end a run.** `src/provider-errors.js`
  classifies the sentence a turn ended with. *Transient* — rate limit/429,
  connection reset, socket/network/DNS, 5xx, "overloaded", the free-tier message,
  and **anything unrecognised** — is retried in the same session with exponential
  backoff (`worker.retryBaseSec` 10 s doubling to `worker.retryCapSec` 300 s, ±20%
  jitter), indefinitely. It does not consume an attempt, does not move the ladder,
  and keeps every file already written: the harness sends `synthetic` "continue"
  rather than starting a new worker from scratch. *Terminal* — deprecated/retired
  model, invalid API key, explicit 400/422 — ends the delegation and moves the rung.
  *Context* — the prompt did not fit the window — is a third kind, because neither
  of the other two is right: retrying the same request fails identically, and the
  run is not over. The harness asks the engine to compact and then sends "continue
  from the summary, keep each turn small", for the worker and for the Architect
  alike. This is the error a local server set to **Stop at Limit** returns; the
  alternatives are worse — *Truncate Middle* silently drops the middle of the
  conversation (the task at the top and the last turn survive, the file contents
  between them vanish), and *Rolling Window* drops the beginning. The rule is
  tested before `bad-request`, because OpenAI wraps an over-long prompt in a 400.
  **The engine does not retry; the harness must.** Measured on the clock run: a rate
  limit landed at 00:41:03 and the session was `idle` one second later. The desktop
  app survives that because the client retries; the engine's API does not.
  **A rate limit must not mark a model.** It used to write a `provider` issue, and
  `candidatesFor()` skips marked models — so one 429 at 00:41:04 made every role on
  that model look refused, and the delegation then moved to a model that was
  retired. Only `deprecated` marks a model now; a 401 stops the turn and reports,
  but is never written as a permanent mark (a server under load may be lying, and a
  badge outlives the lie). **Guarded by `node tests\provider-retry.test.mjs`**,
  which drives the real runner against a stubbed engine — 26 checks over
  classification, retry, resume, stop and the wake — because this is the code that
  decides whether an overnight run survives, and every one of those behaviours was
  invisible in review the first time.
- **The wake is watched, not fire-and-forget.** `wake()` used to admit the report
  and move on. On the clock run the Architect's own turn then failed on a rate limit
  two seconds later: the report sat in a transcript nobody read, no delegation
  followed, and the run stopped with the UI showing an idle screen. The wake now
  waits for the Architect's turn and retries its failures on the same schedule; the
  report is sent once and later attempts just say "continue".
- **Stop is the way out, and it is a run-level cancel.** `POST /api/runs/cancel`
  aborts an `AbortController` for that directory: the poll and the backoff sleep see
  it on the next tick (so a five-minute wait stops immediately), the worker session
  is interrupted, the result line is `outcome: 'stopped'`, and **no wake is sent** —
  waking the Architect after a stop would start a turn that could re-delegate the
  very task that was just stopped. The button is enabled whenever a run is live for
  the open project, not only when the open session is busy; it used to be disabled
  exactly when a worker was running, which made it useless for delegations.
- **Every provider failure is written to `data\provider-errors.log`** — its own
  file, its own 30-day retention regardless of `logging.retentionDays`, pruned at
  boot and (throttled to six hours) on write. One line each: timestamp, transient or
  terminal, reason, role, model, task, retry number, and the provider's sentence
  truncated to 180 characters. It exists to answer "are evenings slower, and how
  often is that rate limits?" across months; a month of lines is a few hundred
  kilobytes.
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

The seven cards are `architect, inventor, coder-1, designer, coder-2, qc,
coder-3`. `auditor` and `critic` are retired: the Architect verifies its own
delegations against the disk, so a second confirmation was redundant. The
adversary slot is **QC** (quality control) — the role that judges the build the
way an ordinary person meets it. A config written before a rename is migrated once
(`normalize()` folds `auditor`→`inventor`, `critic`→`hacker`, `hacker`→`qc`), and a
plan file written before it is translated on read (`LEGACY_ROLE` in `plans.js`), so
neither a saved model choice nor an existing plan is lost.

The pipeline is a **menu**, not a checklist: the Architect picks the phases per
project and records them in the plan's `phases`. A clock pays for invent → design
→ build the shell → wire it → QC → fix → re-check; a word-count CLI pays for two
tasks. Roles are identities plus one mandate each (`ROLE_MANDATES` in
`plans.js`), and each owns one folder:

| role | may write | produces |
|---|---|---|
| inventor | `.synapse/ideas/` | `ideas-1.md`, ranked, with a one-line why and effort |
| designer | `.synapse/design/` | `design.md` (the spec) + `mock-N.html` |
| qc | `.synapse/qc_findings/` | `qc-N.md`: ids `Q1…`, severity, exact repro |
| coders | the project | `bin/` |

**The file contract is the point.** `.synapse/` holds `requirement.md` (written by
the harness from the operator's own message, append-only — never a model's
paraphrase), `decisions.md` (the operator's answers to every question asked, same
rule), `plan.json`, `features.json` (confirmed + rejected, every confirmed
item naming the task that delivers it), `ideas/`, `design/`, `qc_findings/` and
`runs.jsonl`. Each brief is assembled from those files, so a worker receives the
operator's words and the confirmed features verbatim, and the rejected ones are
never passed on.

**An example in a brief is a template, not an illustration.** The Inventor's first
mandate said "build me a clock, go" and offered an alarm, a theme and a second time
zone as the shape of a good answer. It was written for the clock project and would
have been sent to every project after it — which is the rule in AGENTS.md, and the
reason it was pulled before a run rather than after one. Few-shot examples are the
strongest thing in a brief and the least controllable: the model copies the surface,
not the lesson, and the mandate is the one place with no operator in the loop to
notice it. It now asks for the same thing without a subject — a named behaviour
small enough to say in a sentence and sayable out loud the way a user would, with
"settings / polish / good UX are not features" as the anti-pattern — plus a rule to
take any illustration from the operator's own request. Write the general rule in
the brief; keep the incident that earned it here.

**The features gate is a multiselect, one option per proposed feature.** The
Inventor proposes; the Architect asks which to include. It used to ask "how much
of it should the clock do" with three bundles, which hid ten individual ideas
behind a mood — the operator's word: they wanted to tick the ones they wanted.
The brief now says: one `multiselect`, never bundles, the recommended ones first
with `(Recommended)`, each option's description carrying that idea's one-line why
and its effort, and `custom: true` for their own. The panel already rendered a
`multiselect` as checkboxes with descriptions, so this was a brief change, not a
UI one. It is instruction, not enforcement — the question schema is the model's
to author.

### What the first real run cost (Clock Test 2: 2h 51m, nine tasks, no retries)

Measured from the engine's own store (`data\engine\opencode\data\opencode\opencode.db`,
`session_message.data.tokens`), not from wall-clock guesses. Nine tasks, zero
retries and zero resumes; 749 model turns; 727k tokens written, **70% of it
thinking**; 13% of the time in tools, the rest in generation.

- **The plan is written in full before the first task runs.** It opened with two
  steps and the Architect added seven while it worked, so what the operator
  approved on the first screen was not what ran. The brief now says so, and the
  validator names the visible symptom: `phases lists "build" but the plan has no
  task for it - write the whole plan before the first task runs, or drop the
  phase`. "The plan is finished" also means every declared phase is covered, which
  is what stopped the missing-summary note firing at 10:59 while the Architect was
  still writing the plan.
- **A second QC pass is a check, not a new hunt.** Round 1 (38m) found nine
  issues; round 2 (32m) re-verified them and opened a new matrix ("every UTC
  offset from -12 to +14") for two off-path edges; round 3 (6m) re-ran the repros
  and the suites and stamped SHIP. The cheap round is the model: the brief now
  says a second pass re-runs the listed repros *and nothing else*, and anything
  new goes in an "observed, not fixed" list.
- **A task that runs long gets slower per turn.** Throughput by prompt size, same
  model: **157 tok/s under 50k, 145 at 50–100k, 117 at 100–150k, 68 at 150–200k**.
  Every long task here finished at 212–290k, and its second half ran at half the
  speed of its first (t2 151→76, t4 167→75, t5 165→82). QC hit 290k and
  auto-compacted (a 228k-token summarise call). The causes are visible: 84% of
  turns issued exactly one tool call, and the engine stores `reasoning` parts in
  the transcript (985 of them here), so thinking is re-sent every turn —
  per-turn growth measured ≈ text + thinking + tool output. What that prompt is
  made of, measured on t4 (212k, no compaction): **thinking 43%, tool results
  30%, tool call arguments 19%, screenshots 4%, instructions 3%, the actual
  conversation ~1%**. Whole file bodies ride along as `write` arguments, and a
  file read at turn 12 is still in the prompt after turn 40 edited it.
  Compaction is not the fix and 200k is not a number to build on — see the window
  watchdog in `docs/notes/models-and-tools.md`.
- **The meter is turns × transcript, and the briefs now say so.** Clock Test 3 read
  **56.4M prompt tokens** (workers 50.3M, Architect 6.1M) over 515 turns: t2 12.8M
  in 71 minutes, t6 13.7M in 34. That is 180–430k tokens a minute, where an
  interactive chat is 100–200k with long gaps — the density is what a free tier
  refuses, in bursts of 5–11 minutes. Since every turn re-sends everything, the
  only instructions that move it are the ones about *how much gets said and how
  often*: think in a sentence and act (thinking was 51% of the transcript), read a
  file once and search it after, edit rather than rewrite (a `write` keeps the whole
  file body), keep the spec under 200 lines, and give tasks a named file and a
  proving command so the worker does not have to explore. The number is reported on
  every run (`Effort:` / `context` in `runs.jsonl`) so it can be measured, not
  guessed.
- **So the harness reports the cost of each run.** The report the Architect gets,
  and the chat, carry one line: `Effort: 130 turns, 118k tokens written (74%
  thinking), context peaked at 212k`. It is also on the `runs.jsonl` result line as
  `context: {turns, peak, generated, thinking, compactions, thinkShare}` and in the
  app log, so an audit reads the run log instead of the engine database. Not on the
  role card: the operator asked for the chat and the log.
- **QC's default focus was dialled down.** `app` now judges the operator's own
  screen and machine, calls another hemisphere / another screen size / a
  hand-edited constant an observation rather than a finding, and says a minor or
  nice-to-have is a note, not a reason for another fix round.
- **Harness alarms judge what a shell does, not what it names.** Eleven of the
  run's alarms were the Architect running `skills\visual-review\shot.mjs` before
  judging a report — the toolbox doing its job, already visible in the transcript,
  the census and the session log. A command whose only harness paths are under
  `skills/` is now quiet; one that names the rest of the harness, or that is shaped
  like a write (a redirect with a real target, or `Set-Content`/`rm`/`mv`/…), is
  still an alarm, and a *write tool* on a harness file is an alarm for everyone.
  Replayed over the run's 399 shell commands: 21 would have alarmed before, 1 does
  now (a compound command that edits project scratch *and* runs the renderer —
  ambiguous, and kept on the loud side). The one "CHANGED DURING A WORKER RUN"
  alarm was the operator's own Settings save, and `configSavedAt()` now excuses
  exactly that: a config change no save of ours explains is still reported.

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

- **Skills** — two levels, in one row of the dialog. The tick on the left is
  *allowed*: the engine refuses anything unticked. The small **Required** box on the
  right is `roles.<id>.mustLoad`, and it changes the brief from "here is what you
  may load" to "load every one of them before your first edit … a skill you skipped
  is part of the job you skipped"; the runner then reads the worker's transcript and
  tells the Architect which required skills never appeared. Required is a subset of
  allowed by construction: the box is dead until the skill is allowed, `normalize()`
  filters it again on the way in, and the dialog filters it on save. A required skill
  the engine refuses would be reported missing on every run, for ever.
  Ticking every skill stores *no* `skills` list, because
  that is the same thing and it lets a skill added later reach the role.
- **Focus** (QC only) — `app` by default, `security` when needed.
- **Instructions** — free text appended to the role's brief on every turn
  (`roles.<id>.instructions`, capped at 2000 characters).

**QC has a volume dial, and it starts low.** `roles.qc.focus` is `app` unless it
is set to `security`, and in `app` it judges the build the way an ordinary,
non-technical person meets it, in this order: **wording** (labels, errors and
reports written in a coder's voice or in jargon — a message the reader cannot
understand is a defect, and QC quotes it and gives the plain version), **design
flaws** (clipped or overlapping text, broken layout, unreadable contrast at the
sizes the project must support), **missing input validation**, and **states that
lie** (silence where something happened, a wrong status, work lost on refresh).
The old `Hacker` tested an app the way a person types into it; QC is that, plus
the reading a non-technical user does. It is still told, in those words, not to
build hostile environments, run locale or interpreter matrices, or fuzz in loops —
`security` is the same role with the gloves off. Both carry a proportion rule ("the
cases with the best chance of happening beat a complete matrix"), because the
197-second
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
| `frontend-design` | taste and direction: distinctiveness, typography, avoiding template defaults (Apache 2.0, licence kept) |
| `aesthetic-foundations` | composition, colour and hierarchy theory plus a critique protocol, for judging a design |
| `code-craft` | the coders' brief: match the surrounding style, keep the surface small, fail loudly, prove it, report what ran |
| `web-guidelines` | the Web Interface Guidelines snapshot (MIT, 21 Oct 2026): focus, forms, motion, hit areas, contrast — the rules QC holds a build to |

**Where the engine looks, and which copy wins.** The engine reads the configured
`skills.paths` *and* `~/.agents/skills` by default — so the operator's own library
stays useful to every other app and still shows up here. When a name exists in
both, the **configured** copy is the one loaded: measured on 2.0.30 by putting a
distinct description in each copy and restarting, the shipped text was the one
read, while a probe skill that existed only in `~/.agents/skills` was still
listed. (An earlier test of the opposite was wrong because PowerShell's
`-replace '^description:'` does not match per line without `(?m)`, so the marker
was never written — verify the file, not the edit.) The consequence is simple:
ship the copy Synapse should use, and leave the global one alone.

**What each role gets by default.** Architect may load `visual-review`, and must
load it before judging. Designer may load all four design skills and must load
`frontend-design` and `aesthetic-foundations`. Every coder may load `code-craft`
and `visual-review`, and must load `code-craft` (a coder that can screenshot its
own shell before reporting is cheaper than a round trip). QC may load
`web-guidelines`, `aesthetic-foundations` and `visual-review`, and must load the
first two; its volume dial is `roles.qc.focus`, not a missing skill. The Inventor
may load `frontend-design` and must load nothing: an ideas role handed design
skills starts designing, but a vague request ("build me a clock, go") is where
direction and typography talk actually helps it name features instead of
categories.

**One skill was deliberately not shipped, and why matters.**
`using-superpowers` reads like coding guidance and is not: it is a rule about
*when to invoke skills* ("if there is even a 1% chance a skill might apply, you
MUST invoke it"), its examples name `superpowers:brainstorming` and
`systematic-debugging`, neither of which is installed here, and it carries seven
per-harness tool references (Claude Code, Codex, Pi, Antigravity, Hermes, Muse)
that mean nothing in a deepseek session. Given to a coder it spends the turn
announcing skills that do not exist. The operator wanted "best practices to write
good code", so `code-craft` was written instead. Read a skill before shipping it;
a description is a claim, not a measurement.

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

## Single and Multi mode

The composer toggle flips the **open session** live; new sessions always start
Single. Both modes have the full toolset — that is the whole point.

- **Single** — a permission ruleset on an ordinary session that denies only
  `subagent`: not a custom agent, not a blanket deny. The role cards stay
  collapsed (`max-height: 0`), so a Single session pays nothing for them.
- **Multi** — the ruleset is cleared (`PATCH /api/session/{id}` with
  `permissions: []`), the wrapper animates open and the chat slides down. Verified
  live: the Architect called `subagent` (general, `completed`) and answered with
  the worker's reply; a subagent run does not leave a child session in the rail.

The mode is a per-session property read from `isSingleSession()`
(`engines/base.js`); nothing is stored in config — `defaults.mode` was removed
once the toggle became live. **A dedicated `chat` agent (tools denied, `steps: 1`)
is the obvious design and it does not work**: the free tier rejected every request
from a custom agent with a provider auth error (measured side by side — the
custom-agent session failed at 20:45:37 while a default-agent session succeeded at
20:45:40). Denying everything also defeats the purpose, because Single is meant to
have tools. `POST /api/session` accepts `permissions`; `PATCH` replaces them.

## The tool census double-counts after a restart

`recordMessages` is called with the **whole transcript** on every turn and
de-duplicates with an in-memory `seen` set of tool-part ids — which is not
persisted, while the aggregates are. So the first turn in a session that predates
a restart re-adds that session's entire tool history. Reproduced: 2 calls →
restart → re-scan the same transcript → 4.

A naive test **looks clean**, because `flush()` is debounced by 2s: call `flush()`
before "restarting", or the first run never reaches disk. The fix is small
(persist the ids, or a per-session high-water mark); do it before trusting the
census for anything.

## Session naming, and never being stuck with "TBD"

A session is created as **TBD**. When its first turn succeeds, Synapse asks the
model for a short title through the engine's one-shot `generate` route — which
adds nothing to the transcript — and renames the session. One attempt per
session, never for a session the operator named, and never for a session with no
user message yet.

Naming is **self-healing**: a name that failed on a transient 503 keeps its
attempt and retries with backoff, and a sweep at boot names anything still
unnamed.

## A question lives in the engine's memory, so a restart loses it

The `question` tool does not write the question into the transcript and wait. It
opens a **form**, and the engine holds that form in memory. Synapse only ever
sees it through the engine's own routes, so if the engine goes away the question
goes with it.

Measured on 21 Oct: a form was waiting, the operator restarted Synapse to pick up
a fix, and afterwards there was nothing to show. `GET /api/pending` returned no
forms and no active sessions, and the transcript's `question` card still read
**running** — a state that can never finish, because the engine that was going to
answer it no longer exists. That session cannot be resumed from there; a new
session is the honest fix.

Two rules follow.

1. **A restart abandons a pending question.** Nothing recovers it. Say so before
   restarting while a run is waiting on the operator, and expect that run to be
   started again.
2. **The question has to be findable outside the open session.** The answer panel
   only exists inside a session view, and a page load opens nothing, so the rail
   marks the session that is waiting (Answer / Decide) and a waiting question is
   announced once. A blocked session and an idle one both emit nothing, so the
   rail is the only honest signal.

## An answer is delivered once, into a transcript a compaction can replace

The operator's reply goes back through `form/{id}/reply`, the engine records it as
the `question` tool's output, and the model reads it in its next turn. That is the
whole mechanism — there is no separate channel, and no confirmation the model read
it. Shift Test 5 showed the seam: the designer was given the same two decisions at
19:46 and 19:51 (both recorded verbatim in the transcript, both printed as *"User
has answered your questions … you can now continue with the user's answers in
mind"*), kept working, then re-opened the settled question at 19:51 and asked it
twice more at 19:53 and 19:54 — 90 seconds apart, with the answer in its own
context and nothing compacted in between. That repetition is the model's, and the
question-loop guard is what stops it.

What is ours is that the answer had no life beyond that transcript. A compaction
replaces older turns with a summary, and a summary is a model's account of an
answer; the requirement file exists for exactly this reason and the answer needed
the same treatment. So `replyForm` now appends to **`.synapse/decisions.md`** — the
question titles and the operator's values, verbatim, append-only, written by
Synapse and never by a model, with a header saying an answered question is settled.
Every brief that finds the file says so: *"read it before you ask anything, and
never ask a question it already answers"*. The Architect's features multiselect
lands there too, which is what makes a rejected idea stay rejected.

Two edges worth knowing. The guard's own memory (`questionHistory`) is in-process:
a restart forgets which questions were already asked, so the file is the only
durable record for the *next* run, not a replacement for the guard. And a session
outside a project has no `.synapse`, so nothing is written — the reply still goes
through, and the missing file is not an error.

