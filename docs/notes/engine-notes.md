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
- **There is no built-in project.** The old General project (one workspace per
  session, undeletable) is gone: every project is one workspace and one chat, and
  an existing General folder is adopted as an ordinary project on the first boot
  after the change. A project with no plan still gets one at boot; a project the
  operator deletes takes its chat, its folder and its `.synapse` with it.
- **`id` is required.** Delegation refers to tasks by id, and the Architect may
  rewrite the file at any time; a task without one is flagged and skipped.
- **It is the current request's checklist, not a diary.** A new operator request
  starts a new plan: new goal, new rows; done rows from the last round are not
  carried over (the run log is the history). Two to six rows, each a deliverable.
  A `found` row is allowed only when the round cannot finish without it, one or
  two at most. Every piece of work in Multi goes through the plan, even a single
  file: write the row, delegate it, judge the report — the Architect does not
  write the product itself (Single is the mode where it acts alone; on 28 Oct a
  one-file request was written by the Architect and the plan pane still said "No
  plan yet"). Row times are scoped to the round, so a t1 in a new plan starts at
  0, not with the previous plan's t1. On 27–28 Oct the pane showed two rounds at
  once — seven rows, NEW badges, a QC "verify" row from an earlier round — and the
  operator could not read it as a list.
- **A blocked note is two sentences.** What is stuck and what the operator must
  decide. The pane clamps it to two lines (the rest is in the row's tooltip); a
  wall of the Architect's reasoning turned the whole pane red on 28 Oct. Status
  and note must agree: `done` has no note, `blocked` says what is needed.
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
  plan + Tools in use; a project is one row (a state dot and its name), and its
  Browse/Cmd/Rename/Delete live in a `⋯` menu (right-click and Shift+F10 open the
  same one). `POST /api/projects/{id}/open` spawns a detached GUI process (array
  args, never a shell string), and both branches are validated before anything is
  spawned.
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

- **A delegation can be orphaned by a turn that never ends.** "Read on the turn
  boundary" means `session.execution.succeeded|failed|interrupted` → `handleTurn`.
  Fever Tracker, 22 Oct: the Architect delegated t8 and then asked the operator a
  question in the same turn; Synapse was restarted, the engine rebuilt its
  locations and **cancelled the pending form** (`Form not found: frm_…`), so the
  turn could not end — and the delegation stayed in the transcript for ever,
  answered "Queued", unjournalled and unrun. Nothing was running, t8 stayed
  `todo`, and the Architect looked idle with the work "finished". `recoverDelegations`
  now makes one pass at boot (5 s in) over each project's newest conversation and
  runs anything `requestsIn` still reports — safe because a call id is journalled
  before the worker starts, so a re-scan can never run one twice.
  **A refusal or a deferral is also a journalled decision.** A delegate refused
  because a worker was already running used to be answered and forgotten, so the
  boot scan found it "unread" and started it: on 27 Oct a restart started t5 from a
  round the operator had stopped because of permission friction. The busy branch now
  records `outcome: 'deferred'`, and every refusal path (`single-mode`,
  `unknown-task`, `qc-cap`, `keep-building-off`, `stopped-by-operator`, `deferred`)
  is a line in `runs.jsonl`, which is what makes "unread" mean unread.
  The lesson for the UI: a form reply that answers `Form not found` means the
  question is gone, so clear the panel and say so — never leave a dead form up.
  rather than omitting the line, and why the harness never moves a task.
- **Retry cap: 3 attempts per task**, then the harness refuses with a report
  telling the Architect to break the task down, change the role/model, or mark it
  blocked. Refusals are logged with an `outcome` and no `attempt` number, so they
  do not count against the cap. A refusal is a real answer, not a silent retry.
  A recoverable provider failure is not an attempt either: a task that was rate
  limited five times and then finished is on attempt 1, because nothing about the
  task failed. **An operator stop is not an attempt, and neither is a restart**
  (`countedAttempts`): Fever Tracker's t1 was "attempted" three times — two of
  them stops by the operator — so the cap was spent before the design had ever
  been judged, and the Architect was then refused the retry it needed and had to
  invent a new task. The harness did not spend those attempts; the operator
  cancelled them, or Synapse died under the worker. For the same reason a stop or
  a restart does not move the task down the ladder (`attemptFailed`): t3 dropped
  from coder-2 to coder-3 because a restart interrupted it, and no change to
  coder-2's model could bring it back.
- **A free-plan usage cap gets ten minutes, not for ever.** "Free usage limit
  reached. Connect a provider or subscribe … switch models" classified as
  `unknown` and was retried indefinitely: on 27 Oct t9 sat on it for 13 retries
  and 51 minutes before the operator stopped it, while t8 recovered after about
  five. It is `usage-limit` now (transient, not terminal), and both the worker's
  rescue loop and the Architect's wake stop after `USAGE_LIMIT_MS` (10 minutes)
  with a message naming the model to switch. A hard model mark is still only for
  `deprecated`; a capped account says nothing about the model.
- **Caps are per round, not per project.** A round ends when the Architect says
  the plan is done: every task `done` **and** the customer-facing summary written.
  That close is one `round` line in `runs.jsonl` (`closeRound`), written when the
  operator **sends the next request**, before the brief — so the brief's QC
  allowance is the new round's, and the finished plan keeps its row times until
  that moment (a close at the end of the plan made its own rows read "not run").
  The marker carries the plan file's exact `mtime`; the QC loop's three rounds
  and every task's three attempts count only after it, and the plan's row times
  do too. Without the boundary a
  mature project spent its whole QC quota in its first three rounds and
  self-verified every bugfix round after (27 Oct: three `qc-cap` refusals, and
  only `qc-1` and `qc-2` on disk), and a task id reused by every new plan (t1,
  t2, …) reached the attempt cap although every one of its attempts had
  succeeded.
  Two failures kept the reset from working: the dedupe compared against
  `stat.mtimeMs`, which `readPlan` does not return (it is `stat.mtime`), so after
  the first marker every later close returned false; and the runner did not
  expose `closeRound`, so the send-time path was a no-op. Both fixed 27 Oct.
  The marker is now bound to the plan's exact `mtime` (`planMtime`), not to the
  wall clock: a plan written a millisecond after the close used to look newer and
  produce a second marker.
  The brief also states the round's allowance now ("QC: 0 of 3 …"): the Architect
  had read the previous handover's "three rounds spent", refused to delegate t7
  at all, and wrote "the delegation was refused" into the plan — a refusal that
  never happened, so the round was self-verified for no reason.
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
  **Changing a role's model starts the task over on that role**
  (`modelChangedSinceAttempt`): a failure on the old model is not a reason to send
  the task to the next coder once the operator has fixed the planned role. The
  count and the step-down are reset for that task; a model the provider still
  marks is skipped until the mark is cleared or another model is chosen.
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
- **`runs.jsonl` is the project's, so a session's view of it is a ledger, not a
  sum.** Delegation records carry `architect` — the session that asked — and
  results now carry it too; older results are joined to their delegation by
  `callId`. `runLedger(records, sessionId)` in `src/plans.js` answers both
  questions the plan pane asks: `spent` (the two stopwatches on a row) and
  `reported` (the dashed "handed back, waiting for review" mark). Both used to be
  summed by task id alone. On 27 Oct a new session opened a rewritten three-row
  plan with t2 and t3 already dashed and over an hour on them, and the QC card
  showed a clock while dimmed as unused: the ids had run in the previous session.
  Task ids repeat between sessions and between plans, so nothing keyed by id alone
  may cross a session boundary.
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

The pipeline is a **menu**, not a checklist: a clock pays for invent → design →
build the shell → wire it → QC → fix → re-check; a word-count CLI pays for two
tasks. The Architect used to record that choice in the plan's `phases` field; it
no longer does, and the field is ignored on read (see "The plan became a work
list" below). Roles are identities plus one mandate each (`ROLE_MANDATES` in
`plans.js`), and each owns one folder:

| role | may write | produces |
|---|---|---|
| inventor | `.synapse/ideas/` | `ideas-1.md`, ranked, with a one-line why and effort |
| designer | `.synapse/design/` | `design.md` (the spec) + `mock-N.html` |
| qc | `.synapse/qc_findings/` | `qc-N.md`: ids `Q1…`, severity, exact repro |
| coders | the project | `bin/` |

**The file contract is the point.** `.synapse/` holds `project.md` — the project's
living document, written by the harness, never by a model: a `## Current` head
(the latest request and the decisions still in force), the `## Handover` from the
last compact, the operator's own `## Notes`, and an append-only `## Log` of every
request and every answer. It replaced `requirement.md` and `decisions.md`; those
are imported into the Log on first use and archived. It also holds `plan.json`,
`features.json` (confirmed + rejected, every confirmed item naming the task that
delivers it), `ideas/`, `design/`, `qc_findings/` and `runs.jsonl`. Each brief is
assembled from those files, so a worker receives the operator's words and the
confirmed features verbatim, and the rejected ones are never passed on.

**The head is why the document exists.** The brief used to quote the first 1,600
characters of `requirement.md` — the project's *original* request — so on a long
project the model opened standing in its first day (see the Single-mode incident
below). The head is rebuilt from the Log on every write, so "the request" is
always the last one the operator sent, and the full history is one file away.
Single-mode messages are logged as `### chat` and never become the head's
request; the head falls back to the newest chat only when a project never had a
Multi request at all.

**Compacting a conversation is the one reset.** `POST /api/session/{id}/compact`
is queued at the next step boundary, so from an idle chat it runs now. It does
**not** delete the transcript: the engine's summary replaces what the model is
sent, and the messages stay. So the reset is a sequence, and the order matters:

1. `engine.compact(session)`; wait for a **new** `compaction` message with
   `status: completed` and a `summary` (a completed row is `{status, reason,
   model, summary}`, and the summary is the engine's own, written by the
   project's model, shaped Objective / Requirements / Decisions / Work State).
2. Write the summary into `project.md`'s `## Handover`, and a `### compact` line
   into the Log. **Nothing is deleted before this succeeds.**
3. Create a new session in the same folder with the project's mode,
   Keep Building, model and the "Always Allow" grants; its metadata carries
   `synapse.compacted {at, summary, messages}` — the post the new chat shows.
4. Delete the old session and broadcast `project.compacted`, so a window looking
   at it follows without a reload.

A compaction the engine refuses, or one that never lands within the timeout,
leaves the conversation exactly as it was: the handover is the point, so there is
no silent discard. The chip that starts it is only shown when a compact can run
(a project is open, nothing is working, there is something to discard), and a
second click within three seconds is the confirmation.

**A worker's transcript is replaced when its compaction no longer fits (28 Oct).**
The engine's compaction prompt is the whole *retained* transcript, not the current
context. A long task therefore asks the model to summarise more than its window
holds — measured at 225k on a 131k model, which failed with "Compaction produced
no summary" — while the active prompt was only 111k. When that failure, or the
provider's context-limit error, reaches a worker run, the runner does **not** retry
the same session. It creates a fresh worker with the same role, model, rules and
briefing, then prompts it with a **Synapse-written handover**: the task and its
detail, the last thing the worker said, and "the project's files are the work —
inspect git status/diff, keep what is done, continue, do not repeat". The old
session is deleted; the run's clock, attempt and budget continue. Up to three
replacements per task, after which the old retry path applies.

The engine's summary is not used here because the failed compaction is exactly the
case where it does not exist. The project compact (above) still uses the engine's
summary when it has one. A grant remembered for the old worker session does not
travel to the new one, so a rare request may be asked again. The delegation
harness covers both roads — a compaction failure and a provider context-limit
error: a second session is created, the first deleted, and the handover carries
the task, the worker's last words and the "do not repeat" instruction.

**"Keep" writes a deliberate project copy (28 Oct).** An attachment is normally
inline in the operator's message and exists only in the engine's transcript: a
compaction may summarise it and a project compact deletes it. Checking **Keep** on
the attic chip writes the bytes to `.synapse/attachments/<stamp>-<name>` before the
prompt, appends a `### attachment` line to the project Log, and every brief says
the folder exists — so a later Architect or a worker can list and read it. The
inline copy is still what the model reads that turn; the file is what survives. It
is a project file, not a temp file: unchecking before sending writes nothing, and
deleting the project deletes it. The name is sanitised and the stored copy is
timestamped so a second keep of the same name cannot overwrite the first.

**A shell command is judged per statement (28 Oct).** A QC migration read
`%APPDATA%` and wrote its report in scratch; judging the whole command as one
outside write asked for a card three times in the last run. `analyzeCommand` now
keeps a read/write answer per statement: an outside **read** is allowed, an
outside **write** asks, and a write with no path after `cd D:\...` is still an
outside write. The AppData hint is chosen from the statement that actually writes,
so a command that only read AppData no longer gets it.

**App data is portable by rule (28 Oct).** Every brief says an app's data lives in
a `data` folder beside its executable (`bin/data`, or `data` next to the published
exe), never `%APPDATA%`, `%LOCALAPPDATA%`, `ProgramData`, the registry or any
user-profile folder. Scratch is temporary and never shipped; app data is part of
the project. The permission gate still **asks** for a profile write rather than
denying it — the operator did not want an outright prohibition — but the card now
says where the data belongs. An app that already keeps data in AppData must move
it and import the old copy once; the current Fever Tracker uses
`%APPDATA%\FeverTracker\data.json` and extracts its web assets under
`%LOCALAPPDATA%\FeverTracker\web`, so it still needs that migration.

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

- **The plan is written in full before the first task runs.** *(Superseded on
  24 Oct: the list is allowed to grow. See "The plan became a work list" below.)*
  It opened with two  steps and the Architect added seven while it worked, so what the operator
  approved on the first screen was not what ran. The brief said so, and the
  validator named the visible symptom: `phases lists "build" but the plan has no
  task for it - write the whole plan before the first task runs, or drop the
  phase`. "The plan is finished" also meant every declared phase was covered, which
  is what stopped the missing-summary note firing at 10:59 while the Architect was
  still writing the plan.
- **A second QC pass is a check, not a new hunt.** Round 1 (38m) found nine
  issues; round 2 (32m) re-verified them and opened a new matrix ("every UTC
  offset from -12 to +14") for two off-path edges; round 3 (6m) re-ran the repros
  and the suites and stamped SHIP. The cheap round is the model: the brief now
  says a second pass re-runs the listed repros *and nothing else*, and anything
  new goes in an "observed, not fixed" list.
- **A compaction can fail because its own summarise call is too big.** The
  engine's compaction prompt is the whole message log, not the model's current
  prompt: t2 on 28 Oct had a 111k turn prompt while the compactor sent **225k to a
  131k model**, and the engine wrote `status: 'failed'` ("Compaction produced no
  summary"). The turn was retried and the next compaction (at 112k) succeeded. A
  failed message is not a compaction and must not be counted as one — the trace
  said "Compacted ×4 · context at 225K/131K" for three real compactions, and the
  225K was the failed prompt. `compactionKeepTokens` changes the tail carried
  *after* a summary, not the history the compactor reads, so it does not fix this.
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
- **`action:'*'` with a path denies reads too** — right for a folder nobody
  should read, wrong for `.synapse`, which is meant to be read.
- **`shell` and `execute` are not path-matched.** They take a command, so a
  worker can go around any path rule with a redirect. Hence
  `synapseFingerprint`/`fingerprintDiff`: the runner compares every file under
  `.synapse` before and after a worker turn and reports anything changed outside
  that role's folder as an alarm — prevention for the file tools, detection for
  the rest. **Verified live:** a coder rule refused `.synapse/probe/x.txt` twice
  (`write:error`, no file), while the same write with an absolute path in the
  prompt got through — which is exactly why the detection layer exists.

### The permission policy (26 Oct 2026)

Three zones, one policy file, and the engine's `ask` as the hook:

| | project | harness | anywhere else |
|---|---|---|---|
| read | allow | documents and logs (`data/`, `config/`, `.git/` denied) | allow, credential stores denied |
| write | allow | denied, no prompt | the operator is asked |
| shell | allow while it stays inside | toolbox scripts and read verbs; else denied | the operator is asked |
| execute | asked | asked | asked |

The scratch root is a fourth, narrow zone: read, write and shell are allowed
there without asking, because it exists precisely so a probe script has somewhere
to go that is neither the project nor the machine's temp. It is not inside the
harness, so the harness deny is untouched.

The ruleset is four broad asks (`edit`, `shell`, `execute`, `read`) plus the
credential denies; `src/permission-gate.js` answers each `permission.asked` from
`src/permissions.js` and replies `once` or `reject`. **`always` is never used
automatically** — a saved allow would outlive the policy that granted it, and the
next identical call must be judged again.

**Always Allow is the operator's decision, so it survives a restart.** The narrow
memory is written through to `data/permission-memory.json` on every grant, capped
at 500 entries, and a session's grants are dropped when that session is deleted.
The process is not allowed to be the only copy of something the operator had to
answer.

What "the request" is comes from `grantKey` (27 Oct). A file action remembers the
resolved path — a relative and an absolute name for the same file are one
consent. A shell command remembers the executable, the files it names and whether
it reads, writes or runs them, not the exact argument string: the model re-runs
the same scratch script with `-ExecutionPolicy Bypass` or a pipe, and every
variant asked again until this. A different file, executable or kind of command
still asks. The card's tooltip says which of the two it is.

**The models' temp is the harness's, not the machine's.** `TMPDIR` alone did
nothing on Windows: Node reads `TEMP`/`TMP`, so the engine and its shells wrote
`%LOCALAPPDATA%\Temp\opencode`. The server now sets `TEMP`/`TMP` to
`Projects\_scratch` — a sibling of the projects and outside the harness — before
it spawns the engine, and the permission analyser expands `$env:TEMP` from the
same process env, so the writer and the judge see one folder. Each project gets
`_scratch\<name>-<hash>` (created at boot and in `createProject`, named in its
brief); the policy treats that root as a **scratch zone**: read, write and shell
are allowed there without asking, while the harness stays denied. The machine's
temp folder is no longer used.

**Full auto can answer for the operator (28 Oct).** With the session's
`synapse.fullAuto` on — the cog's second switch — a request left to the operator
takes the default after `fullAuto.timeoutSec` (20 seconds by default, Settings →
Workers). A permission card is **allowed once** (`decidedBy: 'timeout'`). A
question is answered with the **Recommended** option, or the top one when none is
marked (`src/auto-answer.js`); a server-side sweep every five seconds answers it
(`src/form-auto.js`), so a closed browser cannot stop the work. An operator answer
cancels either timer, turning the switch off disarms a card already on screen, and
it can only answer `ask` verdicts: a harness write or a credential store is denied
before a card exists. Free-text fields take their default (or empty), and
hidden/external fields are skipped. A full-auto question is recorded in the project
document exactly like an operator's answer.

**Zero is a real Full auto wait (29 Oct).** `fullAuto.timeoutSec: 0` means no
permission card is ever drawn: the gate answers `once` on the next microtask,
records the decision with `decidedBy: 'full-auto'` and `asked: false`, so the tool
chip is green rather than amber. Questions still go through the five-second form
sweep, which answers on its first tick. The setting is read on every ask and
`retime()` re-arms cards that are already open, so a Settings change does not need
a restart. The policy walls are untouched: a zero wait can only answer `ask`
verdicts, never a harness write or a credential store.

**A refusal explains itself, through a synthetic note.** The reply body has a
`message` field, but 2.1.2 drops it on the reject path: the tool error is always
"The user declined this tool call". The gate follows the rejection with a
`synthetic` message — why it was refused, that a workaround is not allowed, and
where to escalate (a worker's report; the Architect asks the operator). Measured
26 Oct: the model answered "…I won't attempt any alternate path or tool", which
is the note's instruction.

**Why broad asks instead of path globs.** The engine matches a path *as the model
wrote it*, so a rule that allows `F:/.../project/**` says nothing about a relative
`src/app.js`, and the relative twin of every "outside" rule cannot be expressed.
Resolving both against the session's directory, in one place, judges them the
same. The price is one local round trip per write, shell and read; the gate
answers in the same second, and the UI waits 200ms before drawing a card so an
auto-answered request never flashes.

**Measured on 2.1.2:** `Permission.Effect` is `allow | deny | ask`; the resolver
is `findLast`, so the last matching rule wins and a session rule beats the agent
default; with nothing matching, the default is **ask**. The ladder is therefore
emitted first and the mode/role rules after it — which also fixed Single's
`subagent` deny, previously overridden by the guard's broad allow.

**What the policy cannot see, and does not pretend to:**
- a project script (`npm test`, `node build.js`) can write anywhere once it runs;
- `grep` and `glob` are not path-gated, so they can read what the read tool
  would be refused;
- shell analysis is a heuristic: an unresolvable path asks, but a determined
  wrapper can still get through;
- **a newline separates commands.** `Test-Path D:\` on one line and
  `Set-Content …` on the next is two statements, and each is judged on its own.
  Missing that let a read verb on the first line excuse an outside write —
  measured live on 26 Oct, with a model that wrote the file through a two-line
  shell command after its write was refused.

The card says who is asking (role and task, or the session title), the action,
the resolved path, and why the policy left it to the operator. A worker's request
must be visible even though its session is hidden from the rail — filtered to the
open session it would block the worker until its timeout with nothing on screen.

Every decision is also written against the tool call id the request came from,
which draws the chip on that call. The engine puts it in `source.id` on an edit or
read ask, but **2.1.2 omits `source` on every shell ask** (measured 28 Oct: the
event has only id, sessionID, action, resources and save). So the gate also watches
`session.tool.input.started`, `input.ended` and `called`, remembers the session's
recent calls, and pairs an ask that has no source with the newest unclaimed call of
the same family — preferring one whose command or path contains the ask's
resources. A decision stored without a tool-call id cannot draw a chip, and that is
exactly what happened to shell calls before this fallback. The log is memory only
(`src/permission-log.js`): a restart clears the chips, not the work.

The live event has the same key rule: `permission.decided` must be stored under
`decision.toolCallId`, not the request id. A multi-view handler that keyed it by
`requestId` and returned early made the chip disappear while every other part of
the card still worked; the request id belongs to the card, the tool-call id belongs
to the chip.

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

**Desktop apps are a window around a web page, and both halves are checkable.**
The interface of a Windows app is HTML in `ui/`, so everything built for the web
pipeline applies to the app itself — the measurement report, the contact sheet,
the state capture. The window around it is not HTML, so `skills/app-check` closes
that gap: it starts the exe, waits for a window, photographs it (`PrintWindow`
first, the screen only as a fallback), and reports title, size, DPI scale, whether
the process is **alive and responding after the shot** — a window that dies on its
first paint looks exactly like a working one in a picture — and whether the app
exited before showing anything. `templates/win-app` is the shell a project is
copied from: WPF, WebView2, `PerMonitorV2` DPI awareness, a dark title bar (Windows
10 draws white chrome otherwise, which reads as unfinished next to a dark page),
and `ui/` served over a **virtual https host**, not `file://`, so localStorage,
modules and a reload behave the way the page was designed for. Measured on this
machine: `dotnet publish` → a 58.9 MB single-file `App.exe` plus `ui/`, which runs
on a Win10/11 machine with no .NET installed. Settings → Windows reports what the
machine can build (`src/toolchain.js`), which is the answer to "copy Synapse
somewhere else and start": the pane says what that PC is missing instead of a build
failing three turns in.

**The free zen models are in the catalog; the account is what runs out.** Nine
`opencode/*-free` models are listed by the engine (`/api/model`) and are selectable:
Beam, DeepSeek V4.1 Flash, Flint 40B, GLM-5.3-Flash, Jev 1.13, MiMo-V2.6-Flash,
MiniMax M3.1 Flash, the Nemotron 3s and LongCat. Each was given one prompt in a
throwaway session, and every one came back `idle` with `provider.free-limit`, status
429, `retryAfterMs` about 12.4 hours. So nothing needs plugging in and the routing is
right; the free allowance for this account is spent, and a *run* (rather than a probe)
marks the model, which is what the ISSUES chip in the picker is for. Two route facts
cost a cycle here: `GET /api/session/{id}/message` is **singular**, and `prompt` only
*admits* the message — the turn runs on afterwards, so
`POST /api/experimental/session/{id}/wait` is what blocks until the session is idle.

**A skill may not say where a shipped tool lives; the brief does.** The skill text
used to carry the full path of `shot.mjs` as it was on the machine it was written
on — the operator's own `~/.agents/skills`, which does not carry it here. Three
roles in Timer Test 1 hit `MODULE_NOT_FOUND`, searched the disk for the script
(which raised the harness's *shell command naming the harness* alarm), and then
called it with a flag it does not have (`--help`), which wrote a picture of the
browser's error page into the designer's folder and tripped the stray-write alarm
too. Every one of those turns was spent on a fact the harness already knew. So
`describeSkills()` names the absolute path of the shipped script for any role whose
list includes `visual-review`, the SKILL.md says "the path is in your brief, do not
search for another copy", and `tests/skills.test.mjs` fails if any shipped `.md`
mentions a machine-specific folder again. The general rule: **a skill describes
how to work, the harness describes where things are.**

**The renderer measures, serves and refuses.** `shot.mjs` is ours, not the
engine's, and Timer Test 1 showed how thin it was. Now:

- **It refuses what it cannot do.** An unknown `--option` used to fall through to
  the target, so `--help` photographed a file named `--help` and exited 0. Unknown
  options, extra targets and a missing file are all errors with the usage line, and
  `tests/visual-review.test.mjs` holds them.
- **It serves the page itself**, on a random port, from the file's own folder, and
  closes on exit — because `file://` cannot test localStorage or a reload, which is
  the reason agents kept writing `qc-serve.js` / `python -m http.server` and leaving
  them running (two orphans were still holding 8321 and 8765 hours later).
- **It reports numbers next to the picture**: `status`, `viewport`, `doc.scrollW`
  against the width, elements crossing the edge (`overflow`), WCAG `contrast` below
  4.5 (or 3 for large text, with ancestor opacity folded in and disabled controls
  exempted), controls under 44px, and `painted` counts. On the timer page it found
  six under-44px targets and six shortcut chips at 2.47:1 that the QC pass had
  called fine — which is the argument for measurements over impressions.
- **It fails on a blank page** (0 visible elements, no text, no images) or a 4xx/5xx
  status, because a blank PNG is the one answer that looks like success.
- **Several widths become one contact sheet**, so a narrow-vs-wide comparison is a
  single image read instead of two.
- **`--do "click:#start; wait:800"`** photographs a *state* rather than a guess;
  keys are synthetic events on `document`, which is what a page's own handler
  listens for.

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
once the toggle became live. **It is applied at send, not on toggle** (27 Oct):
`sendMessage` carries the mode, PATCHes the ruleset once if it differs from the
session's, then briefs and prompts in that mode. A click that is never sent
changes nothing, which is what "it doesn't matter until I send" means. **A
dedicated `chat` agent (tools denied, `steps: 1`) is the obvious design and it
does not work**: the free tier rejected every request from a custom agent with a
provider auth error (measured side by side — the custom-agent session failed at
20:45:37 while a default-agent session succeeded at 20:45:40). Denying everything
also defeats the purpose, because Single is meant to have tools.
`POST /api/session` accepts `permissions`; `PATCH` replaces them.

### A Single session is not told it is an Architect

The trap is not a fresh Single session — it is a live Multi session switched to
Single to ask for one small thing. The transcript still contains the whole
campaign, and the project still carries `.synapse/`. Omitting the harness from the
brief is not enough; the brief has to overrule what the model can see.

Measured 26 Oct: asked to copy one exe into a folder, the model read
`.synapse/plan.json`, decided from `t21` whether the build was current, and
reported on `t18` and `t20`. The brief had also quoted the stored requirement
verbatim — the old campaign, "Continue work" and all — because Single used to
present it as "the operator's request".

What the Single brief says now, and nothing else:

- Where the tools operate, and that the answer may need the disk or a command.
- One conversation, no team, no delegation; ignore a delegation tool if offered.
- **Only when a plan file exists**: it was written for a different task, it is to
  be ignored, its tasks are not this conversation's, and it is not to be followed
  or updated.
- **The operator's standing Notes from `project.md`, when there are any** — those
  are about the project, not the old campaign, and they apply to a one-off ask too.

It does not quote the project's request or its handover, does not point at the
plan as a work list, and does not call the session a role — the skills line drops
"this role", "judge the next piece of work" and "your report"
(`describeSkills(..., { chat: true })`). A Single message is logged in
`project.md` as a `### chat` entry, but it never becomes the head's request: that
is a Multi message, and letting a side ask overwrite it is how the earlier task's
record got polluted. A delegation attempted anyway is still refused in the
runner, but the refusal now says "do it yourself" rather than "ask the operator to
switch to Multi" — the second reads as an errand, and the operator did not ask for
one.

Multi is untouched: the same brief it always had.

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

## There is no session naming any more (27 Oct)

A session used to be created as **TBD** and named by a `generate` call after its
first turn. With one chat per project the rail shows the project's name, and an
engine session's title is never read — so the titler is gone, along with the
`generate` call it made for every conversation. A chat is created with the
project's name as its engine title, for an audit read of the engine's own list.

## A project's memory is its folder, so deleting the project takes it

`.synapse` — the plan, the project document, the ideas, the design, the
findings and the run log — belongs to the **directory**, not to a conversation.
That is why a project is one chat: a second conversation in the same folder would
inherit the first one's plan and look as if it had opened onto a dead campaign.
Deleting a project takes its chat, its folder and its `.synapse` together, after
the `bin\` consent; there is no separate "delete the plan" step left. The old
General override (one workspace per session) is gone with the project, and the
old `forget` checkbox went with the session delete.

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
answer; the project's document exists for exactly this reason and the answer needed
the same treatment. So `replyForm` appends to **`.synapse/project.md`**, under the
Log, as a `### decision` entry — the question titles and the operator's values,
verbatim, written by Synapse and never by a model. The head then lists the
decisions still in force, and every brief that sees the file says so: *"the
operator's answers so far are in `.synapse/project.md` … read it before you ask
anything, and never ask a question it already answers"*. The Architect's features
multiselect lands there too, which is what makes a rejected idea stay rejected.

Two edges worth knowing. The guard's own memory (`questionHistory`) is in-process:
a restart forgets which questions were already asked, so the file is the only
durable record for the *next* run, not a replacement for the guard. And a session
outside a project has no `.synapse`, so nothing is written — the reply still goes
through, and the missing file is not an error.

## Stop means stop

Measured 23 Oct: the operator pressed Stop, and the run carried on to the end and
started the next task. Nothing was broken in the runner — the stop button was
aimed at the wrong thing.

**A delegated task runs in its own worker session.** The operator has the Architect
open, so Stop interrupted the Architect, which is not the thing doing the work. The
worker finished, reported back, the Architect was woken by the report, and it
delegated the next task: from the operator's seat, "it just retried later". There
was also a third way back in — `remindSkippedWork`, which nudges the Architect when
a ready task was never asked for.

So Stop now does three things, and all three are needed:

1. **It cancels the run**, not just the session: `runs.cancel(dir)` aborts the
   runner, cuts any backoff short and interrupts the worker session.
2. **It puts the task back to `todo`.** Nothing is running, so a task left as
   `doing` makes the plan say "1 running" for the rest of the day. That is the one
   write the harness makes to the plan (`setTaskStatus`), and it changes one field.
3. **It holds the project** (`stoppedByOperator`): a delegation arriving while held
   is recorded as `stopped-by-operator` and not run, and the "ready but never
   asked for" reminder stays quiet. The hold lifts when the operator speaks —
   `POST /messages` or turning keep-building on — because that message is their
   answer to "what now".

**The run record is not the list of live work.** A worker can outlive a run that
has already reported or been cancelled: the engine still lists its session as
active, Synapse has no run left to cancel, and the Architect on screen is idle —
so Stop looked disabled and pressing it did nothing. Stop now asks the engine for
its active sessions and interrupts every one in the same project as the session
it was pressed on, plus that session. `/api/pending` reports `canStop` for the
open session's project, and the composer's Stop is enabled from that answer even
when nothing looks busy. Measured live on 26 Oct: an idle Architect and a running
worker in one project — `canStop=true`, one press stopped both, and the engine's
active list was empty afterwards.

## A restart is not a pause

Measured 26 Oct: a worker was running t3 and waiting on a permission request when
Synapse restarted. The runner died before writing a result. The plan said `todo`,
the runs file still had the `delegate` line, and the Architect's last message was
"t3 is queued and waiting to run" — so the operator was stuck waiting on a worker
that did not exist. `recoverDelegations` only picks up requests **no turn ever
read**; this one had been read and started.

A boot is the one place that knows the truth: nothing is running yet, so a
`delegate` with no matching `result` was interrupted. On start, every such record
is closed with `outcome: "interrupted"`, the task goes back to `todo`, the project
is held (so the wake cannot retry it on its own), and the Architect is told in its
own transcript: "Synapse restarted while t3 was running… do not retry it on your
own". Order matters: close interrupted runs **before** the unread-delegation pass,
or that pass mistakes an interrupted run for a queued one.

The invariant: **a `delegate` record is always closed by a `result`.** The runner
writes it normally; a boot writes the interrupted one. `openDelegations()` in
`src/plans.js` is the single definition of "open", and it is tested.

A stop with *no* run in flight still holds the project: interrupting the Architect
mid-turn is the same request, and otherwise its next turn delegates the work that
was just stopped.



---

## A plan that routes every task to a coder skips the craft

A brief made almost entirely of visual constraints - a palette, a type pairing, an
8px scale, two widths to prove - came back as `phases: ["build","qc"]` with all six
tasks on `coder-1`. Nothing was broken: the plan delivered every file the request
named, and the one thing the operator wanted to see (the look, decided by someone
whose job is deciding looks) was never planned. The phase lines said what each
*phase* was for and never said who was for *what*, so the shortest path that
satisfied the deliverables won.

Two things came out of it:

- **The brief names the crafts, and the routing rule is one sentence**: send a task
  to the craft it needs, not to whichever role is free; a coder builds a decision,
  never makes one. Picking colours, type, spacing or states is not a coder's task,
  and the coder's task reads `design.md` afterwards.
- **A rule that lands while Synapse is running has not landed.** The design rule
  was committed at 20:41 and the plan written at 20:42 - under a process that had
  booted at 20:16. Reading the commit and reading the behaviour would have given
  the same answer for the wrong reason. When a brief change "does not work", check
  the boot line in `logs\app.log` before the rule.

## The plan became a work list

The file was designed as a plan: written in full, reviewed once, then executed.
The record says it became something else, and the harness was fighting it.

**What the record shows.** On one project the Architect invented `t3b` and `t3c`
to insert work *between* existing items — the schema had no insertion, so it made
up a naming convention. It set a finished task back to `todo` after judging it
(`t3:done` → `t3:todo`, 19:41). It added `t9` and `t10` the next day. Sixteen plan
changes in one evening. On the next project it inserted `t7` between `t2` and
`t3` mid-flight: the array order is the work order and the id is only a reference.

Meanwhile three rules assumed the old shape, and one of them was actively harmful:
a delegation was **refused** while a declared phase had no task under it. On Clock
Test 3 that refusal was right — a two-task plan silently became ten. On a list that
is allowed to grow it is a rule against the behaviour that makes the harness good.

**What changed.**

- **The word.** The brief, the docs and the pane call it a work list. The file is
  still `.synapse\plan.json`: renaming it would migrate every existing project for
  a word, and the file name is not a claim about how it is used.
- **`phases` is gone.** The top-level field, `PHASE_ROLES`, `uncoveredPhases`, the
  validator complaint, the delegation refusal and the "finished means every phase
  is covered" rule. Old plans keep the field and it is ignored on read. The role on
  each task is what says whether design was planned; the order of the array is the
  order of work.
- **`origin` is new** — `plan`, `found` or `operator`. It is a fact about where the
  row came from, not a rating. The pane marks `found` rows with a quiet amber
  "added" chip, so a list that grew after the operator looked says so in one
  glance. An unknown value reads as `plan`; nothing is policed.
- **The brief asks for the opposite of what it asked before**: start with the work
  you can see, add items where they belong in the order, and say in one line what
  you added and why. Scope is still the operator's: `features.json` is the contract
  and a new feature still goes through the feature question.

**What a rating would have cost.** A `priority` field was considered and left out.
A model asked to rate its own additions rates them all high, and a list where
everything is marked is a list where nothing is marked. QC findings already carry
severity (critical / major / minor) inside the finding, which is where a rating
means something because it comes with a repro.

**What it costs, honestly.** The operator's protection against scope creep was "I
saw the whole plan". It is now "the list says what changed, and the features file
says what was agreed". That is weaker on paper and stronger in practice, because
the old rule was being broken productively every single run.

## An attachment is a URI, not bytes — and the dump is older than the server

Measured 25 Oct on engine **2.1.2**, while adding a paperclip to the composer.

The OpenAPI dump at `%TEMP%\opencode\openapi.json` describes `Prompt.FileAttachment`
as `{ data, mime, source: {type:'inline'} }`. The server refuses exactly that:

```
400 Missing key at ["files"][0]["uri"]
```

What it takes is a **`uri`**, and a `data:` URI is accepted:

```
{ uri: "data:application/json;base64,eyJuYW1l...", name: "package.json" }   200
{ uri: "file:///F:/dev/Synapse/package.json", name: "package.json" }        200
{ uri: "F:/dev/Synapse/package.json" }   400 Unsupported attachment URI
```

Two consequences worth keeping. A `file://` URI makes the **server** read the file,
so the bytes have to be on disk first — fine for a path the operator typed, useless
for a browser's file picker, which never reveals a path. A `data:` URI needs no
disk at all, so that is what Synapse sends: the operator attached a file to a
sentence, and nothing appears in the project folder because of it.

And the file stays on the message. The engine records its `data` on the user
message, so a big attachment is re-read on every later turn of that session —
the same bill as quoting a report back. The composer caps one file at 8 MB and one
message at 48 MB in total (24 files is only a sanity cap), and the cap is about
the window as much as the network. Twelve small screenshots fit; six 8 MB files
do, and a forty-ninth megabyte does not.
