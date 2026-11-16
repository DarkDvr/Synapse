# One chat per project — the scope

Status: **all five phases built 27 Oct.** This is the record of what we decided,
what we verified, and the order we built it in. Phase 5 was cleanup; the product
is one chat per project.

The goal: a project is one conversation. No session list, no General, no choice
between "new" and "continue". The only reset is **Compact**, which throws the
conversation away and leaves a handover behind.

---

## The end state

- The rail is a **list of projects**. Clicking one opens its chat. `⋯` on the
  row (or right-click) opens Browse, Cmd, Rename, Delete.
- The row carries a red dot only when its chat is stalled (every other state is
  already said by the row itself), a `?` when it is waiting on the operator, and a
  `⋯` that opens Browse, Cmd, Rename and Delete. No session counts, no children.
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

## The state folder

Every project has one folder for everything the harness keeps about it: `.project`.
The plan, the features, the project document, the run log, reports, shots,
attachments and a private project's scratch all live there. It is excluded from
the run's diff and from git, because it is state, not work.

It was called `.synapse` until 15 Nov 2026. The first boot with this version moves
the folder and rewrites the paths inside it, updates a project's `.gitignore` if it
named the old folder, and adds the new one to `.git/info/exclude` so a model's
`git status` stays clean. A project with both keeps `.project` and moves in what it
can, naming any leftover.

A `.project` **file** (an Eclipse project) cannot coexist with the folder. Such a
project is reported and its state is not created; rename the file first.

## The project document

One file, `.project/project.md`, replacing `requirement.md` and `decisions.md`
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
  Log in order, then copied to `.project/archive/` and removed. A project with
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
- **Exercised end to end on a scratch project** once the local model came up:
  a two-message chat compacted in 4.2 s → a 630-character handover in
  `project.md`, a new chat with `metadata.compacted`, the old one gone, and the
  post rendered at the top of the empty chat (screenshot in the QC folder). The
  scratch project was then deleted with its chat, which also proved the new
  delete path.

### Phase 4 — the project list — **built 27 Oct**
- One row per project: a red dot while its chat is stalled, a `?` when it waits
  on the operator, and a `⋯` menu with Browse, Cmd, Rename, Delete. Right-click
  and Shift+F10 open the same menu; the empty state is a real first run with one
  New Project button.
- General is gone: no auto-create, no default project, no default session
  directory, no undeletable rule, no per-session folders. The old `general`
  folder is adopted as an ordinary project on the first boot after the change
  (verified live: `projects: 3`, one of them General). `deleteProject` now takes
  the chat, the folder and the plan together, refuses while the project is
  working, and no longer has a "delete the sessions first" step.
- The chat opened from a project is its newest session **by creation** (update
  time is touched by unrelated engine writes).
- The client no longer creates a fallback session when none is open: the landing
  asks for a project.
- Tests: the portable-paths suite covers the empty registry and the General
  adoption; `181/181` on the suite. The rail, menu, dots and project open were
  checked live in the QC browser.
- Not yet done (phase 5): the session create/rename/delete routes, titles and the
  titler are still in the code, though the UI no longer shows them.

### Phase 5 — remove the session UI — **built 27 Oct**
- Deleted: the session list route (`GET /api/sessions`), rename (`PATCH
  /api/sessions/{id}`), delete (`DELETE /api/sessions/{id}`), the `forget the
  plan` path that only session deletion used, `titles.js` and `titler.js` (one
  `generate` call per chat), `TBD_TITLE`, the dead session-row functions, the
  inline rename handlers, the old dead CSS (`.tree-row.session`, `.tree-caret`,
  `.tree-project-body`, `.tree-sessions`, `.tree-add-row`, `.tree-rename`,
  `.tree-edit`, `.tree-x`), and the `defaults.directory` config block and
  Settings field ("Where new sessions run").
- The client's helpers were renamed to the product's word: `createChat`,
  `chatBody`; the Settings tab called "General" is "Server" (it is the server
  settings, not the old project).
- **The audit.** Grep over `web/` for `session`/`General` now finds only internal
  identifiers (`state.sessionId`, `view: 'session'`, localStorage keys) and
  comments — the engine's word for the thing Synapse shows as a chat. No
  user-facing string, button, tooltip, tab or dialog mentions sessions or
  General; `Sessions Still Inside` is gone. In `src/`, the word remains where it
  is the engine's: the adapter, the runner's worker sessions, the engine's own
  routes and logs. That boundary is deliberate — the engine has sessions; the
  product has one chat per project.
- Migration: existing projects adopt their newest session as the chat; older
  ones stay in the engine, invisible (never deleted automatically). On this
  machine the older Fever Tracker sessions and the General and recovery-check
  projects were removed by the operator's instruction after the check.
