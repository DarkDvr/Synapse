# One chat per project — the scope

Status: **scoped, not built.** This is the record of what we decided, what we
verified, and the order we'll build it in. Each phase is one commit chain and a
checkpoint; nothing here is a rule until it is built and tested.

The goal: a project is one conversation. No session list, no General, no choice
between "new" and "continue". The only reset is **Compact**, which throws the
conversation away and leaves a handover behind.

---

## The end state

- The rail is a **list of projects**. Clicking one opens its chat. `⋯` on the
  row (or right-click) opens Browse, Cmd, Rename, Delete.
- The row's dot: grey never used, green idle with a conversation, yellow
  breathing working, amber `?` waiting on you. No session counts, no children.
- No New Session, no session titles, no rename-a-session, no General section.
- The chat has a compact chip in its top-left, floating like the scroll buttons
  and hidden whenever a compaction cannot run. Two clicks: the second, within
  3 seconds, on a red pill that names what is lost and what stays.
- Compact: the engine writes a summary, Synapse keeps it in the project
  document, the conversation is deleted, a new one starts, and the chat shows a
  "Compacted …" post with the handover behind it.
- On first run: no projects, and a landing state that says to make one. The
  projects folder is created if it is absent.

---

## Decided

1. **One project, one chat.** Under the hood the engine still has one session
   per chat, and compact replaces it — that is invisible and is not a "chapter".
2. **General is removed.** No default project, no auto-created project, no
   undeletable project, no per-session folders under General.
3. **No chat history, no dump.** Erased means erased. The record is the files:
   the project document, the plan, the run log, the design and findings.
4. **Compact is the only reset**, and it is manual. There is no automatic
   deletion of a conversation; the engine's automatic compaction inside one
   conversation is untouched (it is the safety net, not the feature).
5. **The handover is the engine's summary**, not one we write (see below).
6. **Mode is chosen at send, not on toggle.** Clicking Single/Multi changes
   nothing until a message is sent.
7. **The project's memory is durable and dated**: the operator's words verbatim,
   the decisions answered, the last handover — in the project document.
8. Removed with the chat: the composer's busy note, the rail's "working" chip
   (already gone), the session-level clock keyed by session id (it resets with
   each chat, which is what "this session" always meant).

---

## How compaction really works (verified)

The engine can be asked to compact at any time. `engine.compact()` already
exists in `src/engines/opencode.js` (queued at the next step boundary, safe from
inside a run) and is used by the runner for its own context management.

