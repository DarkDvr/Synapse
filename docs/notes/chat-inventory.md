# The chat inventory — what actually happens in the conversation

Every row is one thing that can appear in the conversation: where it comes from, what
it looks like, **what it must do** (the assertion), and the pain it has today. It was
written as the contract for a rebuild; the rebuild was cut on 19 Nov (§4), and the rows
are now the work list for fixing the chat we have.

The rule of this document: a row without a test is not understood yet, and a test
without an assertion is a screenshot. "The chat is right" means every row renders and
every assertion holds.

Scope is the **conversation and its dock**: the transcript, the question panel, the
composer, the jump buttons, the compact chip, the toasts over it. Not in scope: the
rail, the role cards, the plan pane, settings, the console.

## 1. The vocabulary — six primitives

Everything in the chat is one of six shapes. A new feature should be a new *instance*,
never a new visual language.

| Primitive | What it is | Rules |
|---|---|---|
| **Post** | one speaker's block: a header line and a body | one header line: rule, role, time. The rule is the only left spine. Variants by speaker (You, Architect, Synapse) and state (live, finished, errored) |
| **Block** (in a post) | the content, in time order | exactly five kinds: **prose** (markdown), **disclosure** (a fold), **card** (tool, download, permission, question), **stream** (the live pane), **line** (a status line inside a post) |
| **Line** | one line of status that is not a block | icon + sentence + optional chip: compaction, waiting, lease, alarm, error, loop, steer |
| **Panel** | the question form | owns its input state across renders; pages itself; never rebuilt by a poll |
| **Trace** | a *post variant* for delegated work | same header and spine; a timeline of lines and blocks; folds to one line when it ends |
| **Chrome** | controls over the column | compact chip, jump buttons, toasts. Never content, never in the flow |

Two structural decisions every row assumes:

1. **A block is a node with a key, not a string.** Text grows in place; a fold keeps its
   open state; nothing the operator opened is closed by a render.
2. **The reader's anchor is the contract.** A change above the fold never moves the line
   the operator is looking at. The live pane is the exception only while they are at the
   end of the chat.

## 2. The inventory

Ids are stable: they are the ticket and scenario names. `M` = must, `P` = pain today.

### A. Posts

| Id | Comes from | What appears | Must (M) / Pain (P) |
|---|---|---|---|
| A1 | a `user` message | violet rule, "You", time, the sentence | M: same spine and header as every post; text selectable; time on the header line at every size |
| A2 | text starting `[steer]` | the same post with a "STEER:" tag | M: tag on the first line, sharing a baseline; wrapping is the sentence's |
| A3 | files on a message | chips: type tag, name, hover picture, click opens | M: chips do not disturb the baseline; a picture is a chip, never a thumbnail in the flow |
| A4 | a message just sent, not yet in the engine | the operator's post already there | M: the engine's copy replaces it with no flash, no duplicate, no lost scroll |
| A5 | an `assistant` message | green rule, "Architect", time, blocks | M: the same shape live or finished — no second block, no second head |
| A6 | the turn starting | a post with "Thinking…" | M: opens on the first token; never left behind when the turn ends without a message |
| A7 | the turn's final text | the answer panel (green) | M: the last text of a stepped turn is the answer; narration in a step that then calls a tool stays plain. P: a report followed by `question` is drawn as narration |
| A8 | a message with `error` | the error inside the post, red | M: readable, persists across reload, never a toast only |
| A9 | a provider error frame | the provider's own sentence, labelled as theirs | M: not mistakable for a harness crash |
| A10 | a `synthetic` message | "Synapse · <label>", yellow rule | M: four variants — report, loaded instructions (one line + fold), PROHIBITED (one red line, folds open), plain |
| A11 | a compaction | a post at the top of the new chat: "Compacted <when> · N messages" | M: survives a reload; replaced by the next compact; the only thing in a fresh chat |
| A12 | consecutive assistant steps | one post | M: a line that arrived between two steps must not move to the end of the turn; the pane belongs to the newest assistant post. P: the merge hides which step a card came from |
| A13 | any post rebuilt | — | M: **nothing the operator opened closes**, across a poll, a regroup or a trace update. P: a message fold that rolls into the archive loses its own key |

