# One chat per project — the scope

A project is one conversation. No session list, no General, no choice between "new"
and "continue". **Compact** condenses the model's context in place, writes a handover
and leaves the conversation on screen. All five phases were built on 27 Oct; manual
compaction became in-place on 27 Nov.

## The end state

- The rail is a **list of projects**. Clicking one opens its chat. The row carries a
  red dot only when its chat is stalled, a `?` when it waits on the operator, and a
  `⋯` that opens Browse, Cmd, Rename, Delete (right-click and Shift+F10 open it too).
- No New Session, no session titles, no rename-a-session, no General section.
- The chat has a compact chip in its top-left, floating like the scroll buttons and
  hidden whenever a compaction cannot run. Two clicks: the second, within 3 seconds,
  asks to compact the context; the chat stays.
- Compact: the engine writes a summary, Synapse keeps it in the project document, and
  the same chat gains one tool-card row at the point of compaction. No session is
  replaced.
- On first run: no projects, and a landing state that says to make one.

## Decided

1. **One project, one chat.** The engine still has one session per chat; compact
   condenses that session instead of replacing it.
2. **General is removed.** No default project, no auto-created project, no
   undeletable project.
3. **The transcript stays.** Old messages remain in the session and the chat; the
   project document remains the durable, dated record of the work.
4. **Compact is the manual form of the engine's automatic compaction.** Both condense
   the model's context inside the same conversation; neither is a reset.
5. **The handover is the engine's summary**, not one we write.
6. **Mode is chosen at send, not on toggle.**
7. **The project's memory is durable and dated**: the operator's words verbatim, the
   decisions answered, the last handover — in the project document.
8. **One file**: `project.md` holds the head, the handover, the Notes and the Log.
9. **"Always Allow" grants survive a compact.** The session is the same, so no grant
   has to be carried anywhere.
10. **A persona is Single-only and project-only.** It lives in
    `.project\persona.json`, never in the config, the project document or the records
    commit. Multi ignores it; the Multi brief only says that a Single-mode persona is on
    file and is not in force. The card reads `Vekra (Architect)` in Single and
    `Architect` in Multi; the transcript header stays `Architect`. The ✎ is the same
    role-settings dialog in both modes: skills stay shared, and in Single its
    instruction box is the project persona. A project without one has no voice in
    Single: the global Architect instructions stay Multi-only. A mode switch replaces
    the one yellow Synapse note with a Compact action, and the next brief carries the mode. A
    private project hides the persona from a LAN view with the rest of its files;
    a non-private project serves it to either view, exactly like its conversation.

**Archive is a registry flag, not a folder move.** `archivedAt` lives in
`data/projects.json`; the project, its chat, plan and sessions stay exactly where
they are. The rail filters archived projects into a closed **Archived** section at
the bottom. A working or waiting project cannot be archived, and the open project
is closed when it is archived. Unarchive restores it to the active list.

## How compaction works

The engine can be asked to compact at any time; `engine.compact()` is queued at the
next step boundary and is safe from inside a run. A completed compaction row carries
`status`, `reason`, `model` and a `summary` in a fixed shape — Objective,
Requirements, Decisions, Work State (Completed, Active, Blocked). That summary is the
handover, and it is text we can read.

1. The operator confirms.
2. `engine.compact(session)`; wait for a completed compaction with a `summary` —
   30–120 s on a big context, and the chip shows "Compacting…" while nothing else can
   be sent.
3. Write the summary into the project document; append a compacted line to the Log.
4. Leaving the same session in place, reload its transcript. The engine's compaction
   row is the only new card; the chat, draft and scroll stay.
5. Broadcast `project.compacted` with `inPlace: true`; other views reload the same
   chat.

**Failures, in the order they can happen.** No handover → nothing is written and the
operator sees the error (504); the engine refusing to compact → 502; a working project
→ 409; nothing to compact → 400. There is no silent discard — the handover is the
point.

There is no new session and no `synapse.compacted` post for this path. Legacy chats
created by the old replacement compact still show their start post from metadata; the
handover lives in `project.md` for the brief.

## The state folder

Every project has one folder for everything the harness keeps about it: `.project`.
The plan, the role models (`roles.json`), the project document, the run log, reports,
shots, attachments and a private project's scratch live there. It is excluded from the
run's diff and from git, because it is state, not work.

It was called `.synapse` until 15 Nov 2026; the first boot with this version moves the
folder, rewrites the paths inside it, updates a project's `.gitignore` and adds the
new name to `.git/info/exclude` so a model's `git status` stays clean. A `.project`
**file** (an Eclipse project) cannot coexist with the folder: such a project is
reported and its state is not created.

