# Engine notes

How Synapse talks to the engine, and the things that cost real time to discover. Split out
of `AGENTS.md`; read it when work touches `src/api.js`, `src/runs.js`, `src/plans.js` or
`src/engines/opencode.js`.

## The routes that cost time

The schema dump is a starting point, not the truth; the running engine is.

| route | reality |
|---|---|
| `PATCH /api/session/{id}` | only `title`, `metadata`, `permissions` — **not `agent`** — and **204 with an empty body**; do not parse it. `permissions: []` clears the ruleset, which is how Single→Multi is applied to an open session. |
| `POST /api/session/{id}/model` | `{model:{providerID,id,variant?}}`; **204, empty**. Omitting `variant` stores **`"default"`**. |
| `POST /api/session/{id}/generate` | one-shot completion, `{data:{text}}`, **adds nothing to the transcript**. |
| `POST /api/session/{id}/prompt` | an inbox entry: returns in ~100 ms while a turn runs; takes `text, files, agents, skills, metadata, delivery, resume`. |
| an attachment | **`{uri, name}`**; a `data:` URI is accepted. |
| `GET /api/session/{id}/message` | **singular**, and `prompt` only *admits* the message — `POST /api/experimental/session/{id}/wait` blocks until idle. `limit` + `order=desc` gives the newest page; with that order the **older** page is `cursor.next`, and a cursor request must not send `order`. |
| `GET /api/session/active` | the authority on what is running; survives a restart. |
| `GET /api/form` | scoped by `x-opencode-directory`; from the workspace root it always answers `[]`. |
| `GET /api/pending` | pending forms, and `canStop` for the open session's project. |
| `DELETE /api/debug/location?location[directory]=<dir>` | a **deepObject** (`location%5Bdirectory%5D=…`, else 400 `Expected object`) and **asynchronous**. |
| `POST /api/session/{id}/compact` | queued at the next step boundary, so from an idle chat it runs now. |
| `POST /api/session/{id}/revert/stage` + `/revert/commit` | a **suffix boundary**: commit deletes that message and every later one, plus inbox entries at/after it. `{messageID, files:false}` leaves the files alone. |

**The one deletion is a suffix.** The engine has no "delete this message": it has a revert boundary. Staging the last operator prompt and committing removes that prompt and everything after it. `files:false` is not optional for Synapse's use — this is a conversation edit, and the turn's files, plan and worker sessions stay. A boundary in the middle would take every later message with it, so the UI offers only the newest exchange, only in Single mode, and only when nothing is live or waiting. See `src/session-remove.js`.

**A form dies with the engine.** `question` opens a form the engine holds in memory: on 21 Oct a form was
waiting, `GET /api/pending` came back empty, and the card still read **running** — a state that can never
finish. A restart abandons a pending question and nothing recovers it, so say so before restarting a run
that waits on the operator. **The question must be findable outside the open session**: the answer panel
lives only inside a session view and a page load opens nothing, so the rail marks the waiting session
(Answer / Decide) and announces it once.

## A tool call written as text

A model sometimes prints the call into its answer (`<tool_call>` … `</tool_call>`); the engine sees no tool
part, so nothing runs and the turn ends for no visible reason (test_27b, 12 Nov).

- **A delegated run gets one nudge.** Where the run would be marked completed, `src/model-slips.js` checks
  the transcript the wait already fetched: last message, no tool part, last text **ending** in the closing
  tag with a `function=`/`<parameter` inside — so quoting the syntax mid-answer is not matched. Once per
  task, and only when the turn ended by itself.
- **The outcome stays `completed` and the ladder does not move.** When the last text is nothing but a
  tool-call block (`wroteToolCall`) and no file was written, the report quotes it instead of handing the
  Architect raw XML.
- **The Architect's own turn gets a notice, not a nudge.** The harness sends it no message after its turn —
  that is the shape of the wakes that once resurrected stopped work. The page shows
  `toast('The Model Wrote A Tool Call', …)` from the same rule in `web/transcript.js`; "continue" is the
  operator's, one click.

## MCP: how the engine exposes tools to models

Synapse registers its own MCP server in the engine's isolated config at
`data\engine\opencode\config\opencode\opencode.json`, rewritten on every boot.

```json
{ "mcp": { "servers": { "synapse-search": {
    "type": "local",
    "command": ["<node>", "F:\\dev\\Synapse\\src\\mcp\\search-server.js"],
    "codemode": false } } },
  "websearch": false,
  "skills": { "paths": ["C:\\Users\\Andrew\\.agents\\skills"] } }
```

- **`codemode` must be `false`.** Left on, the engine exposes MCP tools through code mode as
  `tools["synapse-search"].websearch`, and the model calls that literal string as a tool name.
- **`websearch: false` matters.** The built-in search needs a provider key and answers **HTTP 403** here;
  with both present the model picks the broken one by name familiarity.

MCP tools arrive **namespaced** (`synapse-search_websearch`). Match names by suffix, not equality.

**The name is a literal, so the brief has to say it (13 Nov).** An Architect called `delegate_delegate`,
was answered `No tool named "delegate_delegate" is currently available`, and concluded the tool was
missing — probing code mode (which lists only `opencode` and `browser`) and falling back to `subagent`. The
brief now gives the exact names (`synapse-delegate_delegate`, `synapse-lease_lease`) and says that answer
is a spelling error; it also rules `subagent` out for a plan task — no run, no plan row.

**The same server carries `webfetch`**, because a search result is a URL and the engine's own fetcher
returns the page, not the reading: measured 2 Nov, `github.com/DarkDvr/Synapse` is 302 KB of HTML with
11 KB of text. `src/fetch.js` reads GitHub through its API, X posts through oEmbed, everything else through
a reader that strips scripts and navigation, and reports its source (`github:repo`, `x:oembed`,
`readability`). **It refuses walls instead of returning an empty page** — a bot challenge, a 403, a
Cloudflare interstitial — because a model handed "" writes a confident report about nothing; the error
names the wall and points at `docs/notes/web-reading.md`. **A dropped connection is retried once; an answer
is not.**

**A tool with per-session state belongs in the transcript, not in a server.** The engine records **every
tool call, with its full input**, which Synapse reads back each turn the way the census does. Also:
`localSearch: false` used to `return` from all of `ensureEngineConfig`, silently losing the model-limit
overrides; the guard now wraps only the search server. **Keep it to what is needed** — a `time` tool added
for one test question was bloat and was removed.

## Briefing a session: the engine's instruction entries

The engine has a standing-context channel that is **not** the transcript:

```text
PUT    /api/experimental/session/{sessionID}/instructions/entries/{key}   { value }
GET    /api/experimental/session/{sessionID}/instructions/entries
DELETE /api/experimental/session/{sessionID}/instructions/entries/{key}
```

`key` matches `^[a-z0-9][a-z0-9._-]*$`; the reply is **204 with an empty body**; the value is any JSON
value and a size cap answers **413** (`InstructionEntryValueTooLargeError`). Changes "announce as updates
at the next step boundary". Verified on 2.0.30: PUT 204, GET read back.

**The 204 means accepted, and the event is a turn-start signal, not an acknowledgement (13 Nov).** On
`calc-emperor` — created in Single, switched to Multi and sent at once — the engine created the user
message at `19:12:08.362` and applied the entry at `.370`: **eight milliseconds apart**, in that order. The
first turn obeyed the Single brief and did the task alone; the next was told "The context under
'synapse.plan' changed and supersedes the previous value". A wait on `session.instructions.updated` before
the prompt can never work: the event only arrives once a turn is starting, which the prompt itself does. A
chat created in one mode and switched at send is an unreliable first turn; setting the mode while the chat
is idle is the fix, and it is not taken yet.

This is how Synapse briefs a role — which project, where the plan file is, who may write it, how work is
delivered. It is **per session**; it is **durable**, sent once and re-sent only when its text changes; and
it **never appears in the transcript** — there is no system field in `prompt`, and `agents:[{name}]` does
not switch the acting agent, so the alternative is prefixing the operator's message and making it read as
if they had typed it.