### B. Prose

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| B1 | any text part | markdown: headings, lists (incl. task lists), GFM tables, blockquotes, fenced code, rules, inline code, bold/italic/strike, links | M: escaped first (no injected markup); a table never widens the column; code scrolls inside itself |
| B2 | an image inline or on its own line | a chip in the sentence, the picture on hover | M: the chip joins its paragraph; `javascript:` or a missing file is not a chip |
| B3 | text as it arrives | — | M: prose that is still growing is drawn where it is, not re-lettered below the reader |
| B4 | a selection being made | the native selection | M: **a live update never takes it away**. Today it is kept only by refusing to draw: `web/transcript.js` pauses the whole render while a selection rests, so the answer stops being the answer (measured: the post froze at 39 characters while the conversation reached 221). The fix tried in the rebuild: write into the text node the paragraph already has |
| B5 | a right-click | the page's own menu: Copy, Select All; Cut/Copy/Paste in a field | M: Copy puts exactly the selection on the clipboard; never the browser's default menu |
| B6 | copying from a card | the menu over a `<pre>` | M: Copy takes the text, not the card's chrome |

### C. Disclosures (folds)

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| C1 | a `reasoning` part | a fold, summary = its first sentence; the newest ten keep their own | M: open state survives every render; opening one does not move the reader's line. Fixed in 1.62.14 |
| C2 | older reasoning / trace entries | "N earlier reasoning" / "Older entries (N)" | M: contents kept, key stable, opening it closes nothing else. P: a message fold that rolls into the archive still loses its own key |
| C3 | loaded instructions | one line + fold with the file's text | M: one line in the chat; the path in the tooltip; the text behind it |
| C4 | a tool card | detail: input, output, error, exit code | M: stays open across renders; body is `<pre>`; failures colour the body, not the whole card |
| C5 | a browser group | rows of calls | M: open state survives. P: keyed positionally (`browser-group-N`), so it survives only while the whole turn renders identically |
| C6 | a permission diff | "N files · +A −D" + patch | M: closed by default; opening does not move the reader |
| C7 | a finished trace | its fold: role · task · title · took · files · compacted ×N · looped ×N · steered | M: opening it stays open across the next event; the line says enough that it need not be opened. Fixed in 1.62.14 |

### D. Cards

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| D1 | a tool part, running | dot (warn), name, target (one line, ellipsis, tooltip), "streaming", chevron | M: one row; the target never wraps; the card says what is happening without being opened |
| D2 | a tool part, done | dot (ok), "completed", output behind | M: the status pill is the only state word |
| D3 | a tool part, failed | dot (err), "Failed" or "Exit N", error in red | M: a non-zero exit is a failure even though the engine says completed |
| D4 | a call that reached outside the project | a permission chip (green allowed / amber asked / red refused) | M: the chip appears only when there was a decision; the tooltip is one sentence: who asked, what, why |
| D5 | the `question` tool | a card whose target is the first question | M: a record, not the interface — the panel is where it is answered |
| D6 | two or more consecutive browser calls | "SynaBrowse · N calls" with the calls inside | M: one card, one intention; a single call is itself |
| D7 | a browser download | live: name, bar, bytes, path; done: one line, "Saved" | M: belongs inside the post whose time window it falls in; folds on completion |
| D8 | a pending permission | actor + "needs your permission/screen/sign-in", task, lead sentence, paths, reason, diff, buttons. Drawn only in the asking project's chat | M: four button sets — file/shell (Allow Once, Always Allow, Reject, Reject With Reason, Stop Run), screen (Allow Screen, Reject, Stop Run), sign-in (Allow Sign-In, Reject, Stop Run). The countdown says when Auto-Permissions takes it; another project's card is never drawn here (rail `?` + a toast) |
| D9 | an answered permission | the card goes; the decision stays on the tool chip | M: no flash of a card answered elsewhere |
| D10 | a worker's live lease | a line in the stream, like any tool call: a live dot, "lease", the countdown, the reason | M: drawn from the lease itself, never from the call that asked for it (a worker's MCP call is over between two polls, 21 Nov); the same clock the line uses (`data-lease-until`); an ended lease says "ended — asking whether it needs more" and keeps no clock. The lease reaches the page as `run.note kind:"lease"` with its state in `leaseKind` — the note's `kind` is the page's switch and was being overwritten, so no card ever appeared live. A chat's own lease has no note: the call carries the timer |