A read-only look at the engine's database (`session_message`, `type =
compaction`) settled the important question. A completed compaction row carries:

```
{ "status": "completed", "reason": "auto",
  "model": { "providerID": …, "id": … },
  "summary": "## Objective … ## Requirements … ## Decisions …
              ## Work State ### Completed ### Active ### Blocked" }
```

So: **the engine writes the summary, with the project's model by default**, and
it is stored as text we can read. The shape is exactly a handover — what the
work is, what was decided, what is done, what is active, what is blocked. That
summary is what goes into the project document and into the post.

The flow, with the order that doesn't lose the chat on a failure:

1. The operator confirms.
2. `engine.compact(session)`; wait for a completed compaction message with a
   `summary` (watch `session.compaction.*` and read the transcript; 30–120 s on
   a big context — the chip shows "Compacting…" and nothing else can be sent).
3. Write the summary into the project document; append a compacted line to the
   log.
4. Create the new session in the same folder, with the project's mode, Keep
   Building flag and model; brief it.
5. Delete the old session; broadcast the new session id so other views re-point.
6. The new chat renders the post from the project document.

If step 2 fails (provider down, timeout), the conversation stays exactly as it
was and the operator sees the error. No summary, no deletion — the handover is
the point, so there is no silent discard. (Open: whether to offer a second,
explicit "discard without a handover" after a failure.)

---

## The project document

One file, `.synapse/project.md`, replacing `requirement.md` and `decisions.md`
and carrying the handover. Four sections:

```
## Current      <- rebuilt by Synapse from facts, never by a model
Request:        the latest operator message, verbatim, capped
Decisions:      the latest answer per question, capped
Plan:           n/m done, and the open task titles
Updated:        date

## Handover     <- the last compaction summary, replaced on each compact
(the engine's summary, or "None yet.")

## Notes        <- the operator's own standing rules; preserved verbatim
(anything they want every turn to remember)

## Log          <- append-only: every operator message and every answer, dated
### 2026-10-27 13:12 — request
…verbatim…
### 2026-10-27 13:20 — decision: "Which chart?" -> "Line, as agreed"
```

- The brief quotes **Current** and **Handover** (bounded, ~2,500 characters
  total) and names the file; the model reads the Log only when it needs the
  history.
- Synapse writes the file, atomically (temp + rename). No model restates the
  operator's words — that is how a requirement drifts.
- **This fixes a live bug**: `requirement.md` is append-only and the brief
  quotes its first 1,600 characters, i.e. the project's *original* request.
  After a compact the Architect would open standing in the first campaign. The
  head always quotes the latest.
- Migration: existing `requirement.md` and `decisions.md` are imported into the
  Log in order, then moved to `.synapse/archive/` (kept, not shown).

---

## Mode at send

Today the toggle PATCHes the session's permission ruleset immediately. That is
why it can disagree with what the operator meant when they clicked twice.

- The toggle changes only the page's pending choice: no API call, no engine
  state, no toast.
- `sendMessage` carries `mode`; the server applies the ruleset (only if it
  differs from the session's) and then briefs and prompts. One turn, one mode.
- The applied mode is what the session is, so another view learns it from the
  session record; the pending choice is per page and may differ until sent.
- The toggle stays disabled while the project is busy, because the running
  turn's mode is already fixed; otherwise it is free to click.
- Compaction carries the applied mode into the new session.

---

## Phases

### Phase 0 — probe and record (small)
- This document, committed.
- One live probe of a manual compact on a scratch chat: confirm the summary
  arrives through `getMessages` (not just the DB), how long it takes, and that a
  new session can be created in the same folder with its mode. Not a feature.
- Done when the probe is written down here and the shape is confirmed.

### Phase 1 — the living project document
- Merge `requirement.md` + `decisions.md` into `project.md`; the derived head;
  the `## Notes` section; migration and archiving.
- The brief reads Current + Handover; the model can read the Log.
- Tests: append/rebuild (the Log survives a rebuild), latest-request-wins,
  decisions-in-force (latest per question), Notes preserved, migration.
- Risk: rewriting a file that holds the operator's words — atomic write, and
  the old files are archived on migration.
- Done when the brief on a long project quotes the latest request, and a
  second session reads the same memory.

### Phase 2 — mode at send
- Toggle becomes pending-only; `sendMessage` applies the mode once; the toggle
  is disabled while busy; the applied mode is readable by other views.
- Tests: toggling sends no PATCH; a send applies exactly one; Single and Multi
  both take effect on the first message; a compact carries the mode.
- Done when clicking back and forth ten times and sending once behaves like
  clicking once and sending.

### Phase 3 — compaction
- The chip (hidden unless available), the 3-second red confirm, "Compacting…",
  the server action, the summary, the project document, the new session, the
  delete, the broadcast, the post.
- Carry mode, Keep Building, model; carry the "Always Allow" grants too
  (recommended: compaction is about context, not consent).
- Tests: summary extraction; new session created with the project's settings;
  old deleted; post rendered from the file; a second view re-points without a
  reload; a failed compact leaves the chat intact; a timeout does not delete.
- Done when a compact from the UI produces a handover the next message can
  rely on, and the other window follows.

### Phase 4 — the project list
- One row per project; `⋯` menu with Browse, Cmd, Rename, Delete; the three dot
  states plus the `?` waiting mark; delete = its chat + folder + plan, with the
  `bin\` consent it already has.
- Rip out General: auto-create, default project, default directory, the
  undeletable rule, per-session folders; create the projects root if absent;
  the first-run empty state.
- Tests: no projects at boot; create/open/rename/delete; delete while busy is
  refused; a menu that works with the keyboard; the dot states.
- Done when a fresh install has no General and one project is one row.

### Phase 5 — remove the session UI
- Delete the session list, New Session, rename/delete-session, titles,
  `TBD_TITLE`, the titler (one less model call per chat).
- The client follows "the project's chat" instead of a session choice; a compact
  swaps the id underneath it; localStorage clocks key by project + chat.
- Migration: existing projects adopt their newest session as the chat; older
  ones stay in the engine, invisible, and can be deleted later (never
  automatically — that would be a destructive upgrade).
- Done when the word session appears nowhere in the UI, and the suite is green.

---

## Invariants

- One conversation per project, and the server enforces it (the busy guard
  already does).
- The server decides; the UI mirrors. No reload for sync — a compact re-points
  the other view.
- The palette is unchanged: yellow accent, green/amber/red semantic only, red for
  the two destructive controls (Stop, and the compact confirm).
- Synapse writes the operator's words and the facts; a model writes only the
  handover summary, and it is labelled as such.
- No project, product or model name in code, briefs or config.

---

## Open questions

1. `project.md` as one file (recommended) or `handover.md` separate from the
   request/decision log?
2. Compact failure: retry only (recommended) or also offer "discard without a
   handover"?
3. Plan row times after a compact: reset with the chat (recommended, matches
   yesterday's fix) or span compactions with a plan-generation id?
4. Old sessions on upgrade: leave them hidden in the engine (recommended) or
   delete them?
5. The `⋯` menu: is Rename there, or does a double-click rename (the menu is
   clearer)?

---

## How this is tested

- `node --test tests\*.test.mjs` after every phase (156 today, and the new
  files: project document, mode-at-send, compaction).
- One live QC pass per phase in the QC Edge profile: the rail, the menu, the
  dot states, the chip, the confirm, a compact with a second view open, a
  reload after a compact, and a fresh profile with no projects.
- `docs.test.mjs` keeps this file linked from `AGENTS.md`.

## Rollback

Each phase is a commit; the only data migration is the project document, and it
archives the files it replaces. A bad phase is reverted with git and the
archive restored.