**Never put a lone backslash in text a model reads.** The first plan came back as invalid JSON because the
brief said `bin\` and the model copied it into a JSON string, where `\ ` is an invalid escape. Model-facing
paths use forward slashes (`bin/`, `.project/plan.json`).

## The project plan: a file the Architect owns

`<project>\.project\plan.json` — goal + tasks (`id`, `title`, `role`, `status`, `detail`, `dependsOn`,
`result`, `note`, `checks`, `origin`), written with the ordinary file tools; there is no tool and no store
for it.

- **One writer.** The Architect owns it; workers are told it is read-only and handed their own task, and
  the harness fingerprints the file around a worker turn so a stray edit is visible.
- **Synapse only reads it — it never repairs it.** Reading is tolerant and never throws: a bad file becomes
  `error` (unparseable) or `problems` (it parsed but breaks the shape), and the same sentence goes into the
  Architect's brief, so **the model fixes its own document** (verified: one bare "Continue." closed the
  loop). A delegation reads the parse error first — `Nothing was run: plan.json is not valid JSON:
  <message>. … A JSON string cannot contain a real newline: keep each string on one line, or write \n
  instead. Fix the file, then ask again.`, journalled `bad-plan` — because a row was there in a file that
  could not be read, and "the plan has no task t1" cost three turns (17 Nov).
- **`id` is required.** Delegation refers to tasks by id and the Architect may rewrite the file at any
  time; a task without one is flagged and skipped.
- **It belongs to the project, not the conversation**, so a new session continues the same plan. Created
  empty (`{"version":1,"goal":"","tasks":[]}`) when a project is added and at boot for one missing it.
  `.project` belongs to the **directory**, which is why a project is one chat; deleting the project takes
  its chat, folder and `.project` together. The old General project is gone — an existing General folder
  is adopted as an ordinary project on first boot.
- **It is the current request's checklist, not a diary.** A new request starts a new plan: new goal, new
  rows, no done rows carried over (the run log is the history). Two to six rows, each a deliverable; a
  `found` row only when the round cannot finish without it. Every piece of work in Multi goes through the
  plan, even one file — on 28 Oct the Architect wrote a one-file request itself and the pane said "No plan
  yet". Row times are scoped to the round, so a t1 in a new plan starts at 0. The brief asks the opposite
  of what it once did: start with the work you can see, add items where they belong in the order, and say
  in one line what you added. That is weaker than "I saw the whole plan" and stronger in practice, because
  the old rule was broken productively every run — sixteen changes in one evening, `t3b` and `t3c` invented
  to insert work. Scope is still the operator's: `features.json` is the contract.
- **`phases` is gone.** Old plans keep the field and it is ignored on read; each task's role says whether
  design was planned, and array order is work order. A delegation was once **refused** while a declared
  phase had no task under it — right on Clock Test 3, where a two-task plan silently became ten, and a rule
  against the behaviour that makes the harness good on a list that may grow. **`origin`** is `plan`, `found`
  or `operator` — a fact, not a rating; the pane marks `found` rows with a quiet amber "added" chip, and an
  unknown value reads as `plan`. A `priority` field was left out because a model asked to rate its own
  additions rates them all high.
- **A blocked note is two sentences.** What is stuck and what the operator must decide, clamped to two
  lines (rest in the tooltip) — a wall of reasoning turned the pane red on 28 Oct. Status and note must
  agree: `done` has no note, `blocked` says what is needed.
- **A title is the plan's human index: what the work *is*, not which file it lands in.**
  `Write bin/wordfreq.py and bin/NOTES.md` is a `problem`; `Build the word-frequency report` is not. The
  brief says so ("no file paths and no code identifiers in a title: put them in detail") and `readPlan`
  enforces it in the same `problems` channel. The patterns are deliberately narrow: `FILEISH_TITLE`
  (`/[A-Za-z0-9_-]+\.[A-Za-z]{1,5}\b/`) and `PATHISH_TITLE` (a leading `bin|src|web|docs|config` +
  separator). A bare slash is a good title — **`Audit the UI/UX` must not be flagged**, and is the test
  that proves it. **Titles over 80 characters are a `problem`, not a silent trim**: the pane clamps to two
  lines with the full text on hover, and the grid item must not be wrapped in another span on that
  `flow-root` reading — it clips either way.
- **A result with a status that has not caught up is a `problem`.** test-project-3's t1 got a full
  `result` and was left `todo`. `readPlan` flags "has a result but its status is \"todo\""; a `blocked` or
  `failed` task may legitimately carry one. **A done row owes a result**: `done` with no `result` is the
  same kind of problem — *"one line saying what proved it, or it is a claim with nothing behind it"*. Both
  wait for the file to stand still, because the two fields land in two writes.
- **A finished plan owes a customer-facing summary.** One sentence a customer would understand, no paths or
  code, under the **Done** chip and flagged by `readPlan` when missing. The Architect writes it because it
  has the context and owns the file; a `generate` call would leave the text nowhere to live that survives a
  restart.
- **A task's `result` is not printed under its title** — it rides the tooltip. A `note` stays visible,
  because a blocked task is where the operator is being asked for something — **and only while it is that
  reason**. Problems are a labelled list, not a filled block: a left amber rule, a heading and one bullet
  each, because an amber panel read as a rendering fault.
- **The pane shows one loud row: the step in hand.** Titles are muted except a `doing` task, whose border
  and `tN` id carry its dot's colour (2px); dots are grey not started, green done, yellow in hand, red
  blocked/failed. **The step in hand is the run, not the file** — the Architect writes the plan only when it
  *judges*, so `renderPlan` overlays the runner's live run and only the row is live. **A polled reader must
  not log on every poll**: `logPlanState` keys on a signature of the state and speaks only when it changes.
- **A finished project's folder can be deleted while Synapse runs — the engine has to let go.** A
  *location* stays loaded once the engine has served a turn there, and that handle makes the directory
  undeletable. The release is `DELETE /api/debug/location?location[directory]=<dir>`; it **works** and is
  **asynchronous** (an immediate delete failed, the same delete a second later succeeded), so
  `evictLocation()` polls `GET /api/debug/location` until it is gone (30 × 100ms). `deleteProject` evicts
  and waits (281ms measured); `wipeProjectDir` evicts, retries `fs.rmSync`, then fails with 423.
- **The project row is the whole project UI.** No panel, no path label: one row whose
  Browse/Cmd/Rename/Delete live in a `⋯` menu, and `POST /api/projects/{id}/open` spawns a detached GUI
  process with array args. **A command prompt needs `start`**: `spawn('cmd.exe', ['/K','cd','/d',dir])`
  exits 0 in a second with no window; the working form is `cmd.exe /c start "" cmd.exe /K cd /d <dir>`.
  **Explorer takes about a second** and that is Explorer, not us (`POST /open` answers in ~57ms).
- **Speaker headers are yellow, and every turn has a hairline above it**: `You` / `Architect` /
  `Synapse · …`, so a report no longer repeats `[harness]`. The old `ui.answerBg` / `ui.harnessBg` and
  Settings → Chat group are gone — `normalize()` deletes a `ui` block so an old config carries no dead key.
  Anything user-facing says Synapse.
- **Deliverables go in `bin/`**; everything else in the project is scratch.

## Delegation: the Architect asks, the harness runs

Settled, and the reason is per-role models: **the Architect cannot choose a subagent's model**, so
`subagent` would leave every per-role pick decorative. Each step runs as a real engine session with that
role's model and effort.

`delegate { task }` is a stateless MCP tool (`src/mcp/delegate-server.js`). The request is read from the
transcript on the turn boundary, exactly like the census, and answered once — the call id goes to
`.project\runs.jsonl` **before** the worker starts, so a restart or re-scan cannot run it twice.
`src/runs.js` creates a session for the task's role and model, briefs it with its own task, runs it,
records the evidence, and wakes the Architect.

- **`POST /api/session/{id}/synthetic`** is how the Architect is woken with nobody typing: the message is
  its own transcript type, rendered as **Harness · \<description\>** with an amber edge, never as the
  operator. **`metadata` on `POST /api/session`** is free-form, so `metadata.synapse.internal` marks a
  worker session; the API filters those out of the rail and the counts, and the engine still lists them, so
  a worker transcript stays inspectable at `/api/session`.
- **A worker's claim is not evidence.** The first delegated run reported writing `bin/calendar_design.md`;
  no such file existed and `runs.jsonl` recorded `files: []` from its own tool calls. Hence `Files written:
  none.`
- **A model that waits inside its turn for the run it just delegated deadlocks itself (13 Nov).**
  `calc-emperor-strict`: the Architect called `delegate`, then read `plan.json` ten times over 35 seconds —
  "still todo, let me wait a bit more" — while a delegation is read on the turn boundary, so the run could
  not start. What the model reads is the **receipt**, whose first line now says to end the turn: "reading
  the plan again... will never show it running."
- **A delegation can be orphaned by a turn that never ends.** Fever Tracker, 22 Oct: the Architect
  delegated and asked a question in the same turn; a restart cancelled the pending form (`Form not found:
  frm_…`), the turn could not end, and the delegation stayed "Queued", unjournalled and unrun.
  `recoverDelegations` makes one pass at boot (5 s in) over each project's newest conversation and runs
  anything `requestsIn` still reports.
- **A refusal or a deferral is also a journalled decision.** A delegate refused because a worker was
  running was answered and forgotten, so the boot scan started it (27 Oct: a restart started t5 from a
  stopped round). Every refusal path (`single-mode`, `unknown-task`, `qc-cap`, `keep-building-off`,
  `stopped-by-operator`, `self-delegation`, `deferred`) is a line in `runs.jsonl`, which is what makes
  "unread" mean unread. **A row whose role is the Architect is its own work** (11 Nov): it drew a
  delegation from the Architect's card back to itself, so it is refused, journalled, and woken with "do it
  here with your own tools".
- **A deferral is reported with the run, not woken on its own.** Waking it with "ask again when it reports
  back" cost a turn per duplicate ask (5 Nov: three delegate calls bought three Architect turns); the ask
  rides the live run and is named in its report, once. **A form reply that answers `Form not found` means
  the question is gone**: clear the panel and say so.
- **Retry cap: 3 attempts per task**, then the harness refuses with a report telling the Architect to break
  the task down, change the role/model, or mark it blocked. Refusals log an `outcome` and no `attempt`, so
  they do not count. **A recoverable provider failure is not an attempt** (five rate limits then a finish is
  attempt 1). **An operator stop is not an attempt, and neither is a restart** (`countedAttempts`): Fever
  Tracker's t1 was "attempted" three times, two of them operator stops, so the cap was spent before the
  design was judged. A stop or a restart does not move the task down the ladder either (`attemptFailed`).
- **A free-plan usage cap gets ten minutes, not for ever.** Classified `unknown` it was retried
  indefinitely (27 Oct: 13 retries, 51 minutes). It is `usage-limit` now, and both the worker's rescue loop
  and the Architect's wake stop after `USAGE_LIMIT_MS` naming the model to switch. A hard model mark is
  still only for `deprecated`.
- **Caps are per round, not per project.** A round ends when every task is `done` **and** the summary is
  written. That close is one `round` line (`closeRound`), written when the operator **sends the next
  request**, before the brief — so the brief's QC allowance is the new round's and the finished plan keeps
  its row times until then. The marker carries the plan's exact `mtime` (`planMtime`), not the wall clock,
  because a plan written a millisecond later produced a second marker. Without it a mature project spent
  its whole QC quota in its first three rounds (27 Oct: three `qc-cap` refusals) and a reused id reached the
  attempt cap although every attempt had succeeded. The brief states the allowance ("QC: 0 of 3 …"), because
  an Architect read a handover's "three rounds spent", refused to delegate t7, and wrote a refusal into the
  plan that never happened.
- **A coder that cannot do the job hands it down the line.** The coders are peers (`worker.ladder`, default
  `coder-1 → coder-2`) and the harness moves the *same task* between them — the Architect cannot, because
  the first thing it learns about a refused model is a report saying nothing happened. `candidatesFor()`:
  **a provider refusal moves to the next peer inside the same delegation**, and **an attempt after the
  first starts one rung further down**, because re-delegating the same task *is* the Architect's verdict. It
  starts at the **role's own rung** — `slice(at + skip)`, not `slice(skip)`, so a coder-2 task no longer
  began on coder-1 (test-project-1's f-string run). **A marked model** — a provider refusal, one that cannot
  drive the tools, one that looped to its limit — is skipped from the start, so a coder-1 task opens on
  coder-2 while coder-1 is out. A timeout does not loop: the worker may have produced something, and the
  counter moves that case next time.
- **Changing a role's model starts the task over on that role** (`modelChangedSinceAttempt`): the count and
  the step-down reset. **It also ends the role's backoff**: `wakeRole(role, {ref, variant})` fires the run's
  wake signal (separate from Stop's controller) and retries at once; only a run whose `retry` is set is
  woken. The Architect's own loop is the same idea in `wake()`.
- **The plan's `role` is never rewritten.** The report says *"this attempt ran on coder-2, not coder-1 — the
  plan still says coder-1, judge the work on its merits"*, and `runs.jsonl` records `role`, `plannedRole` and
  `ladder`. The invariant: a task's role is its *first rung*, and the ladder only ever moves down. **The
  operator's own choice overrides the "write it for coder-1" rule** (30 Oct: "tell coder 2 to create…" was
  silently rewritten): a row they asked for carries `origin: "operator"`, and the plan check accepts
  `coder-2` there.
- **Build tasks are planned for coder-1, and only coder-1.** The ladder is the harness's, so a plan naming
  coder-2 spends the fallback on work the first coder could have done; `validatePlan` reports it. Shift Test
  4: six build tasks spread across the coders while coder-1 was idle.
- **The reason is visible in three places**, because "why is Coder 1 idle?" is what a card invites: the
  provider's own sentence in the report, `skipped: [{ role, message }]` on the run so the card reads
  `Skipped — <reason>`, and the model's badge in the picker. test-project-2's t1: 1.8s refusal → `coder-2`
  in 87s, `role=coder-2 plannedRole=coder-1`.
- **Single mode refuses.** Tool rulesets cannot hide an MCP tool, so a delegation in a Single session is
  refused in the runner and the Architect is told to do it itself.
- **One worker per project at a time** (`busy` set keyed by directory) — two Architects editing one plan
  file is the one thing that can actually corrupt it.
- **`runs.jsonl` is the project's, so a session's view of it is a ledger, not a sum.** Records carry
  `architect`; older results are joined by `callId`. `runLedger(records, sessionId)` in `src/plans.js`
  answers `spent` (the row's stopwatches) and `reported` (the dashed "handed back" mark), which used to be
  summed by task id alone: on 27 Oct a rewritten three-row plan showed t2 and t3 already dashed with an hour
  on them. Task ids repeat between sessions and plans, so nothing keyed by id alone may cross a session
  boundary.
- **"Keep building" is a session switch, not a setting.** `metadata.synapse.auto` (exposed as `auto`) is
  toggled by the finish-line flag between Stop and Send and read in three places: the brief, every worker
  report so a mid-run flip lands on the next judgement, and the runner at report time. Hidden in Single; on,
  the remaining three tasks ran themselves in 12.8 minutes. **The flag is enforced**: after a free model
  read "Keep building is OFF" three times and delegated anyway, the runner refuses when keep-building is off
  **and the operator has not spoken since the last report** — `operatorSpokeSince()` compares the newest
  `user` timestamp with the newest `synthetic` — unless the delegation is for **the task just reported**,
  which is a retry. The refusal is logged, recorded as `outcome: 'keep-building-off'`, shown as a toast, and
  does **not** wake the Architect.
- **A worker is never killed for taking a long time.** There is no wall-clock ceiling: a designer turn of
  forty minutes is normal. What is stopped is a turn that produces *nothing at all* — `waitForIdle` compares
  a **signature of the transcript** (message and part counts, timestamps, text length) on every poll, and
  when it has not changed for `worker.stallSec` (default 600 s) the turn is interrupted and **resumed**, not
  failed: continue from where it stopped, up to `worker.resumeMax` times (default 4), then it is a timeout.
  `roles.<id>.stallSec` overrides it. The old 600 s ceiling was the wrong shape: on 19 Oct three consecutive
  turns hit it *while working* (48 tool calls and a 447-line contract). **A question for the operator is not
  silence**: while a `question` tool part is running the stall clock is paused.
- **A loop is one phrase held, or one call repeated. The harness counts it and never changes the effort.**
  Tokens keep arriving, so the signature keeps changing; two rules. **Thinking**: the newest assistant
  message is looked at only while it has written no text and called no tool — a last 320-character tail that
  is periodic (the same 12–96 character phrase) and still the same ten seconds later is a loop. **Calls**:
  the same tool with the same target four times inside the last twelve calls; a step that calls a tool ends
  with a tool part, so the thinking check cannot see it (eight runs of `node bin/t1a-proof.js` were
  `loops: 0` on 4 Nov because of that). The runner interrupts, sends a `synthetic` "stop repeating and carry
  on", and counts it: `↻ Loop detected ×1 of 3 — asking it to carry on`. It **does not touch the model's
  thinking effort** — walking the variant down made the model worse and was removed on 4 Nov. At
  `worker.loopLimit` loops in one work order (three) the model is marked ISSUES (kind `loop`), the task moves
  to the next coder **inside the same delegation**, and the log records `loopMark: { role, model }`. The
  report names the coder that *was marked* — naming the run's *final* coder once told the Architect the one
  that had just delivered was broken. `worker.loopGuard` turns the guard off; the rescues ride the run and
  its result as `loops`.
- **A changed answer is a new question, and a spent strike is spent (16 Nov).** Four runs of one test script
  were called "the same target 4 times" while the model was editing between runs: the answers were a
  traceback, two `#REF!`s and a pass. The target key now includes the answer digest; the strike carries its
  own tool (it named an edit rather than the shell that repeated), the window is cleared when a nudge lands,
  and the watcher starts at the send.