### E. Lines

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| E1 | a compaction | "Compacted ×N · context at K/L", hourglass, amber | M: sits where it happened, never a footer; the count only goes up |
| E2 | a live tool | "SynaBrowse is opening…", "Thinking…", "starting…" | M: says the tool is working while it emits nothing; goes when it ends |
| E3 | a worker's lease | "Coder 1 asked for a 5:00 lease · 4:12 left · 'why'"; expired variant | M: the clock ticks without re-rendering the chat |
| E4 | a harness alarm | amber line: title by kind + paths; detail in the tooltip | M: names what happened in the operator's words |
| E5 | a PROHIBITED refusal | red line: "PROHIBITED · <tool> · <target>", folds open | M: one line, never a paragraph; the harness message that repeats it is dropped |
| E6 | a failure to keep | red block: title, detail, "Copy Error" when long | M: survives a reload (per chat); the same failure twice is one line |
| E7 | a loop rescue | "Loop detected ×N of 3 — asking it to carry on" | M: sits where it happened; "marked ISSUES, next coder" at the limit |
| E8 | a steer in a trace | "STEER: …" with file chips; pending state | M: keeps the moment it was sent, never dragged to the bottom |
| E9 | a plain trace note | one text line | M: the same left inset as everything else |

### F. Traces

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| F1 | a run starting | a live trace: head (role · task · title), lines, pane | M: the same spine as a post; the head says who and what |
| F2 | a finished run | a fold: the summary line | M: readable when folded: role · task · title · took · files · compacted · looped · steered |
| F3 | a trace's timeline | lines and blocks in time order | M: a tool call sits between the thought that asked for it and the thought after it. P: the four newest steps stay open and the rest fold — the operator cannot keep one open |
| F4 | a worker's prose | an answer-style block | M: the same markdown and type as an Architect answer; a switch turns it off |
| F5 | a worker's tool call | the tool card head alone | M: exactly the Architect's component, not a lookalike |
| F6 | a worker's permission | the tool head + the permission chip | M: the same component as D4 |
| F7 | a trace key | `dir` + `task` + `startedAt` | M: a note that lands after a reload still finds its trace |

### G. The live step

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| G1 | the first delta of a turn | a post with the pane | M: the post does not appear twice, and a compaction line mid-turn does not hide the pane |
| G2 | reasoning deltas | the pane: a window of about eleven lines, tail, eased slide, "Thinking…" collapsed, dim when idle | M: a fixed window — growth moves nothing outside it; the words stay when the step ends; the ▾ hides it and clicking again brings the same words back. P: it grows line by line and pushes the post below it down, and the wheel does not move it |
| G3 | words arriving faster than they are read | — | M: the pane follows only while the reader is at its end; a reader who scrolls up is left there and told new words are waiting. P: it pins to the bottom every frame |
| G4 | the step's message landing | the words also exist in the message | M: no duplicate, no flicker, no re-lettering; the same words once |
| G5 | a live tool | a waiting line from the tool's own input | M: appears without a render of the whole chat |
| G6 | the Architect's prose | streamed in as written | M: the operator reads it while it is written, paced to something readable, reconciled when the message lands |