## The project document

One file, `.project/project.md`, carrying the handover and replacing `requirement.md`
and `decisions.md`. Four sections delimited by HTML comment markers
(`<!-- synapse:current -->` …), because the Notes are the operator's prose and a `##`
inside them must not be read as a section:

```
## Current      <- rebuilt by Synapse from the Log, never by a model
Request:        the latest Multi message, verbatim, capped at 800 characters
Decisions in force:
- Question -> answer (stamp)   the latest answer to each question, capped
Updated:        the stamp of the last write

## Handover     <- the last compaction summary, replaced on each compact

## Notes        <- the operator's standing rules; preserved verbatim

## Log          <- append-only: every request, chat and answer, dated
### request · 27 Oct 2026, 16:20
### chat · 27 Oct 2026, 16:31        a Single-mode message: recorded, never the request
### decision · 27 Oct 2026, 16:40
- **Which chart?** -> Line, as agreed
```

- The brief quotes **Current** (1,800 chars) and **Notes** (900), and the handover as
  a **digest** of about 700 characters when it has recognisable sections — the whole
  thing, capped at 2,000, only when it does not. It names the file; the model reads the
  Log when it needs history. Single mode quotes Notes and nothing else.
- Synapse writes the file, atomically (temp + rename). No model restates the
  operator's words.
- The head is why the document exists: the brief used to quote the *first* 1,600
  characters of `requirement.md` — the project's original request — so a month-old
  brief opened with day one (verified on Fever Tracker, 27 Oct).
- Migration: existing `requirement.md` and `decisions.md` are imported into the Log in
  order, then copied to `.project/archive/` and removed. A project with only the old
  files still briefs from them until the first write.
- A file the operator has edited into something without markers is never overwritten:
  the write reports the error and leaves it alone.

## The project's AGENTS.md

`AGENTS.md` at the project root is the one file every session starts with: the
generated map of who may write where, and the notepad of durable facts. It replaced
`.project/facts.md`, which only the Architect ever opened.

- **The file's name is the delivery.** The engine reads `AGENTS.md` from the session's
  directory, so the map is in context before the first tool call — for the Architect
  and every worker — without a line of brief.
- **The block is generated from the rules.** `headerText` in `src/project-agents.js`
  builds it from the same constants as `roleWriteRules`, so the map cannot describe a
  fence the ruleset does not enforce.
- **Kept current by comparison.** Two markers delimit the block; on boot, on Add
  Project and before a session is created, Synapse regenerates it and rewrites only
  the block when its text differs. An unmarked file keeps every word: the block is
  prepended and the whole file becomes the notepad.
- **The notepad is the old facts file**, folded in and deleted once, including in a
  project that already had its own `AGENTS.md`.
- **One author.** The Architect keeps the notepad; every other role is denied `edit`
  on `AGENTS.md`, relative and absolute. The cap (6,000 characters) applies to the
  notepad, not to the block.

## Scratch is the project's

Before 20 Nov it was `F:\dev\Synapse.Projects\_scratch` — a subfolder of the folder the
fence calls prohibited, with an exception carved out for it, 26.7 GB of debris, and a
brief that named a path inside a folder it told the model not to browse.

Now: `<project>\.project\scratch`, made at boot and on Add Project, with a
`.gitignore` (`*`) and a `temp` folder for a command that needs one. One writable
place, and every rule follows from it: `roleWriteRules` allows
`.project/scratch/**` for every role, `withProjectFence` needs no exception,
`SYNAPSE_SCRATCH_ROOT` is gone, and a finished task's scratch folder is removed while
a failed one is kept as evidence.

## Mode at send

The toggle changes only the page's pending choice: no API call, no engine state, no
toast. `sendMessage` carries `mode`; the server applies the ruleset only if it differs
from the session's, then briefs and prompts. One turn, one mode.

The applied mode is what the session is, so another view learns it from the session
record; the pending choice is per page and may differ until sent. The toggle stays
disabled while the project is busy. Compaction carries the applied mode into the new
session.

## One code path, two modes

Single and Multi share the chat, the cards, the composer, the permission panel and the
briefs; the difference is one thing — **Multi has runs**. A run is a delegated worker
with its own engine session, trace, plan row and `run.progress` events. Single has
none of that: the Architect's own turn *is* the work.

That asymmetry is where changes quietly fail. Anything written against a run has no
caller in Single, and nothing complains:

