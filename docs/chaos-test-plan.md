# Chaos test plan — stopping, continuing, switching models

Written 4 Nov 2026, to run **first thing tomorrow**. Nothing here is executed yet.

The target is not features. It is the workflow the harness is most fragile in:
a run being stopped in each of its phases, the Architect being told to carry on,
and models being changed under a live turn. The cases are ordered so the cheap,
high-value ones come first and the destructive ones (server restart) last.

---

## Rules for the tester

1. **One case at a time.** Reset between cases (see "Reset between cases"); a
   dirty start makes a failure ambiguous.
2. **Never edit the harness while a run is live.** Any dirty file in the repo
   raises `HARNESS CHANGED DURING A WORKER RUN` and the run is stopped. Test
   actions go through the API or the UI, never through an editor.
3. **Write down the time and the ids.** Every case records: wall clock, project,
   task, architect session id, worker session id(s), run outcome, and the tail of
   `logs/app.log`.
4. **One worker at a time is the invariant.** Two worker sessions active in the
   same minute is a failure even if everything else looks right. Evidence:
   `logs/session.log`, grouped by minute, distinct session ids.
5. **A Stop is not a fault.** No model mark, no attempt count, no wake, no
   "retry" synthetic, and the task goes back to `todo`.
6. Use free/local models only (polystrata, local, opencode-go free). Do not burn
   paid quota on a chaos run.
7. Keep the plan file in `data/`; it is ignored by git on purpose.

---

## Evidence kit

Run these from `F:\dev\Synapse` (PowerShell). Ids come from `GET /api/runs` and
`logs/app.log`.

```powershell
# What is running now (task, role, worker, architect, startedAt)
Invoke-RestMethod http://127.0.0.1:8700/api/runs | ConvertTo-Json -Depth 4

# The run journal of the project under test (last lines)
Get-Content 'F:\dev\Synapse.Projects\f4-modlist\.synapse\runs.jsonl' -Tail 10

# The app log, filtered to the case
Select-String -Path logs\app.log -Pattern 'run t11|stop|wake|looped|marked|retry|cut a retired' |
  Select-Object -Last 40 | ForEach-Object { $_.Line }

# Distinct sessions active per minute (the two-conversation check)
$now = (Get-Date).ToUniversalTime()
Get-Content logs\session.log -Tail 6000 | ForEach-Object {
  if ($_ -match '^(\S+) \[INFO \] event (session\.(?:step|execution)[^\s]*) (\S+)') {
    $t = [datetime]::Parse($matches[1], [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
    if ($t -ge $now.AddMinutes(-10)) { [pscustomobject]@{ min = $t.ToString('HH:mm'); sid = $matches[3] } }
  }
} | Group-Object min | ForEach-Object { "{0} {1}" -f $_.Name, (($_.Group.sid | Sort-Object -Unique) -join ',') }

# Model issue marks (loop / provider) for the models in play
$c = Get-Content data\model-cache.json -Raw | ConvertFrom-Json
$c.models.PSObject.Properties | Where-Object { $_.Value.issues } |
  ForEach-Object { "$($_.Name): $($_.Value.issues.kind -join ',')" }
```

Useful actions:

```powershell
$arch = 'ses_...'   # the project's Architect session (from the UI or /api/runs)
$proj = 'F:\dev\Synapse.Projects\f4-modlist'

# Gentle stop (first Stop): finish the step, then cut
Invoke-RestMethod -Method Post "http://127.0.0.1:8700/api/sessions/$arch/stop"

# Abrupt stop (second Stop): immediate interrupt
Invoke-RestMethod -Method Post "http://127.0.0.1:8700/api/sessions/$arch/interrupt"

# Tell the Architect to carry on (operator speech — this also clears the hold)
Invoke-RestMethod -Method Post "http://127.0.0.1:8700/api/sessions/$arch/messages" `
  -ContentType 'application/json' `
  -Body (@{ text = 'Continue from where you left off. The previous run was stopped; nothing is running now.' } | ConvertTo-Json)

# Change a role's model the way Settings does (server reconciles keys)
$cfg = Invoke-RestMethod http://127.0.0.1:8700/api/config
$cfg.roles.'coder-1'.ref = 'polystrata/qwen-agentworld-35b-a3b-q6-200k'
$cfg.roles.'coder-1'.variant = 'medium'
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:8700/api/config -ContentType 'application/json' `
  -Body ($cfg | ConvertTo-Json -Depth 30)
