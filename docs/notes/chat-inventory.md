# The chat inventory — what actually happens in the conversation

The contract for the chat rebuild. Every row is one thing that can appear in the
conversation, written as: where it comes from, what it looks like, **what it must do**
(that is the assertion), the pain it has today, and the scenario that drives it.

The rule of this document: a row without a scenario is not understood yet, and a
scenario without an assertion is a screenshot. "The new chat is done" means every row
renders and every assertion holds — in both renderers until the old one is deleted.

Scope is the **conversation and its dock**: the transcript, the question panel, the
composer, the jump buttons, the compact chip, the toasts over it. Not in scope: the
rail, the role cards, the plan pane, settings, the console. (Those read the same
state and will follow later; the vocabulary below is built so they can.)

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
| A13 | Any post rebuilt | — | M: **nothing the operator opened closes**, across a poll, a regroup or a trace update; P: three holes — two closed on chat-v2 (1.62.14: a trace's reasoning fold and its archive read their keys, and a folded trace has one), and the third still open: a message fold that rolls into the archive loses its own key |

### B. Prose blocks

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| B1 | Any text part | Markdown: headings, lists (incl. task lists), GFM tables, blockquotes, fenced code, rules, inline code, bold/italic/strike, links | M: escaped first (no injected markup); a table never widens the column; code scrolls inside itself |
| B2 | An image written inline or on its own line | A chip in the sentence, the picture on hover | M: the chip joins the paragraph it illustrates; a `javascript:` or missing file is not a chip |
| B3 | Text as it arrives | — | M: prose that is still growing is drawn where it is, not re-lettered below the reader (see G3/G4) |
| B4 | A selection the operator is making | The native selection | M: **a live update never takes it away**. Done on chat-v2: the paragraph keeps its node and only the words that arrived are appended to its text node, so the highlight stays on the words the operator chose (measured: held in 6 of 6 frames while the post grew 109 → 221 characters, `selection`). The old chat keeps it only by refusing to draw — `web/transcript.js` pauses the render while a selection is in the chat, and the post stays frozen at 39 characters |
| B5 | A right-click | The page's own menu: Copy, Select All; Cut/Copy/Paste/Select All in a field | M: Copy puts exactly the selection on the clipboard, in the operator's own text; the menu never appears as the browser's default (no Print/Reload/Save As/Inspect); today right-click is switched off everywhere |
| B6 | Copying from a card | The menu over a `<pre>` (tool output, code) | M: Copy takes the text, not the card's chrome |

### C. Disclosures (folds)

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| C1 | A `reasoning` part | A fold, summary = its first sentence; the newest ten keep their own | M: open state survives every render; opening one does not move the reader's line. **Fixed on chat-v2** (1.62.14): a trace's fold reads its own key and is drawn open |
| C2 | Older reasoning / older trace entries | One "N earlier reasoning" / "Older entries (N)" fold | M: contents kept, key stable, opening it does not close anything else; P: the trace archive ignored its key until chat-v2 (1.62.14); the message archive honours it, but a message fold that rolls into the archive still loses its own key, which reads as "the chat collapsed my history" |
| C3 | Loaded instructions | One line + fold with the file's text | M: one line in the chat; the path is in the tooltip; the text is behind it |
| C4 | A tool card | Detail: input, output, error, exit code | M: stays open across renders; body is `<pre>`; failures colour the body, not the whole card |
| C5 | A browser group | Rows of calls | M: open state survives; P: its key is positional (`browser-group-N`), not the calls' own ids, so it only survives while the whole turn renders identically |
| C6 | A permission diff | "N files · +A −D" + patch | M: closed by default; opening does not move the reader |
| C7 | A finished trace | Its fold: role · task · title · took · files · compacted ×N · looped ×N · steered | M: opening it stays open across the next event, and the line says enough that it does not need opening; P: the fold had no key and no `open` state, so the next render shut it — fixed on chat-v2 (1.62.14) |

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
| D8 | A pending permission | Card: actor + "needs your permission/screen/sign-in", task, lead sentence, paths, reason, diff, buttons | M: four button sets — file/shell (Allow Once, Always Allow, Reject, Reject With Reason, Stop Run), screen (Allow Screen, Reject, Stop Run), sign-in (Allow Sign-In, Reject, Stop Run); the countdown says when Auto-Permissions will take it; the card is the operator's, never the gate's |
| D9 | An answered permission | The card goes; the decision stays on the tool chip | M: no flash of a card that was answered elsewhere |

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
| G2 | Reasoning deltas | The pane: a window of about eleven lines, tail, eased slide, "Thinking…" when collapsed, dim when idle | M: a fixed window — growth moves nothing outside it; the words stay when the step ends; the ▾ hides it and clicking again brings the same words back. Done on chat-v2: the two shapes are two elements and the view rebuilds when the shape changes (measured: 245 → 63 → 245 px, the same 127 characters back, then 172 with the next delta, `pane-collapse`) |
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
| H4 | Auto-Answer | "Auto-Answering in N seconds…", page advance, the reply after the last page | M: the countdown is the server's clock; a manual answer wins |
| H5 | A worker's question | The same panel, note says "a worker is waiting — answer here" | M: answerable from the operator's chat; no "open that chat" that does not exist |
| H6 | The panel arriving | At the end, report above it | M: placed only after the transcript has the report; the head visible when the panel is taller than the chat; the composer disabled, Stop live |
| H7 | The answer sent | The panel goes, the chat carries on, the card stays | M: no double POST; a 409 is "already answered", not an error |

### I. The dock

| Id | Comes from | What appears | Must / Pain |
|---|---|---|---|
| I1 | The composer's state | Placeholder: "CTRL+Enter to send", "Working — Stop to take over", "Message the Architect — seen mid-turn", "Message Coder 1 — seen at its next step", "Waiting on the provider — Stop or wait", "Answer the question to continue", "Resolve the permission to continue" | M: one sentence, always the true one; a blocked text box says why |
| I2 | Send, while work runs | "Steer", yellow border | M: the same click, a different promise; the target is the role that will read it |
| I3 | Stop | Red always; enabled when busy, a run, a stop or a compact | M: first press graceful, second press hard; the notice says which; P: the notice is a page state that must not outlive the server's |
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
| K6 | Motion: 120ms, ease-out, transform/height only; only state changes animate (a fold opening, a card expanding, the panel arriving, a report settling), never the scroll while text arrives; honour reduced motion |

### L. What survives

| Id | State | Must |
|---|---|---|
| L1 | A reload | Messages, compact post, chat errors, steers, downloads, forms, permissions survive; the pane is rebuilt from the live stream; open folds and scroll position do not (today) |
| L2 | A reload mid-turn | The page rejoins the turn: the post, the pane from the next delta, the composer says Working |
| L3 | Switching chats and back | Nothing of the old chat leaks in: no trace, no pane, no pending steers, no clocks; a chat opens at its **end**, never at a remembered offset (Q3: decided) |

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
- S9 a worker's question arriving in another project's chat. **Assert: it is shown,
  answerable, and says who asked.**
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
renderer with no server and no browser, and `tests/scenario.test.mjs` holds the first case
(`tests/scenarios/S1-folds.json`) — every fold the operator opened stays open across the
next update. It fails on the renderer before 1.62.14 and passes after it, which is how we
know the harness can see the thing it is for.

Nine cases exist so far. Two of them are locks rather than faults — they pin behaviour the
chat already gets right, so the rebuild cannot lose it quietly: `download-placement.json`
(a saved download is drawn inside the post it happened in) and `alarm-split.json` (a
prohibition splits the turn it arrived in, instead of sliding to the end of it). The rest are
the promises the rebuild is for: `stream-burst` (the pane's fixed window), `pane-scroll` (the
"new words" hint), `anchor` (the reader's line), `form` (the panel keeps typed answers),
`selection` (a selection survives the delta after it) and `pane-collapse` (the pane's two
shapes, and the words coming back).

`node scripts/chat-lab.mjs --check` answers the ones that can be pass/fail — text identity
between the two renderers on every frame, the selection against each of them, the pane's fold
— and exits non-zero when one breaks. It needs a browser, so it is a lab command, not part of
`scripts/checks.mjs`.

Every scenario runs at: normal speed, 10× speed, and paused on each frame boundary
(for screenshots). Each produces a screenshot pair (old/new) at 1280 and 1600, and the
numbers the layout audit already knows how to measure: left edges, baselines, overlaps,
overflow.

---

## 4. What the rebuild is *not*

- Not the server, the message shapes, the SSE events or the permission policy.
- Not the composer's behaviour, the ask panel's logic, or the markdown renderer.
- Not the rail, the role cards, the plan pane or settings — they will use the same
  primitives afterwards, but they are the next job, not this one.

## 5. Background changes the phase needs

1. **An events recorder** — a debug switch that writes every server→page event with its
   payload to `logs/events-<session>.jsonl`, plus periodic message snapshots. Without
   it, R1–R7 are hand-written stories rather than real ones.
2. **Stable part keys** — every part gets a key that survives a regroup and the
   live-post → real-message swap (the tool's own `part.id` where the engine provides
   one, otherwise message id + part index assigned once). Folds and cards key by it.
3. Nothing else. The engine's event stream is fine-grained enough; the chat's problems
   are all on this side of it.

## 6. Decisions

Answered by the operator on 18 Nov; these are the design, not options.

1. **The Architect's prose streams in.** The operator reads what it is writing while it
   writes it, not after the message is stored. Paced, reconciled when the message lands
   (G6, G4). The pane keeps its own hand-off rule (G3).
2. **Folds survive the page, not a reload.** Open/closed state is reading state
   (Q2 → L1).
3. **No scroll memory per chat.** A chat opens at its end; switching away means "I am
   done reading that" (L3).
4. **The pane keeps what it has:** dim and keep the finished step, click to fold (G2).
5. **Keep the current colours**, and the vertical rule is what says whose post it is:
   You violet, Architect green, Synapse yellow, a worker's trace its own grey. The
   *structure* unifies; the colour does not (Post, §1).
6. **Motion: 120ms**, fast but not instant (K6). Everything that appears, folds or
   grows animates; nothing on the scroll under a live update. A fold opens by growing its
   body from zero and closes by shrinking it before it is taken away — measured in the lab
   with `--motion`: closed 0 px, 60 ms in 55 px, settled 56 px. Reduced motion turns all of
   it off, and the lab says so in every frame.
7. **Tool cards keep one line plus expand** — and expanding and collapsing animate like
   every other disclosure: the body grows from zero and shrinks before it is taken away
   (measured in the lab with `--motion`: closed 1 px of border, 56 px at 60 ms, 96 px
   settled, back to 1 px). The click is the page's: the view reports it and `state.open`
   keeps the answer, so a repaint opens the same card (D1–D3, C4, K6).
8. **Text must behave like text again.** Right-click is a real menu (Copy, Select All,
   Cut/Copy/Paste in a field), and a selection must survive a live update: while the
   operator is selecting, the render waits and catches up when they release it (B4–B6).
   Both are current-chat faults, fixed now as well as in the rebuild.
9. **The pane is a fixed window (19 Nov).** Eleven lines from its first word, the words at
   its bottom growing upward, the text scrolling inside it, and the follow released the
   moment the reader scrolls up — with a small "New words" hint when words arrive after
   that, which takes them back to the end. Measured in the lab: the old chat grew its post
   from 45 to 162 px while a stream arrived; the new one stayed at 245 px through every step
   (G2, G3), and the hint appears in the new panel only (pane-scroll scenario).
10. **The reader's line is the anchor (19 Nov).** An update never moves the first thing
    visible: the view remembers its offset from the top of the window and puts it back
    after the paint, unless the reader is at the end (then it follows). Measured in the
    lab: a tool card landing above a reader scrolled into the history moved the old chat
    by 44 px and the new one by 1 (a whole-pixel rounding).

---

## 7. The item model — what the new renderer is given

The renderer is the easy half. The hard half is turning `state` (messages, traces, forms,
downloads, alarms, leases) into something a renderer can draw without knowing the rules.
That derivation is the **item model**: a pure function of the page's state and the
operator's open folds.

```js
buildChat(state) -> { handover, items, pending, form }
```

- `items` is the column: posts, traces and lines.
- `handover` is the compact post at the top, or null.
- `pending` is the operator's permission cards, after the conversation.
- `form` is the question panel, or null. It is **not** in the column: it is the last thing on
  screen, it is moved rather than rebuilt, and its fields keep what the operator typed — the
  one part of the chat whose state lives in the DOM on purpose.

It does grouping, windowing, ordering and keying — every rule in this document that is not
a pixel. The renderer then only walks the list.

### The shapes

| `kind` | Fields | Drawn as |
|---|---|---|
| `post` | `key, speaker` (you, architect, synapse), `at, time, state` (live, done, error), `blocks[]` | A post: rule, role, time, body (Post, §1) |
| `trace` | `key, role, task, title, at, state` (live, folded), `blocks[]` | A trace post variant: head plus timeline, folded to one line when done |
| `line` | `key, line` (compact, waiting, lease, alarm, refusal, error, loop, steer), `at, props` | One line of status (Line, §1) |

A `post` holds `blocks`, exactly five kinds — the four below, plus a `line` used inside a post or a trace (waiting, steer, compaction, loop):

| `block.kind` | Fields | Drawn as |
|---|---|---|
| `prose` | `key, text, answer: boolean` | Markdown; `answer` is the green answer panel |
| `fold` | `key, tone` (reasoning, archive, loaded, refusal, trace), `summary, body, open: boolean` | A disclosure; `open` comes from the model, which reads `state.open` |
| `card` | `key, card` (tool, browser, question, download, permission), `props, open: boolean` | A card: head, optional body |
| `stream` | `key, text, live: boolean` | The live pane — one text node, no animation of its own |
| `line` | `key, line` (waiting, steer, compact, loop, note), `at, props` | One status line, inside the post or trace it belongs to |

### The keys

Stable for the page's life, and never positional:

| Thing | Key |
|---|---|
| A message's part | `<messageId>:<partIndex>` (assigned once, before grouping) |
| A reasoning archive | `reasoning:<messageId>` |
| A trace's own fold | `<traceKey>:fold` |
| A trace's older entries | `<traceKey>:older` |
| A trace's reasoning block | `<traceKey>:r<at>` |
| A download | `download:<id>` |
| A permission | `perm:<requestId>` |
| An alarm | `alarm:<at>:<action>` |
| The compact post | `compact-post` |

Two rules follow, and they are the whole point: **a key never changes because a neighbour
appeared**, and **`open` is read from the key, not remembered by the renderer**.

### The rules the model owns

1. **One post per turn.** Consecutive assistant messages merge; a prohibited alarm between
   two steps breaks the merge there; completion is the last merged message's completion.
2. **The pane belongs to the newest assistant post**, even when a line arrived after it.
3. **Downloads sit in the post whose window contains them** (`[post.at, next.at)`), and a
   live one lands in the newest.
4. **A line sits at its own `at`**, never pinned to the end; a compaction and a loop mark
   are lines, not footers.
5. **A trace is a post with a role** — same spine, same blocks; its timeline is ordered by
   `at`, with one `archive` fold for everything older than the last four steps and ten
   reasoning blocks.
6. **Nothing is sorted by accident**: `at`, then the key as a tiebreak, so two runs of the
   same scenario produce byte-identical output.

### What the model must never do

No HTML, no DOM, no state mutation, no timers. It takes the state and the open set and
returns a list. That is what lets the scenario harness assert the *rules* (this item, that
key, this order) separately from the pixels, and what lets one model drive both renderers
while the old one is still on screen.

### How it is proven

The scenarios in `tests/scenarios/` feed `state`; `tests/scenario.test.mjs` asserts the
rendered frames. When the model exists, the same files get a second assertion — the item
list — and a disagreement between the two is a bug in one of them, not a matter of taste.

## 8. Done means

- Every row above has a scenario and its assertions pass on the new renderer.
- Every scenario also passes on the old renderer, or the difference is written down
  and accepted.
- The five pains have a rule each: no jump on growth (G2/G3/K6), readable live words
  (G3/G6), nothing closes on its own (A13/C5/C7), motion on every state change (K6),
  one measured spine (K1/K2/K3) — plus text that behaves like text (B4–B6).
- A screenshot pair per category, at two widths, reviewed before the next phase.

---

## 9. Where it stands, and how to run it

**The branch.** `chat-v2`, in its own worktree at `F:\dev\Synapse.worktrees\chat-v2` so the
running app's folder is never touched. Main still draws the old chat, and `main` is merged
into the branch whenever it moves (`b04d091` merged `8be801d`).

**What is built.**
- `web/chat-model.js` — the item model (§7): `{ handover, items, pending, form }`.
- `web/chat-view.js` — the keyed renderer: posts, traces, lines, prose, folds, cards,
  streams, the question panel. One element per key, a repaint writes into that element, and
  a paragraph that grew is written into the text node it already had.
- `tests/browser/lab.html` + `lab.js` — both renderers, one state, side by side, with the
  anchor, the pane, the hint, the selection and the motion measured on every frame, and
  `__labCheck()` for the promises that can be answered pass/fail.
- `scripts/chat-lab.mjs` — stages the page into `%TEMP%\synapse-chat-lab` and runs it:
  `node scripts/chat-lab.mjs <scenario> [--shot] [--motion] [--width N --height N]`,
  `--panel old` to make a scenario's selection in the old panel, and `--check` for the cases.
- `tests/scenario-steps.mjs` + `tests/scenario-player.mjs` — one scenario, applied in Node
  against the old renderer or in the lab against both. Steps: `messages`, `parts`, `grow`,
  `trace`, `trace-update`, `note`, `download`, `alarm`, `lease`, `form`, `permission`,
  `handover`, `open`, `close`, `stream`, `stream-flag`, `render`, and the lab's `scrollTo`,
  `scrollPane`, `select`.
- `tests/scenarios/` — `S1-folds`, `download-placement`, `alarm-split`, `stream-burst`,
  `pane-scroll`, `anchor`, `form`, `selection`, `pane-collapse`.
- `tests/chat-model.test.mjs` and `tests/scenario.test.mjs` — the model and the frames.

**What is proved**, both renderers, one state (`node scripts/chat-lab.mjs --check`, 10 cases):

| Promise | Old | New |
|---|---|---|
| Folds the operator opened stay open | closes | open (S1) |
| A download sits inside its post | yes | yes (download-placement) |
| A prohibition splits the turn it landed in | yes | yes (alarm-split) |
| The two render the same characters | — | identical words on every frame of seven scenarios |
| The pane grows without moving the chat | post 45 → 162 px | 245 px throughout (stream-burst) |
| The reader's line holds still | 44 px | 1 px (anchor) |
| The pane says there are new words | no | yes (pane-scroll) |
| Folds and cards open in 120 ms | instant | 0→55→56 px; 1→56→96→1 px |
| The question panel keeps typed answers | yes | yes (form) |
| A selection survives the delta that follows it | kept by *not drawing*: the post froze at 39 characters | kept while drawing: 109 → 221 characters (selection) |
| The pane folds to one line and comes back | yes | 245 → 63 → 245 px, same 127 characters, then 172 (pane-collapse) |

**What is left**, in order:

1. **The panel's arrival animation**, and the question countdown in v2 — `firstAt` and
   `wait` are in the model, the ticking is not.
2. **The app switch**: `chat.renderer: v1 | v2`, the ask host and the permission cards wired
   to the view, then the operator's side-by-side judgement and the decision.
3. Only then: the rail, the role cards and the plan pane on the same primitives.

**Traps that cost time here.**
- The lab's panels must beat the app's `body[data-view] .chat-dock` rules, so the lab's rules
  carry `#lab`. Without it the panels grow to their content and nothing can be scrolled.
- Headless Chromium reports `prefers-reduced-motion: reduce`, so every transition measures
  as *none*; `--motion` on `shot.mjs` emulates no-preference, and the lab reports the
  preference in every frame so a measured zero cannot be misread.
- A closed `<details>` still *measures* its content (content-visibility), so a fold's body
  needs `display: none` while closed or the animation has nothing to grow from.
- The view's anchor is a **text identity** and a **viewport offset**. A content offset changes
  whenever anything above grows — that is geometry, not movement.
- A closing fold has to stay `open` until its body has shrunk, or the content disappears
  before anything can move.
- **A container that is kept across repaints has to take its own leftovers away.** Replacing
  a block's node without removing the old one drew the same reasoning archive twice — the
  lab caught it as 163 extra characters, and the fix is `replaceWith` plus a run that ends at
  a marker.
- **An empty placeholder element is not free.** A permanently present `msg-steer` span made
  every assistant post 2 px taller than the old chat's; an empty inline-flex box still takes
  a line. The header span is built when a turn is steered and removed when it is not.
- **A selection in a detached tree still answers `toString()`.** `web/transcript.js` pauses
  its render while a selection is in the chat, so the old panel kept the words *and* stopped
  drawing — the lab had to ask `node.isConnected` before it could tell a kept selection from
  a frozen conversation.