- Tests: `184/184` (three of them the new UI-words guard), docs `39/39`. The rail,
  the menu, the compact confirm and the General adoption were checked live; the
  General project deleted to the Recycle Bin after a restart released its folder
  handle (first attempt: 423 locked).

---

### The projects folder is the registry's source — built 30 Oct

A folder copied into `..\Synapse.Projects` used to be invisible until the operator
used Add Project, even though a project **is** its directory. At boot
`projects.discover()` now scans the immediate children and registers the ones the
registry does not name:

- A leading underscore is the harness's namespace: `_scratch`, `_probe` and any
  future harness folder are never adopted. Dot folders, `$` folders and drive
  metadata are skipped, and a junction back to the harness (or to a folder
  containing it) is refused and logged.
- A discovered project gets the same two things Add Project gives one:
  `.project\plan.json` when it is missing, and its scratch folder under
  `_scratch`. An existing plan, name and created stamp are never touched.
- Discovery runs before `pruneMissing()`, so a folder that came back keeps its
  registry name instead of being pruned and re-added as the folder name.
- The boot line reports the count: `projects: 4 (2 found in the folder)`.
- Add Project and the boot pass now share `ensureProjectFolders()`, so there is
  one definition of what a project owns.

Tests: `tests/project-discovery.test.mjs` (adoption, scaffolding, reserved
folders, an existing plan and name, idempotence, a direct `ensureProjectFolders`
check). Suite 257/257.

---

### The QC pass after phase 5 — 27 Oct, live

Three tests, run one after another against the running app, fixing what each found
before starting the next. All five bugs below are fixed and committed (`936a84c`,
`ce85a35`); the suite went from 184 to 187.