```

---

## A. Stop family (do these first)

### A1 — Gentle stop mid-turn
**Setup:** start a run (Architect delegates t11 on the plan). Wait until the
worker is editing or reading (30–60 s in).
**Steps:** one `POST /stop` on the Architect.
**Expect:**
- `graceful stop: t11 (coder-1) will finish its step`, then `run t11 (coder-1)
  stopped`, `stopped by the operator`.
- Outcome `stopped`, `stoppedBy: operator` in `runs.jsonl`; task back to `todo`.
- No `looped` mark, no attempt counted, **no synthetic to the Architect**, no
  new Architect turn.
- `GET /api/runs` empty within a few seconds.
**Fail signs:** a wake/report after the stop; the task left `doing`; a model
marked; a second turn starts.

### A2 — Abrupt stop
**Setup:** start a run; wait until it is mid-tool-call.
**Steps:** two Stops quickly (`/stop` then `/interrupt`, or the UI Stop twice).
**Expect:** `stop: N session(s) interrupted, run cancelled`, outcome `stopped`,
no retry, no wake, task `todo`, one worker session interrupted.
**Fail signs:** the worker continues after the interrupt; a retry is scheduled.

### A3 — Stop on the Architect's wake (the 1.24.5 bug)
**Setup:** let a run **complete**; as soon as the yellow report line appears and
the Architect starts processing it, press Stop (gentle, then abrupt if needed).
**Expect:** the Architect's turn is cut **and the wake loop dies with it** — no
`(retry)` synthetic, no new Architect turn. The card may show a provider-error
line for a moment, then clear.
**Fail signs:** a second synthetic `(retry)` after the stop; the Architect
starts again on its own; repeated wakes.
**Then:** send "Continue…" and confirm exactly one Architect turn follows.

### A4 — Stop, then continue
**Setup:** as A1.
**Steps:** stop; wait 10 s; send the continue message.
**Expect:** runs resume (hold cleared), **one** worker created, same task, plan
untouched, no duplicate delegation, no leftover old worker session. The run log
shows a new `delegate` with `attempt: 1` or 2 (not a jumped count).
**Fail signs:** two workers; the old worker session starts again; the Architect
says it is waiting while nothing runs.

### A5 — Double Stop race
**Steps:** press Stop twice within 2 s, then a third time after 5 s.
**Expect:** the second/third are no-ops or "nothing is running"; no errors pile
up; one result line only.
**Fail signs:** two result lines for one callId; an unhandled rejection in the log.

### A6 — Stop while a permission card waits
**Setup:** start a run that asks a shell permission (t11 does); leave the card
unanswered.
**Steps:** Stop (the UI says stopping now is immediate); then interrupt.
**Expect:** the run stops; the card is cleared/answered by the stop; no worker
turn after it.
**Fail signs:** the card stays pending forever; the worker resumes on a stale
answer.

---

## B. Model switching

### B1 — Switch coder-1 mid-turn
**Setup:** run active, worker mid-edit.
**Steps:** change `roles.coder-1.ref` to a different free/local model.
**Expect:** the current turn finishes on the old model; the **next** prompt uses
the new one; no duplicate worker; no new run; no crash. The new model's **loop
marks are cleared** (`model loops cleared for coder-1: …` in the log) and the
task's attempt count restarts (`modelChangedSinceAttempt`).
**Fail signs:** the run restarts from scratch; two workers; the picker shows
ISSUES on the newly chosen model; the attempt count keeps climbing.

### B2 — Switch during a provider backoff
**Setup:** get a run into a retry/backoff (a rate-limited or capped model, or
stop the local server briefly). The card shows "Retrying at HH:MM".
**Steps:** change the role's model.
**Expect:** `model change for coder-1: waking 1 run(s) to continue on <ref>`; the
backoff is cut short; the session continues on the new model; one worker only.
**Fail signs:** the old backoff still fires; a second session is created; the
wake switches the wrong session.

### B3 — Switch the Architect mid-turn
**Setup:** Architect processing a report (wake turn live).
**Steps:** change `roles.architect.ref`.
**Expect:** the wake's backoff is cut (`the Architect woke early: its model was
changed`), the same turn continues on the new model, no second Architect turn.
**Fail signs:** two Architect turns; a retry line that never clears.

### B4 — Rapid switching
**Steps:** change coder-1's model 4 times in 20 s (A→B→A→B), then let the run
continue.
**Expect:** config stable at the last value; one worker; no queue of wakes; no
crash; the run finishes or is stoppable normally.
**Fail signs:** multiple sessions created; run restarting each time; config
reverting.

### B5 — Switch + stop + continue
**Steps:** stop a run, immediately switch coder-1's model, then send "Continue…".
**Expect:** a **fresh** run on the new model, attempt 1, no stale loops, no old
session. The Architect delegates once.
**Fail signs:** the task refuses ("attempted 3 times"); the old model is used; a
zombie session from the stopped run.

### B6 — Switch to a model with an ISSUES mark
**Setup:** mark a model (run a real loop, or use a model already marked).
**Steps:** point coder-1 at it.
**Expect:** its **loop** marks clear on selection (`model loops cleared for
coder-1`); provider marks (bad key/deprecated) stay. The picker shows no ISSUES
for the loop mark.
**Fail signs:** ISSUES appears immediately on selection.

---

## C. Workflow chaos

### C1 — Duplicate delegation flood
**Steps:** while a run is live, make the Architect ask for the same task again
(three delegate calls in one turn, or three messages in a row).
**Expect:** the extra asks are **deferred** (`delegate … deferred` in the
journal), one worker only; the Architect is told when the run is done.
**Fail signs:** two runs; two workers; the task status flapping.

### C2 — Re-delegate the same task right after completion (the 4 Nov zombie)
**Setup:** a run completes; the Architect judges it and delegates the same task
again within a minute.
**Expect:** the old worker session is **retired and cut**; if the engine
delivers a queued note to it, `cut a retired worker session that started again`
appears once and the session stays quiet. **One** active session at a time; no
100K/45K alternation in the provider log.
**Fail signs:** the old session emits step events after its run ended; two
sessions in the same minute; two conversations alternating every turn.

### C3 — Steer during a run
**Steps:** send a steer message mid-run ("also check X").
**Expect:** the steer joins at the step boundary, one worker, no extra turn.
**Fail signs:** the steer starts a second turn after the run; the message is lost.

### C4 — Keep Building toggle mid-run
**Steps:** turn Keep Building off while a run is live; let it finish; turn it on.
**Expect:** the Architect stops after judging the task (off) and resumes on the
next task only after the switch is on. No delegation while off.
**Fail signs:** the next task starts anyway; the toggle is ignored.

### C5 — Server restart mid-run (last; destructive)
**Steps:** restart Synapse (tray or `POST /api/restart`) while a worker runs.
**Expect:** boot logs `closed 1 run interrupted by a restart`; the task is back
to `todo`; the Architect is told it was interrupted and must not retry on its
own; **no** worker session survives; the plan is untouched.
**Fail signs:** the task stuck `doing`; a phantom run in `/api/runs`; a worker
session still executing after boot; a second result line for the old callId.

### C6 — Two views
**Setup:** open the UI on the LAN address as a second client.
**Steps:** stop from one view while the other has a permission card open; answer
a question from the second view.
**Expect:** both views agree; one decision per card; no double-answer errors.
**Fail signs:** a card answered twice; the second view stuck busy.

### C7 — Permission refusal during a run
**Steps:** refuse a tool card with a reason while the worker is mid-task.
**Expect:** the worker gets the refusal note, continues (or reports), **one**
turn; the note does not start a second conversation after the run.
**Fail signs:** a new turn after the run; the note re-delivered forever.

---

## Global pass/fail criteria (check after every case)

- `GET /api/runs` has **at most one** run for the project; after a stop, zero.
- `logs/session.log`: **one** session id per minute while a run is live; the
  Architect and a worker may share a minute only at a handoff, never for long
  stretches.
- A stopped run: `outcome: stopped`, `stoppedBy: operator`, no attempt, no mark,
  no wake, task `todo`.
- No `(retry)` synthetic after a stop on the Architect.
- Model change: loop marks cleared on the new model; attempt count resets for
  that role's task; one worker.
- A completed run's worker session is quiet afterwards; a re-delegation starts a
  new session only.
- The plan file is written by the Architect only; a worker never changes it.
- No `HARNESS CHANGED DURING A WORKER RUN` caused by the test itself.

---

## Results table (fill in during the run)

| Case | Time | Task | Worker(s) | Outcome | Verdict | Evidence |
|---|---|---|---|---|---|---|
| A1 gentle stop | 18:06 | t1 | 1 (coder-1) | stopped/operator | pass | result line `stopped`, task `todo`, no wake, no retry |
| A2 abrupt stop | 18:35 | t4 | 1 (coder-2) | stopped/operator | pass, same run as A5 | the interrupt mid-shell-call: `stop: 2 session(s) interrupted, run cancelled`, task `todo`, no retry, no wake |
| A3 stop on wake | 18:24 / 18:30 | t2, t3 | 1 each (coder-2) | completed, then Architect turn cut | pass after 1.26.4 | first pass exposed a bug: the plan reminder woke the Architect 2 s after the Stop (see below). After `runs.hold()` in the gentle Stop: no retry, no new turn, one idle, `Continue` produced exactly one turn |
| A4 stop → continue | 18:56 | t13 | 1 at a time | stopped, then completed | pass, same run as B5 | after the stop and the message: a fresh delegation with `attempt: 1`, no duplicate worker, the old session stayed quiet |
| A5 double stop | 18:35 | t4 | 1 (coder-2) | stopped/operator | pass | stop → 200 (worker), interrupt 1 s later → 200 `stoppedRun`, third stop 5 s later → 409 "Nothing is running now."; one result line, task `todo`, no synthetic after |
| A6 stop with card | 18:39 | t6 | 1 (coder-2) | stopped/operator | pass, with a note | the card waited (an outside write); Stop → 200 `target: worker` because a live run short-circuits `busyInfo`, so the "waiting" 409 never fires while a run is live; interrupt cleared the card (`cards now: 0`), no worker turn after |
| B1 switch mid-turn | 18:43 | t8 | 1 (coder-1) | completed | pass | coder-1 → deepseek 25 s in, during a 60 s sleep; the run finished on Tiel (71 s), one worker, no restart; the next delegation (t9) logged `model=opencode-go/deepseek-v4.1-flash` |
| B2 switch in backoff | 18:48 | t10 | 1 (coder-1) | completed, 1 retry | pass | `local/qwen3.8-27b-ud` refused the connection (`ECONNREFUSED`, after 84 s); the switch logged "switched … mid-run" and "woke early: the role's model changed"; the same worker session finished on the new model |
| B3 switch Architect | 18:50 | t11 | 1 (coder-2) | completed | pass | the UI's path (config + `POST /sessions/{id}/model`) during the wake turn: the turn finished on its own, one idle, no retry, no second turn; the chat's model is the new one |
| B4 rapid switch | 18:53 | t12 | 1 (coder-1) | completed | pass | four switches in 20 s (A→B→A→C), all 200; config ended on the last value; one worker, retries 0, no crash |
| B5 switch+stop+continue | 18:56 | t13 | 2 sessions, 1 at a time | stopped, then completed | pass | interrupt, switch to Tiel, `Continue`: a fresh delegation with `attempt: 1` on the new model, no "attempted 3 times" refusal, the stopped session stayed quiet |
| B6 switch to marked model | — | — | — | — | not run | `worker.loopGuard` is off in this config, so no loop mark can be produced; the clearing itself is unit-covered (`tests/model-cache.test.mjs`: loop marks cleared, provider marks kept) |
| C1 duplicate delegates | 19:06 | t15 | 1 (coder-2) | completed | pass after 1.26.5 | three asks in one turn: one worker, one wake, and the report says "also received a delegation for t15 2 times and deferred it". Before the fix each deferred ask bought an Architect turn ("I'll hold") |
| C2 re-delegate zombie | | t1 | 2 (old retired) | completed | pass | old worker session idle after its run, new session for the re-delegation, no step events from the old one |
| C3 steer | 19:08 | t16 | 1 (coder-2) | completed | pass | the steer went to the worker mid-run (`target: worker`), the file has both words, the report quotes it, one turn |
| C4 Keep Building toggle | 19:21 | t21, t22 | 1 at a time | completed | pass, with a note | off mid-run: t21 was judged, t22 stayed `todo`, nothing started. Turned back on, nothing started either — the switch is carried by the next brief, not a wake — and `Continue` then delegated t20 and t22 in turn |
| C5 restart mid-run | 19:19 | t20 | 1 (coder-2) | interrupted | pass | `closed 1 run interrupted by a restart`; the task back to `todo`; the Architect told "do not retry it on your own"; only the Architect session left active; the plan untouched |
| C6 two views | 19:12 | t18 | 1 (coder-2) | completed | pass | two SSE clients (loopback + LAN with the remote cookie), both told of the decision; the card answered twice: `already:false` then `already:true`, both 200, no error |
| C7 refusal | 19:11 | t17 | 1 (coder-2) | completed | pass | the card was refused with a reason; the worker got "The operator declined this exact request. They said: …", stopped as instructed and reported; one wake, one turn |
| D1 lease | 18:06 | t1 | 1 (coder-1) | completed | pass | granted → expired → extended → completed; 0 retries, 0 resumes |
| D2 step cap | 18:2x | t1 | 1 | stopped/limit | pass, with a caveat | the cap is checked per step: with `maxTurns=1` the run ended only when the 180 s tool returned, not on the wall clock |

### A3's bug, 5 Nov (fixed in 1.26.4)

Stop at the report line cut the Architect's turn and killed the report loop as
designed — and **two seconds later a new turn began anyway**, sent by the plan
reminder ("t2 is ready and was not asked for"), which then marked the task done.
`remindSkippedWork` guards on `stoppedByOperator`; `interrupt()` set it, the
gentle `stop()` did not. The fix is `runs.hold()` in the gentle path, and
`tests/stop-hold.test.mjs` keeps both Stops holding.

### C1's bug, 5 Nov (fixed in 1.26.5)

Three delegate calls in one turn: the first started the run, the other two were
deferred and **each deferred ask woke the Architect** — two extra turns while the
worker was still working, both of them saying "I'll hold". The deferral is still
journalled (so a boot cannot replay it), but it no longer wakes anyone: the run's
own report says "also received a delegation for t15 2 times and deferred it".
`tests/provider-retry.test.mjs` case 9 holds it.

### Small observations (not fixed, not worth a version)

- A `POST /api/sessions/{id}/permission` with a missing `requestId` answers
  **500**, not 400: the engine's 400 ("Expected a string starting with \"per\"")
  is passed through as a server error. The UI never sends one.
- A provider that *hangs* rather than refuses (a dead port behind a firewall)
  keeps the worker's turn open until the stall clock: the ECONNREFUSED for
  `local/qwen3.8-27b-ud` took 84 s to surface. The lease covers the long-command
  case; a hung connection is the same shape of silence.



---

## Reset between cases

1. Stop anything running (gentle, then interrupt if needed); confirm `/api/runs` empty.
2. Confirm the task is `todo` in the plan and the project's `runs.jsonl` has one
   result line for the case (no duplicates).
3. If a model was marked during the case, note it; clear only if the case was
   about marks (`POST /api/models/issues/clear {ref}`).
4. Confirm `git status` in the harness is clean (the plan file is in `data/`,
   which is ignored).
5. Note the next case's start time in the results table.

## Order and budget

A1–A4 (~40 min), B1–B3 (~40 min), A5–A6 + B4–B6 (~40 min), C1–C4 (~30 min),
C7 (~10 min), C6 (~10 min), C5 last (~10 min + restart). Total ~3 hours,
including resets. If a case fails, stop and record it before moving on — a
failure is the point of the exercise.

---

## C8 — A long, silent tool (the 1-hour download case)

**Why this is on the list:** a download that takes an hour is normal work, but it
produces no transcript change while it runs. `waitForIdle` measures "nothing
changed" by polling the transcript, so a quiet tool looks exactly like a lost
session. `worker.stallSec` is 900 s in this config (default 600, max 7200), so
the runner will interrupt the turn — and the engine kills the tool process —
after 15 minutes. That is a false stall on legitimate work.

**Setup:** a scratch script that sleeps 20 minutes without output:
`pwsh -NoProfile -Command "Start-Sleep -Seconds 1200; 'done'"`.

**Steps:** have a worker run it as a shell call (or run it directly and watch
`waitForIdle`).

**Expect (current behaviour, likely):** at ~15 minutes the card says nothing has
happened, the turn is interrupted, the script's process dies, and the worker is
resumed with "continue". The download would restart from zero.

**Desired behaviour:** a running tool is *activity*, not silence. The stall clock
pauses while a tool part has `status: running`; a separate hard cap
(`worker.toolMaxSec`, e.g. 7200, max 86400) ends a tool that is genuinely hung.
The card says "running a long command" rather than "nothing happened".

**Also verify:** whether the engine itself imposes a shell timeout — run
`Start-Sleep -Seconds 1200` and see whether the tool returns at 20 min or is cut
earlier. If the engine cuts it, the harness cap is not the only limit.

**Workaround until fixed:** long downloads should be started detached
(`Start-Process`) and polled with short calls, so the turn never sits on one
silent tool. Keep PC Awake should be on for the duration (Settings → Automation).


---

## D1 — The lease, at a test-sized scale

**Setup:** a worker brief that says: "Call lease for 0.1 minutes (six seconds),
then run `Start-Sleep -Seconds 20`." The shell call is longer than the lease.

**Expect:**
- one violet chat line: "Coder 1 asked for a 00:00:06 lease · … left · reason";
- the clock counts down in place, once a second;
- at six seconds the line turns amber: "Lease ended — asking whether it needs more";
- the worker is interrupted with the lease question, not killed;
- the worker calls lease again (one extension) or answers with text: the line
  returns to a countdown marked "(extended)";
- after the extension, silence is a stall again: the normal interrupt/resume.

**Fail signs:** the stall fires during the lease; the chat line does not tick; the
extension is granted twice; the worker is killed at expiry without being asked.

**Second pass:** 0.1 minutes with the worker silent after the first lease — it must
be asked once, then stall at grace end.

## D2 — The step cap, at a test-sized scale

**Setup:** `worker.maxTurns = 5` in Settings → Workers; give a worker a task that
needs more than five steps.

**Expect:** the run stops at step 6 with outcome `stopped`, `stoppedBy: limit`, the
report "too big for one delegation — split it", no attempt counted, no model mark.

