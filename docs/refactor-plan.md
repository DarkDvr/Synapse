# Refactor plan — the audit items that are left

The audit (`docs/audit-2026-11-06.md`) listed ten things. #2, #4, #9 and #10 are
done. This is the plan for the rest, one step at a time, each with the test that
proves it took. No push to GitHub until the operator says so.

The rule for every step: change it, run the suite, add or adjust the test that
would fail if the change had not taken, run it, commit. A bug the change caused is
fixed on the spot; a bug found on the way that is unrelated goes in
`docs/known-issues.md` and waits.

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

**Plan.** `src/wake.js` takes `waitForIdle`, the retry ladder for a wake, and the
loop itself. `runs.js` keeps `wake()` as a thin caller so its public surface does not
move. No behaviour change: same retries, same stop handling, same report.

**Test that proves it.** The existing wake tests must pass untouched (that is the
point of a pure move), plus one new assertion that `runs.js` no longer contains the
loop's internals — a structural check that the extraction happened.

**Risk.** Medium-high. A pure move is safe only if it is really pure; the stop
handling is subtle.

---

## Step 6 — `web/app.js` comes apart (#1)

**Now.** 10,546 lines in one module: transcript, composer, rail, cards, plan pane,
settings pages, update dialog, ask panel, desk badge, SSE handler, over one mutable
`state` with a hundred fields.

**Plan.** In this order, one commit each, each behind the UI tests:
1. `web/state.js` — the store and its accessors.
2. `web/events.js` — the SSE handler and the sync functions.
3. `web/settings.js` — the Settings pages.
4. `web/transcript.js` — the chat rendering.
5. `web/composer.js` — the dock, Stop, attachments.
6. `web/rail.js` — projects, cards, plan pane.

**Test that proves it.** After each step the suite is unchanged and green, and
`tests/ui-layout.test.mjs` + a screenshot of the page still match. The structural
check: `app.js` line count falls below the previous step's and nothing else changes.

**Risk.** High. Load order and event wiring are the two ways this breaks silently.
This is the step that must not be rushed, and it is the reason the plan is a list
rather than one commit.
