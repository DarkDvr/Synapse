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

## OC provider fixes — details to come (6 Nov)

The operator has a list of fixes for the OpenCode providers — the two engine rows
(`opencode` / OC Zen, `opencode-go` / OC Go) and what Synapse does with them. Held
here on purpose so the list is not lost between sessions; the detail arrives later.

One concrete symptom for that list, found while moving the names into the adapter
(7 Nov): a provider the engine serves *and* the config also holds is rendered twice
differently. The config has a row `opencode-go` named "OpenCode Go" pointing at
`https://opencode.ai/zen/go/v1`; the Providers pane shows the engine's own row
("OC Go", "Engine catalog") and hides the config's, because it checks the engine list
first — while the model menu labels that provider from the config ("OpenCode Go").
Two names for one provider, in two places that are supposed to agree.

Where: `web/provider-list.js` (`providerLabel`), `web/providers.js` (`rowFor` — the
builtin check comes before the config row), `src/engines/opencode.js` (what the
engine registers), `config/synapse.config.json` (the row that duplicates it).
Fix: wait for the operator's notes. Do not guess at them.

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