- **Recoverable provider failures never end a run.** `src/provider-errors.js` classifies the sentence a
  turn ended with. *Transient* — rate limit/429, connection reset, socket/network/DNS, 5xx, "overloaded", the
  free-tier message, and **anything unrecognised** — is retried in the same session with exponential backoff
  (`worker.retryBaseSec` 10 s doubling to `worker.retryCapSec` 300 s, ±20% jitter), indefinitely; it consumes
  no attempt, moves no rung, and keeps every file written (`synthetic` "continue", not a new worker).
  *Terminal* — deprecated/retired model, invalid key, explicit 400/422 — ends the delegation and moves the
  rung. *Context* — the prompt did not fit — is a third kind: retrying fails identically and the run is not
  over, so the harness asks the engine to compact and sends "continue from the summary, keep each turn
  small". That is what a local server set to **Stop at Limit** returns; *Truncate Middle* silently drops the
  middle of the conversation and *Rolling Window* the beginning. The context rule is tested before
  `bad-request`, because OpenAI wraps an over-long prompt in a 400. (The engine's side changed on 6 Nov —
  see "The engine retries on its own" — so the harness retry covers only what the engine gives up on.)
- **A rate limit must not mark a model.** It used to write a `provider` issue and `candidatesFor()` skips
  marked models, so one 429 made every role on that model look refused and the delegation moved to a retired
  model. Only `deprecated` marks one; a 401 stops the turn and reports but is never a permanent mark.
  **Guarded by `node tests\provider-retry.test.mjs`** — 26 checks over classification, retry, resume, stop
  and the wake — because this decides whether an overnight run survives.
- **A declined permission is not a provider failure (29 Oct).** The engine ends a declined step with "Step
  interrupted"; the gate has already sent a refusal note and the worker often answers it with its report.
  The runner used to read the *first* assistant error, retry, and tell the worker "the provider cut the
  turn", which invited the same tool again. `turnErrorOf` reads the **last** assistant message and
  `toolDeclined` stops a retry when a tool part says the permission was declined.
- **The wake is watched, not fire-and-forget.** It used to admit the report and move on; on the clock run the
  Architect's turn then failed on a rate limit two seconds later and the report sat unread. It now waits for
  that turn and retries on the same schedule.
- **A report's header names the task, the coder, the model and the cost**: "t6 completed by QC (<model
  name>) · ran for 00:26:28 · used 12.4M tokens (58% was reasoning)", with `failed in`, `timed out in` and
  `stopped in` in the same shape. The clock and token totals moved here *from* the report, so the chat says
  each number once; the report keeps turns, peak context and compactions.
- **An attempt belongs to the ask, not to the id.** A rebuilt plan reuses t1, t2, …, so on 4 Nov a rebuilt
  plan refused its t1 because an earlier plan had spent the three attempts. A delegate carries the plan's
  goal and the task's title, and `countedAttempts` counts only records whose stamp matches (`sameAsk`).
- **A steer is on the trace before the model reads it.** The prompt does not come back until the next step,
  so waiting left the chat silent for minutes after the button (4 Nov). The run line is pushed, journalled
  and broadcast at the press; the prompt is awaited in the background, and a refusal takes the line back
  with a toast. An Architect steer paints the sentence at once, with a purple dot
  breathing beside it. The engine's own `[steer]` message is the read receipt; when it
  lands the page opens the next Architect post, so the steer moves above the thinking
  pane at the read rather than at the end of the step. A second `run.steer` with
  `delivered: true` follows for a worker, which is the boundary where it reads it; that
  is what ends the UI's breathing, not the first event. A file-only steer is the same
  path with an empty sentence: the marker is `[steer]`, the files carry it, and
  `runs.steer` accepts it.
- **An automatic answer is not the operator speaking.** After Auto-Answer replies, a synthetic line says
  the operator is away and the harness chose the recommended options, because without it the next turn
  reasoned about a decision nobody had made.
- **Stop is the way out, and it is a run-level cancel.** `POST /api/runs/cancel` aborts an
  `AbortController` for that directory: the poll and the backoff sleep see it next tick, the worker session
  is interrupted, the result is `outcome: 'stopped'`, and **no wake is sent**. The button is enabled
  whenever a run is live for the open project.

- **Every provider failure is written to `data\provider-errors.log`** — its own file, its own 30-day
  retention, pruned at boot and (throttled to six hours) on write: timestamp, transient or terminal,
  reason, role, model, task, retry number, the provider's sentence truncated to 180 characters. The suite
  stays out of it (`NODE_TEST_CONTEXT`), because stub models had added fake lines beside a real usage cap
  and that file is evidence.
- **The worker's poll is also the UI's source of live activity.** `waitForIdle` already fetches the
  transcript, so the newest tool call costs nothing extra: the runner reads its name and target and emits
  `run.progress` only when it changes. The run sits in a map keyed by directory, served at `GET
  /api/runs` — the SSE events are the fast path, and this is what a reloaded page reopens.

## The pipeline: ideas, design, a build, and an adversary

The six cards are `architect, inventor, coder-1, designer, coder-2, qc`. `auditor` and `critic` are
retired: the Architect verifies its own delegations against the disk. The adversary slot is **QC**. A
config written before a rename is migrated once (`normalize()` folds `auditor`→`inventor`,
`critic`→`hacker`, `hacker`→`qc`) and an old plan is translated on read (`LEGACY_ROLE`).

The pipeline is a **menu**, not a checklist: a clock pays for invent → design → build → wire → QC → fix;
a word-count CLI pays for two tasks. Roles are identities plus one mandate each (`ROLE_MANDATES` in
`plans.js`), and each owns one folder:

| role | may write | produces |
|---|---|---|
| inventor | `.project/ideas/` | `ideas-1.md`, ranked, with a one-line why and effort |
| designer | `.project/design/` | `design.md` (the spec) + `mock-N.html` |
| qc | `.project/qc_findings/` | `qc-N.md`: ids `Q1…`, severity, exact repro |
| coders | the project | `bin/` |
| every role | `.project/reports/`, `.project/shots/` | evidence and the renders it took |


**The file contract is the point.** `.project/` holds `project.md` — written by the harness, never by a
model: a `## Current` head (the latest request and the decisions still in force), the `## Handover` from
the last compact, the operator's `## Notes`, and an append-only `## Log`. It replaced `requirement.md`
and `decisions.md`, which are imported on first use and archived. It also holds `plan.json`,
`features.json` (confirmed + rejected, each confirmed item naming the task that delivers it), `ideas/`,
`design/`, `qc_findings/` and `runs.jsonl`. **The head is why the document exists**: the brief used to
quote the first 1,600 characters of the *original* request, so a long project opened standing in its
first day. The head is rebuilt from the Log on every write; Single messages are `### chat` and never
become the head's request.

