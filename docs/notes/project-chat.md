# One chat per project — the scope

Status: **Phase 1 built; phases 2–5 pending.** This is the record of what we
decided, what we verified, and the order we'll build it in. Each phase is one
commit chain and a checkpoint; nothing here is a rule until it is built and
tested.

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
9. **One file** (not `handover.md` beside a log): `project.md` holds the head,
   the handover, the Notes and the Log. The operator confirmed it on 27 Oct.
10. **"Always Allow" grants carry across a compact.** Compaction is about
    context, not consent; re-asking the same file after every compact is
    friction. (Phase 3 implements the carry.)

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
and carrying the handover. Four sections, delimited by HTML comment markers
(`<!-- synapse:current -->` …) because the Notes are the operator's prose and a
`##` inside them must not be read as a section:

```
## Current      <- rebuilt by Synapse from the Log, never by a model
Request:        the latest Multi message, verbatim, capped at 800 characters
Decisions in force:
- Question -> answer (stamp)   the latest answer to each question, capped
Updated:        the stamp of the last write

## Handover     <- the last compaction summary, replaced on each compact
(the engine's summary, or empty)

## Notes        <- the operator's own standing rules; preserved verbatim

## Log          <- append-only: every request, chat and answer, dated
### request · 27 Oct 2026, 16:20
…verbatim…
### chat · 27 Oct 2026, 16:31
…a Single-mode message: recorded, never the project's request…
### decision · 27 Oct 2026, 16:40
- **Which chart?** -> Line, as agreed
```

- **Built in phase 1** (`src/project-doc.js`, plus the brief and the two write
  paths): the head, the Log, Notes, the migration, and `ensureProjectDoc` on the
  first brief. 11 tests in `tests/project-doc.test.mjs`, plus the updated
  `single-brief`, `run-rules`, `api-reply-form` and `cleanup` tests.
- The brief quotes **Current** (1,800 chars), **Notes** (900) and **Handover**
  (2,000) and names the file; the model reads the Log only when it needs history.
  Single mode quotes Notes and nothing else.
- Synapse writes the file, atomically (temp + rename). No model restates the
  operator's words.
- The head is why the document exists: the brief used to quote the *first* 1,600
  characters of `requirement.md`, i.e. the project's original request. Verified
  on the Fever Tracker project: its brief now opens with the 26 Oct fixes, not
  the first day's plan.
- Migration: existing `requirement.md` and `decisions.md` are imported into the
  Log in order, then copied to `.synapse/archive/` and removed. A project with
  only the old files still briefs from them (read-only) until the first write.
- A file the operator has edited into something without markers is never
  overwritten; a write reports the error and leaves it alone.

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

### Phase 1 — the living project document — **built 27 Oct**
- `src/project-doc.js`: the four sections with marker delimiters, the derived
  head, Notes, the Log, the atomic write, the legacy import and archive.
- The brief reads Current + Notes + Handover; the model can read the Log.
  `readPlan` no longer carries a requirement; the old writers are gone.
- Single messages are logged as `### chat` and never become the head's request.
- Tests: 11 in `project-doc.test.mjs` (append/rebuild, latest wins, decisions in
  force, Notes preserved, handover replaced, migration/archive, a hand-edited
  file is never overwritten, legacy read-only fallback) plus the four updated
  suites. 167/167 on the whole suite.
- Checked on the Fever Tracker project: its brief now quotes the 26 Oct request
  instead of the project's first day.
- Risk taken: the file holds the operator's words, so the write is temp+rename
  and the old files are archived before they are removed.

### Phase 2 — mode at send — **built 27 Oct**
- The toggle changes only the page's pending choice. No PATCH, no toast, no
  busy-guarded request.
- `sendMessage` carries `mode`; the server applies the ruleset (only if it
  differs), announces `session.mode` for other windows, briefs with that same
  mode and prompts. One message, one mode.
- Tests: 6 in `mode-at-send.test.mjs` (apply once and before the prompt, no
  patch when unchanged, two sends are one apply, Multi clears the ruleset, no
  mode means the applied one, the announcement). 173/173 on the suite.
- Still open for phase 3: the ruleset is a session property, so a compact must
  carry the applied mode into the new session.

### Phase 3 — compaction — **built 27 Oct**
- The chip (hidden unless a compact can run), the 3-second red confirm, the
  "Compacting…" state, the server action, the summary, the project document, the
  new session, the delete, the broadcast, the post.
- Carries mode, Keep Building and model into the new session; carries the
  "Always Allow" grants (`permissionMemory.carry`).
- The post lives in the new session's metadata (`synapse.compacted`), so it
  survives a reload; the Handover lives in `project.md` for the brief.
- Failure rules: no handover → nothing created or deleted (504); the engine
  refusing to compact → 502; a working project → 409; nothing to compact → 400.
  A handover that is written but whose new session fails to create leaves the
  handover in place and the old chat alive — the next attempt overwrites it.
- Tests: 6 in `compact.test.mjs` plus the grants test in
  `permission-memory.test.mjs`. 180/180 on the suite.
- Still open for phase 4/5: the conversation the operator sees is a session in
  the projects payload; the rail still lists sessions until phase 5.

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

1. ~~One file or two?~~ One file (`project.md`), settled 27 Oct.
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