### H. The question panel

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| H1 | a pending form | panel: dot, title, note, fields, actions | M: one node, moved never rebuilt, so answers survive a poll |
| H2 | fields | radio, checkbox, boolean, text, number, external link, "Something Else…" | M: a `when` rule hides a field that is not answerable yet; hidden fields answer nothing |
| H3 | a multi-question form | one question per page, "Question N of M", Back/Next/Submit | M: paging hides by class, not `hidden`, so answers survive; required fields gate the right button |
| H4 | Auto-Answer | "Auto-Answering in N seconds…", page advance, the reply after the last page | M: the countdown is the server's clock; a manual answer wins |
| H5 | a worker's question | the same panel in the worker's own project's chat; note says "a worker is waiting — answer here" | M: another project's question is never drawn here (rail + toast instead) |
| H6 | the panel arriving | at the end, report above it | M: placed only after the transcript has the report; the head visible when the panel is taller than the chat; the composer disabled, Stop live. P: it appears instantly and a render rebuilds it |
| H7 | the answer sent | the panel goes, the chat carries on, the card stays | M: no double POST; a 409 is "already answered", not an error |

### I. The dock

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| I1 | the composer's state | one of seven sentences: "CTRL+Enter to send", "Working — Stop to take over", "Message the Architect — seen mid-turn", "Message Coder 1 — seen at its next step", "Waiting on the provider — Stop or wait", "Answer the question to continue", "Resolve the permission to continue" | M: one sentence, always the true one; a blocked text box says why |
| I2 | Send while work runs | "Steer", yellow border | M: the same click, a different promise; the target is the role that will read it |
| I3 | Stop | red always; enabled when busy, a run, a stop or a compact | M: first press graceful, second press hard; the notice says which. A hard Stop **ends the work, never the conversation**: pressing it twice used to freeze the chat behind a yellow glow and "Chat paused · N updates waiting" (21 Nov) |
| I4 | Attach | chip strip above the row | M: paste, drag, picker; limits produce a chat error, not a lost draft |
| I5 | Mode | Single / Multi, disabled while blocked | M: the switch applies to the open session |
| I6 | chrome in the dock | compact chip; jump buttons (top, prev, next, bottom) | M: hidden when they cannot act; the question is a jump target |
| I7 | toasts | top-left over the chat | M: "Saved" is a toast; "your message was not sent" is also a line in the chat (E6) |

### J. Empty and failure states

| Id | Comes from | What appears | Must |
|---|---|---|---|
| J1 | no project open | the landing page; no dock | M: no half-drawn chat |
| J2 | a fresh chat | an empty transcript; the composer is the only thing | M: no phantom "Architect" header; no leftover pane |
| J3 | the chat gone | the landing page, a toast, the rail updated | M: a 404 for an old chat does not close the new one |
| J4 | a failed transcript load | a chip, not a silent chat | M: one line in the status |
| J5 | the engine down | the status chip; the composer refuses | M: the failure is named where the operator acts |
| J6 | a provider failure mid-turn | the message's error + the role card's red text | M: the chat keeps the turn; Stop still works |

### K. Layout and rhythm

| Id | Invariant |
|---|---|
| K1 | one left spine: every rule, line, card and fold starts on the same x; text on one inset from it |
| K2 | the header is one line: role and time share a baseline at every chat font size. P: "You" and the sentence sit on different baselines at some sizes |
| K3 | spacing is in line units (¼, ½, 1, 2), not ad-hoc pixels. P: the Compacting line's inset does not match a post's |
| K4 | both layouts (wide, stacked), the zoom control and every font size are the same design, measured at 1280/1460/1600 |
| K5 | no horizontal scrollbar ever; the scrollbar gutter is stable; long words wrap or scroll inside their own block |
| K6 | motion: 120ms for a fold or a card, 200ms for a row that has just arrived; ease-out, opacity/transform/height only; a row's slide moves nothing around it; honour reduced motion |

### L. What survives, and time

