# Refactor plan — the audit items that are left

The audit (`docs/audit-2026-11-06.md`) listed ten things. #2, #4, #9 and #10 are
done. This is the plan for the rest, one step at a time, each with the test that
proves it took. No push to GitHub until the operator says so.

The rule for every step: change it, run the suite, add or adjust the test that
would fail if the change had not taken, run it, commit. A bug the change caused is
fixed on the spot; a bug found on the way that is unrelated goes in
`docs/known-issues.md` and waits.

## Where it stands

| Step | State |
|---|---|
| 1 — event names | **done** — `web/events.js`, and a scan that fails on a new literal |
| 2 — one error shape | **done** — `src/errors.js`, 25 of 37 sites; the test counts the rest |
| 3 — a catch that says nothing | **done** — baseline of 71, and it may only go down |
| 4 — sync reads on the request path | **done** — the plan is parsed once per change |
| 5 — the wake loop leaves `runs.js` | **half** — the report writer is out; the wake loop waits on `waitForIdle` moving first (measured, see below) |
| 6 — `web/app.js` comes apart | **stopped, deliberately** — 10,546 → 2,296 lines, 41 modules. What is left is the event stream (492), the wiring (831) and nine small blocks — see "Where I stopped" below |

---

## Step 1 — Event names are strings in six files (#6)

**Now.** `'session.step.started'`, `'session.retry.scheduled'`,
`'session.execution.interrupted'` and their friends are written out in `index.js`,
`runs.js`, `api.js`, `stop.js`, `web/app.js` and the tests. A typo is silent: the
handler simply never runs, and the only symptom is a feature that does nothing.

**Plan.** `src/events.js` exports one name per event Synapse compares, plus the
regexes built from them. The adapter keeps the raw strings — it is the only place
that should know what the engine emits. Consumers import the names.

**Test that proves it.** A new `tests/events.test.mjs`: every exported name is a
string starting with `session.` (or the few non-session ones), no two names are
equal, and — the important one — a scan of `src/` and `web/` finds no bare
`'session.*'` literal outside `src/engines/`. That last check is what makes a typo
impossible rather than merely unlikely.

**Risk.** Low. Mechanical, and the suite exercises most of the paths.

---

## Step 2 — One error shape (#8)

**Now.** Every route builds its own error: `const err = new Error(...); err.status =
409; err.body = {...}; throw err;`. It works and the client reads it, but the shape
is re-invented per handler and a new route has to remember all of it.

**Plan.** `src/errors.js` with `fail(status, message, extra)` and `refuseBusy(info)`
moved beside it. Convert `api.js` first (it has most of them), then the few in
`server.js`.

**Test that proves it.** A new `tests/errors.test.mjs` checks the helper produces
`{message, status, body, busy}` exactly as the handlers did; plus a scan of `api.js`
for `err.status =` outside the helper — the count must be zero.

**Risk.** Low, but wide: every refusal the operator sees comes through here.

---

## Step 3 — A catch that says nothing (#3)

**Now.** 179 `catch {}` in `src/`, with no way to tell a deliberate swallow from a
forgotten one. The Stop bug hid in exactly this: an interrupt failing during the
engine's retry wait threw nothing anyone could see.

**Plan.** Not a sweep. Two parts:
1. Every catch that wraps an **engine** call logs at `warn` once (the ones that
   matter: interrupt, getMessages, listActiveSessions, prompt, replyPermission).
2. A rule in `AGENTS.md`: a bare `catch` carries a comment naming why it is safe.
   A test enforces it for new code by keeping a baseline list of the ones that are
   already there — a new bare catch without a comment fails.

**Test that proves it.** `tests/catch-discipline.test.mjs`: scans `src/` for
`catch {` with no trailing comment on the same line, compares the set with the
baseline file, and fails on anything new. Plus the engine-path catches log, checked
by a unit test with a throwing engine.

**Risk.** Medium: touching error paths can turn a silent failure into a loud one in
a place that used to be quiet.

---