| if the change touches… | it reaches | because |
|---|---|---|
| `state.sessionId`, the transcript, the composer, permissions, questions | **both** | one chat, one panel, one set of cards |
| `state.runs`, `currentRun()`, `run.progress`, `traceForSession()`, `noteCompactionEvent()` | **Multi only** | a run is the only thing with a worker session |
| the briefs, roles, the plan, `briefSession()` | **Multi only** | Single's brief is one paragraph |
| the thinking pane, the chime, the taskbar blink, the clocks | **both**, from different data | the pane is fed by deltas either way; the card's number comes from the session in Single and the run in Multi |

So the question before any change is: **which session owns this, in each mode?** If the
answer is "the run", the other mode needs a session-level path or the change is half a
change. Two failures from one day, both the same mistake: a compaction line drawn only
inside a worker's trace (Multi said "Compacting", Single said nothing), and a thinking
pane whose duplicate check compared against the whole transcript (it vanished after a
tool call in Single, masked in Multi).

The fix is not to special-case Single at every call site. Decide at the top, and write
the answer down in the commit ("Single only, because…" / "both, and the session path is
new") and in the note that owns the feature.

## A card, a question and a stop belong to their chat

Once two projects can work at once, every piece of the page that waits on the operator
must say **which chat it is waiting in**. The first version kept that state globally: a
card from either project was drawn in whichever chat was open, any project's card
disabled the composer, a question from another project fell into this chat's panel,
"Stopping…" was one flag for the page, and the chime listened only to the chat on
screen.

The scope is **the project's folder** — the same key as `state.runs` and the records. A
chat is a directory; its Architect session and any worker sessions are the same chat.

- `web/run-view.js` answers "which chat is this ask in": `askDir()`, `inChat()`,
  `sameChat()`, `permissionsHere()`, `formsHere()`, `waitingIn()`. Every renderer and
  handler uses them.
- **A card is drawn only in its chat**, at the end of that chat's transcript, under the
  post it is about. Another project's card is never drawn here; its rail row carries
  `?` and one toast names the project.
- **The composer is blocked by its own chat's cards and question only.**
- **The question panel belongs to the chat.** `currentForm()` takes this session's
  form, then a form from a worker in the same folder, and nothing else. Switching chats
  redraws the panel explicitly: it is moved, never rebuilt.
- **Stop is per chat.** Every `stop.*` and `run.stopping` event carries a folder; an
  event for another project does not set or clear this chat's notice.
- **Sounding it**: `web/attention.js` watches every chat and reports two transitions —
  a chat that finished, and a chat that became blocked — each after a grace, so a gap
  between tasks or a card the gate answers itself does not knock. A chat the operator
  stopped is quiet.
- **A sign-in card** is drawn by the browser's own server, which starts in the
  project's folder and sends its directory with the ask. An ask that cannot name a chat
  is drawn in the open chat rather than lost — the only case where that happens.

What this does not change: one worker per project, the screen lease, and the fact that
a project's work appears only in its own conversation.

## Three kinds of session

A project's folder holds three kinds of engine session, and only the first is the
operator's conversation:

1. **the chat** — Synapse made it; the title is the project's name; it carries
   `metadata.synapse.automation`;
2. **a worker's run session** — made by `src/runs.js`, marked
   `metadata.synapse.internal`, deleted when the run ends;
3. **the engine's own subagent** — made by the *model* through the engine's `subagent`
   tool. It carries no Synapse metadata at all, only `parentID`. Its title is whatever
   the model asked for.

The third was invisible until it wasn't. On 13 Nov one was created eleven seconds after
the chat, so it was the newest session — clicking the project opened the child, showed
the engine's subagent preamble as a **YOU** message, put its interrupted step under the
**Architect's** name, and a Stop cut the child instead of the chat.

- **A parented session is scaffolding.** `normalizeSession()` sets `internal` for a
  session with a `parentID` as well as for Synapse's mark, so it is never offered, never
  counted, and `newestSession()` filters it.
- **Page state keyed by folder dies with the folder.** `pruneFolderState()` drops
  traces, rates and project alarms when the folder is no longer a project — deleting
  and recreating a project at the same path once left the old run fold above the new
  conversation.

**Open policy question:** should a chat be allowed to call the engine's `subagent` at
all? It has no run, no trace, no plan row and no report, and Single already denies the
tool. Denying it in Multi too would make the rule uniform; leaving it lets a model
explore in a way the operator cannot see.

## The folder is the identity

A project **is** its directory: the plan, the document and the run history live inside
it, and the conversation lives in the engine keyed by directory. So:

- **Discovery.** At boot `projects.discover()` scans the immediate children of the
  projects root and registers the ones the registry does not name. A leading underscore
  is the harness's namespace and is never adopted; dot folders, `$` folders and drive
  metadata are skipped; a junction back to the harness is refused and logged. A
  discovered project gets the same scaffolding as Add Project — `AGENTS.md`,
  `.project\plan.json`, `.project\scratch` — and an existing plan, name and created
  stamp are never touched. The boot line reports the count: `projects: 4 (2 found in the
  folder)`.
- **Rename is a move.** The engine lets go of the directory (`evictLocation` — a process
  whose working directory is the folder keeps it undeletable), the folder moves
  (`fs.rename`, four tries), the registry takes the new directory, and the engine's
  project row and its sessions are pointed at it (`moveProject`: `PATCH /api/project/{id}`
  plus one `UPDATE` of `session_v2.directory`). Refused while a session in that project
  is mid-turn, and refused for a name Windows cannot create.
- **Deleting takes everything**: the chat, the folder, the plan. It is refused while
  the project is working.

## Private projects

The `⋯` menu has a **Private** switch below Cmd, after a divider. It is a marker file
in the project itself — `.project\private` — so the flag is part of the folder, never a
record about it. The menu shows a check mark; there is no badge in the rail, because a
badge would be a trace too.

With the marker on, Synapse writes nothing about the project outside its folder:

- **no log lines**, in any channel and not even in `debug.log`: the logger drops a line
  that names the project's folder or one of its sessions (`src/privacy.js`);
- **no census** (`toolStats.recordMessages` is skipped), **no trace reasons**, **no
  permission memory**, **no provider diary**.

**Switching it on also removes what is already there.** The toggle is not a promise
about the past: it (1) rewrites every `logs\*.log` and `data\provider-errors.log`,
dropping lines that name the project, its scratch folder or its sessions; (2) deletes
the project's trace reasons; (3) forgets its remembered permission answers; (4) drops
its census's recent errors (aggregate counts stay — they carry no project name); and
(5) registers the folder and sessions with the filter immediately. `console.log` is
owned by the shell, which holds it open without write sharing, so the server sends one
`[[purge-console]]` request on stdout and the shell rewrites its ring and the file.

**A LAN view does not see a private project at all.** The filter is server-side
(`fromLan`): the rail excludes it, `/api/runs`, `/api/pending` and the cards leave it
out, a guessed id answers 404, `/api/image` refuses its folder, and the event stream
drops any frame that names it for non-loopback clients.

What cannot be covered with this engine:

- **the engine's session store** holds the conversation, as it does for every chat.
  Deleting a project asks the engine to delete its sessions (measured 16 Nov: 18,790
  messages, no row left behind) and the next engine start runs a forced secure
  `VACUUM`, so the pages SQLite kept are rewritten too;
- **the shared browser profile** keeps the cookies of sites opened from a private
  project;
- **the projects registry** knows the name and folder — it has to, or the rail could not
  list it.

### What a delete leaves behind

A private project was created and deleted inside four minutes as a test, and three
things came back. Each is removed at delete now:

- **the engine's project row** — `forgetProject` removes it, its `worktree` rows, and
  the shell output under `data\opencode\shell\<project id>`;
- **the engine's own log** (`log\opencode.log`) names the folder it booted for and the
  `cwd` of every shell command — the tool calls in plain words. `purgeEngineLog`
  rewrites those lines out, at the switch and again at delete;
- **the orphaned brief blob** — the text handed to a session is stored twice, as the
  session's entry and as a content-addressed blob; the blob survived a delete on 16 Nov,
  still naming the folder, and `forgetProject` removes one whose text names it.

What still survives a delete, and why: **the folder in the Recycle Bin** (that is the
undo, and it holds `project.md`, whose Log keeps every request verbatim), **the SQLite
pages** until the next engine start VACUUMs them, the **shared browser profile** and the
**projects registry**.

The lesson: "deleted" and "forgotten" are different words.

## Invariants

- One conversation per project, and the server enforces it.
- The server decides; the UI mirrors. No reload for sync — a compact re-points the other
  view.
- The palette: yellow accent, green/amber/red semantic only, red for the two destructive
  controls (Stop, and the compact confirm).
- Synapse writes the operator's words and the facts; a model writes only the handover,
  and it is labelled as such.
- No project, product or model name in code, briefs or config.

## How this is tested

`bin\node\node.exe scripts\checks.mjs` after every change. A compact is the one flow
that swaps the open chat under the page, so it is tested from **two tabs** with the post
open — the second tab is the only witness to whether the broadcast re-points a view.
`docs.test.mjs` keeps this file linked from `AGENTS.md`.

## Rollback

Each phase is a commit; the only data migration is the project document, and it
archives the files it replaces. A bad phase is reverted with git and the archive
restored.
