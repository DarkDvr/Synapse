# Known issues

Bugs found while doing something else. Each one says where it is, how it shows, and
what it would take. They are not fixed on the way past: a bug fixed inside an
unrelated change has two causes and one commit.

Newest first. When one is fixed, delete it here and say so in the commit.

---

## A run's snapshot commits whatever is uncommitted in the Synapse repo — 7 Nov

Starting a delegation writes a `snapshot: before t1 (coder-1)` commit, and it takes
the harness repository's whole working tree with it. During the smoke test that
swept up half-finished edits to `web/` and `src/` into three commits with a message
nobody wrote. The work was safe, but it landed under the wrong name: `git log` said
"snapshot: before t1 (coder-1)" for a fix to the permission policy.

Shows: `git status` clean in the middle of an editing session, and two or three
commits with the same generated message.

Where: the harness snapshot in `src/runs.js` (`harness snapshot committed …`).
Fix: decide what the snapshot is *for*. If it is the project's state, it must run in
the project's directory and skip a project that is not a repository. If it is the
harness's, it must refuse to commit a dirty tree and say so — taking someone else's
in-progress work under a generated message is worse than not snapshotting.

## `/api/busy` with no session says the engine is down — 7 Nov

`GET /api/busy` without `?session=` asks the engine for `GET /api/session/null`,
gets a 400, and answers
`{"busy":false,"engineDown":true,"reason":"GET /api/session/null -> 400 …"}`. The
page never calls it that way — it passes `state.sessionId` and skips the call when
there is none — so nothing shows this today. Anything else that asks (a stale tab, a
script, a future caller) is told the engine is down while it is answering every
other route.

Where: `busyFor()` in `src/api.js`; the `catch` around `engine.getSession()` reads
any failure as "not answering".
Fix: return `{ busy: false }` when there is no session id, before the engine is
asked. Then a failure there can only mean the engine is really unwell.

---

## The suite fails intermittently on its two browser tests — 7 Nov

`node --test "tests/*.test.mjs"` runs test *files* in parallel. Two of them launch
Edge through `skills/visual-review/bin/shot.mjs` and take 15–31 seconds each:
`tests/baseline-layer.test.mjs` (the cascade-layer behaviour) and
`tests/visual-review.test.mjs` (`--diff`). Run together with everything else they
fail — measured 7 Nov: `baseline-layer` failed twice in one evening (once at 15.4 s,
once at 5.3 s with empty stdout, which is Edge never starting) and passed every time
it was run alone, and `--diff` timed out at 21 s once and passed alone at 31 s.

Shows: a red suite that is not red, which is worse than a slow one — it trains you to
ignore the failure. The 5.3 s failure is the tell: not a slow assertion, a browser
that never launched.

Where: `tests/baseline-layer.test.mjs`, `tests/visual-review.test.mjs`, and whatever
serialisation `skills/visual-review/bin/shot.mjs` does not do.
Fix: one lock file around the browser launch so only one Edge runs at a time (the
script already writes a throwaway profile; a `.lock` in the temp dir, waited on, is
enough), or run those two files with `--test-concurrency=1` from a wrapper. Measure
after: the full suite should be green five times in a row.

## The screen badge may stay on screen after the desk is released — 7 Nov

Seen once, while checking the page after a refactor move: the desk badge read "Screen
in use — A worker may use your mouse and keyboard. Take Back" on a page that had just
loaded, while `/api/desk` answered `{"desk":null}` a few minutes later. No run had
started or finished in between, so either the badge was drawn from a state that was
already stale, or something set it that does not clear it.

Not reproduced: the page has been loaded a dozen times since and the badge was hidden
each time. So this is a "watch for it" entry, not a diagnosis.

Where: `web/desk.js` (`renderDesk`), whatever sets `state.desk` (boot's `/api/desk`
read and the `desk.*` events), and `src/desk.js` on the server.
Fix: when it happens again, read `/api/desk` at the same moment and compare. If the
server says null the page is the bug (a missing clear); if the server says held, the
server is (a lease that was never released).