**1. A new project's first chat (`qc-life`).** New Project → the folder is
suggested, the empty chat opens, the chip is hidden. A Single message was logged
as `### chat` while the head kept it as the fallback request (the chat-only
rule); the toggle then went to Multi with **no** engine call — the session still
said `single: true` — and the send applied it once ("mode single -> multi …
applied at send"). Reload reopened the same chat in Multi with four messages.
Found: every write doubled `## Handover` and `## Notes`, because an empty
section's heading is the last thing before the end marker and the reader only
stripped a heading followed by a newline. Fixed in `project-doc.js`; a document
written by the old code is repaired by its next write.

**2. Compact from two views.** Two tabs of the same app on `qc-life`. The chip
confirmed "Discard 7 messages?" over a four-message chat (the engine's list also
holds two idle markers and one system note), then compacted in about four
seconds to an 810-character handover. The second view followed the broadcast and
showed the post without a reload. The compacting view, however, landed on the
empty state: its 8-second poll was still asking for the old chat, got the 404
the compact itself had caused, and closed the new chat. A second compact after
the fixes kept both views on the new chat, with the new post and the new id.

Found: the stale-404 race (and the same race in the plan pane, where a late
answer for the previous project painted "No plan yet" over Fever Tracker's three
tasks); the message count; the post having no mark that it opens; and the post
closing itself at the next poll because the toggle handler only remembered
Reasoning blocks. All fixed: `loadMessages`/`loadPlan` capture the chat they
asked about, `loadProjects({ keepOpen })` is used by the compact path and the
broadcast, the count comes from the transcript, the summary wears a chevron, and
`state.open` remembers `compact-post`.

**3. Fever Tracker, read-only, then the delete.** Opened the operator's project:
the 17:14 compact's post ("78 messages"), the handover behind it, the plan's
three tasks (visible after the `loadPlan` fix) and Multi mode, with the chip
correctly hidden because the new chat has nothing to discard. Settings shows
**Server**, Runtime, Providers, Workers, Tools, Windows, Logging — no General, no
session words anywhere in the page text. Then `qc-life` was deleted through the
`⋯` menu: the Delete Project dialog appeared (no "Sessions Still Inside"), the
folder went to the Recycle Bin, the registry has only Fever Tracker, and the
open Fever Tracker stayed open. The `## Notes` duplicate in Fever Tracker's own
document is left for its next write to repair, by design.

Evidence: screenshots of the document and chat, the post-open handover, and the
Settings tabs (that last one caught when an occluded window returned a stale
frame — see `docs/notes/ui-lessons.md`). They were taken during the round and are
not kept; `data\` is local and regenerable, so a path here would rot.

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

1. Compact failure: retry only (recommended) or also offer "discard without a
   handover"?

---

## How this is tested

- `bin\node\node.exe scripts\checks.mjs` after every change (`docs/notes/tests.md`).
- One live QC pass per phase in an Edge profile: the rail, the menu, the chip,
  the confirm, a compact with a second view open, a reload after a compact, and a
  fresh profile with no projects.
- A compact is the one flow that swaps the open chat under the page, so it is
  tested from **two tabs** with the post open, not one: the second tab is the
  only witness to whether the broadcast re-points a view.
- `docs.test.mjs` keeps this file linked from `AGENTS.md`.

## Rollback

Each phase is a commit; the only data migration is the project document, and it
archives the files it replaces. A bad phase is reverted with git and the
archive restored.

## Renaming a project's folder (12 Nov)

The folder is the project's identity: the plan, the project document and the run history
live inside it, and the conversation lives in the engine keyed by directory. So a rename is
a move of all of it, and the Rename dialog does it in one step:

1. the engine lets go of the directory (`evictLocation`) — a process whose working
   directory is the folder keeps it undeletable;
2. the folder moves (`fs.rename`, four tries, because a browser or an editor may hold it);
3. the registry takes the new directory;
4. the engine's project row and its sessions are pointed at it (`moveProject` in the
   adapter: `PATCH /api/project/{id} {canonical}` plus one UPDATE of
   `session_v2.directory`). Measured: the engine serves the new path on the next request,
   so the chat is there when the page reloads — no search, no copy.

Refused while a session in that project is mid-turn, and refused for a name Windows cannot
create (`folderNameProblem`). The engine-specific half lives in the adapter, as rule 5 of
AGENTS.md requires.

## One code path, two modes (12 Nov)

Single and Multi are not two products. They share the chat, the cards, the composer, the
permission panel and the briefs; the difference is one thing — **Multi has runs**. A run is a
delegated worker with its own engine session, its own trace, its own plan row and its own
`run.progress` events. Single has none of that: the Architect's own turn *is* the work.

That asymmetry is where changes quietly fail. Anything written against a run simply has no
caller in Single, and nothing complains:

| if the change touches… | it reaches | because |
|---|---|---|
| `state.sessionId`, the transcript, the composer, permissions, questions | **both** | one chat, one panel, one set of cards |
| `state.runs`, `currentRun()`, `run.progress`, `traceForSession()`, `noteCompactionEvent()` | **Multi only** | a run is the only thing that has a worker session |
| the briefs, roles, the plan, `briefSession()` | **Multi only** | Single's brief is one paragraph |
| the thinking pane, the chime, the taskbar blink, the clocks | **both**, but from different data | the pane is fed by deltas either way; the card's number comes from the session in Single and from the run in Multi |

So the question before any change is: **which session owns this, in each mode?** If the answer
is "the run", the other mode needs a session-level path or the change is half a change.

Two examples from one day, both the same mistake:

- a **compaction line** drawn only inside a worker's trace — Multi showed "Compacting", Single
  showed nothing at all, and the operator asked why the context had dropped in silence;
- a **thinking pane** whose duplicate check compared against the whole transcript — the pane
  vanished after a tool call in Single, and the same check in Multi was masked because a
  worker's pane is surrounded by notes rather than by messages.

The fix is not to special-case Single at every call site. It is to ask the question at the
top, decide explicitly, and write the answer down: in the commit ("Single only, because…",
"both, and the session path is new"), and in the note that owns the feature.

## Three kinds of session, one of them is the chat (13 Nov)

A project's folder holds three kinds of engine session, and only the first is the
operator's conversation:

1. **the chat** — Synapse made it; the title is the project's name; it carries
   `metadata.synapse.automation`;
2. **a worker's run session** — made by `src/runs.js`, marked `metadata.synapse.internal`,
   deleted when the run ends;
3. **the engine's own subagent** — made by the *model*, through the engine's `subagent`
   tool. It carries **no Synapse metadata at all** — only `parentID`, pointing at the
   session that spawned it. Its title is whatever the model asked for, and its transcript
   begins with the engine's own "You are a subagent spawned by another session."

The third kind was invisible until it wasn't. On 13 Nov 2026 `fable_calc`'s Architect
called `subagent`; the child was created in the project folder eleven seconds after the
chat, so it was **the newest session** — and `newestSession()` picks the newest by
creation (a compact makes a newer chat, which is why that rule exists). Clicking the
project opened the child: the engine's subagent preamble as a **YOU** message, the
child's interrupted step under the **Architect's** name, and a Stop that cut the child
instead of the chat. The project's real conversation was never touched; it was simply
not what the page was showing.

Two rules came out of it:

- **A parented session is scaffolding.** `normalizeSession()` sets `internal` for a
  session with a `parentID` as well as for Synapse's own mark, so `projectsWithSessions()`
  never offers it and the rail never counts it. `newestSession()` also filters internal
  and parented sessions — the belt to the server's braces.
- **Page state keyed by folder dies with the folder.** The same evening `fable_calc` was
  deleted and made again at the same path, and the deleted project's run fold
  ("DESIGNER-1 · t1 · 3s") was still above the new conversation: traces, rates and
  project alarms are keyed by directory, not by session. `pruneFolderState()` drops
  them when the folder is no longer a project.

**Open question, for the operator:** should a chat be allowed to call the engine's
`subagent` at all? The work it does has no run, no trace, no plan row and no report —
Synapse's `synapse-delegate` is the managed path, and Single already denies the tool.
Denying it in Multi too would make that rule uniform; leaving it allows a model to
explore in a way the operator cannot see. It is a policy choice, not a bug.
## Private projects (15 Nov)

The project menu (⋯) has a **Private** switch below Cmd, after a divider. It is a marker
file in the project itself — `.project\private` — so the flag is part of the folder, never a
record about it. The menu shows the state with a check mark; there is no badge in the rail,
because a badge would be a trace too.

With the marker on, Synapse writes nothing about the project outside its folder:

- **no log lines**, in any channel and not even in `debug.log`: the logger drops a line that
  names the project's folder or one of its sessions (`src/privacy.js`). The rail's load
  registers the folders and session ids, and so do chat creation and send, so the filter is
  in place before the first line about them;
- **no census**: `afterTurn` skips `toolStats.recordMessages` for the session;
- **no trace reasons**: `/api/runs` returns none, new ones are refused, and switching a
  project to Private deletes the traces written before the switch;
- **no permission memory**: an answer still holds for that gate run, but it is not written
  to `data\permission-memory.json`;
- **no provider diary**: failures are not written to `data\provider-errors.log`;
- **no scratch folder outside**: a private project's scratch is `<project>\.project\scratch`
  instead of the shared `_scratch` root.

**Switching it on also removes what is already there.** The marker stops new traces; the
toggle is not a promise about the past, so it (1) rewrites every `logs\*.log` and
`data\provider-errors.log`, dropping the lines that name the project's folder, its scratch
folder or one of its sessions (`src/privacy-purge.js`); (2) deletes the project's trace
reasons; (3) forgets its remembered permission answers; (4) drops its tool census's recent
errors (the aggregate counts stay — they carry no project name); and (5) registers the
folder and sessions with the filter immediately. `console.log` is owned by the shell, which
holds it open without write sharing, so the server sends one `[[purge-console]]` request on
stdout and the shell rewrites both its ring and the file. The engine's database and the
browser profile are not touched, for the reasons below — those are the leftovers that
cannot be removed.

**A LAN view does not see a private project at all.** Remote access serves the same page, so
the filter is server-side (`src/server.js`, the `fromLan` flag): the rail's project list
excludes it, `/api/runs`, `/api/pending` and the permission cards leave it out, a guessed
project or session id answers 404, `/api/image` refuses its folder, and the event stream
drops any frame that names it for non-loopback clients. The host's own page is unaffected.

What is *not* covered, and cannot be with this engine:

- **the engine's own session store** (`data\engine\opencode\opencode.db`) holds the
  conversation, exactly as it does for every chat. Deleting a project asks the engine to
  delete its sessions (the chat rows go — measured 16 Nov: 18,790 messages, not one row
  left behind), and the next engine start runs a forced secure `VACUUM`, so the pages
  SQLite kept are rewritten too. The startup console says how many deleted projects were
  cleaned and how much was reclaimed. Brief/instruction rows still remain;
- **the shared browser profile** under `data\browser` keeps the cookies of sites opened
  from a private project;
- **the projects registry** (`data\projects.json`) knows the project's name and folder — it
  has to, or the rail could not list it.

The work itself — plan, runs, project document, artifacts — lives in the project folder as
always, which is where the operator can delete it in one move.

### What a delete leaves behind (16 Nov)

A private project was created and deleted inside four minutes as a test, and three things
came back afterwards. Each was recovered by hand, and each is now removed at delete:

- **the engine's project row** — it remembers the folder's path, and the row survived the
  delete. `forgetProject` removes it, its `worktree` rows, and the shell output written
  under `data\opencode\shell\<project id>` (`src/engine-project-purge.js`). The store is
  open while the engine runs, so this writes to it — as `moveProject` already did, with a
  busy timeout, and the engine reads these rows per request rather than caching them;
- **the shell output itself** — the tool output of that project was still readable, byte
  for byte, in that folder. It is deleted with the row;
- **the project's own `.project\scratch`** — it sits inside the folder, so the Recycle Bin
  took it along with the plan and the project document. It is emptied before the move.

What still survives a delete, and why:

- **the folder in the Recycle Bin** — that is the undo, and it holds `.project\project.md`,
  whose Log keeps every request verbatim. Empty the bin for a private project, or the
  prompts are one right-click away;
- **the SQLite pages** until the next engine start VACUUMs them (`engine-purge.js`);
- **the shared browser profile** and **the projects registry**, as above.

The lesson worth keeping: "deleted" and "forgotten" are different words. Deletion moved the
folder and dropped the chats; it did not touch the engine's own memory of the project, and it
left the project's scratch in the bin.
