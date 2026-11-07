# Known issues

Bugs found while doing something else. Each one says where it is, how it shows, and
what it would take. They are not fixed on the way past: a bug fixed inside an
unrelated change has two causes and one commit.

Newest first. When one is fixed, delete it here and say so in the commit.

---

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

## A window reloaded mid-session shows only after a restart (6 Nov, narrowed 7 Nov)

The two causes are fixed. `measureLocalWindows` and `noteLoadedWindow` no longer apply
a `/props` server's window to every model in the provider, and the probe now asks the
server's own list — which carries `meta.n_ctx` per model — before `/props`, which only
ever knows the one model it has loaded. The operator's four PolyStrata rows measured
126976 / 204800 / 131072 / 204800 from the server itself, and the picker and the
card's corner read them correctly.

What is left is a property of the engine, not a bug in it: the catalog's `context` is
fixed when the engine starts and there is no route to change one model's window
mid-life. So if a model is *reloaded in its own app* with a different context while
Synapse runs, the next run measures it and writes the config, but the page keeps
showing the number the engine was started with until a restart — which
`noteLoadedWindow` warns about in the log.

Where: `web/rate-view.js` (the corner reads the engine's catalog), `src/index.js`
(what the engine is told at boot).
Fix: accept the restart as the boundary, or give the engine a route that changes a
model's window without one. Not worth either while a restart is a click.

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

## The engine home is mostly one database nobody prunes (6 Nov, measured 7 Nov)

The entry said 574 MB and blamed snapshots. Measured: **575 MB, and 430 MB of it is
`data/engine/opencode/data/opencode/opencode.db`** — the engine's own store of every
session and message it has ever kept. The rest is 62 MB of snapshots, 48 MB of logs,
22 MB of temp and 3 MB of config. `src/housekeeping.js` already reclaims the
snapshots it knows about; the database is not Synapse's to rewrite.

Shows: a `data/` folder that grows with every conversation and never comes down.

Where: `data/engine/opencode/data/opencode/opencode.db`, `src/housekeeping.js`.
Fix: two honest options, and it is the operator's data, so the decision is theirs —
(a) leave it to the engine, which owns the file and its schema; or (b) a housekeeping
pass that asks the engine to forget sessions older than N days, through its own API
rather than by deleting rows. Measure again after either. Do not delete the file.
