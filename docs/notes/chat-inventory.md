# The chat inventory — what actually happens in the conversation

The inventory of the chat that ships: every row is one thing that can appear in the
conversation, written as where it comes from, what it looks like, **what it must do** (that
is the assertion), and the pain it has today. It was written as the contract for a rebuild;
the rebuild was cut on 19 Nov (§5), and the rows are now the work list for fixing the chat we
have.

The rule of this document: a row without a test is not understood yet, and a test without an
assertion is a screenshot. "The chat is right" means every row renders and every assertion
holds.

Scope is the **conversation and its dock**: the transcript, the question panel, the
composer, the jump buttons, the compact chip, the toasts over it. Not in scope: the
rail, the role cards, the plan pane, settings, the console.

---

## 1. The vocabulary — six primitives

Everything in the chat today is one of six shapes. The unification is the point: a
new feature should be a new *instance*, never a new visual language.

| Primitive | What it is | Rules |
|---|---|---|
| **Post** | one speaker's block: a header line and a body | One header line: rule, role, time. The rule is the only left spine. Variants by speaker (You, Architect, Synapse) and by state (live, finished, errored) |
| **Block** (inside a post) | the content, in time order | Exactly five kinds: **prose** (markdown), **disclosure** (a fold), **card** (tool, download, permission, question), **stream** (the live pane), **line** (a status line *inside* a post: waiting, steer, compaction, loop) |
| **Line** | one line of status that is not a block | Icon + sentence + optional chip. Used inside posts and traces: compaction, waiting, lease, alarm, error, loop, steer |
| **Panel** | the question form | Owns its input state across renders; pages itself; never rebuilt by a poll |
| **Trace** | a *post variant* for delegated work | Same header and spine as a post; timeline of lines and blocks; folds to one line when it ends |
| **Chrome** | controls over the column | Compact chip, jump buttons, toasts. Never content, never in the flow |

Two structural decisions that follow from the five complaints, and that every row
below assumes:

1. **A block is a node with a key, not a string.** Text grows in place; a fold keeps
   its open state; nothing the operator opened is closed by a render.
2. **The reader's anchor is the contract.** A change above the fold never moves the
   line the operator is looking at. The live pane is the exception only while they are
   at the end of the chat, and even then it must not move text they are reading.

---

## 2. The inventory

Ids are stable: they are the ticket names and the scenario names. `M` = must,
`P` = pain today.

### A. Posts