| Id | State | Must |
|---|---|---|
| L1 | a reload | messages, compact post, chat errors, steers, downloads, forms, permissions survive; the pane is rebuilt from the live stream; open folds and scroll position do not (today) |
| L2 | a reload mid-turn | the page rejoins the turn: the post, the pane from the next delta, the composer says Working |
| L3 | switching chats and back | nothing of the old chat leaks in: no trace, no pane, no pending steers, no clocks, **no card, no question and no "Stopping…"**; a chat opens at its **end**, never at a remembered offset |
| M1 | a post's time | `HH:MM` on the header line, correct at every size and on both layouts |
| M2 | countdowns | auto-answer, auto-permission, lease, shutdown: server time, one tick per second, only the number changes |

## 3. The scenario catalogue

A scenario is a JSONL file of `{at, kind, payload}`, where `kind` is one of `message`,
`delta`, `stream-end`, `run`, `note`, `form`, `permission`, `download`, `alarm`,
`lease`, `error`, `resize`, `scroll`, `open`, `click`. The player feeds it to the page
through the same entry points the app uses; the page does not know whether a model or a
file wrote it.

- **Recordings:** plain Q&A with heavy markdown; a long report followed by a question
  (the incident — assert the report is visible above the panel); a delegated run with a
  trace, prose, cards, a permission and a steer; a refused command and the note that
  follows it; a compaction; a browser run with a download and a permission; a failed
  turn then recovery.
- **Synthetic:** the echo swap and the roll-up (nothing opened closes, nothing
  duplicates); two `/messages` answers out of order; a 200-message history scrolled to
  the middle then a new message (the line does not move by a pixel); a 40-option form
  taller than the chat; 50 deltas in 200ms; a 10,000-line tool output; markdown
  extremes; resize 1280 ↔ 1600 while the pane and a form are live; a worker's question
  arriving while another project is on screen; a compact with an open fold and a
  scrolled-up reader; the empty states; the composer's seven states; three countdowns;
  reloads mid-turn and into another chat and back; the rare harness lines; the motion
  audit at 0.25×; text interaction across a streaming turn.

Every row in §2 was mapped to at least one scenario; that map was the rebuild's proof
and is not repeated here. The player survives: `tests/scenario-player.mjs` applies a
scenario to the page's own renderer with no server and no browser, and
`tests/scenario.test.mjs` holds the one case that matters —
`tests/scenarios/S1-folds.json`: every fold the operator opened stays open across the
next update. It fails before 1.62.14 and passes after, which is how we know the harness
can see the thing it is for.

## 4. What the rebuild found, and why it was cut

The rebuild ran to a working switch (`?chat=v2`) and was cut on 19 Nov: it was a
regression from the old chat in the things that matter while reading — the pane, the
selection, the sense of motion — and parity was costing more than fixing the old chat
directly. The code is in the history before 1.64.0
(`git show 16b2ef5:web/chat-view.js`) if it is ever wanted again. What it *found* is
the list of defects in the chat that ships:

- **a fold that rolls into the reasoning archive loses its own key**, so the next render
  shuts it (C2). The one rule the old chat still breaks: "nothing the operator opened
  closes".
- **a browser group's card is keyed by position** (`browser-group-N`), not by the calls
  it holds, so it keeps its open state only while the whole turn renders identically
  (C5).
- **a selection stops the whole chat**: `web/transcript.js` pauses the render while a
  selection rests, so the operator reads an answer that is no longer the answer. The
  chosen fix is to keep the freeze but make it visible — a yellow pause sign and a
  Continue button.
- **the live pane grows the conversation as it writes** (G2–G4): every new line pushes
  the post below it down. A fixed window that scrolls inside itself is what the rebuild
  proved works, and it is a small change to `web/thinking-pane.js` and its CSS.
- **the pane cannot be scrolled by hand**: its text moves by a transform the wheel does
  not touch. The wheel should move the pane, and stop it following, while the pointer is
  over it.

## 5. The harness that stays

`tests/scenario-player.mjs` and `tests/scenario.test.mjs` feed a scenario to the old
renderer with no browser and no server, and `tests/scenarios/S1-folds.json` holds the one
promise the operator complained about. It is how a fix to the fold keys can be proved
rather than argued. The browser lab that ran the catalogue against two renderers went
with the rebuild.