**Compacting a conversation keeps it.** `POST /api/session/{id}/compact` is queued at the next step
boundary and does **not** delete the transcript: the engine's summary replaces what the model is sent.
Manual compact now follows the same path as the engine's automatic one:

1. `engine.compact(session)`; wait for a **new** `compaction` message with `status: completed` and a
   `summary` (shaped Objective / Requirements / Decisions / Work State).
2. Write the summary into `project.md`'s `## Handover`, and a `### compact` line into the Log. **Nothing
   is written before this succeeds.**
3. Keep the same session and reload its transcript; the compaction card is the only new row. Broadcast
   `project.compacted` with `inPlace: true`.

There is no replacement session and no `synapse.compacted` post. A refusal or a timeout leaves the
conversation exactly as it was: there is no silent discard. **A failed compaction is not waited out, and
Stop cancels the wait (29 Oct)**: the engine writes `status: 'failed'` when it gives up, so
`waitForHandover` returns an error at once instead of polling three minutes; Stop marks the wait cancelled
(`cancelCompact`) and the request rejects with 409.

**A worker's transcript is replaced when its compaction no longer fits (28 Oct).** The compactor reads
the whole *retained* transcript, so a long task asks the model to summarise more than its window holds —
measured at 225k on a 131k model, while the active prompt was 111k. When that or a provider
context-limit error reaches a worker run the runner does **not** retry the session: it creates a fresh
worker with the same role, model, rules and briefing and prompts it with a **Synapse-written handover** —
the task and its detail, the last thing it said, and "the project's files are the work — inspect git
status/diff, keep what is done, continue, do not repeat". Three replacements per task, then the old retry
path applies.

**"Keep" writes a deliberate project copy (28 Oct).** An attachment is normally inline in the operator's
message, where a compaction may leave it out of the model's context; the session still has it, but the
durable copy is what survives. Checking **Keep** writes
the bytes to `.project/attachments/<stamp>-<name>` before the prompt, appends a `### attachment` line to
the Log, and every brief says the folder exists. Unchecking writes nothing, deleting the project deletes
it, and the timestamp stops a second keep overwriting the first.

**A shell command is judged per statement (28 Oct).** A QC migration read `%APPDATA%` and wrote its
report in scratch; judging the whole command as one outside write asked for a card three times.
`analyzeCommand` keeps a read/write answer per statement: an outside **read** is allowed, an outside
**write** asks, and a write with no path after `cd D:\...` is still an outside write.

**App data is portable by rule (28 Oct).** Every brief says an app's data lives in a `data` folder beside
its executable (`bin/data`), never `%APPDATA%`, `%LOCALAPPDATA%`, `ProgramData`, the registry or any
profile folder; scratch is temporary and never shipped. The gate still **asks** for a profile write, but
the card says where the data belongs.

**A shipped tool runs from anywhere in a command (4 Nov).** The rule that lets a model run
`node skills\...` looked only at the first word, so `timeout 30 node ...\skills\…\shot.mjs` was judged a
write to the harness and refused. It is per statement and per interpreter now: the first non-flag word
after the last interpreter must be a script under `skills/`, inline code (`-e`, `-c`, `-Command`) never
qualifies, and every harness path named must be under `skills/`. The engine's PATH carries `bin\node`
first, so the plain `node` in a brief works with no Node installed.

**An example in a brief is a template, not an illustration.** The Inventor's first mandate offered an
alarm, a theme and a second time zone as the shape of a good answer — written for one project and about
to be sent to every project after it, where a model copies the surface, not the lesson. It now asks for a
named behaviour small enough to say in a sentence, sayable out loud the way a user would, with "settings
/ polish / good UX are not features" as the anti-pattern. The features gate follows the same rule: one
`multiselect`, never bundles, the recommended ones first with `(Recommended)` each carrying its why and
effort, and `custom: true`. It is instruction, not enforcement — the question schema is the model's.

**A plan that routes every task to a coder skips the craft.** A brief made almost entirely of visual
constraints came back with all six tasks on `coder-1`: every named file was delivered and the one thing
the operator wanted to see — the look, decided by someone whose job is deciding looks — was never
planned. The phase lines said what each *phase* was for and never who was for *what*. The routing rule is
one sentence: **send a task to the craft it needs, not to whichever role is free; a coder builds a
decision, never makes one.**

**A rule that lands while Synapse is running has not landed.** The design rule above was committed at
20:41 and the plan written at 20:42, under a process booted at 20:16. When a brief change "does not
work", check the boot line in `logs\app.log` before the rule.

## What a run costs

Measured from the engine's store (`data\engine\opencode\data\opencode\opencode.db`).

- **Throughput by prompt size, same model:** **157 tok/s under 50k, 145 at 50–100k, 117 at 100–150k, 68
  at 150–200k**. Every long task finished at 212–290k and its second half ran at half the speed of its
  first (t2 151→76, t4 167→75, t5 165→82).
- **Tokens per minute:** Clock Test 3 read **56.4M prompt tokens** over 515 turns — 180–430k a minute,
  where an interactive chat is 100–200k with long gaps. That density is what a free tier refuses, in
  bursts of 5–11 minutes.
- **The thinking share:** 70% of the 727k tokens Clock Test 2 wrote, and 51% of Clock Test 3's
  transcript. The engine stores `reasoning` parts, so every turn re-sends them; a 212k prompt measured on
  t4 was thinking 43%, tool results 30%, call arguments 19%, screenshots 4%, instructions 3%, the
  conversation ~1%.
- **A compaction can fail because its own summarise call is too big.** The compactor reads the whole
  message log: t2 on 28 Oct had a 111k turn prompt while the compactor sent **225k to a 131k model**, and
  the engine wrote `status: 'failed'`. **A failed message is not a compaction** — the trace said
  "Compacted ×4 · context at 225K/131K" for three real ones. `compactionKeepTokens` changes the tail
  carried *after* a summary, not the history read.

**Since every turn re-sends everything, the only instructions that move the number are about how much
gets said and how often**: think in a sentence and act, read a file once and search it after, edit rather
than rewrite, keep the spec under 200 lines, give tasks a named file and a proving command, never re-run
a passing check, and keep a notes file in scratch. **The harness reports it**: `Effort: 130 turns; the
context peaked at 118k of its 200k window`, on `runs.jsonl` as `context: {turns, peak, generated,
thinking, compactions, thinkShare}` and in the app log. The line used to end with a verdict — "Past about
150k a run gets slower with every turn" — and the operator asked why the model was being told that
(21 Nov): true of the model it was measured on, then said to every model. The window is printed only when
the peak fits inside it.

**A task that needs 80 steps is too big.** Every step re-sends the conversation, so the step count is
both the time and the cost. `worker.maxTurns` (default 80, 0 turns it off) stops a run that crosses it
with "the task needs splitting" — outcome `stopped`, no attempt counted, the model not marked. Measured
4–5 Nov: a local coder spent 178 steps and 18.6M prompt tokens on one task; that is a plan problem, not a
model problem.

**QC's default focus was dialled down.** `app` judges the operator's own screen and machine, calls
another hemisphere / screen size / hand-edited constant an observation rather than a finding, and says a
minor is a note, not another fix round. **A second QC pass is a check, not a new hunt**: round 1 (38m)
found nine issues, round 2 (32m) re-verified them, round 3 (6m) re-ran the repros and stamped SHIP. A
second pass re-runs the listed repros *and nothing else*.

**Harness alarms judge what a shell does, not what it names.** Eleven alarms in one run were the
Architect running `skills\visual-review\shot.mjs` before judging — the toolbox doing its job. A command
whose only harness paths are under `skills/` is quiet now; one naming the rest of the harness, or shaped
like a write, is still an alarm, and a *write tool* on a harness file is an alarm for everyone. Replayed
over 399 shell commands: 21 would have alarmed before, 1 does now. **Our writes are not a worker's
(10 Nov)**: a kept attachment and an answer to a question both land in the project while a turn is open,
so `src/synapse-writes.js` records what Synapse wrote and the comparison excuses only those, in that
window — exempting the file *names* would have let a worker edit `project.md` unnoticed. `alarmTitle()`
maps each kind to its own sentence, and `configSavedAt()` excuses the operator's own Settings save.

**A changed tree is not a witness (13 Nov).** The post-run `git status` comparison announced "Synapse's
own files changed while a worker ran" for six files the operator's agent was editing: `git status` cannot
see who wrote a file. The run's own transcript decides the sentence — if any tool call named the harness,
the files are evidence; if none did, it is titled *"The harness changed during a run, and no tool call in
that run named Synapse"*. Nothing is suppressed: the files are listed, the log records them, and the
rules and restore point are unchanged, because a project script with a hard-coded path could still write
here.

### What a permission rule actually does

Measured on 2.0.30, and not guessable:

- **The rule matches the path as the model wrote it.** A relative rule (`.project/**`) refuses a relative
  write; an **absolute** rule does *not* refuse a relative path. Emit both forms.
- **`edit` is the action for both the `write` and the `edit` tools.** `write` is not an action name — a
  rule on it denies nothing, which looks like a working rule until you test it.
- **`read` is an action**, so reads can be denied separately.
- **`action:'*'` with a path denies reads too** — right for a folder nobody should read, wrong for
  `.project`.
- **`shell` and `execute` are not path-matched**, so a worker can go round any path rule with a redirect.
  Hence `synapseFingerprint`/`fingerprintDiff`: the runner compares every file under `.project` before and
  after a worker turn — prevention for the file tools, detection for the rest. **Verified live:** a coder
  rule refused `.project/probe/x.txt` twice (`write:error`) while the same write with an absolute path got
  through.
- **Scratch and shell logs are exempt from that fingerprint.** The role rules allow
  `.project/scratch/**`; the fingerprint originally compared every file and reported a QC
  run's own permitted scratch as a stray write (24 Nov). `shots`, `reports`, `scratch` and
  `logs` are the shared folders the comparison skips.

### The permission policy

Three zones, one policy file, and the engine's `ask` as the hook:

| | project | harness | anywhere else |
|---|---|---|---|
| read | allow | documents and logs (`data/`, `config/`, `.git/` denied) | allow, credential stores denied |
| write | allow | denied, no prompt | the operator is asked |
| shell | allow while it stays inside | toolbox scripts and read verbs; else denied | the operator is asked |
| execute | asked | asked | asked |

Every decision from `decide()` is one object: `effect` (`allow`, `deny` or `ask` — what the gate replies
`once` or `reject` for), `scope` (the zone: `project`, `harness`, `temp`, `prohibited`, `secret`,
`processes`), `reason`, and `outside`. **The prohibited list itself is `docs/notes/protection.md`**;
nothing here widens it. There is no fourth zone any more (20 Nov): a model's scratch is
`.project/scratch` inside its project, so read, write and shell there are the project's rules — the role
ruleset allows that folder explicitly, because it denies `.project/**` first.

