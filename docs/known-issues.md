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

## The corner cannot refresh a window until the engine restarts (6 Nov)

The stamping that caused this is fixed (7 Nov): `measureLocalWindows` and the per-run
`noteLoadedWindow` now apply a `/props` server's window only to the model it named, so
one load no longer overwrites every model in the provider. What is left is smaller and
is a property of the engine, not a bug in it: the catalog's `context` is fixed when the
engine starts, and there is no route to change one model's window mid-life. So the
card's "Nk/Mk ctx" corner still shows the number the engine was started with, and a
model whose context was corrected during a run shows the new number only after a
restart — which `noteLoadedWindow` already warns about in the log.

One consequence worth knowing: the four polystrata rows in the config still say
`126976` from the old stamping, and nothing can measure them while that server is
down. Each one corrects itself the first time it is loaded and a run starts on it,
because `noteLoadedWindow` writes the measured number back.

Where: `web/rate-view.js` (the corner reads the engine's catalog), `src/index.js`
(what the engine is told at boot).
Fix: either accept the restart as the boundary, or give the engine a route that
changes a model's window without one. Not worth either while a restart is a click.

## OC provider fixes — details to come (6 Nov)

The operator has a list of fixes for the OpenCode providers — the two engine rows
(`opencode` / OC Zen, `opencode-go` / OC Go) and what Synapse does with them. Held
here on purpose so the list is not lost between sessions; the detail arrives later.

Where: `web/provider-list.js` (`ENGINE_PROVIDERS`, `providerLabel`), `web/providers.js`
(the pane and the editor), `src/engines/opencode.js` (what is registered with the
engine) — depending on what the list turns out to be.
Fix: wait for the operator's notes. Do not guess at them.

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