## The boot-error trap records but does not surface — 7 Nov

`web/index.html` keeps the first page errors in `window.__errs`, and that is how every
dead page in this refactor was found. But nothing *shows* them: the operator sees a
rail with no chat and no message, exactly as before. The trap is for a `--eval` to
read, not for the person in front of the screen.

Where: `web/index.html` (the two-line trap), `web/app.js` (`boot()`).
Fix: the last line of `boot()` checks `window.__errs` and, if it is not empty, says so
— a toast or a line in the chat, with the first message. Worth doing at the same time:
`connectStream()` first, so a half-dead page at least has its identity.

## A local name shadows an imported function (`askHost`) — 7 Nov

In `web/app.js`'s wiring there is `const askHost = $('askHost');` inside a function,
while the module also imports `askHost` (the accessor the ask panel uses, from
`web/ask-panel.js`). Legal JavaScript, and harmless today because nothing in that
function calls `askHost()` — but it is a trap: a later line in that scope that means
the accessor gets the DOM element instead, and the failure would be "cannot read
properties of undefined" a long way from the cause.

Where: `web/app.js`, the wiring function that binds the ask panel's input events.
Fix: rename the local (`askHostBox`), one line, no behaviour change. Filed rather than
fixed because it sits inside the file the refactor is still taking apart.

## The chat page's layout audit reports five standing nits — 7 Nov

`skills/visual-review` with `--audit` reports the same five findings on the chat page
every time it is run, and they are real but small: the Send button is 39px tall
against the run button's 36 (tops 1.5px apart), and four baselines sit apart on one
line (two `code` runs 19.8px apart, `tool-name` against `tool-chev` 0.9px, two `em`
41.8px, two `strong` 20.9px).

Shows: a composer row that is a hair out of line, and inline code or emphasis that
does not sit on the text's baseline. Nobody has reported them; the tool sees them.

Where: `web/synapse.css` — the composer's button row and the inline-code/emphasis
rules in the transcript.
Fix: measure the row and set one height for both buttons; give inline `code` a
`vertical-align` that matches its line box. Do it as its own change with a screenshot
before and after, not inside a refactor.

## The window does not refresh when the model is switched (6 Nov)

Switching a role's model from one local model to another — 126k to 200k — leaves the
old window in place: the card's "Nk/Mk ctx" corner and the point where the watchdog
compacts keep the first model's number until Synapse restarts.

**Found the cause while filing this, in the config itself.** All four polystrata
models carry the same window — `126976` — including the two whose names say 200k:

```
qwen3.8-flash-next-IQ2_XS-GSQ-126k   ctx=126976
qwen3.8-flash-next-IQ2_XS-GSQ-200k   ctx=126976
tiel-coder-35b-a3b-Q5_K_XL-131k      ctx=126976
tiel-coder-35b-a3b-Q5_K_XL-200k      ctx=126976
```

The mechanism is the `*` fallback in `probeLoadedWindows`/`measureLocalWindows`
(`src/providers.js`). A llama.cpp-family server answers `/props` for the **one** model
it has loaded, and that window is recorded under `*` as well as under its own id "so a
model whose id differs from the alias still gets the right number". `measureLocalWindows`
then writes `windows.get(id) || windows.get('*')` into **every** model of that provider,
so whichever model happened to be loaded stamps its window onto all of them. Load the
126k model once, and the 200k one is now 126k forever.

Shows, live: the Architect's corner read `150K/127K ctx` after the switch — a prompt
larger than the "limit" — and a run budgets and compacts for 126k on a 200k model.