The ruleset is four broad asks (`edit`, `shell`, `execute`, `read`) plus the credential denies.
**`always` is never used automatically** — a saved allow would outlive the policy that granted it. **Always
Allow is the operator's decision, so it survives a restart**: the memory is written to
`data/permission-memory.json` on every grant, capped at 500 entries, and a session's grants are dropped
when the session is deleted.

**What "the request" is comes from `grantKey` (27 Oct).** A file action remembers the resolved path — a
relative and an absolute name for one file are one consent. A shell command remembers the executable, the
files it names and whether it reads, writes or runs them, not the exact argument string: the model re-runs
the same script with `-ExecutionPolicy Bypass` or a pipe, and every variant asked again until this.

**Synapse's temp is the harness's, not the machine's, and not a model's.** `TMPDIR` alone did nothing on
Windows: Node reads `TEMP`/`TMP`, so the engine wrote `%LOCALAPPDATA%\Temp\opencode`. The server sets both
to `data\temp` before spawning the engine, and the analyser expands `$env:TEMP` from the same env, so the
writer and the judge see one folder. One engine serves every project, so this cannot be per-project: it is
plumbing, and what lands there is debris. A command needing a temp directory points `TEMP` at
`.project/scratch`.

**Full auto can answer for the operator (28 Oct).** With `synapse.fullAuto` on — still written back as a
mirror, though the four switches own it — a request left to the operator takes the default after
`fullAuto.timeoutSec` (20 seconds). A card is **allowed once** (`decidedBy: 'timeout'`); a question takes
the **Recommended** option, or the top one (`src/auto-answer.js`), and a server-side sweep every five
seconds answers it (`src/form-auto.js`), so a closed browser cannot stop the work. An operator answer
cancels either timer, and it can only answer `ask` verdicts: a harness write or a credential store is
denied before a card exists. **Zero is a real wait (29 Oct)**: `timeoutSec: 0` draws no card — the gate
answers `once` on the next microtask with `decidedBy: 'full-auto'` and `asked: false`, so the chip is
green. The setting is read on every ask and `retime()` re-arms open cards.

**A refusal explains itself, through a synthetic note.** The reply body's `message` is dropped on the
reject path in 2.1.2 — the error is always "The user declined this tool call" — so the gate follows the
rejection with a `synthetic` message: why, that a workaround is not allowed, and where to escalate
(26 Oct: the model answered "…I won't attempt any alternate path or tool"). The Architect of a **Multi**
chat is not sent one without a typed reason: that is the operator's conversation. A **Single** chat always
gets one (16 Nov), because no worker report and no wake follow and the engine ends the turn: the request
was declined, not the work; a typed reason is quoted back and is what the model acts on; keep working;
this is not a Stop. It carries no list of forbidden routes — the first version said "do not try another
path or tool" beside a reason that said "retry this tool call".

**A read statement is a read, even beside a command (16 Nov).** `node --version; Test-Path
"…\skills\visual-review\bin\shot.mjs"` asked *"Synapse is the app itself…"* although the Test-Path only
looked: the harness test used the command's `readsOnly` flag and `node --version` made that false. The
decision is per statement now — a read-only statement's harness path is checked for readability, and only
a non-read statement's is a write.

**Why broad asks instead of path globs.** The engine matches a path *as the model wrote it*, so a rule
allowing `F:/.../project/**` says nothing about a relative `src/app.js`. Resolving both against the
session's directory in one place judges them the same. The price is one local round trip per write, shell
and read; the UI waits 200ms before drawing a card.

**Measured on 2.1.2:** `Permission.Effect` is `allow | deny | ask`; the resolver is `findLast`, so **the
last matching rule wins** and a session rule beats the agent default; with nothing matching the default is
**ask**. The ladder is emitted first and the mode/role rules after it, which also fixed Single's
`subagent` deny.