| Id | Comes from | What appears | Must (M) / Pain (P) |
|---|---|---|---|
| A1 | A `user` message | Purple rule, "You", time, the sentence | M: same spine and header as every post; text selectable; time on the header line at every font size |
| A2 | A `user` message whose text starts `[steer]` | The same post with a "STEER:" tag | M: the tag is on the first line, so the sentence and the tag share a baseline; wrapping is the sentence's, not the tag's |
| A3 | Files on a message | Chips in the post: type tag, name, hover picture, click opens | M: chips do not disturb the first line's baseline; a picture is a chip, never a thumbnail in the flow |
| A4 | A message just sent (not yet in the engine) | The operator's post already there | M: the engine's copy replaces it with no flash, no duplicate, no lost scroll — this is the one place the DOM's key changes under the content |
| A5 | An `assistant` message | Green rule, "Architect", time, blocks | M: the post is the same shape whether live or finished — no second block, no second head |
| A6 | The turn starting | A post with "Thinking…" | M: opens on the first token, not at the first tool; never left behind when the turn ends without a message |
| A7 | The turn's final text | The answer panel (green emphasised) | M: "the last text of a stepped turn" is the answer; narration in a step that then calls a tool stays plain; P: a report followed by the question tool is drawn as narration, not as the answer, because a tool comes after it |
| A8 | A message with `error` | The error inside the post, red | M: readable, persists across reload, never a toast only |
| A9 | A provider error frame | The provider's own sentence, labelled as theirs | M: not mistakable for a harness crash |
| A10 | A `synthetic` message | "Synapse · <label>", yellow rule | M: four variants: report, loaded instructions (one line + fold), PROHIBITED (one red line, folds open), plain |
| A11 | A compaction | A post at the top of the new chat: "Compacted <when> · N messages", summary behind it | M: survives a reload; replaced by the next compact; the only thing in a fresh chat |
| A12 | Consecutive assistant steps | One post | M: a line that arrived between two steps must not move to the end of the turn (an alarm splits the post); the live pane belongs to the newest assistant post even if a line follows it; P: the merge hides which step a card came from, and an alarm is the one visible seam |
| A13 | Any post rebuilt | — | M: **nothing the operator opened closes**, across a poll, a regroup or a trace update; P: three holes — two closed in 1.62.14 (a trace's reasoning fold and its archive read their keys, and a folded trace has one), and the third still open: a message fold that rolls into the archive loses its own key |

### B. Prose blocks

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| B1 | Any text part | Markdown: headings, lists (incl. task lists), GFM tables, blockquotes, fenced code, rules, inline code, bold/italic/strike, links | M: escaped first (no injected markup); a table never widens the column; code scrolls inside itself |
| B2 | An image written inline or on its own line | A chip in the sentence, the picture on hover | M: the chip joins the paragraph it illustrates; a `javascript:` or missing file is not a chip |
| B3 | Text as it arrives | — | M: prose that is still growing is drawn where it is, not re-lettered below the reader (see G3/G4) |
| B4 | A selection the operator is making | The native selection | M: **a live update never takes it away**. Today it is kept only by refusing to draw: `web/transcript.js` pauses the whole render while a selection rests in the chat, so the answer on screen stops being the answer (measured on the rebuild: the post froze at 39 characters while the conversation reached 221). The fix that was tried and lost with the rebuild: write the new words into the text node the paragraph already has, so the highlight stays while the chat keeps drawing (§5) |
| B5 | A right-click | The page's own menu: Copy, Select All; Cut/Copy/Paste/Select All in a field | M: Copy puts exactly the selection on the clipboard, in the operator's own text; the menu never appears as the browser's default (no Print/Reload/Save As/Inspect); today right-click is switched off everywhere |
| B6 | Copying from a card | The menu over a `<pre>` (tool output, code) | M: Copy takes the text, not the card's chrome |

### C. Disclosures (folds)

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| C1 | A `reasoning` part | A fold, summary = its first sentence; the newest ten keep their own | M: open state survives every render; opening one does not move the reader's line. **Fixed in 1.62.14**: a trace's fold reads its own key and is drawn open |
| C2 | Older reasoning / older trace entries | One "N earlier reasoning" / "Older entries (N)" fold | M: contents kept, key stable, opening it does not close anything else; P: the trace archive ignored its key until 1.62.14; the message archive honours it, but a message fold that rolls into the archive still loses its own key, which reads as "the chat collapsed my history" |
| C3 | Loaded instructions | One line + fold with the file's text | M: one line in the chat; the path is in the tooltip; the text is behind it |
| C4 | A tool card | Detail: input, output, error, exit code | M: stays open across renders; body is `<pre>`; failures colour the body, not the whole card |
| C5 | A browser group | Rows of calls | M: open state survives; P: its key is positional (`browser-group-N`), not the calls' own ids, so it only survives while the whole turn renders identically |
| C6 | A permission diff | "N files · +A −D" + patch | M: closed by default; opening does not move the reader |
| C7 | A finished trace | Its fold: role · task · title · took · files · compacted ×N · looped ×N · steered | M: opening it stays open across the next event, and the line says enough that it does not need opening; P: the fold had no key and no `open` state, so the next render shut it — fixed in 1.62.14 |

### D. Cards

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| D1 | A tool part, running | Dot (warn), name, target (one line, ellipsis, tooltip), "streaming", chevron | M: one row; the target never wraps; the card says what is happening without being opened |
| D2 | A tool part, done | Dot (ok), "completed", output behind | M: the status pill is the only state word; no second error button |
| D3 | A tool part, failed | Dot (err), "Failed" or "Exit N", error in red | M: a non-zero exit is a failure even though the engine says completed |
| D4 | A tool call that reached outside the project | A permission chip (green allowed / amber asked / red refused) | M: the chip appears only when there was a decision; the tooltip is one sentence: who asked, what, why |
| D5 | The `question` tool | A card whose target is the first question | M: a record, not the interface — the panel is where it is answered |
| D6 | Two or more consecutive browser calls | "SynaBrowse · N calls" with the calls inside | M: one card, one intention; a single call is itself |
| D7 | A browser download | Live: name, bar, bytes, path. Done: one line, "Saved" | M: belongs inside the post whose time window it falls in; folds on completion; a page opened mid-download shows it |
| D8 | A pending permission | Card: actor + "needs your permission/screen/sign-in", task, lead sentence, paths, reason, diff, buttons. Drawn only in the asking project's chat | M: four button sets — file/shell (Allow Once, Always Allow, Reject, Reject With Reason, Stop Run), screen (Allow Screen, Reject, Stop Run), sign-in (Allow Sign-In, Reject, Stop Run); the countdown says when Auto-Permissions will take it; the card is the operator's, never the gate's; another project's card is never drawn here (rail `?` + a toast names it) |
| D9 | An answered permission | The card goes; the decision stays on the tool chip | M: no flash of a card that was answered elsewhere |
| D10 | A worker's live lease | The Architect's tool-card shape, pinned at the bottom of that run's trace: a live dot, "lease", the countdown, the reason | M: drawn from the lease itself, never from the call that asked for it — a worker's MCP call is over between two polls and never reaches the trace (21 Nov); the same clock the lease line uses (`data-lease-until`), so one ticker keeps both honest; an ended lease says "ended — asking whether it needs more" and keeps no clock. The lease reaches the page as `run.note kind:"lease"` with the lease's own state in `leaseKind`: the note's `kind` is the page's switch, and it was being overwritten by the lease's fields, so no card ever appeared live — only a page opened mid-lease showed one, from `/api/runs` (21 Nov, second report) |

### E. Lines

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| E1 | A compaction in a post/trace | "Compacted ×N · context at K/L", hourglass, amber | M: sits where it happened, never a footer; the count only ever goes up |
| E2 | A live tool | "SynaBrowse is opening…", "Thinking…", "starting…" | M: says the tool is working while it emits nothing; goes when it ends |
| E3 | A worker's lease | "Coder 1 asked for a 5:00 lease · 4:12 left · 'why'"; expired variant | M: the clock ticks without re-rendering the chat |
| E4 | A harness alarm | Amber line: title by kind + paths; detail in the tooltip | M: names what happened in the operator's words, never a shouted constant |
| E5 | A PROHIBITED refusal | Red line: "PROHIBITED · <tool> · <target>", folds open to the call and who asked | M: one line, never a paragraph; the harness message that repeats it is dropped |
| E6 | A failure the operator must keep | Red block: title, detail, "Copy Error" when long | M: survives a reload (per chat); the same failure twice in a row is one line |
| E7 | A loop rescue | "Loop detected ×N of 3 — asking it to carry on" | M: sits where it happened; "marked ISSUES, next coder" at the limit |
| E8 | A steer in a trace | "STEER: …" with file chips; pending state | M: keeps the moment it was sent, never dragged to the bottom |
| E9 | A plain trace note | One text line | M: the same left inset as everything else |

### F. Traces (delegated work)

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| F1 | A run starting | A live trace: head (role · task · title), lines, pane | M: the same spine as a post; the head says who and what |
| F2 | A finished run | A fold: the summary line | M: readable when folded; role · task · title · took · files · compacted · looped · steered |
| F3 | A trace's timeline | Lines and blocks in time order | M: a tool call sits between the thought that asked for it and the thought after it; P: the four newest steps stay open and the rest fold — the operator cannot keep one open |
| F4 | A worker's prose | An answer-style block | M: the same markdown and type as an Architect answer; a switch turns it off |
| F5 | A worker's tool call | The tool card head alone | M: exactly the Architect's component, not a lookalike |
| F6 | A worker's permission | The tool head + the permission chip | M: the same component as D4 |
| F7 | A trace key | `dir` + `task` + `startedAt` | M: a note that lands after a reload still finds its trace |

### G. The live step

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| G1 | The first delta of a turn | A post with the pane | M: the post does not appear twice, and a compaction line arriving mid-turn does not hide the pane |
| G2 | Reasoning deltas | The pane: a window of about eleven lines, tail, eased slide, "Thinking…" when collapsed, dim when idle | M: a fixed window — growth moves nothing outside it; the words stay when the step ends; the ▾ hides it and clicking again brings the same words back. P: it grows line by line and pushes the post below it down, and the wheel does not move it — its text is slid by a transform (§5) |
| G3 | Words arriving faster than they are read | — | M: the pane follows only while the reader is at the pane's end; a reader who scrolls up is left where they are and told new words are waiting; P: it pins to the bottom every frame, so it cannot be read or scrolled |
| G4 | The step's message landing | The words also exist in the message | M: no duplicate, no flicker, no re-lettering; the pane's words are the same words as the fold's, once |
| G5 | A live tool | A waiting line from the tool's own input | M: appears without a render of the whole chat |
| G6 | The Architect's prose | Streamed in as it is written | M: the operator reads it while it is being written, paced to something readable, and reconciled when the message lands (Q1: decided — stream it) |

### H. The question panel

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| H1 | A pending form | Panel: dot, title, note, fields, actions | M: one node, moved never rebuilt, so answers survive a poll |
| H2 | Fields | radio, checkbox, boolean, text, number, external link, "Something Else…" | M: a `when` rule hides a field that is not answerable yet; hidden fields answer nothing |
| H3 | A multi-question form | One question per page, "Question N of M", Back/Next/Submit | M: paging hides by class, not `hidden`, so answers survive; required fields gate the right button |
| H4 | Auto-Answer | "Auto-Answering in N seconds…", page advance, the reply after the last page | M: the countdown is the server's clock; a manual answer wins. The countdown, the page advance and the reply are all in `web/ask-panel.js` and have been since 1.62.0 |
| H5 | A worker's question | The same panel, in the worker's own project's chat; note says "a worker is waiting — answer here" | M: a worker runs in its project's chat, so its question is shown there and answerable there; another project's question is never drawn here (announced by the rail and a toast instead) |
| H6 | The panel arriving | At the end, report above it | M: placed only after the transcript has the report; the head visible when the panel is taller than the chat; the composer disabled, Stop live. P: it appears instantly, and a render rebuilds it — a choice made in it survives only because the render is held |
| H7 | The answer sent | The panel goes, the chat carries on, the card stays | M: no double POST; a 409 is "already answered", not an error |

### I. The dock

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| I1 | The composer's state | Placeholder: "CTRL+Enter to send", "Working — Stop to take over", "Message the Architect — seen mid-turn", "Message Coder 1 — seen at its next step", "Waiting on the provider — Stop or wait", "Answer the question to continue", "Resolve the permission to continue" | M: one sentence, always the true one; a blocked text box says why |
| I2 | Send, while work runs | "Steer", yellow border | M: the same click, a different promise; the target is the role that will read it |
| I3 | Stop | Red always; enabled when busy, a run, a stop or a compact | M: first press graceful, second press hard; the notice says which; P: the notice is a page state that must not outlive the server's. A hard Stop **ends the work, never the conversation**: pressing it twice used to freeze the chat behind a yellow glow and "Chat paused · N updates waiting", and it stayed frozen until Continue was found (21 Nov) |
| I4 | Attach | Chip strip above the row | M: paste, drag, picker; limits produce a chat error, not a lost draft |
| I5 | Mode | Single / Multi, disabled while blocked | M: the switch applies to the open session |
| I6 | Chrome in the dock | Compact chip; jump buttons (top, prev, next, bottom) | M: hidden when they cannot act; the question is a jump target |
| I7 | Toasts | Top-left over the chat | M: "Saved" shape is a toast; "your message was not sent" is also a line in the chat (E6) |

### J. Empty and failure states

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| J1 | No project open | The landing page; no dock | M: no half-drawn chat |
| J2 | A fresh chat | The transcript is empty; the composer is the only thing | M: no phantom "Architect" header; no leftover pane |
| J3 | The chat gone | The landing page, a toast, the rail updated | M: a 404 for an old chat does not close the new one |
| J4 | A failed transcript load | A chip, not a silent chat | M: one line in the status, not 2,000 log lines |
| J5 | The engine down | The status chip; the composer refuses | M: the failure is named where the operator acts |
| J6 | A provider failure mid-turn | The message's error + the role card's red text | M: the chat keeps the turn; Stop still works |

### K. Layout and rhythm (the invariants the five complaints are about)

| Id | Invariant |
|---|---|
| K1 | One left spine: every rule, line, card and fold starts on the same x; text on one inset from it |
| K2 | The header is one line: role and time share a baseline at every chat font size; P: "You" and the sentence sit on different baselines at some sizes |
| K3 | Spacing is in line units (¼, ½, 1, 2), not in ad-hoc pixels; P: the Compacting line's inset does not match a post's |
| K4 | Both layouts (wide, stacked), the zoom control and every font size are the same design, measured at 1280/1460/1600 |
| K5 | No horizontal scrollbar ever; the scrollbar gutter is stable; long words wrap or scroll inside their own block |
| K6 | Motion: 120ms for a fold or a card, 200ms for a row that has just arrived (a post, a reasoning line, a tool card, a trace line); ease-out, opacity/transform/height only; a row's slide moves nothing around it, so the bottom edge and the scroll hold still while text arrives; honour reduced motion |

### L. What survives

| Id | State | Must |
|---|---|---|
| L1 | A reload | Messages, compact post, chat errors, steers, downloads, forms, permissions survive; the pane is rebuilt from the live stream; open folds and scroll position do not (today) |
| L2 | A reload mid-turn | The page rejoins the turn: the post, the pane from the next delta, the composer says Working |
| L3 | Switching chats and back | Nothing of the old chat leaks in: no trace, no pane, no pending steers, no clocks, **no card, no question and no "Stopping…"** — those belong to their own chat (20 Nov); a chat opens at its **end**, never at a remembered offset (Q3: decided) |

### M. Time

| Id | What | Must |
|---|---|---|
| M1 | A post's time | HH:MM on the header line, correct at every font size and on both layouts |
| M2 | Countdowns | Auto-answer, auto-permission, lease, shutdown: server time, one tick per second, only the number changes |

---

## 3. The scenario catalogue

A scenario is a JSONL file: `{at, kind, payload}` where `kind` is one of `message`,
`delta`, `stream-end`, `run`, `note`, `form`, `permission`, `download`, `alarm`,
`lease`, `error`, `resize`, `scroll`, `open`, `click`. The player feeds it to the page
through the same entry points the app uses; the page under test does not know whether
a model or a file wrote it.

**Recordings** (real, deterministic, replayed):
- R1 plain Q&A, markdown-heavy answer (tables, code, lists).
- R2 a long report followed by a question — the incident. **Assert: the report is
  visible above the panel when the panel opens, and its last line is on screen.**
- R3 a delegated run: trace, worker prose, tool cards, a permission, a steer.
- R4 a refused command and the harness note that follows it.
- R5 a compaction (line, then the compact post in the new chat).
- R6 a browser run: group card, a download, a permission card.
- R7 a failed turn: provider error, then recovery.

**Synthetic** (what a recording cannot produce on demand):
- S1 the swap and the roll-up: a `local-` echo replaced by the engine's message, and a
  reasoning block crossing the tenth fold into the archive while its own fold is open.
  **Assert: nothing the operator opened closes, and nothing duplicates.**
- S2 two `/messages` answers out of order. **Assert: the older one never wins.**
- S3 a 200-message history, scrolled to the middle, then a new message.
  **Assert: the line the reader is reading does not move by a pixel.**
- S4 a 40-option form, taller than the chat. **Assert: its head is on screen.**
- S5 a burst: 50 deltas in 200ms. **Assert: nothing moves except the pane's own tail.**
- S6 a 10,000-line tool output. **Assert: no layout shift; the chat stays responsive.**
- S7 markdown extremes: a 4KB single line, nested lists, emoji, a table wider than the
  column. **Assert: no horizontal scrollbar, no clipping.**
- S8 resize 1280 ↔ 1600 while the pane and a form are live. **Assert: the anchor and
  the panel stay put.**
- S9 a worker's question arriving while another project is on screen. **Assert: it is not
  drawn in that chat; its own project's rail row carries `?` and one toast names the
  project; opening that project shows it at the end, under its report.**
- S10 a compact with an open fold and a scrolled-up reader. **Assert: nothing jumps,
  nothing reopens.**
- S11 no chat: no project open, a chat that was deleted, a transcript load that failed.
  **Assert: the landing page, one chip, no half-drawn chat.**
- S12 the composer's seven states: idle, working, steering to the Architect, steering to
  a worker, waiting on the provider, blocked by a question, blocked by a permission.
  **Assert: the sentence and the button's promise match the state.**
- S13 countdowns: Auto-Answer, Auto-Permissions, a lease. **Assert: the number ticks in
  place and nothing else moves.**
- S14 a reload: mid-turn, on a finished chat with an open fold, and into another chat and
  back. **Assert: L1–L3.**
- S15 the rare harness lines: an alarm, a loop rescue, a lease expiry. **Assert: each
  sits where it happened and says what it is in the operator's words.**
- S16 the motion audit: open and close every disclosure, show and answer the panel, let a
  report land — at 0.25× speed. **Assert: 120ms, transform/height only, no scroll
  movement, nothing moves under a reduced-motion setting.**
- S17 text interaction: select a sentence across a streaming turn, right-click it, Copy,
  then Select All; then do it in the composer and over a tool card's output. **Assert:
  the selection survives the update, the clipboard is exactly the selected text, and the
  menu is the page's own.**

The mapping is the contract — each row lands in at least one scenario:

| Scenario | Covers |
|---|---|
| R1, R5 | A1, A3, A5, A6, A7, A10, A11, B1, B2, C3, D2, E1, M1, K1–K5 |
| R2 | A7, D5, G6, H1–H3, H6, H7, M2 (Auto-Answer) |
| R3 | A2, A12, C7, D1–D4, E2, E8, E9, F1–F7, G1–G5 |
| R4 | D3, E4, E5 |
| R6 | C5, C6, D6–D9, E2, E3 |
| R7 | A8, A9, J5, J6 |
| S1 | A4, A13, C1, C2 |
| S2 | A5, A13 |
| S3 | K1–K5 (the anchor under load) |
| S4 | H2, H3, H6 |
| S5 | A12, B3, G2–G4 |
| S6 | B1, C4, D1, K5 |
| S7 | B1, B2, K5 |
| S8 | H6, K4 |
| S9 | H1, H5 |
| S10 | A11, A13, C7, L3 |
| S11 | E6, I7, J1–J4 |
| S12 | A2, I1–I7 |
| S13 | E3, H4, M2 |
| S14 | L1–L3 |
| S15 | E1, E3, E4, E7 |
| S16 | K6 |
| S17 | B4, B5, B6 |

The player exists: `tests/scenario-player.mjs` applies a scenario to the page's own
renderer with no server and no browser, and `tests/scenario.test.mjs` holds the one case that
survives (`tests/scenarios/S1-folds.json`) — every fold the operator opened stays open across
the next update. It fails on the renderer before 1.62.14 and passes after it, which is how we
know the harness can see the thing it is for.

The rest of the catalogue is the work list, not a suite: each row names the scenario that
would prove it, and the row's "M" is the assertion to write. The browser lab that ran these
against two renderers went with the rebuild (§6).

---

## 4. What the rebuild is *not*

---

## 5. What the rebuild found, and why it was cut

The rebuild ran to a working switch (`?chat=v2`) and was cut on 19 Nov by the operator's
judgement: it was a regression from the old chat in the things that matter while reading —
the pane, the selection, the sense of motion — and getting back to parity was costing more
than fixing the old chat directly. The code is in the history before 1.64.0 (`git show
16b2ef5:web/chat-view.js`) if it is ever wanted again; the branch and its worktree are gone.
What it *found* stays useful, and these are the defects it found in the chat that ships:

- **A fold that rolls into the reasoning archive loses its own key**, so the next render shuts
  it (row C2). The one rule the old chat still breaks: "nothing the operator opened closes".
- **A browser group's card is keyed by position** (`browser-group-N`), not by the calls it
  holds, so it only keeps its open state while the whole turn renders identically (row C5).
- **A selection stops the whole chat**: `web/transcript.js` pauses the render while a
  selection rests in the conversation, so the operator reads an answer that is no longer the
  answer. It is the one thing keeping the selection alive today; the fix the operator chose is
  to keep the freeze but make it visible, with a yellow pause sign and a Continue button.
- **The live pane grows the conversation as it writes** (rows G2–G4): every new line pushes
  the post below it down. A fixed window that scrolls inside itself is what the rebuild
  proved works, and it is a small change to `web/thinking-pane.js` and its CSS.
- **The pane cannot be scrolled by hand**: its text moves by a transform the wheel does not
  touch. The wheel should move the pane (and stop it following) while the pointer is over it.

## 6. The harness that stays

`tests/scenario-player.mjs` and `tests/scenario.test.mjs` feed a scenario to the old
renderer with no browser and no server, and `tests/scenarios/S1-folds.json` holds the one
promise the operator complained about: every fold they opened is still open after the next
update. It is how a fix to the fold keys can be proved rather than argued.

The browser lab (`tests/browser/lab.*`, `scripts/chat-lab.mjs`) and the v2-only scenarios went
with the rebuild; they measured the new renderer against the old one and have nothing to
measure now.