## Step 4 — Synchronous reads on the request path (#7)

**Now.** 89 sync fs calls in `src/`. Most are at boot or on a write, which is fine.
The one that matters is `readPlan` on the poll path: every `/api/plan` re-reads and
re-parses `.synapse/plan.json` from disk, on the same thread that serves the stream.

**Plan.** Cache the parsed plan by path + mtime + size, with a small
`invalidate(dir)` called by the writers (`setTaskStatus`, the plan editor). No async
conversion — the file is small; the point is to stop re-parsing it on every poll.

**Test that proves it.** `tests/plan-cache.test.mjs`: a plan read twice is parsed
once (counted with an injected reader), an mtime change is seen immediately, and a
write through `setTaskStatus` invalidates it.

**Risk.** Medium — a stale cache is worse than a slow read. The test has to prove
freshness after every write, not just the hit.

---

## Step 5 — The wake loop leaves `runs.js` (#5)

**Now.** `runs.js` is 3,895 lines carrying four jobs: the worker loop, the
Architect's wake loop, the report writer and the run ledger. The wake loop is the
part with the worst incident history (stopping it, holding the project, a report that
wakes it again) and the cleanest seam.

**Done first — the report writer.** `report()` turned out to be the only one of the
four with no runner state in it: a run's facts in, the sentence the Architect reads
out. It is `src/report.js` now (191 lines, `runs.js` down to 3,714) and the tests
that read its text (`run-rules`, `loop-run`, `provider-retry`, `run-stop`) pass
untouched.

**Measured for the second half.** The wake loop is 180 lines and needs twenty things
from the runner: `engine`, `log`, `out`, `notify`, `getConfig`, `workerSettings`,
`newWake`, `archWakes`, `waitForIdle`, `contextWindow`, `classifyFailure`,
`recordProviderError`, `backoffMs`, `sleep`, `turnErrorOf`, `markOf`, `desk`,
`screenCallOver`, `normDir`, and two constants. A factory with twenty arguments is
not obviously better than the function where it is — it trades file size for
coupling surface. The better move is to take `waitForIdle` out first (it is used by
both loops and owns the poll, the stall clock and the leases), then the wake loop
needs five things instead of twenty.

**Test that proves it.** The existing wake tests pass untouched (that is the point of
a pure move), plus one structural check that `runs.js` no longer contains the loop.

**Risk.** Medium-high until `waitForIdle` moves; low after.

---

## Step 6 — `web/app.js` comes apart (#1)

**Now.** 10,546 lines in one module: transcript, composer, rail, cards, plan pane,
settings pages, update dialog, ask panel, desk badge, SSE handler, over one mutable
`state` with a hundred fields.

**Plan.** In this order, one commit each, each behind the UI tests:
1. `web/state.js` — the store and its accessors.
2. `web/events.js` — the SSE handler and the sync functions.
3. `web/settings-*.js` — the Settings pages (form primitives, then panes; the
   Providers editor is the last piece).
4. `web/transcript.js` — the chat rendering.
5. `web/composer.js` — the dock, Stop, attachments.
6. `web/rail.js` — projects, cards, plan pane.

**Done so far.** `state.js` (the 160-line store, 78 keys at load), then `format.js`,
`api.js`, `dom.js`, `console.js`, `settings-data.js`, `events.js`, `settings-form.js`
(the four form primitives), `settings-panes.js` (the tab list and nine panes),
`ui-prefs.js` (the chat's text size and the language), `provider-list.js` (which
providers exist, their names and order), `providers.js` (the Providers pane and its
editor), `chat-notes.js` (the alarms, leases and kept errors that are drawn in a chat
but are not messages) and `rate-view.js` (the tokens-per-second and window corner of
a role card). app.js is 8,917 lines, down from 10,546. **The Settings block is now
entirely out.**

The Settings block is what proved the order matters: the panes could not leave until
their primitives had, and the four Prohibited handlers could not leave at all — they
edit the draft and re-render the window, which is the app's state machine, not a
pane's job. The Providers editor *could* leave, because the four app calls it needs
(`collectSettings`, `renderSettings`, `openDialog`, `toast`) are few enough to wire in
at boot — the same pattern the console and the panes already use.