Where: `src/providers.js` (`measureLocalWindows`, `probeLoadedWindows`),
`src/runs.js` (`contextWindow`, `noteLoadedWindow`), `web/rate-view.js` (the corner).
Fix: apply the `*` window only to the model the server says it has loaded (its
`model_alias`), never to ids that differ; and re-measure the selected model when the
model changes rather than only at boot. The `*` entry is the bug, not the symptom.

## OC provider fixes — details to come (6 Nov)

The operator has a list of fixes for the OpenCode providers — the two engine rows
(`opencode` / OC Zen, `opencode-go` / OC Go) and what Synapse does with them. Held
here on purpose so the list is not lost between sessions; the detail arrives later.

Where: `web/provider-list.js` (`ENGINE_PROVIDERS`, `providerLabel`), `web/providers.js`
(the pane and the editor), `src/engines/opencode.js` (what is registered with the
engine) — depending on what the list turns out to be.
Fix: wait for the operator's notes. Do not guess at them.

## A boot error leaves a page that looks alive and is not

`boot()` in `web/app.js` is one long `await` chain: `wire()` binds the handlers, then
a dozen loads run in order, then `connectStream()` — which is what gives the page its
identity and its live feed — is the *last* line. One rejection anywhere in the middle
(the 6 Nov pane split put a `ReferenceError` there for ten minutes) and everything
before it stays: the project rail draws, the chat size is applied, the page looks
finished. What is missing is silent — no console message the operator would see, no
toast, and the Settings button answers "this view is not connected" because the page
never got a client id.

Where: `web/app.js`, `boot()`.
Fix: `connectStream()` first, and a `window.onerror` / `unhandledrejection` trap that
puts a line in the chat or a toast. Found by accident; it will be found again.

## The page knows two engine provider ids by name

`ENGINE_PROVIDERS` in `web/app.js` hardcodes `opencode` and `opencode-go`, with the
badge and the note each one shows ("OC Zen", "OC Go"). That is engine-specific
knowledge in the page, and the pillar says the OpenCode adapter is the only place
that should have it: a second engine, or a renamed provider, leaves the page
labelling the wrong thing — or nothing.

Where: `web/app.js`, `ENGINE_PROVIDERS` and `providerLabel`.
Fix: the server knows its providers (`/api/providers`), so the label and the note
could come from there. Not urgent while there is one engine. (6 Nov: the two rows can
now be removed and restored, which makes the page own a little more of that knowledge
— it is also the list of ids `hiddenProviders` accepts — so this got slightly worse,
not better.)

## A stopped run can still be reported as completed if the cut lands before its first token

Seen 6 Nov while testing Stop: a run cut at the very first step of a worker that had
not produced a token yet ends with `outcome: stopped`, but the report's body is the
generic "ended with reasoning only" sentence, which reads like a failure. It is not
wrong, it is just confusing next to "stopped by the operator".

Where: `src/runs.js`, the `if (!stopReason && !text && !files.length)` branch.
Fix: when `gracefulStop` is set, say the turn was cut before it produced anything.

## The engine home never shrinks below its snapshots

`data/engine/opencode` is 574 MB after three weeks. `src/housekeeping.js` reclaims
snapshots at boot, but only the ones it knows about; the engine keeps its own
storage. Worth a look at what the 574 MB actually is before deleting anything.

Where: `src/housekeeping.js`, `data/engine/opencode`.
Fix: measure first — a listing by subfolder, then a retention rule.

## The Updates page still calls the engine "Runtime" in one place

The page says "Runtime" everywhere, but the engine update dialog's title says
"Engine update". Two names for one thing in the same panel.

Where: `web/app.js`, the update card.
Fix: one word, decided by the operator.

## `data/chaos-test-plan.md` is the only copy of a record

It is the pass record of the chaos run, it is 23 KB of good evidence, and it lives
in `data/`, which is gitignored and regenerable by definition. A clean install loses
it.

Where: `data/chaos-test-plan.md`.
Fix: move it to `docs/` (it is a record, like the release notes) or delete it and
accept the loss.