**What the policy cannot see, and does not pretend to:**
- a project script (`npm test`, `node build.js`) can write anywhere once it runs;
- `grep` and `glob` are not path-gated, so they can read what the read tool would be refused;
- shell analysis is a heuristic: an unresolvable path asks, but a determined wrapper gets through;
- **a newline separates commands.** `Test-Path D:\` and `Set-Content …` on the next line are two
  statements, each judged alone; missing that let a read verb excuse an outside write on 26 Oct.

The card says who is asking (role and task, or the session title), the action, the resolved path, and why
the policy left it to the operator. A worker's request must be visible even though its session is hidden
from the rail — filtered to the open session it would block the worker with nothing on screen. Every
decision is written against the tool call id, which draws the chip. The engine puts it in `source.id` on
an edit or read ask, but **2.1.2 omits `source` on every shell ask** (measured 28 Oct), so the gate
watches `session.tool.input.started`, `input.ended` and `called`, remembers recent calls, and pairs a
source-less ask with the newest unclaimed call of the same family. The log is memory only
(`src/permission-log.js`). The live event has the same key rule: `permission.decided` must be stored under
`decision.toolCallId`, not the request id — keying it by `requestId` made the chip vanish.

**Skills are per role, and enforced.** `roles.<id>.skills` is an allowlist; the session gets
`{action:'skill', resource:'*', deny}` plus one allow per name (**the last matching rule wins**), and the
brief names them. Measured: a denied skill answers "Permission denied: skill (type: permission.rejected)"
while an allowed one loads. No list means no restriction; an empty list means none. The ✎ button holds
**Skills** (the tick is *allowed*; the **Required** box is `roles.<id>.mustLoad` and changes the brief to
"load every one of them before your first edit … a skill you skipped is part of the job you skipped"),
**Focus** (QC only) and **Instructions** (`roles.<id>.instructions`, capped at 2000 characters). Required
is a subset of allowed by construction, because a required skill the engine refuses would be reported
missing for ever. **The end-of-run check uses the list the brief actually asked for**, snapshotted when the
worker was created, not `getConfig()` at the end: on 17 Nov the Architect was told three designer skills
"were never loaded" after the list had moved. Ticking every skill stores *no* list, because that is the
same thing and it lets a later skill reach the role.

**QC has a volume dial, and it starts low.** In `app` it judges the build the way an ordinary,
non-technical person meets it: **wording** (labels and errors in a coder's voice or in jargon — a message
the reader cannot understand is a defect, quoted with the plain version), **design flaws** (clipped text,
broken layout, unreadable contrast), **missing input validation**, and **states that lie**. It is told not
to run locale or interpreter matrices or fuzz in loops — `security` is the same role with the gloves off.
Both carry a proportion rule ("the cases with the best chance of happening beat a complete matrix"),
because the 197-second locale-matrix run was correct and useless. **Ideas are hidden from coders**:
`roleReadRules` denies `read` on `.project/ideas/**` for `coder-*` only, because that file is where
rejected options live.

**Synapse ships the skills it needs, and says what it cannot find.** `skills\` next to `src\` is put on
`skills.paths` on every boot, ahead of any configured folder and independent of the config — the difference
between "the pipeline works on a new PC" and "the Architect silently has no eyes". It ships `visual-review`
(renders a mock and reads the PNG — the only way these agents see), `ui-design`, `frontend-design`,
`aesthetic-foundations`, `code-craft` (match the surrounding style, keep the surface small, fail loudly,
prove it) and `web-guidelines`.

**Which copy wins.** The engine reads the configured `skills.paths` *and* `~/.agents/skills`; when a name
exists in both the **configured** copy loads (measured on 2.0.30 by putting a distinct description in each
and restarting — verify the file, not the edit, because PowerShell's `-replace '^description:'` needs `(?m)`
per line). **By default** the Architect may load `visual-review` and must before judging; the Designer may
load all four design skills and must load `frontend-design` and `aesthetic-foundations`; every coder may load
`code-craft` and must; QC may load `web-guidelines`, `aesthetic-foundations` and `visual-review` and must the
first two; the Inventor may load `frontend-design` and must nothing, because a vague request is where
direction talk helps it name features rather than categories.

**Two rules about the library itself.** `using-superpowers` was deliberately not shipped: it is a rule about
*when to invoke skills* ("if there is even a 1% chance a skill might apply, you MUST invoke it"), with
examples naming skills that are not installed here, so a coder spends the turn announcing skills that do not
exist — read a skill before shipping it, because a description is a claim, not a measurement. And a skill may
not say where a shipped tool lives: the text used to carry the full path of `shot.mjs` as it was on the
machine it was written on, three roles in Timer Test 1 hit `MODULE_NOT_FOUND`, searched the disk for it
(raising the *shell command naming the harness* alarm) and called it with `--help`, writing a picture of the
browser's error page. So `describeSkills()` names the absolute path for any role whose list includes
`visual-review`, the SKILL.md says "the path is in your brief, do not search for another copy", and
`tests/skills.test.mjs` fails if any shipped `.md` mentions a machine-specific folder. **A skill describes how
to work, the harness describes where things are.** The operator's own folders are extra paths on top
(`engine.opencode.skillPaths`), and nothing is downloaded at runtime.

**Eyes are a skill, not a tool.** `visual-review` (`skills\visual-review`, `bin\shot.mjs`) renders a file or
URL with the machine's Edge (`--headless=new`, a throwaway `--user-data-dir`, ~1.2s) and writes the PNG into
the project; the model then **reads the PNG**, which works on deepseek and not just on a vision model
(measured: it named a made-up word and its background colour correctly). Two widths at most — each image is
roughly a thousand tokens. The SKILL.md carries the honesty rules: say what is measurable, say what a still
cannot show, never invent a label.

**The renderer measures, serves and refuses.** Unknown options, extra targets and a missing file are errors
with the usage line (an unknown `--option` used to fall through, so `--help` photographed a file named
`--help` and exited 0). It serves the page itself on a random port from the file's own folder, because
`file://` cannot test localStorage or a reload — agents kept writing `qc-serve.js` / `python -m http.server`
and leaving them running, and two orphans still held 8321 and 8765 hours later. It reports numbers next to
the picture: `status`, `viewport`, `doc.scrollW` against the width, `overflow`, WCAG `contrast` below 4.5 (3
for large text, ancestor opacity folded in, disabled controls exempt), controls under 44px — on the timer
page it found six under-44px targets and six chips at 2.47:1 that QC called fine. It fails on a blank page or
a 4xx/5xx, because a blank PNG is the one answer that looks like success, and `--do "click:#start; wait:800"`
photographs a *state*.

**Desktop apps are a window around a web page, and both halves are checkable.** The interface is HTML in
`ui/`, so the web pipeline applies. The window is not, so `skills/app-check` starts the exe, waits for a
window, photographs it (`PrintWindow` first, screen as fallback), and reports title, size, DPI scale, whether
the process is **alive and responding after the shot** — a window that dies on its first paint looks exactly
like a working one in a picture — and whether it exited before showing anything. `skills/win-app/template` is
the shell a project copies: WPF, WebView2, `PerMonitorV2` DPI, a dark title bar, and `ui/` over a **virtual
https host**, not `file://`, so localStorage, modules and a reload behave. Measured: `dotnet publish` → a
58.9 MB single-file `App.exe` plus `ui/`, running on a Win10/11 machine with no .NET installed.
`GET /api/toolchain` answers what a PC can build; it is no longer a Settings pane.

**The free zen models are in the catalog; the account is what runs out.** Nine `opencode/*-free` models are
listed (`/api/model`) and selectable, and every one answered one throwaway prompt `idle` with
`provider.free-limit`, status 429, `retryAfterMs` about 12.4 hours: the routing is right and the free
allowance for this account is spent. A *run* rather than a probe marks the model — that is what the ISSUES
chip is for.

## Git and session names on a session's first successful turn

Beside the old auto-namer's slot in `afterTurn`, Synapse checks the session's directory for a repository
(`git rev-parse --git-dir`) and runs `git init` if there is none. Once per directory per process, and no
config.

- `rev-parse` succeeds inside any **parent** repo, so a project folder under an existing repository is
  left alone — Synapse never creates a nested repo. Since the projects root is a *sibling* of the harness,
  a project is no longer inside Synapse's own repository, which also keeps its files out of the harness's
  `git add -u` snapshots.
- `git` missing or the command failing is logged and skipped; a turn never fails because of it. Verified
  in an isolated temp folder: exit 128 before `git init`, `.git` and exit 0 after.

**There is no session naming any more (27 Oct).** A session used to be created as **TBD** and named by a
`generate` call after its first turn. With one chat per project the rail shows the project's name and an
engine session's title is never read, so the titler is gone. A chat is created with the project's name as
its engine title, for an audit read of the engine's own list.

## Single and Multi mode

The composer toggle flips the **open session** live; new sessions always start Single. Both modes have the
full toolset — that is the whole point.

- **Single** — a permission ruleset on an ordinary session that denies only `subagent`: not a custom
  agent, not a blanket deny. The role cards stay collapsed (`max-height: 0`).
- **Multi** — the ruleset is cleared (`PATCH /api/session/{id}` with `permissions: []`), the wrapper
  animates open and the chat slides down. Verified live: the Architect called `subagent` (general,
  `completed`) and answered with the worker's reply; no child session in the rail.

The mode is per session, read from `isSingleSession()` (`engines/base.js`); nothing is in config —
`defaults.mode` was removed once the toggle became live. **It is applied at send, not on toggle** (27 Oct):
`sendMessage` carries the mode, PATCHes the ruleset once if it differs, then briefs and prompts. **A
dedicated `chat` agent (tools denied, `steps: 1`) is the obvious design and it does not work**: the free
tier rejected every request from a custom agent with a provider auth error (measured side by side —
20:45:37 failed, 20:45:40 succeeded). `POST /api/session` accepts `permissions`; `PATCH` replaces them.

### A Single session is not told it is an Architect

The trap is not a fresh Single session but a live Multi one switched to Single for one small thing: the
transcript still holds the campaign and the project still carries `.project/`. Omitting the harness is not
enough; the brief has to overrule what the model sees. Measured 26 Oct: asked to copy one exe, the model
read `.project/plan.json`, decided from `t21` whether the build was current, and reported on `t18` and
`t20` — and the brief had quoted the stored requirement verbatim.

What the Single brief says now, and nothing else: where the tools operate and that the answer may need the
disk or a command; one conversation, no team, no delegation, ignore a delegation tool if offered; **only
when a plan file exists**, that it was written for a different task and is not to be followed or updated;
and **the operator's standing Notes from `project.md`**. It does not quote the request or the handover,
and does not call the session a role — the skills line drops "this role" and "your report"
(`describeSkills(..., { chat: true })`). A Single message is logged as `### chat` but never becomes the
head's request. A delegation attempted anyway is refused with "do it yourself" rather than "ask the
operator to switch to Multi", which reads as an errand. Multi is untouched.

## The tool census, and the restart it used to double-count

`recordMessages` is called with the **whole transcript** on every turn and de-duplicates with a set of
tool-part ids. Those ids ride along with the totals now (`seen` in `data/tool-stats.json`, capped at
4000), so the first turn after a restart resumes where the last process stopped instead of re-adding a
session's whole tool history — the old failure was an in-memory set with totals on disk: 2 calls →
restart → re-scan → 4. A census written **before** ids were kept cannot be repaired, so it says so once
and is wrong for one more scan. A test looks clean unless it calls `flush()`: the write is debounced by
2s. `tests/toolstats.test.mjs` pins the restart, the warning and the clearing.

## An answer has to outlive the transcript

The reply goes back through `form/{id}/reply`, the engine records it as the `question` tool's output, and
the model reads it next turn — no separate channel, and no confirmation the model read it. Shift Test 5
showed the seam: the designer was given the same two decisions at 19:46 and 19:51, kept working, then
re-opened the settled question and asked twice more at 19:53 and 19:54, with the answer in its own context
and nothing compacted. That repetition is the model's, and the question-loop guard stops it.

What is ours is that the answer had no life beyond that transcript, and a summary of an answer is a
model's account of it. So `replyForm` appends to **`.project/project.md`**, under the Log, as a
`### decision` entry — the question titles and the operator's values, verbatim, written by Synapse and
never by a model. The head lists the decisions still in force, and every brief says so: *"the operator's
answers so far are in `.project/project.md` … read it before you ask anything, and never ask a question it
already answers"*. The features multiselect lands there too, which is what makes a rejected idea stay
rejected. Two edges: the guard's own memory (`questionHistory`) is in-process, so the file is the durable
record for the *next* run, not a replacement for the guard; and a session outside a project has no
`.project`, so nothing is written and the reply still goes through.

## Stop means stop

Measured 23 Oct: the operator pressed Stop and the run carried on to the end and started the next task.
Nothing was broken in the runner — the button was aimed at the wrong thing. **A delegated task runs in its
own worker session**, so Stop interrupted the Architect; the worker finished, reported, the Architect was
woken and delegated the next task. Stop does three things:

1. **It cancels the run**, not just the session: `runs.cancel(dir)` aborts the runner, cuts any backoff
   short and interrupts the worker session.
2. **It puts the task back to `todo`.** A task left `doing` makes the plan say "1 running" for the rest of
   the day. That is the one write the harness makes to the plan (`setTaskStatus`).
3. **It holds the project** (`stoppedByOperator`): a delegation arriving while held is recorded as
   `stopped-by-operator` and not run, and the "ready but never asked for" reminder stays quiet. The hold
   lifts when the operator speaks — `POST /messages` or turning keep-building on.

**The run record is not the list of live work.** A worker can outlive a run that already reported or was
cancelled: the engine still lists its session as active, Synapse has no run to cancel, and the Architect
looks idle, so Stop was disabled and did nothing. Stop now asks the engine for its active sessions and
interrupts every one in the same project, plus that session. `/api/pending` reports `canStop`, and the
composer's Stop is enabled from that answer. Measured 26 Oct: an idle Architect and a running worker —
`canStop=true`, one press stopped both.

**A stop used to be filed as the previous provider failure.** Measured 29 Oct: a cap was retried seven
times, cleared, the worker ran five minutes and Stop was pressed; the result kept `Free usage limit
reached…` because the runner breaks on `stopped` before recomputing the turn's error, so the Architect
relayed the cap as the cause. A result now carries `stoppedBy` (`operator` or `harness`) and
`lastTurnError` separately, and `error` is null for a plain operator stop. The report's head says who
stopped it, and the old provider sentence is quoted as "before the stop, the last turn had ended with…".
The record answers *why did it end* and *what was the last thing it heard*.

**A stop wakes nobody, says nothing, and is two-stage.** The first Stop lets the open assistant message
finish and cuts when a different one begins — the next step. No message is sent, no report is requested,
nothing says "the operator stopped you": the model sees a turn cut at a boundary, what a dropped
connection looks like. The 45-second `STOP_GRACE_MS` catches a long step; the UI says so in the top-right
notice and rings the chat in a fast red glow. A second Stop cuts immediately, mid-token if that is where
it is. Since 6 Nov both stages belong to `src/stop.js`. No Architect turn follows. The hold survives a
restart: `recoverStops` reads the latest result's `stoppedBy: operator` and holds unless a user message
arrived since; `recoverLostReports` skips stopped and interrupted results, so a boot cannot replay a
stopped run as a report and invite the Architect to re-delegate it. A harness stop (the question-loop
guard) still reports immediately: a failure the operator must see, not a decision.

### The engine retries on its own

Everything above was true and Stop still did not work, because one fact was missing: **the engine runs its
own retry loop inside the session.** On a 429 it schedules a retry and fires it about thirty seconds
later, with no request from Synapse; an interrupt arriving during that wait has no generation to abort, so
it does nothing — then the retry fires and the work carries on.

Measured: five Stops between 11:51:47 and 11:51:51 were each answered "1 session interrupted", and the
engine retried at 11:52:05, 11:52:36, 11:53:07, 11:53:38 and 11:54:08. The sixth Stop, at 11:54:10, landed
1.6 s after a step had started and worked. After the eighth failure the engine scheduled a retry for
11:58:00, never fired it, and left the session active with nothing running — Stop enabled, the log saying
"interrupted", the event list frozen on `session.retry.scheduled`. That event is the engine's: not a wake,
not a schedule Synapse made, and no evidence anything is about to happen. So Stop was rebuilt
(`src/stop.js`):

- **One intent per project, one timer, one owner.** The gentle press, the immediate press and a stop from
  a card all call `stopper.stop()`. The harness side — cancel the run, mark it stopped, kill the wake
  loop, hold the project, release the screen — happens there, once. The runner's `requestStop` only marks
  the run; its 45-second timer and step-boundary check are gone.
- **Stopped means quiet, not "an interrupt was sent":** no session in the project is active *and* every
  session touched ends its transcript with an `idle` message — the marker that separates "finished" from
  "waiting out a retry".
- **It keeps cutting.** While a session is still active it interrupts again on every tick, which is what
  makes a stop land on the retry scheduled before the press.
- **A retry is a boundary**, so the gentle press cuts when the next step begins; and **a turn already
  waiting out a retry is cut at once**, because the last message is a failed assistant turn and there is
  nothing left to finish.
- **A wedged session is recognised**: not active, no idle marker, a failed assistant turn — it is
  interrupted again, which is what clears it.
- **It says so when it cannot.** After sixty seconds still running the page is told `stop.stuck` with the
  provider's sentence; after five minutes it gives up and says that too. It never reports "stopped" while
  a session is alive.
- **The operator speaking clears it**, so a stop still watching cannot cut the turn they started.

`node tests\stop-controller.test.mjs` pins the retry loop, the wedge, the boundary, the second press and
the clear-on-speak.

## Talking to work in flight: steer, not stop

`POST /api/session/{id}/prompt` is an inbox entry, not a blocking call. `steer` is the default `delivery`
and `queue` the alternative. Measured on 2.1.2 and again on 2.2.3:

- `steer` **joins the running turn** and is read at the **next step boundary** — after the tool call in
  flight, not mid-token. A worker doing tool calls sees it in seconds; a model streaming a 900-word answer
  saw it when that answer ended (34 s) and obeyed it in the same turn.
- `queue` waits for the turn to end, which makes it a normal follow-up message with ceremony.
- Neither can preempt a tool call or a generation. **Stop is the hard interrupt.**

Synapse sends a steer with the marker `[steer]` and a space before the operator's words. A file-only steer
has no words, so the marker stands alone and the files are the message. The briefs define it: guidance for
the task in flight, not a new task; apply it, say in the report what changed, do not restart. The report
quotes every steer and the Architect judges against the latest instruction. **Who may steer:**
anyone looking at the project — the first cut allowed only the computer that started the work, and the
operator removed that check on 30 Oct, choosing reach over ownership. The computer name stays on the steer
line as an audit fact. The composer becomes **Steer** with a yellow border in every view while the work
runs.

**The plan follows the steer.** The Architect is told to put the change in the task note and the plan, and
to ask when a steer changes the task materially rather than quietly reshaping it. A small steer is a note;
a big one is a decision, and the operator owns it. **Two guards the engine does not give us**: a steer
admitted just as the turn ends can start a turn nobody polls, so the runner interrupts once after a run
that carried steers; and a steer during a provider backoff is refused, because the session is idle and the
message would race the retry.

**The worker id is not in `run.started`.** That event is emitted before the worker session exists, so its
`workerId` is null. Measured 30 Oct: a coder that was only thinking showed no worker to the page, and Send
stayed disabled instead of becoming Steer. The runner now emits `run.progress` right after `spawnWorker()`,
and the composer targets the live run. Measured live (2.2.3): a coder writing 400 numbered lines was
steered with "put `STEERED` at the top"; the file came back 401 lines with `STEERED` first.
`tests/steer.test.mjs` pins the runner side and the briefs. **A steer is seen** on that worker's run trace
with the yellow `STEER:` marker — not a "You" message, because the worker has its own session — and it
survives a reload through `/api/runs`; its tag breathes while `deliveredAt` is absent, and stops when the
runner reports the read. If the run stops before the report, the next brief carries "the operator's steer
to the last run still stands".

## A long command is a lease, not a stall

A worker running a 90-minute download produces no transcript change, and `waitForIdle` measures exactly
that: silence. Before the lease, the stall clock fired and the interrupt killed the download. The worker
now calls the `lease` tool **before** the long command (`src/mcp/lease-server.js`, a stateless receipt like
`delegate`): minutes and a one-line reason. The runner reads the call from the transcript on its next poll
and holds the stall clock off until the lease ends. The chat shows one violet line with a live countdown
and `/api/runs` carries it.

**The card is drawn from the lease, not from the call (21 Nov).** The countdown used to ride only the tool
call that asked for it, and a worker's lease call never reaches the trace: the page's tool notes are the
*polled* shell calls, and an MCP call that takes forty milliseconds falls between two polls. The operator
watched a worker think "call the lease", saw no card, and asked whether the model was lying — it was not:
three `synapse-lease_lease` calls and a live 15-minute lease in `/api/runs`. The card is now `leaseCard()`,
from `leaseFor()`, pinned at the bottom of the trace beside the thinking: the Architect's card shape, a
breathing dot, the same `data-lease-until` clock, and the reason. The line itself is only for a lease whose
run has folded or is not on the page, so one lease is never said twice.

**The note's `kind` is the page's switch, and the lease had overwritten it (21 Nov).** `onLease` emits
`run.note` with `kind: 'lease'` and then spreads the lease's own fields, which carry a `kind` of `granted`,
`extended` or `expired` — so every note arrived as `granted`, `noteLease` never ran, and nothing was drawn
while the stall clock was held off correctly. The lease's state now rides as `leaseKind`, after the spread,
and `traceSig()` includes the leases.

At the end the worker is **asked**, not killed: a synthetic says the lease is over and it may call `lease`
once more for the time it needs. Any assistant message after the question earns the one extension; a second
lease call replaces the clock. If nothing arrives within `worker.leaseGraceSec` (default 300), the silence
is a stall again and the normal resume path runs. A model inside a shell call cannot answer — that is why
the lease is asked for before the command and the question queued. `tests/lease.test.mjs` pins the receipt
and the settings; the timer needs a live run.

## A worker stops what it started, by id

A coder tidied up with `Stop-Process -Id 26232 -Force; Get-Process python | ForEach-Object { Stop-Process
-Id $_.Id -Force }`. The second clause stopped **every python on the machine**, the local model server
among them — dead at 00:07:45, one retry 433 ms later, eight minutes against a closed port, and still
reported "completed". Nothing looked wrong: the worker asked permission, Auto-Permissions allowed it 26 ms
later, and 121 of the 122 kill commands in the same logs are `Stop-Process -Name SysMonitor`, the project's
own app. **The shell refuses now** — a sweep, a family, an id the command looked up — in the `processes`
scope, with no card (`permissions.js` FAMILY_TEXT); a project's own app by name stays allowed, and so does
a plain `-Id <number>`. **The brief's sentence is the second layer**: stop a process you started by its id,
never by its name, because a name matches every process that carries it. `run-rules.test.mjs` holds the
sentence, and that it names no language, runtime or product.

**A self-restarting server makes this failure quiet.** The operator's server no longer answers to a
runtime's name and restarts when it dies, so the same kill costs seconds instead of eight minutes — and the
turn that lost its model looks like an ordinary retry. When a run stalls for no reason, read the provider
port's pid at the start of the turn first. Synapse's cleanup cannot reach it either, by design: `mayStop()`
in `src/cleanup.js` stops only runtimes that can serve a page (`node`, `python`, `pwsh`, `deno`, `bun`),
because cleanup exists for a worker's leftovers and a worker does not start the model server.

## A restart is not a pause

Measured 26 Oct: a worker was running t3 and waiting on a permission request when Synapse restarted. The
runner died before writing a result, the plan said `todo`, the runs file still had the `delegate` line, and
the Architect's last message was "t3 is queued and waiting to run" — so the operator waited on a worker
that did not exist. `recoverDelegations` only picks up requests **no turn ever read**; this one had been
read and started.

A boot is the one place that knows the truth: nothing is running, so a `delegate` with no matching `result`
was interrupted. On start each such record is closed with `outcome: "interrupted"`, the task goes back to
`todo`, the project is held, and the Architect is told "do not retry it on your own". Order matters: close
interrupted runs **before** the unread-delegation pass, or that pass mistakes one for a queued run. The
invariant: **a `delegate` record is always closed by a `result`.** `openDelegations()` in `src/plans.js` is
the single definition of "open", and it is tested.

**The result can be written and the wake still lost.** Measured 29 Oct: t2 finished at 17:01:30 and the
result was on disk, but the process restarted between `appendRun(result)` and the Architect's turn — the
plan said `todo`, no message followed, and the page sat on a clock that had stopped 36 minutes earlier.
Neither recovery catches that: the record is closed and the call was read. So a boot also looks for the
*other* orphan: a result newer than every message in its Architect's transcript, with no `wake` marker. It
re-sends "a run finished before Synapse restarted… read `runs.jsonl` and judge it" and writes
`{kind:"wake", callId, status:"done"}` so it is replayed once — only the newest three results of the open
round, only within two days. A successful ordinary wake writes the same marker, which is what makes the two
distinguishable (`recoverLostReports`). A stop with *no* run in flight still holds the project:
interrupting the Architect mid-turn is the same request.

## An attachment is a URI, not bytes — and the dump is older than the server

Measured 25 Oct on engine **2.1.2**, while adding a paperclip to the composer. The OpenAPI dump at
`%TEMP%\opencode\openapi.json` describes `Prompt.FileAttachment` as `{ data, mime, source: {type:'inline'}
}`. The server refuses exactly that:

```
400 Missing key at ["files"][0]["uri"]
```

What it takes is a **`uri`**, and a `data:` URI is accepted:

```
{ uri: "data:application/json;base64,eyJuYW1l...", name: "package.json" }   200
{ uri: "file:///F:/dev/Synapse/package.json", name: "package.json" }        200
{ uri: "F:/dev/Synapse/package.json" }   400 Unsupported attachment URI
```

A `file://` URI makes the **server** read the file, so the bytes must be on disk first — fine for a path
the operator typed, useless for a browser's file picker, which never reveals a path. A `data:` URI needs no
disk, so that is what Synapse sends. And the file stays on the message: the engine records its `data` on
the user message, so a big attachment is re-read on every later turn of that session. The composer caps one
file at 8 MB and one message at 48 MB (24 files is only a sanity cap), and the cap is about the window as
much as the network.

## Four automation switches, one of them on by default

"Keep running" and "Full auto" were two switches doing four jobs: one wanted the plan carried through, the
other answered *everything*, so a person who only wanted questions answered also had every permission
allowed. They are four now, each independent and per project:

| switch | what it does | starts |
|---|---|---|
| Keep Building | the Architect carries the plan to the end, or to a blocked task | **on** |
| Auto-Permissions | a permission card is allowed once after its wait | off |
| Auto-Answer | a question takes the Recommended option (or the top row) after its wait | off |
| Auto-Shutdown | the PC goes off when nothing is running and nothing can start | off |

**The switches are the session's, the waits are the config's.** Which four are on lives in
`synapse.automation` in the session metadata, so it travels with the chat and survives a restart; the waits
live in `config.automation` (`keepBuildingSec` 5, `permissionsSec` 10, `answerSec` 30, `shutdownMin` 5)
because patience is a property of the harness, not of a project. `src/automation.js` is the one reader, and
it carries a chat saved under the old names into the new shape: `synapse.auto` becomes Keep Building,
`synapse.fullAuto` becomes both answering switches, and it writes those two back as mirrors so an older
reader cannot disagree. **A new project is seeded at creation**, so the cog has real answers before
anything is toggled; a chat from before the four keeps what it had — Keep Building stays off there, because
`synapse.auto` was off unless the operator turned it on.

**Auto-Shutdown is the server's clock** (`src/auto-shutdown.js`), because a hidden window throttles its
timers and the operator who needs this is asleep with Synapse in the tray. Its condition is the whole
machine — no turn, no form, no pending permission anywhere, plus at least one project with the switch on —
then the idle minutes, then the 20-second countdown with Cancel. A cancel starts the whole wait again
rather than re-arming on the next sweep; a run that starts cancels it outright. **Synapse being quiet is
not the machine being idle (16 Nov)**: at 15:12 the app powered the PC off while the operator was working
in another app, because no Synapse turn had run for twenty minutes — true, and all the old tick checked.
The deadline now asks Windows for the last mouse or keyboard input (`GetLastInputInfo`, one PowerShell call
at the deadline only) and counts from that; if the answer cannot be had it does not power off, because not
knowing is not permission. **Only the operator's window can arm it**: the page marks its requests with
`x-synapse-ui` and the server refuses `autoShutdown: true` from anything else, so a test, a script or a
stray call can turn the switch off but never on. `scripts/checks.mjs` turns it off before a run and leaves
it off — a restore is an enable with a nicer name, and restoring it is what armed the 15:12 power-off.

**The form list is scoped by directory (3 Nov).** Auto-Answer never fired, with the old switch either: the
fault was the listing. `GET /api/form` is scoped by the `x-opencode-directory` header, and Synapse asked
from the **workspace root**, where the answer is always `[]` — so the sweep had nothing to answer, for
ever, and said nothing because "no forms" is also the normal state. Measured: the same sweep pointed at the
form's own directory answered immediately (`answered: 1`). The server now passes `formsEverywhere`
(`src/api.js`) to `createFormAuto`, which asks every known and every active session for its own forms and
de-duplicates by id. Anything else that lists engine objects by directory has to be checked the same way,
because an empty list looks exactly like a quiet machine.

## A plan row can own other rows

The Architect already reached for this: asked for a fix after `t2`, it wrote `t2a`. What was missing was
not the naming — **nobody put the row under its parent**: rows were drawn in file order, so an appended
`t2a` sat at the bottom after the finished work and read as an afterthought, which is the "the plan is out
of order and messy" the operator kept seeing. The fix is ordering, and it is one sentence: **a root keeps
its own place and its children follow it.**

- A **root** is an id no other id owns (`t2`). A **child** is a root's id followed by letters (`t2a`,
  `t2aa`). Letters only: `t2-1`, `t2_1` and `t21` are ordinary ids, because a rule that guesses is worse
  than one that does not. Where the Architect *wrote* the child does not matter: it is drawn directly under
  its root. One level of indentation only — a third level in a 300px rail is a table.
- An id named like a part whose whole is missing (`t2a` with no `t2`) is a **plan problem**, reported in
  the Architect's "Plan problems to fix" line, because the alternative is a row that quietly sits at the
  bottom.

**A part waits for its whole.** `t2a` needs no `dependsOn`: it is not ready while `t2` is not done. That is
what makes the naming worth something — the Architect describes the shape of the work instead of
maintaining a second dependency list — and it has to be in three places, or the card offers a part before
its whole: the rail's "Waiting on you" line, the blocked-card rule, and the server's "this step is ready
and was never asked for" reminder. All three call `taskReady()`. **Nothing is renumbered, ever, and the
file is never rewritten.** Ordering is a view: `t2a` is already a legal id everywhere it appears, so this
needed no migration. The rule lives in `web/plan-order.js`, imported by the page and by
`src/plans.js`/`src/runs.js`.

## A check the harness runs

A row can carry the proof itself, not only a sentence about it. `checks` is one to three short commands;
the harness runs them in the project when the worker says it is done.

- **Same policy as a shell call.** Each command goes through `decide()` before it runs. A check that would
  ask or is refused is reported as *not run*, with the reason — never silently passed, because a skipped
  check that reads as a pass is worse than no check.
- **One repair turn.** A failure sends the command, its exit code and the tail of its output back to the
  same worker. A second failure stops there: the report head says *finished, but its check fails*, the
  worker's own words follow, and the Architect judges. The harness never marks the row.
- **A check that cannot run is not a worker failure.** A missing cmdlet or executable (`... is not
  recognized ...`, `command not found`, exit 127/9009) is marked invalid: the report says *finished, but
  its check could not run* and tells the Architect to replace it. The worker is not nudged — it cannot
  install a command into the harness's shell, and asking it to try is what sent t2a into protected Windows
  folders on 17 Nov.
- **Why one, not a loop.** A check that fails twice is a task the worker cannot finish or a check that is
  wrong; retrying the same turn finds neither. QC still judges the work.
- **Bounded and local.** At most three commands, 300 characters and two minutes each. Output is capped;
  the full log goes to `.project/reports/checks/` and nothing is kept outside it.

`parseChecks` is tolerant of a missing field and names a malformed one in the plan problems; the format
line and one sentence in the Architect's brief tell a model the field exists. The worker is told the
commands in its task message, so a task without checks costs no extra context.

## The loop guard: three shapes, two watchers

A model that loops does one of three things:

- **the same call, again** — the same tool on the same target four times in a window of twelve. The target
  carries `offset:limit`, so paging a long document stays quiet.
- **the same answer, again** — the same read-only tool returning byte-identical output three times, whatever
  was asked. This is the shape the first rule misses: `offset 34, limit 11` and then `offset 35, limit 10`
  return the same paragraphs. The digest comes from the output already in the transcript, so it costs no
  engine call.
- **the same explanation, again** — an 18-word passage repeated in five distinct assistant turns inside a
  window of sixteen. The first two cannot see it: the model changes the probe every turn, so no target
  repeats while the same paragraph comes back (16 Nov: ninety turns re-explaining one hash check). Five, not
  three or four: a model may quote its acceptance sentence while it works, and a guard that cries wolf is
  worse than none.

Thresholds are high on purpose — four calls, three answers, twelve wide — because a strike is a nudge and a
false one spends a model's attention. Outputs shorter than 240 characters are never evidence, and writes are
never judged by their answer.

**Two watchers use the one rule** (`src/loop-detect.js`):

| watcher | covers | what a strike does |
|---|---|---|
| the runner's (`waitForIdle`) | a delegated worker | interrupt, one nudge, and the run's loop limit |
| `src/turn-guard.js` | the chat the *operator* drives | **steer** a nudge into the live turn — no interrupt, no wake — and tell the operator at the third |

The second exists because the switch governed nothing in Single mode: a run is waited on by the runner, and
a chat the operator drives is not, so the guard could be on and catch nothing. It starts when a message is
sent, polls only while the engine says that session is active, and stops the moment it is not, so it can
never nudge a turn that ended.

**Three false strikes, and what each taught.** Five reads of `archive.txt` at offsets 216, 454, 668, 905,
1100 were paging a long file — the Architect's watcher used the path rather than the path *and the slice*,
and now uses the runner's `toolTarget()`. Five writes of one `ANSWER.md` were write, check, fix, write
again: a file being rewritten is the work, so **mutating tools are no longer judged by their target at
all**, while a command that repeats with byte-identical output still is. And a model walking a long thread
took five `browser_scroll {dy: 400}` calls, each from a new position, so for the tools in `MOVING` the
signature carries the result as well as the arguments — a scroll that lands somewhere new is a new call, and
one that cannot move still strikes. The lesson that keeps recurring: a rule that fires on real work teaches
the operator to ignore the alarm, which is worse than no alarm.

**A mark survives the trace's birth (17 Nov).** `run.note` is the fast path, but a page opened mid-run has
only `/api/runs` to rebuild from, and a note can arrive before the trace exists. `adoptRunMarks()` copies
the runner's timestamped loop and compaction marks on every progress tick, idempotently; without it the
count survived and the line fell back to the pinned footer.

## A model's shell: its encoding, and where its output goes

**Python's streams are UTF-8, because its locale is not (15 Nov).** A worker printed a check mark and its
step died:

```
'charmap' codec can't encode character '\u2713' in position 4: character maps to <undefined>
```

Nothing in Synapse was decoding: Python had failed before its output reached us. When stdout is a **pipe** —
which is how the engine captures a command's output — Python takes its encoding from the locale, and on
Windows that is cp1252, where "✓" does not exist; the console code page does not help, because Python does
not consult it for a pipe. The engine is started with `PYTHONIOENCODING=utf-8` and every command a model runs
is a child of it. Only the streams are pinned: a script's own `open()` default is still the locale's, which
is the script's business.

**A backgrounded command's output belongs to the project (17 Nov).** The engine answers a long command with
"moved to the background" and a path under its own data folder — `data\engine\opencode\data\opencode\shell\…`
— which is closed to models, so the one handle a model is given is a file it may not open. A QC run waited
on a suite it could not read, ended its turn "waiting", and the run completed without `qc-8.md`. The output
is not a permission exception: it is the model's own work, so the harness **copies it into the project** at
`.project/logs/shell-<id>.out`, where the model may read it and the operator keeps it — the same rule as the
browser's screenshots. The runner mirrors it on every poll (`src/shell-mirror.js`), so the copy grows with
the command; the brief names the pattern in one line, and a chat turn is told the same by a steer from its
turn watcher. A read of the engine path is refused with the project path in the note, and the gate copies
the file at that moment. The copy is a snapshot: read it again after a pause. "Waiting" is not finishing.

## The harness core and the handover digest

The project brief was doing two jobs: teaching the harness and carrying the project. Split them.

- **Two roots are process environment**, set in `src/index.js`: `SYNAPSE_HARNESS` and
  `SYNAPSE_PROJECTS_ROOT`. The engine and the check processes inherit them, so a shell and the check that
  judges it see one answer. There is deliberately no `SYNAPSE_PROJECT`: one engine serves every project, and
  a global value would be the wrong project's. `$PWD` is the per-shell project root. `SYNAPSE_SCRATCH_ROOT`
  is gone with the shared scratch root (20 Nov).
- **`synapse.harness`** is a second instruction entry, ~400 characters, set beside `synapse.plan` for every
  session. It names the roots and the rule that a relative shell path is judged from the working directory,
  not from a script's own `Push-Location`; for an output folder use `"$PWD\bin"` or an absolute path. It
  cannot be skipped by not loading a skill and cannot be edited by a project. With the browser on it also
  names `synapse-browser_open` and the rest of that family, `synapse-search_websearch` and
  `synapse-search_webfetch`, because the engine prefixes a server's tools with its key and a model cannot
  infer a name it has never seen. One copy for every role: set once per session, not repeated in each
  role's brief.
- **The handover digest is deterministic.** `handoverDigest()` extracts Objective, Requirements and Decisions
  from the compaction handover; the full handover stays in `.project/project.md` with a pointer. No second
  model, no invented decisions, and an unstructured handover is left full rather than guessed at. Same
  input, same digest — which is why it is a function and not a prompt.
- **The bare-brief guard is not a project budget.** `tests/brief-layers` measures a brief with no skills and
  no project document. A real VPA brief was 10.2k for a coder and 21.7k for the Architect; after the digest
  it is 9.0k and 20.4k. Skills can be larger than the brief itself (three coder skills were 19k characters
  in the same turn).

## One turn at a time per local server

Two turns on one local server do not queue inside the server: each sends its whole prompt, so both are
re-read and a model swap can reload in between — "the model got slow" was often two turns on one server.
`src/local-lease.js` holds one lease per server, keyed by the provider's base URL (a localhost address is
local whatever its type says). A turn takes the lease before its prompt and releases it on the engine's own
`idle` in `src/index.js` — one release point, so the operator's send, a worker run and the Architect's wake
are all covered, including a turn that is stopped or fails.

An operator's message is refused at once, naming who holds the server, and the words stay in the composer: a
prompt that has not reached the engine is not a post in the chat, so parking it erased the post on the next
switch and read as work that finished (20 Nov). Runs and wakes wait in the queue until Stop cancels them; a
lease nobody releases lets go after six hours. Two different local servers, and every cloud model, never
wait.