A lesson for the next step: a test that reads `web/app.js` for text which moved is
not a test that broke, it is a test that lied about where the code lives. The four
UI test files now read the page's modules together, so a move cannot read as a
deletion.

**And a second lesson, paid for twice.** A script that moves code with multi-line
anchors silently does nothing on a CRLF file, and a missing `wiring` call or a
function left un-exported fails *quietly*: the pane still draws, the row still
clicks, nothing happens. Both were caught by clicking through the page afterwards,
not by the suite. Move it, run the suite, then **use it**.

### The transcript is four things, not one (measured 6 Nov)

The plan said "the transcript" as one step. It is not one block: the 1,147 lines
between `renderTranscript` and the scrolling section are four subsystems that happen
to be next to each other, and they are tangled through the rest of the file.

- **The non-message lines** — **done**, `web/chat-notes.js`.
- **The rates and the window** — **done**, `web/rate-view.js`.
- **The streaming panel and the follow** — **done**, `web/chat-scroll.js` (466 lines:
  the scroll helpers, the two-line follow rule, the reader's-place slack and the
  panel that slides). It went with the follow logic because they are one mechanism:
  `appendStream` arms the follow and reads the scroller, and `endStream` redraws.
- **The trace** — **done**, `web/traces.js` (294 lines: the live line, the folds, the
  leases, the steer pins, the session's own panel). It turned out to be a fifth thing
  the first measurement missed, and it needed exactly one wire.
- **What is drawn** — **done**, `web/transcript.js` (486 lines: `renderTranscript`,
  `renderMessage`, `renderTool`, `questionSummary`, `permissionTip`, `toggleTool`, the
  compact post and four chip helpers). Five wires, and the move was proved faithful
  the only way that counts: the chat renders **601,269 characters of HTML before and
  after**, with 32 messages, 96 tool cards, 74 reasoning folds and 16 answer panels.

All five are out. `app.js` is 7,756 lines from 10,546, and the two big blocks — the
Settings pages and the whole transcript — are no longer in it.

`web/run-view.js` was the unlock: the seven roles, which model each has and what that
model can do, which project and run are open, the turn merge and the form waiting on
the operator. It took the renderers' need from 24 names to 10 — and the same module let
`chat-notes`, `rate-view`, `chat-scroll` and `traces` stop being wired to app.js for
`dirKey`, `currentRun`, `roleLabel` and friends.

**The composer is out too** (7 Nov): `web/composer.js` (796 lines, four wires) and
`web/toast.js` (the page-wide one-liner the composer and app.js both need).

**Then the chat geometry and the question panel** (7 Nov): `web/chat-geometry.js` (178
lines — how tall the chat is, the 1359 breakpoint, and holding the reader's place while
the box changes) and `web/ask-panel.js` (510 lines, three wires).

**Then the plan pane and the rail** (7 Nov): `web/plan-pane.js` (242 lines, two wires),
with `ago` and `hhmmss` moved into `format.js` because three modules now need them; and
`web/projects.js` (227 lines, four wires) — the whole navigation, plus `findSession`
and the stall window. `app.js` is 5,944 lines, from 10,546.

**What is left, measured rather than guessed:**

| Block | Lines | What it needs from app.js |
|---|---|---|
| the model picker | 466 | **3** — `fillRoleModels`, `modelLabel`, `modelMeta`/`modelTitle`/`issuesTitle` |
| the live event stream | 492 | **38** — it is the spine |
| "live delegated work" | 653 | 5 — but it holds `handleRunEvent` and `syncRuns` |
| the project menu, compact, things that block a session | 299 / 416 / 344 | 8 / 8 / 6 |
| the Prohibited handlers | 605 | 11 |
| the wiring at the bottom | 800 | 62 — it is the app's assembly, it stays |

**The "searchable model picker" section is three subjects** (measured 7 Nov): the picker
itself (`setupModelPickers`, `openModelMenu`, `chooseModel`, `onModelKey`, the shared
`pickers` map), the **run menu** (`toggleRunMenu`, `positionRunMenu`, `togglePower`,
`setAutomationSwitch`, `renderKeep`), and **mode** (`renderMode`, `chatBody`,
`SINGLE_PERMISSIONS`, `sessionMode`, `answerWaitSec`). Three modules, not one — the
next move is to split it that way rather than to move 466 lines with one name on it.

**The event stream is not a module candidate.** It needs thirty-eight names from
app.js because it is the thing that *is* the wiring: every event it receives belongs
to some other part of the page, and its job is to hand it over. If it ever leaves, it
leaves last, and it leaves as a router that each part registers with — not as a
750-line file with a thirty-eight-name object at the top.

**The tool this refactor was missing** (`scripts/check-imports.mjs`, 7 Nov). Two moves
in a row shipped a missing import that the suite and `node --check` both passed: the
page loaded, the module parsed, and the first call threw a `ReferenceError` — leaving
a page that looked alive and was not. The script compares the names a module *calls*
against what the other modules export, strips comments and strings first, and skips
names a file wires at boot. Run it after every move; today it reports nothing across
all 33 modules.

It now checks the **other half** of the same mistake, because the rail move made it:
`projects.js` declared `isBusy` with `const` and never exported it, so `app.js` asked
for an export that did not exist and the browser refused the whole module graph with
"does not provide an export named isBusy". A name can be missing in two directions.
Proven by deleting one `export` and watching the check report it.

That second check first produced thirteen false positives, all from one bug in its own
comment/string stripper: a quote inside a template literal (`It's`) paired with the
next apostrophe hundreds of lines away and swallowed the code between, so real exports
were invisible. Templates are stripped first now and a quoted string may not cross a
newline. **A checker that lies is worse than no checker** — it was believed for ten
minutes.

**And a third pass, because most of this UI is template strings**: a call written inside
`${…}` was invisible, which is exactly how `versionTag` and `relTime` went missing with
the checker reporting "nothing missing". Reading inside `${…}` found **eight** modules
carrying a missing import that had not been hit yet — `renderMarkdown` (the changelog),
`hhmm`, `hiddenProviderIds`, `fmtBytes`, `dirKey`, `slugify`, `shortSpan`, `relTime`.
Every one was a page that dies the first time its path runs. All fixed, one line each.

### Where I stopped, and why (7 Nov)

`app.js` is **2,296 lines from 10,546** — 41 modules out, 78% gone. What is left:

| What | Lines | Why it stays |
|---|---|---|
| the live event stream | 492 | needs 38 names from app.js: it *is* the wiring. It goes last, as a router, or not at all |
| the wiring + `boot()` | 831 | the app's assembly — the one file that is allowed to know every module |
| messages | 196 | a small store with a poll; separable, but it would be the 42nd module for 196 lines |
| role cards (static markup) | 156 | the seven cards' HTML and the Architect's |
| view state | 83 | `setView`, `showNothing`, `openSession` |
| chime, shutdown, permission countdown, reject-with-reason, models/modes, settings-live, helpers | ~290 | each is one behaviour of 13–70 lines |

The remaining moves are all small, and each one costs a slice, a boundary check and a
live test. The ratio has flipped: the file is now the app's spine plus a handful of
small behaviours, which is a reasonable shape for it to be in. **Stopping here is a
decision, not an unfinished move** — if it is picked up again, the honest next step is
`messages.js`, then `view-state.js`, and after that there is nothing left worth a file.

**Test that proves it.** After each step the suite is unchanged and green, and
`tests/ui-layout.test.mjs` + a screenshot of the page still match. The structural
check: `app.js` line count falls below the previous step's and nothing else changes.

**Risk.** High. Load order and event wiring are the two ways this breaks silently.
This is the step that must not be rushed, and it is the reason the plan is a list
rather than one commit.
