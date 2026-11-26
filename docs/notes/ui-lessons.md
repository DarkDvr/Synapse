# UI lessons

The reference for anyone touching `web/`: the layout's invariants, what the chat
draws, the cards, the panel and the picker, with the numbers that prove them.
**Where this file and `web/` disagree, `web/` is right and the sentence here is
history** — a layout rule is only true for as long as the build keeps it.

**Historic layout, five lines.** The stage used to be three columns that needed
1460px, with the rail stacked under the chat below that, the dock's height fitted
frame by frame from a measurement, a `min(70vh, 720px)` ceiling above which the
transcript scrolled, and a `260ms` `max-height` transition on the dock.
All of it is gone, for one reason: a measured height only ever approximated a box
the grid can make definite. `panel.css` owns the two-column stage now.

## The palette, stated once

- **Violet is a fill or a surface. Orange is an accent only** — text, a border, a
  dot-ant. **Never orange text on a violet fill**: white is the only ink that goes
  there (the active Settings tab is the standing example).
- **Green, amber and red are semantic, never decorative.** Green = idle but has
  taken part, amber = waiting or a warning, red = blocked, refused or destructive.
- **Affordances have their own colours:** `+` green, `✕` red, edit and settings
  icons yellow. **Stop is red whether or not it is hovered, and Settings' Revert is
  red too** — they are the two controls that throw work away, plus the compact
  chip's second click, which is the third.
- **The live path is one colour: yellow.** A 2.5px yellow stroke with yellow beads
  separated by their glow (`drop-shadow`), because the beads used to be orange and
  two hues on one thin line read as a colour bug. Delegation cards wear the same
  yellow while in flight, and **red means blocked and nothing else**.
- **The working wash and ring:** an amber wash entering from both edges, 12.3% at
  the edges, breathing every 2.7s, plus a 2px conic arc lapping the perimeter in
  2.1s. It marks `.has-work` on a project row and `.is-working` on a card — the
  card only while its own turn runs, not while it waits. Reduced motion keeps the
  still tint and a fixed arc.
- **Buttons are Title Case.** That is buttons only — not headings, body text,
  labels or tooltips.
- **Status dots are `display: inline-block`**; as inline spans they ignore
  width and height and paint as a 4px square.
- **No duplicate status labels:** a failed tool card shows the `Failed` pill only,
  a failed probe row the `Error` button only.
- **Scrollbars are ours.** `::-webkit-scrollbar` styled thin and dark (plus
  `scrollbar-width` / `scrollbar-color`) — Chromium stops drawing its native bar
  the moment that pseudo-element is styled, which is what removes the Windows
  stepper arrows (a tool card's 200px output box was showing two and read like a
  spreadsheet). Tool output never scrolls sideways: `white-space: pre-wrap` +
  `overflow-wrap: anywhere` + `overflow-x: hidden` on `.tool-body pre` (measured: 0
  of 82 output blocks scrolled sideways on a real four-round transcript).
- **One flat pane.** `.control-room .main-content` is one `#0E161E`; the cards and
  the chat are the only things in it with edges, and the dock is an opaque surface.
  A background belongs to the sidebar alone.
- **Mode colours:** Multi is orange, Single violet, both filled pills with white
  text and a white dot. The mode is readable at a glance, and neither colour is
  ever used as text on the other.
- **A provider error is red *text* on the card, never a border.** While a role is
  retrying or its wake failed, its subtitle reads `Retrying at 00:45 — Rate limit
  exceeded` in `--red` at 600 weight, clamped by the same three-line slot, whole
  sentence in the tooltip. The border keeps its own meaning. The source is
  `role-error` events in `state.roleErrors`, keyed `dirKey|role`, deliberately not a run
  event — `run.progress` cannot clear it because the runner emits one right after the
  notice.

## The stage: one grid in both modes

`panel.css` is the whole main panel and it measures nothing. The stage is two
columns and two rows at every window size:

| | Single | Multi |
|---|---|---|
| columns | `minmax(0,1fr) 0` | `minmax(0,1fr) 360px` |
| the Architect | one bar across the top | the top of the rail |
| the workers | hidden | stacked under it, one column, in a 22px gutter |
| the plan | hidden (still in the DOM) | the rail's second row |
| the chat | column 1, row 2 | column 1, both rows |

- **The chat is in column 1 in both modes.** Spanning both columns pinned its right edge
  to the stage's edge whatever the columns were doing, so the switch re-laid the text out
  in one frame while only the rail moved.
- **A mode switch animates exactly one property:** `grid-template-columns` over `240ms
  ease` (measured 747 → 1107 in fifteen frames, the rail 360 → 0 in step).
- **The rail's contents are right-anchored while the column shrinks** (`margin-left: auto`
  on the topology and the plan), so the chat's edge sweeps over the cards — "hidden behind
  the chat" — instead of clipping them from their right side, a wipe from the wrong end.
- **A switch lands the chat at its own end.** Keeping the bottom line where it was leaked
  one mode's offset into the other: a chat scrolled up in Single opened scrolled up in Multi
  (reported 21 Nov). The transcript's `ResizeObserver` keeps the end glued while the panel
  narrows, and a wheel during the switch wins. If a line must be held, hold it by its place
  in the **content** — `rect.top - box.top + scrollTop` — never by adding a delta to a
  viewport reading: the next frame's reading then depends on this frame's write and the
  line flickers between two messages for the length of the switch.
- **The dock is a grid cell with a definite box.** The stage is `height: var(--stage-h,
  calc(100vh - 26px))`, with `--stage-h` set from the measured viewport minus any classic
  horizontal scrollbar. `fitChatHeight`, `setChatHeight`, `watchChatGeometry` and the
  per-frame rAF loop are deleted, not disabled (`web/chat-geometry.js` keeps only the slack
  helpers). There is **no ceiling**, no fitted height and **no height transition**: a
  transition on the height made the bottom edge — the window's edge — lag every change above
  it, and during a run the Architect's status line dragged the composer 8.8px between two
  idle samples, one pixel per frame. `.chat-dock` is `grid-template-rows: minmax(0,1fr)
  auto` with `min-height: 0`, `.chat-scroll` is the only scroller and reserves its gutter,
  and the composer is row 2 in both modes — so an empty chat names its row instead of
  floating at the top.
- **The work area is left-anchored and capped.** `.content-wrap` is a column flex item with
  `width: 100%; margin: 0`; `margin: 0 auto` on it made the whole room shrink-to-fit, so
  Multi looked fine while Single collapsed to ~380px and drifted right. `--work-w: 1240px`
  is the room's cap: sidebar → cards+chat → rail → empty space at the right edge.
- **Measured in Multi at 1600×900:** stage 1296 wide (x 280→1576), columns **912 + 360**
  with a **24px** column gap and an **8px** row gap, the plan **360×440**, the chat **910**
  wide with an **815**-tall transcript, `--chat-fs` **13px**.
- **`body { min-width: 1100px }`** is the supported floor: the two columns need it, and
  below it the page is deliberately wider than the window — 200px of scrolling at 900px,
  258px at the operator's 842px window, which is what made the panel look cut off. **Still
  open:** whether the floor should come down and the columns stack instead.
- **`body[data-view="session"] .stage` is `overflow-x: clip`.** `clip` and not `hidden`:
  `hidden` would make the stage a scroll container and change what sticks and what the
  scroll arithmetic sees. The cards overflow their cell for a quarter of a second while the
  column closes; `clip` stops that reaching the document.

## The six role cards

The Architect plus five workers — Inventor, Designer, QC, Coder 1, Coder 2, in that
fixed order (`ROLES` in `web/run-view.js`). A card is two fixed rows, `22px` and
`13px`, `gap: 9px 10px`, `padding: 7px 12px 6px`, so a card is the same size whether
its readouts have anything to say or not: an empty span is zero high, and cards that
grew and shrank as runs came and went would move the plan under the pointer. In
Single the Architect is a `flex` bar (`padding: 5px 12px`) with the name, rate,
clock and picker joined into one row.

- **The subtitle slot is a fixed three lines** (`--task-lines: 3`), clamped with
  `-webkit-line-clamp`, full text in the `title`. A card that grew when its task appeared
  took its room from the transcript's top edge and read as the whole UI jumping every time
  an agent started. Height comes from the card's own rows, so filling the slot changes none.
  The trade is real — the stack is ~200px taller for ever, out of the chat — and
  **`--task-lines` is the one number to change** (it goes to 2 under
  `@media (max-height: 820px)`, fixed within a window size so the no-shift rule holds).
- **The wrapper is `overflow: clip` in every mode, never `auto`.** It must never
  scroll: not by wheel, keyboard, drag or script, and no bar may appear beside the
  cards. `auto` was wrong twice over — it made the section scrollable, and a
  241.06px topology under a 241px cap grew a hairline bar, because `scrollHeight`
  rounds down so the overflow was invisible but real. `clip` makes any attempt to
  scroll a no-op: verified across 41 frames of a Multi→Single switch at 1680px and
  1200px, `overflow: clip`, `scrollTop` forced to 50/60 stayed 0, gutter 0.
- **The connector is a solid 1px `#4a505a` hairline** drawn by `drawActivePath()`
  in `live-runs.js` from the real card boxes: one line down the gutter, one into
  each card, measured from the cell's own centreline rather than assumed, so which
  side a worker sits on is decided by comparing centres. **No beads at rest** — two
  dash attempts failed because beads are placed by distance along each piece and
  the layer does not start on a whole pixel. **A live run** replaces the L with the
  same path in yellow plus travelling beads: count from the path's length,
  `DUR = Math.max(2.2, len / 90)` — the 2.2s floor — and **no arrowhead**, because
  the beads already say which way the work flows. A card hidden by Single mode has
  a zero-width box, which is the guard that stops a path being drawn to nothing.
  **A card is never its own destination.**
- **The dot is a state, derived — nothing is stored.** Grey: never took part.
  Yellow breathing (`.status-dot.live`, `--yellow`): taking part now. Red: a task of
  its role is `blocked` or `failed`, or the role was skipped. Green: idle but has
  taken part. Precedence is live → skipped/blocked → done → idle, read from the plan
  file, the runs the runner already serves, and the open session's turn.
- **The dim is 0.55, not 0.8** — at 80% the operator could not see it at all — and
  hovering restores the card to full, so a dimmed picker is never unreadable.
  Participation is **per session, not per plan**: a non-Architect card starts dim
  and goes solid the first time that role is used in this session, and stays solid.
  It comes from `used`, computed from `runs.jsonl`, because deriving it from the log
  is what makes it survive a reload and a restart; the Architect counts as the open
  session, and both the role a task was written for and the role that ran it count
  (that is how Coder 2 is solid after the ladder handed it Coder 1's task). The
  Architect is never dim.
- **A skipped role looks blocked:** red border, red label, and its **picker goes
  red** (border and model name, background unchanged) because the model is what
  failed and swapping it is the fix. The mark survives the run: the live run's
  `skipped[]` while it lasts, then the role's current model carrying a `provider`
  issue.
- **Two chips, one resting state each:** a green `Done` when there is a plan and
  every task is done, and a yellow `Waiting on you` when nothing is in flight and
  work is outstanding — naming the ready task (`Waiting on you — t2 is ready and
  Keep Building is off`) or the blocked one. Both put the card in `is-settled`,
  which is the **green border**; yellow border means a delegation is in flight.
  Because a chip is the size of a line of text it cannot change a card's height.
- **A clock and a dim are two claims about one card, so both come from one ledger.**
  `runLedger` scopes a role's total to this session's runs of its tasks, so a timer
  cannot appear on a card that never worked here; `dim` also refuses to fade a card
  whose tasks have session time.
- **`state.roleSig` includes every fact the card shows** — role, text, dot, working,
  dim, settled, skipped, chip, error — or a poll that changed only a status returns
  early and the dot never repaints. `loadPlan()` calls `renderRoleActivity()`,
  because the plan poll (30s, plus every message event) is the only thing that
  learns a task changed.
- **The role name does not shrink; the model label does.** With both free, a 290px
  card turned "Inventor" into "Inven…" while the picker kept 137px. The h3 is
  `flex: 0 0 auto`; `.model-search` gives way.
- **Every role owns its model and effort; there is no "default model."** The
  Architect's choice lives in `roles.architect` like every other role, persisted in
  `config\synapse.config.json`; `defaults` holds only the working directory. An
  older `defaults.model` is folded in once by `normalize()` and the key deleted.
  Changing the Architect card switches the open session at once.

## The chat

- **A post is one block: one header line, one spine.** Every speaker gets the same shape
  — a coloured name and a 2px rule down the left of what was said (you violet, the
  Architect green, Synapse yellow) — and **nothing in the transcript has a fill**. The
  tinted panel per speaker was removed: the name already says who is talking, so the fill
  was decoration needing a palette exception.
- **One assistant block per turn, not per step.** The engine emits a message per step;
  `groupTurns()` merges consecutive assistant messages into one header with the steps in
  order and the answer panels among them, so three questions read as three blocks and not
  fourteen headers.
- **An alarm is a break in that merge.** `alarmBreaks()` marks the first Assistant message
  at or after the alarm's time and `groupTurns(…, { breakBefore })` stops merging there, so
  a refusal sits between the step that caused it and the step after it instead of sliding
  to the bottom of a growing turn.
- **Only conversation is chat.** User and assistant turns, and errors whatever type carries
  them; system prompts, scaffolding and context dumps are filtered — one leak put AGENTS.md
  prose and diff hunks above the operator's own message.
- **A tool row is deliberately small:** `.tool-head` is `padding: 2px 7px`, a 7px flat
  status dot (no ring), mono at `0.84 × --chat-fs`, a name that differs by weight and colour
  only, and a state pill at `0.72 × --chat-fs`. A busy turn emits dozens, which is why the
  margin is `2px` and the dot is flat.
- **Expanded state lives outside the DOM.** Every part is tagged with a stable key
  (`<message id>:<index>`), `state.open` holds the open keys and the render restores them
  (`data-k` on `<details>`, the key itself on `data-tool-card`); `renderTranscript()`
  returns early when the conversation's signature has not changed, so a poll that learned
  nothing does not touch the DOM at all.
- **A turn's reasoning folds, and its gist is its first sentence.** A turn keeps its newest
  **ten** reasoning blocks as folds and puts everything older in one `Older entries (N)`
  fold, in time order — one header for one idea, because "9 earlier steps" above "12 earlier
  reasoning" made where a line landed an accident of what it was. Each summary carries the
  block's first sentence clipped to one line (`reasoningGist`), in **sentence case** even
  inside a trace (`.trace summary` is upper case, and an inherited fold shouted
  "REASONING · LET'S START…"). `.trace-lines > * { min-width: 0 }` is what lets the ellipsis
  land at the pane's edge rather than at the sentence's end.
- **Every fold has a key**, including the prohibited alarm's (`alarm:<time>:<action>`, in the
  same `state.open` set as the reasoning folds and the compact post) and the engine's own
  "Instructions from …" posts, which each carry their own `data-k` — the compact post's was
  keyed twice and a second fold would have opened the wrong one.
- **The cut is the browser's, not a character count.** A character count is a guess at a
  column; `reasoningGist` returns its first sentence whole, the alarm its whole command, and
  `nowrap` + ellipsis shortens it at the edge. Measured on a two-size render at 1100px: at
  14px the alarm carried all 121 characters, at 20px it ended at the content edge.
- **Speech and work are separated by position, not by meaning.** Wherever prose meets a
  card, either way round, the rule breaks for one line and 20px of gap sits between them
  (`.msg-body > :is(.reasoning, .tool-card) + .msg-answer` and `.msg-answer +
  :is(.reasoning, .tool-card)`). CSS only: the adjacency is the fact, so nothing decides
  whether a paragraph is "the answer".
- **A gap is not a surface.** The rule break is painted out with the panel's own ink,
  `--chat-ink`, not `--surface`: the dock is translucent over the ground picture, and a
  lighter surface showed as a grey bar in the green rule (reported 24 Nov). With
  `data-ground="none"` the dock is the surface, so the variable switches with it.
- **A steer is the operator talking, so it never folds.** It is drawn twice: the engine
  keeps the `[steer]` marker, and the transcript shows a violet **You** with a bright yellow
  **STEER:** inside the text span (so the browser aligns it with the first line, not 9.5px
  above a 13.5px sentence). In a worker's trace it is a flex row, the tag centred on the
  sentence's line, the sentence wrapping instead of being cut, and it carries the same 2px
  yellow rule as the permission log drawn over the trace's grey one and reaching back 12px —
  one rule that turns yellow where the operator spoke. Every steer stays in the open tail,
  and a finished trace says `· steered` on its folded line so the words cannot vanish.
- **A steer appears when it is sent.** The page paints it into the transcript or the
  trace *before* the request, marked `pending`; a purple dot breathes beside the
  `STEER:` tag, and the rule goes faint, until the model has it. The dot is the same
  "this is still happening" mark a compaction wears, in the operator's own colour —
  the tag alone was too quiet to see. For the Architect the request returns at the
  engine's next step, and the page opens the next post at that moment so the steer
  moves above the thinking pane *then*, not when the step ends. A worker reports
  `run.steer` twice — once when the server took it, once with `delivered` when the
  worker reached the boundary where it reads it. Only the second ends the breath. A
  refusal takes the line off with a toast, and confirmation **adopts** that line
  instead of pushing a second one. A file-only steer has no sentence: the tag and
  its chip are the whole line, and it is still a steer. `steerLine()` in `traces.js`
  builds the text for both sides, because two builders drift by half a character
  and read as duplicates.
- **A compaction is a moment, not a banner.** It wears the tool head's shape — a
  small yellow dot, `Compacting ×2`, and `context at 173K/205K` as the target — because
  that is the row the operator already reads as "something happened here". It has no
  chevron (nothing behind it), 0.8 of the chat type, 2px margins, and it sits above the
  live thinking pane: the transcript moves a compaction message that follows the pane's
  post into that post's tail, before the pane, so it does not sit under the final tool
  card until the turn ends. The line stays there when the pane goes away (25 Nov).
- **A compact leaves the post and nothing else above it.** The post is a `<details>` from
  the session's metadata (`synapse.compacted`), so a reload shows it, and its open state is
  keyed like a reasoning fold's; `forgetConversation(dir, oldSessionId)` drops the fold lines
  and alarms, which were that chat's evidence. A compact is also one quiet line where it
  happened: `⤵ Compacted — the conversation was summarised · 172K prompt, 2K summary`.
- **A compact keeps the unsent box.** `openSession` clears the draft and attachments on a
  normal chat switch because they belong to the chat they were typed in; the replacement a
  compact opens is the same conversation, so it passes `{ keepDraft: true }` and leaves
  both alone (25 Nov). Clearing them made the operator retype the message and re-attach the
  files after every handover.
- **A line that arrives animates.** The conversation is one rebuilt HTML string, so the page
  has to know what is new: every row that can arrive carries its name (`data-line="msg:<id>"`,
  `part:<message>:<index>`, `data-tool-card`, `data-trace`, a trace line's moment plus a
  hash, a permission card's request), and the names are collected before `innerHTML` is
  replaced and compared after. 200ms ease-out, opacity and a 7px `transform` only — **the
  animation must not touch layout**, or it moves the words under the reader's eyes. A row
  inside a new row rides its parent's slide; a row that takes another's place (the local
  echo, the post opened on a turn's first token) or is rebuilt mid-slide keeps the old
  arrival time as a negative `animation-delay` (measured: 70ms in, the successor carried
  `animation-delay: -72ms` and no second slide started); more than eight new rows in one
  draw is history and is drawn plainly; the first draw of another chat is not an arrival.
  `planArrivals` in `web/transcript.js`, tested in `tests/arrivals.test.mjs`.
- **The jump buttons** sit in the transcript's top-right corner, in the same right-anchored
  row as the compact chip at `right: 112px` — the corner covers a sliver of one line where
  the middle of the pane covered two. They anchor on **every** `.msg[data-msg]`, including
  Synapse's reports, and step message by message from an anchor (`navAnchors()`: the last
  message whose top is at or above `scrollTop + 12`), never from the raw offset, because the
  first message sits ~11px below the content top and a "first message below the fold" test
  got stuck. `animateScroll()` is a hand-rolled 280ms ease-out rAF scroll — measured ~289ms
  end to end, about 30% quicker than `behavior: 'smooth'`, whose duration the browser owns.
- **The follow is a gesture, not a geometry.** `CHAT_FOLLOW_SLACK = 48` (two lines) is both
  the window in which a new message pulls the chat down and the meaning of "at the end".
  `followAfterScroll()` is pure: an upward gesture releases the follow and only the reader's
  own downward gesture, or the scrollbar landing at the end, may re-arm it. Geometry alone
  is never evidence, because the pin makes geometry true — the wheel passed `-e.deltaY`
  once, so wheel-up *was* "coming back to the end"; the release waited for a scroll event
  the frame loop had already outrun; the render re-pinned from `chatAtBottom()` alone; and
  `noteChatScroll` re-armed on every frame of an animated wheel, one notch up, pin, one
  notch up, pin. All four are load-bearing. `restoreChatSlack()` snaps a reader within two
  lines flush only while the chat is following; once they have taken over, their two lines
  are two lines.
- **A render never moves the page; only Send and opening a session do.** Every scroll helper
  goes through `chatScroller()`, which returns the transcript when it scrolls and `null`
  otherwise — never a fallback to the document's bottom, which is the rail under the chat.
  Opening a session puts the transcript at its end once after `loadMessages()`, and does not
  move the page.
- **The composer.** `Ctrl+Enter` sends and `Enter` is a newline (the textarea's title says
  so). There is **no target picker**: every message goes to the Architect, and the target is
  derived — while a run is live the button says **Steer** and the placeholder reads
  `Message <role> — seen at its next step` or `Message the Architect — seen mid-turn`; at
  rest it reads `CTRL+Enter to send`. `field-sizing: content` sizes the box (see Traps). Stop
  is enabled by `state.busy`, `currentRun()`, `state.canStop`, `state.compacting` or a lease
  wait — it is the way out of everything.
- **A file card is a door.** Right-clicking a tool card that named a `filePath`/`path` offers
  exactly **Open File** and **Open Folder**; a picture chip with a project-relative path does
  too. The server resolves the path against the project and refuses anything outside it —
  the model's string reaches `explorer.exe`, so the project fence is the permission. Open
  Folder passes `/select,<path>` as one argument, because Explorer treats a separated
  `/select,` as "open the folder" and selects nothing.
- **The whole chat takes a dropped file.** Drag from Explorer onto the transcript or the
  composer and it lands in the same attachment strip as the paperclip and Ctrl+V, under the
  same 8MB/48MB/24-file rules. The dock is the target, not the one-line box: aiming at a text
  field first is precision the rest of the page never asks for. The target only lights while
  the composer can take the file; a question, a permission or a compaction closes both doors
  together. A file dropped outside the dock is swallowed too, so the WebView2 never navigates
  to it and replaces the app.
- **Selected chat text can go back into the chat.** The right-click menu adds **Copy Into
  Chat** when the composer is available, and puts the selection at the caret (or appends it);
  when a question panel is up it checks **Something Else** on the current page and appends
  the text there. The menu item is absent, not disabled, when there is nowhere for the text
  to land.
- **Markdown is hand-rolled and escape-first** (`web/md.js`): the source is HTML-escaped
  before any rule runs, and link targets are limited to `http(s)`, `mailto`, `/` and `#`,
  images additionally `data:image/`. Fenced code, headings, GFM tables with alignment,
  blockquotes, both list kinds, task lists, images, rules and paragraphs are covered. Tables
  **wrap, never scroll** — `.msg-answer th/td` is `white-space: normal` + `overflow-wrap:
  anywhere`, because the baseline's `nowrap` ran a nine-column report off the chat.
- **A picture is a chip and the picture is the hover.** A project-relative markdown image is
  one violet chip in the sentence; hovering shows it centred above the chip. `/api/image`
  serves only images inside the projects root (no SVG, 24MB cap, realpath checked). Inline
  put a wall of chat on screen for every screenshot.

## The live pane

- **Eleven lines, one text node, one transform.** `calc(11 * 1.45em)` tall, so it scales
  with `--chat-fs`; the words inside are moved by `transform`, which is compositor work and
  invalidates no layout. The top edge fades only while text leaves through it
  (`is-scrolling`), because a hard cut reads as the box eating the text; the bottom stays
  crisp. The text is **appended, never rewritten**, and cut on a line boundary; a finished
  step keeps its last window, dimmed (`.is-idle`), until the next block replaces it or the
  run folds — taking it away pulled eleven lines out of the chat and put them back.
- **The tail is trimmed in one chunk.** `PANE_MAX = 12000`, `PANE_KEEP = 9000`
  (`web/thinking-pane.js`): keeping exactly the cap means the next character trims again,
  a full rewrite every frame for the rest of the step. One block reached 43,526 characters
  in a single turn, which is what made the rule.
- **The slide is one exponential ease, not a spring.** `paneEase` with τ = 120ms
  (`TAU = 0.12`), snapped below 0.5px, integrated against the real frame time; half a
  second lands within 5% of the end and it arrives exactly, so the loop can stop. The old
  stream-view spring (stiffness 90, damping 18, 8ms sub-steps) went with the file that held
  it; `tests/thinking-pane.test.mjs` holds the ease, the trim, the end and the wheel.
- **The pane's end is its last word.** The model writes a paragraph break before the
  paragraph, so the newest text ends in `\n\n` until the next words start; those lines are
  part of the body, the follow pins the body's bottom, and the words sat two or three lines
  above it with empty space under them, so the pane looked scrolled past its own text
  (measured: each trailing newline was 20px of body). `paneShown` trims the **display**,
  never `s.text` — the stream keeps its newlines because the next words need them.
- **A downward wheel while following never takes the pane.** At 100+ tokens a second the
  slide is hundreds of pixels behind the end, so there *is* a position below the follow and
  `takeOver` used to move there on a wheel the operator was using to keep up. `wheelIntent`
  answers: downward while following is `stay` (swallowed), upward is `read`, and the top of
  a read pane hands the wheel back to the conversation. The wheel decides **where** to be;
  `paneShown` decides what the end **is**.
- **A pane belongs to a turn, not to a chat.** `openSession` starts with no pane; it is
  drawn only while the turn is live (`state.busy`, or a newest assistant message the engine
  has not completed, via `web/turn-live.js`), and a delta for a finished turn is refused —
  a finished turn's reasoning is its folds above the post. `busyNow()` reads the engine's
  active list rather than the transcript, because a step's message completes when it issues
  its tool call and the tool then runs for ten seconds, so reading `busy` out of the
  transcript dropped the pane after every tool call. `turnOver()` ends the turn on
  succeeded, failed and `session.idle`, and **not** on an interrupt: the engine interrupts
  and starts the next execution in the same millisecond.
- **Once `reserved`, the pane stays until the turn ends.** Hiding it when the step's message
  carried the same words was right for a duplicate and wrong for a full pane: hiding and
  redrawing moved the chat eleven lines twice a step. It is placed by `panePostIndex()` —
  the newest Assistant post, whatever follows it — not by "the newest post is last", which a
  compaction line or a harness message broke for one render.
- **A rebuild must put the slide back.** The offset is a transform on the text node and
  `renderTranscript()` replaces the node, so `restoreStreamView()` re-applies the offset and
  the fade after every render: **a transform is DOM, not state**, and anything that rebuilds
  the node has to restore it. `adoptStream()` also reconciles — a different block is
  replaced, a prefix gets only its tail, an identical string writes nothing.
- **The Architect's pane is inside its own post.** `.trace.is-own` drops the head line and
  the left rule only: the 11-line box, its hairline, radius and padding stay, because
  stripping the box too left a wall of italic text with no edge (1.13.4, restored 2 Nov). A
  worker's finished thinking is a fold inside its trace (last twelve,
  `data/trace-reasons.json`, pruned at boot to forty runs) and is posted to
  `/api/runs/reason`, so a reload and a second view get it back.
- **A step with no run still has somewhere to put its words.** `appendStream()` looked its
  trace up with `traceOf(currentRun())`, and the Architect's own turn has no run, so every
  delta was dropped and the wall arrived with the message. `liveTrace()` answers "whose
  writing is this": the live run's trace, else the open session's own (`sess:<id>`). The pane
  is hidden once the step's message carries the same words, and the session stream is cleared
  on `session.execution.ended`.
- **A compaction says how full the window was while it runs** —
  `⏳ Compacting ×3 · context at 47K/205K` — from the last prompt the run reported, handed to
  the trace with `session.compaction.started`. The finished line keeps the engine's number.

## The ask panel

A model asking the operator something is not a chat message — it is a blocked session.
It renders as **the last post in the conversation**, in the chat's own colours with an
orange border, above a composer switched off until it is answered. It used to be a panel
painted over the chat, and that covered the very reply the question was about: answering
meant guessing what had been said.

- **A post in flow, moved never rebuilt.** `renderTranscript()` replaces the transcript's
  markup on every change, so an element living inside it would be destroyed — and its
  radios, its page and its focus with it. `#askHost` is created in the shell and
  `mountAskPost()` appends the *same node* as the transcript's last child after each
  render, which is what lets the polling rule below work.
- **It posts whole: no cap, no inner scroll.** No `max-height`, `.ask-fields` does not
  scroll, and if it is taller than the chat the chat scrolls, as for any long message — a
  question you scroll *inside* a box inside a chat is a question with two scrollbars. The
  head is **flush** (`padding-right: 0`); the 104px reserve for the floating jump buttons
  was a gap for a control the operator did not want there.
- **It opens at the end, under the report that raised it.** `askScrollTop()` puts the
  panel's bottom at the end of the chat with the report above it. Scrolling to the panel's
  *top* put the whole report above the fold, so the operator answered a question about a
  report they only saw once the panel was gone (18 Nov); the follow is not cut, so a report
  the poll has not fetched yet settles above the panel. A panel taller than the chat is the
  one case where both cannot be shown, and then its head goes to the top: a list of answers
  with the question above the fold is the bug.
- **The report must be in the page before the panel is placed.** Three things could keep it
  out, and all three are closed: the pending poll and the message poll are separate timers,
  so `renderAskPanel` asks for the transcript (`loadMessages()`) and only then places; the
  transcript's "nothing changed" signature compared part *counts*, so a report growing
  inside an existing part never redrew (a live message's text length is part of it); and
  two fetches could land out of order, the older snapshot last — only the newest answer may
  write `state.messages` (`messagesAsked`). The blocked turn has no later event to refetch.
- **It is per chat, and a chat switch redraws it.** `currentForm()` takes this session's
  form, then a form from a worker session in the same project folder, and nothing else —
  one project's question used to fall back into another's panel. Because the node is moved
  and never rebuilt, opening another chat calls `renderAskPanel()` explicitly: the poll's
  signature can be unchanged and the old question would still be mounted under the new
  report.
- **A worker can ask too,** and the head says where it came from —
  `asked in another chat — open that chat to answer`, or `a worker is waiting — answer here
  to continue` for a worker in this one. The wording lives in `web/ask-note.js`, not a
  template string, because the first version said `another chat is waiting on you · full
  auto answers on its next check`: false under Full auto, and "check" is engine vocabulary
  for a poll nobody sees. **Any** pending question blocks the composer, whoever asked it.
- **The composer is disabled while a question waits** and says `Answer the question to
  continue`; Attach, the mode switch and the run menu go with it, because a half-dead
  composer invites a click that goes nowhere. **Stop stays live** — it is the way out of a
  question nobody can answer, and the engine treats it as the immediate stop.
- **A question can carry files.** The panel has its own strip, under the composer's rules
  (8 MB each, 48 MB total, 24 files), with the Attach button, paste and a drop anywhere on
  the panel. The engine's `Form.Reply` accepts an `answer` and nothing else, so the files
  cannot ride the reply: they follow as a short steer once the answer settles, and an
  Architect whose turn already ended gets them as a message instead. A worker's form gets
  the steer only — a message into that session would brief it as the Architect. There is no
  Keep box in the panel for the same reason the engine has no file field: a steer does not
  go through the chat's kept-copy path, and a checkbox that only sometimes kept the file
  would be a lie. The strip is empty on a new form and survives a poll of the same one.
- **A new question takes the chat's place:** on a new form signature the page arms the
  follow and scrolls to the end, because that is what the run is waiting on; otherwise the
  reader's position is respected. **A form opens the dock** — `has-history` holds while a
  form is pending, or a fresh session's strip of composer squeezes the panel to 64px with
  its action row outside it.
- **One question per page, and paging hides by class.** `Question 2 of 5` in the action row,
  `Back` from the second page, the orange fill only on the last page's **Submit Answer**;
  `Next` is gated on *that* page's required fields and says "Answer this question to
  continue.", while Submit speaks for the whole form ("Answer every required question to
  send.") — a warning about a question further down, while Next is available, is a warning
  about something not on screen. A one-question form keeps the old shape: no counter, no
  paging, just Submit. **Never `hidden`:** `hidden` belongs to the engine's `when` rules and
  `collectAskAnswer()` skips a hidden field, so paging with it would silently drop every
  answer already given. Verified on a fabricated three-question form: paged 1 → 2 → 3, back
  to 2, across a poll boundary, and the reply still carried
  `{stack:"page", features:["sky","quote","world"], skin:"warm"}`.
- **It is polled, so it must never rebuild for nothing.** `refreshPending` runs every 8s;
  rebuilding the panel threw away answers already given (reproduced: pick a radio, wait for
  the poll, the radio cleared and Submit disabled itself again). `state.askSig` is the
  form's id plus its fields and option values — nothing about the answers — and an unchanged
  signature only re-places the panel. One level up, `paneSig()` (permission ids, form ids,
  busy, canStop, the busy reason) is compared before and after the poll, and an unchanged
  poll paints nothing: a rebuild is not free just because its output is identical.
- **Orange marks the panel; it does not fill it.** Orange is the border, the head's title,
  the waiting dot, the required mark, the Recommended chip, the radio/checkbox accent and
  the Submit fill — nothing else. The surface, the question text and the option rows are the
  ordinary colours, the rows divided by neutral hairlines (one above every row, the first
  included), and the picked row marked by a lifted background and a white label, never an
  orange wash. The first version was orange all the way down and was pulled back the same
  day.
- **Type:** question **15px** bold (the one thing read standing up; "three points larger" is
  4px in CSS, and 15 is where it settled), head title **11.5px** bold upper case, field
  title **12.5px**, option label **12.5px**, description **10.5px** muted, Required mark and
  Recommended chip **9px**, radio 13px. Descriptions are the model's own reasoning about
  each choice and are most of the value, so they are never dropped.
- **The engine's `header` is a heading only when it separates questions** — a short label
  for telling several apart. A one-field form drops it and leads with the question text,
  because models write slugs there ("--reverse meaning"). A title equal to the description
  is skipped, or the question prints twice.
- **`custom: true` becomes "Something Else…"**: a radio/checkbox row with a text input that
  stays disabled until that row is picked and whose text becomes the answer, on its own
  line, the box indented 21px to the label column.
- **"(Recommended)" becomes a chip.** The question tool's convention is the recommendation
  first, its label ending " (Recommended)"; the panel strips the suffix and shows a chip,
  and the role brief tells both roles to write it that way.
- **The countdown runs on server time.** The head used to say "Auto-Answer replies in 30s"
  and the 30 never moved, so a broken sweep looked like one about to fire. The server says
  *when* (`autoAnswerAt`, from the moment its sweep first saw the form) and the page ticks
  that one line down, writing only it — never rebuilding the panel.

## The permission card

The card sits in the transcript and the engine blocks the session until it is answered.
It says, in words read once: **who** is asking — the role's own name ("Coder 1", "The
Architect") with the task id on the right — **what it wants to do** ("Coder 1 wants to
change a file outside this project"), the exact path or command, and **why** it has to ask
("Only the project may be changed without asking. This is not in it.").

Never say "The AI", and never phrase the policy as something the operator did: "The AI"
hides which of the six roles is blocked, and "outside your workspace" reads as the operator
being somewhere they shouldn't. The policy returns a `scope` (project, outside, harness,
secret, unknown) and role-neutral reasons, and the card puts the role name in front.

Every card also says **Nothing has happened yet. You can still say no.** The buttons stand
in one row at the bottom left, each with its consequence as a hover tooltip — "Reject"
alone does not say whether the role stops or carries on:

| button | colour | what pressing it does |
|---|---|---|
| Allow Once | green | does it this time only; the next one asks again |
| Always Allow | amber | does it, and remembers this exact path or command for the session |
| Reject | amber | says no; the role is told and carries on |
| Reject With Reason | amber | says no in the operator's own words, typed in a small dialog |
| Stop Run | red | ends the work, not just the request |

A **screen** request (`scope: 'desk'`) and a **browser sign-in** (`scope: 'browser'`) are a
different question from a file — the operator's mouse, keyboard and focus, answered for the
run — so they get `Allow Screen` / `Allow Sign-In` and **no Always Allow**.

- **Always Allow is ours, not the engine's.** The engine's `always` reply saves the
  request's `save` patterns for the whole project, and for an edit those are `*`, so one
  click would let the model edit anything, Synapse included. Synapse answers `once` and
  keeps its own narrow memory: same action, same exact resource, this session, and it can
  only turn an `ask` into an allow — never a `deny`.
- **A click that wakes the window is not an answer — unless the card was already there.**
  Clicking an unfocused window brings it forward *and* delivers the click to the page; on
  30 Oct a card "disappeared before I could answer" because it had just appeared under the
  pointer and the wake click hit Always Allow. A permission control ignores a wake click
  only when the card was drawn in the last **two seconds** (`Date.now() - seen < 2000`) and
  the focus arrived under **400ms** ago; a card that has been waiting has been read.
  Keyboard activation is never a wake click (`e.detail === 0`), and the refused click
  leaves a one-line note on the card instead of a toast — the click after it is taken.
- **Every answer is logged** with the page, the button, the role and the request
  (`permission allowed in the page by ANDREWS (coder-1): … — Always Allow`), so an answered
  card never looks like one that vanished.
- **A worker's request is shown too — in its own project's chat.** A worker session is
  hidden from the rail, so filtering to the open *session* left it blocking until its
  timeout with nothing on screen. The filter is the project's **folder**, not the session
  id: the Architect's turn and its workers share one chat, so both are shown there, while
  another project's card belongs to that project's chat and is announced by its rail row
  and a toast.
- **An auto-answered request must not flash.** The card is drawn after a 200ms refresh, not
  painted from the event. The delay alone was not enough: the engine lists a request as
  pending from the moment it raises it, so a poll could catch one the gate was mid-answer —
  a run with every call allowed looked like a stream of permissions appearing and vanishing.
  The gate marks the requests it is judging (`answering`), `GET /api/pending` skips those
  and anything decided, and only a request really waiting on the operator reaches the page.
- **The chip on a tool call is the same record after the fact**, and four states must stay
  distinct or it is decoration: inside the project → no chip; outside and auto-allowed →
  green; outside and answered by the operator → amber; refused by anyone → red. Hovering
  says who asked, what was asked, the policy's reason and who decided. The record is memory
  only, so a restart clears the chips and nothing else.

## The model picker

- **The hidden `<select>` is the truth.** Each `.role-model` stays in the DOM as the source
  of every handler and is `display: none`; a `.model-search` input plus one shared
  `#modelMenu` drives it. **Typing only filters** (name or ref substring); a model is set
  only by choosing a row, `Enter` on the active row, or Escape to revert. Never make the
  typed text the value.
- **The name is shown whole.** The picker used to strip "free" and cut at 28 characters
  because a `<select>` cannot ellipsize, so `Beam Free` read `Beam`. The menu sizes to its
  content instead: `width: max-content`, a **320px floor** and a **560px cap** — measured
  **484px** on a catalog whose longest row is
  `qwen3.8-9b-distill-slerp-f451-pro-writer-uncensored` plus an ISSUES chip, no row clipped.
  The card's own box still ellipsizes: it has a tooltip, and the list is where the choice
  happens.
- **The menu is fixed and clamped.** `position: fixed` so it escapes the cards' clipped
  wrapper — which also meant nothing clamped it until `positionModelMenu` did: measure from
  a known left edge **first** (a stale `left` near the right edge makes shrink-to-fit report
  a narrower menu than it can be), set `min-width` 320 capped at `min(560, vw - 16)`, clamp
  `left` into `[8, vw - 8 - w]`, open **upward** when there is under 180px below and more
  room above, and take `max-height` from the space it has (80–300px) with the list scrolling
  inside. Measured: 1200×900 right edge 1192 of 1200; 900×700 with the input off-screen at
  1008 → menu `572…892`; 900×460 opens up (top 108, bottom 339); 900×300 → `max-height` 164,
  `scrollHeight` 229, `maxScroll` 67. Scroll and resize reposition it; the arrow keys
  already call `scrollIntoView({block:'nearest'})`.
- **Rows are compact (22px) and carry a source chip** — the provider id is part of a model's
  identity, so `OpenCode` and `OpenCode Go` read differently. A 1px `--line` rule separates
  sources, inserted only where `m.provider` changes and outside `.model-opt`, so `menuRefs`
  stays aligned with the options. The order is the operator's own, from Settings →
  Providers.
- **The ISSUES badge is the model's, not the role's**, and a model change does not clear it.
  It clears when the model delivers — a run that completes — or by hand in the picker. A
  clean probe does not clear it: a test is not work.
- **The effort button** shows 1–3 stacked **green** chevrons: a dot for the engine default,
  one chevron per variant the model allows. One inline SVG per level with integer-spaced
  paths — three separate SVGs with fractional negative margins rounded unevenly and the gaps
  read differently. Strokes with round caps, not a font and not rotated bordered boxes
  (those alias into odd shapes at 22px); both glyphs are centred on the 22px button to
  within 0.01px, with ~1.5px of margin at three chevrons. Click cycles default → lowest →
  … → highest → default; the tooltip is `Current thinking effort: <label>` where `<label>`
  is the provider's own `reasoningEffort`, never our id. Two variants get two chevrons, and
  none gets a disabled button.
- **A model change is a repair.** It clears the red provider line for that role and lifts
  the project hold — otherwise a Stop or a failed model outlives the fix, with the picker
  showing a healthy model while every delegation is refused. The hold also lifts on an
  operator message and on keep-building on; those three are the only exits. The select must
  be updated **before** the card re-renders, because `renderRoleActivity` reads the refused
  mark from that value.
- **A model change also ends a wait.** A role asleep in a provider backoff is waiting on a
  clock the operator has just made irrelevant: saving a new model wakes the run at once,
  moves the session to the new model (the ref *and* its variant), nudges it to carry on, and
  starts the backoff short again. It is a wake, not a stop; the Architect's own retry loop is
  woken the same way.
- **The ladder has the matching rule on the server:** a stop or a restart is not a failed
  attempt, and a task planned for a role whose model changed starts over on that role
  instead of stepping down to the next coder.

## The rail, the plan and Settings

- **The rail is a list of projects, one row each.** Clicking a row opens the project's
  one conversation; double-clicking it opens the folder, the same as Browse. The menu — the
  `⋯` or Shift+F10 — offers Browse, Cmd, Rename, Delete and **Move Up / Move Down**, the ends
  disabled rather than a click that does nothing. A right-click is the page's text menu
  instead (Copy, Select All, Copy Into Chat), never this project menu. The two clicks of a
  double-click can arrive before the first open has returned, so `openProjectChat` remembers
  the project it is already opening; otherwise a project with no chat would make two.
- **The order is the registry file**, written in the order shown, a new project appended.
  Nothing is sorted by name: a rename must not move a row the operator is looking for. The
  model menu follows the provider order set in Settings for the same reason.
- **The one dot left is a red stall mark**, clickable to interrupt. Green "has a
  conversation" and amber "working" went because the row already says both; a stall is
  rare enough that its absence need not reserve a 7px hole in every row.
- **No prefill, in any field.** The app would remember project names, addresses and paths
  typed once by mistake and offer them back. `autocomplete=off` is set at boot, on focus
  and on every DOM change, and WebView2's form and password stores are off in `MainWindow`.
- **The plan pane prints the plan, not the plan's homework.** The validator's yellow lines
  were the Architect being talked to, and every one was already in its own instruction
  block; they stay in `logs\app.log` (`logPlanState`). A plan that cannot be read is still
  shown, because the operator needs that one. The rule for any yellow text: either it is
  the operator's to act on, in short common English, or it is not on screen.
- **Plan rows:** goal **11px**, step title **11.5px** clamped to three lines, step id
  **9.5px** centred under its dot, blocked note **2 lines** with the whole reason in the
  tooltip. Dot and id stack on one axis and the row is centred, so a one-, two- or
  three-line title sits level with the dot. Each step's stopwatch lives in a right-hand
  column (`plan-side`), so the row is as tall as the stack whatever the title does — no
  `min-height` guessing. A step nobody ran hides its zeros; a row the Architect settled
  itself says **not run** rather than showing an absent clock. The same `spent` drives the
  row's review mark, so a task done by an earlier session does not open this one dashed.
- **A cut row must read as "more below".** `.rail-plan::after` fades the bottom edge into
  the panel while `updatePlanOverflow()` reports something still below — on repaint,
  resize, the plan's own scroll and when the cards settle. A hard line through a card looks
  like clipping; a fade looks like scrolling. A panel's scroller must not be scoped to
  where the panel used to live: `.inspector .rail-panel …` stopped matching when it moved.
- **Three stopwatches, all client-side:** `HH:MM:SS / HH:MM:SS` on each card (the current
  task, then the role's total for this session) and the session's total in the plan footer.
  They derive from what the cards already show, so waiting on a question, a permission or a
  finished plan stops them without inventing a second notion of "working". Totals live in
  `localStorage` keyed by session id, and the current interval restarts from now on reload,
  because time with the page closed is not time measured. The clock is advanced from the
  **session's** busy state (`advanceClock` in `web/clocks.js`), not from the cards in the
  DOM, or opening another project stopped the Architect's clock.
- **The plan footer is only the clock.** The `tok/s` label beside it was removed on
  **17 Nov** because it read as a stray value under the chat and duplicated the role cards;
  `planRate` no longer exists anywhere in `web/`, and Single mode has no rate row at all.
  The card's rate row is the run's average plus a window, with the cache share in the
  tooltip — which is what left the line 132px at the narrowest card, where a four-digit
  rate and an "M" window still fit.
- **Countdowns run on server time.** Both compared a timestamp the server wrote with
  `Date.now()` on the page; on a laptop those are two clocks, and a card that had just
  appeared said "picked now" in the other room. Every response's `Date` header is read into
  `state.clockSkew` and the countdowns use `serverNow()`.
- **Settings has twelve tabs**: General, Server, Engine, Browser, Providers, Workers, Tools,
  Automation, Prohibited, Logging, Check for Updates, About. There is no "Runtime" tab — it
  is **Engine** — and Updates/About are those last two, not extra screens. A tab is a
  *subject*, not a field: Notices held one sound, moved into General, and Automation
  replaced it. Browser is SynaBrowse: it ships on, so there is no enable switch and no
  engine/profile field — a close-after field and a Signed
  In table in the Prohibited table's shape, whose last row *is* the form (an address typed
  in the site column, `Sign In…` in place of "last used"). A row becomes real only after
  the window is closed and the address opened once more, hidden, to confirm it no longer
  asks for a password; it shows an age, not a countdown, and `✕` clears that host's cookies
  as it removes the row.
- **Settings geometry and footer.** Window `min(980px, 100%)`, rail `176px`, 15px inline
  SVG icons, 12.5px labels, the active tab a violet fill with white text and icon.
  **Every tab wears the footer** — Cancel, Revert, Apply and one primary whose label says
  what it does: `Close`, `Save & Close` or `Save & Restart`; with nothing to save the first
  three are disabled. About is the one exception: a credits card with its own Close, not a
  form. A window that keeps its furniture everywhere except one room makes that room look
  like a screenshot.
- **Every pane edits a draft that survives a tab switch.** `collectSettings()` runs on every
  tab change into `state.setDraft` (a deep copy taken when the window opens); nothing
  reaches the file until Save, so Revert is exactly "throw the copy away". A provider is the
  one thing that is not a `data-path` field: an object in a list, typed into the draft.
- **Every control carries a plain-English tooltip, and units live in the label.** Long
  durations show in **minutes** (`data-scale` converts on read and save): "20" beside
  "Restart after silence (minutes)" is a decision, where "1200" was a number nobody could
  read. A pane has **at most one short visible line**, and only for what would bite.
- **A field that needs a restart says so, and the save dialog asks only then.** Server
  host/port, the engine's port, binary, home, password, start timeout and extra skill
  folders carry a grey `RESTART` chip, and the Providers heading carries one for the
  section (`restartNeeded()` lists the same paths by name). Everything else is read when it
  is used, so saving it is done and no dialog appears. A save that does need a restart ends
  in a dialog with three answers — **Restart Now**, **Revert All Changes** (red) and
  dismiss — because "Restart Synapse to apply" was a toast the operator could only answer
  by leaving the app. The restart is the app's: the server exits with code 2 and the app
  starts a new one, and the window, tray and page all survive.
- **A key is shown masked, and only while typed or deliberately revealed.**
  `sk-live-0123…7df` renders as `sk-liv***7df` — enough to tell two keys apart, never
  enough to use one. The eye is a drawn SVG at 14px in yellow, toggling a `type`-less text
  field rather than password dots, because a row of dots cannot answer "is the right key in
  there". Focusing selects, leaving re-masks, and `env:NAME` shows the variable, no eye.
- **Provider badges are a fixed vocabulary, and local is not a vendor.** Two engine badges,
  **OC Zen** (`opencode`) and **OC Go** (`opencode-go`); a configured provider is **Local**
  when it points at this machine, whatever runs it, or its own name otherwise.
  `providerLabel()` asks the config for the type, never the vendor. A provider's id is
  derived once from its name and then locked, because model refs are `provider/model` and a
  moving id would strand every role's choice; duplicate names get `-2`, in `src/config.js`.
- **A modal owns the wheel.** `body:has(.modal-backdrop:not([hidden])) { overflow: hidden }`
  plus `overscroll-behavior: contain` on the backdrop and `.settings-body`; without it the
  settings list reached its end and the page beneath carried on scrolling, which reads as
  the dialog jumping. Measured before: 877px of page content in a 620px viewport with the
  list already at its end; after: `scrollY` stays 0, and the page's `scrollbar-gutter:
  stable` means hiding the bar moves nothing.
- **A dialog is a layer.** Controls either side of a backdrop are not a row: the audit asks
  the browser what is on top at a control's centre (`document.elementFromPoint`) and groups
  only same-layer controls, because the Settings footer came within a row of the sidebar's
  Settings link behind the backdrop and read as a finding.

## Type and colour rules

- **One transcript size: `--chat-fs`.** Every size inside the transcript is a multiple of
  it. A rule that kept a fixed px size would stop following the setting while its
  neighbours scaled — the role label leaves its clock's centre line, a code span sinks into
  the prose, a table breaks its column. The change touched 41 declarations, and
  `tests/chat-text.test.mjs` fails if any rule in the transcript's selector families
  (`msg`, `chat-post`, `trace`, `reasoning`, `tool-card`, `perm-card`, `state-pill`,
  `chat-alarm`) carries a `font-size` in px again, or a literal 18.75px box.
- **The bounds are in two places on purpose.** 10–20px in whole pixels, default **13**: the
  form (`web/settings-panes.js`) and the config (`src/config.js`, `CHAT_TEXT_MIN` /
  `CHAT_TEXT_MAX`) both clamp, because a hand-edited file must not make the chat unreadable
  or push the composer off a 900px window. 10 is the floor the operator asked for; 20 is
  the largest that still leaves a full answer above the composer. The control is a slider
  (violet fill behind the thumb, tabular value, one notch per step), and Ctrl+wheel, Ctrl+±
  and Ctrl+0 belong to the page (`web/chat-zoom.js`) with `IsZoomControlEnabled = false` in
  the shell, so WebView2's zoom cannot answer the same gesture and grow the whole interface
  while `ui.chatTextPx` stays put. A chip says `Chat text 15 px`, or `· largest` /
  `· smallest` at an end; every notch applies at once, the config is written 600ms after
  the last, and a gesture while Settings is open moves the draft too, or Save undoes it.
- **Tables inherit the chat's size.** The locked baseline sets `th { font-size: 9px }` and
  `td { font-size: 10px }`, and a direct element rule beats an inherited size, so a chat
  table stayed at 9 and 10px while the prose scaled. `#transcript th, #transcript td
  { font-size: inherit }`, held by the same test.
- **A chip inside a text slot inherits its line-height, and that is what de-centres it.**
  `Done` sits in a slot whose `line-height` is 1.45, so its box was the *line box*
  (13.775px) plus padding while its text is 9.5px. `line-height: 1` gives it a box the size
  of its own text; the rest is optical — **uppercase has no descenders, so centring the em
  box reads half a pixel high** — and the answer is one pixel more padding above than below
  (`.role-done` / `.role-waiting` `3.75px 7px 1.25px`, `.ask-rec` `2.5px 6px 0.5px`).
  Settle it with a **4× render and a 1px line at 50% of the pill**, which is what the eye
  compares; two earlier "centred" versions passed two metrics and still looked high.
- **Two type sizes in one row put two baselines in it.** The tool head was 0.84 of the chat
  size and the name 0.888, and `align-items: center` centres boxes, so two line boxes of
  different heights sat about a pixel apart. One size, and the name's baseline is the
  target's to the pixel (measured: both 10.92px in a 16.38px box, same top).
- **Alignment is the baseline, not a number.** The steer's "You" was nudged twice, by a
  pixel and then 0.23em, and each time it looked right at the size measured and wrong at
  the next: the gap between a box's centre and an uppercase word's visual centre depends on
  the font *and* the chat size. The row is a flex row with `align-items: baseline` and the
  label a plain inline box; the only correction left is 4% of the type size below the
  baseline, the same fraction at every size. Chips and the Reuse pill centre on the line,
  because a bordered box has no baseline worth trusting.
- **One chevron for every fold:** `▸`/`▾` at 1.3em, line-height 1.15, in the same absolute
  16px slot, so the first glyph of an alarm is on the column of every other fold's first
  glyph. A 0.8em marker in the line's flow was a speck beside a red word and pushed the
  text right by its own width.
- **Two rules are one too many.** The refused message wore the post's amber rule *and* the
  message's red one, 17px apart, which read as a bracket. The post's rule and its 10px
  indent are off the refusal, so the PROHIBITED line starts on the speaker's own column and
  the opened sentence's rule gets 10px of air from its text.
- **The chat's cells are one column of type.** A compacted line that wore mono,
  `letter-spacing: 0.04em` and 0.8 of the chat size read as a code label in a conversation;
  it takes the chat's own type at 0.96, the size every fold uses, and the reasoning fold's
  marker to the letter.

## Traps

- **A comment is code.** A comment above `.chat-alarm` lost its opening `/*` in an
  earlier edit, so the browser parsed four prose lines as CSS and dropped the rule that
  followed: every declaration in `.chat-alarm` was dead, including the flex row holding
  the mark and its text, which is why a red line wrapped off the edge while a shorter
  one beside it ellipsised. Find it by asking the browser which selectors it actually
  has — `.chat-alarm { … }` was missing from `document.styleSheets` while
  `.chat-alarm-mark` was present — never by reading the file. A file is worth a
  structural check: braces balanced, no declaration at brace depth 0 (a paste once left
  `.trace-role { }` empty with its four declarations on the next line, outside the
  braces, and every one was dropped without a word).
- **`display: revert` does not mean "back to my stylesheet".** It rolls back to the
  USER-AGENT value — `block` for `<article>` — so every worker card silently stopped
  being a grid item; the visible symptom was a missing 8px gap that had never applied
  (measured 0). Worse, the show-rule written to replace it lost to the hide-rule's
  `:not()` specificity, so Multi showed no worker cards at all. Hide conditionally
  (`body[data-view="session"]:not(.workers-on) …`) and let each element keep its own
  display. Check the *computed* display, not the class list.
- **`scrollHeight` rounds down**, so a 241.06px topology under a 241px cap has an
  overflow that is invisible and real — and grew a hairline scrollbar. Measure the real
  box and round **up** (`Math.ceil`) when a cap must clear its content.
- **`margin: 0 auto` on a flex item makes it shrink-to-fit.** It is the reason the whole
  room sized itself to its content: Multi looked fine and Single collapsed to ~380px
  and drifted right. `width: 100%; margin: 0` and a `max-width` on the room.
- **A floor taller than the room does not grow the room.** `min-height: clamp(150px,
  32vh, 360px)` on the chat was written for a content-sized layout; inside a definite
  row it did not enlarge anything — the transcript sat 31.5px lower than its own row,
  behind the composer, on a 1369×770 window (214.9px of room against a 246.4px floor).
  A height fit has to honour a floor by making the whole dock overflow the page, not by
  letting the transcript overflow the dock.
- **`field-sizing` instead of measuring a textarea by shrinking it.** `height: auto`,
  read `scrollHeight`, write it back leaves the composer one line tall for an instant,
  and the browser **clamps the chat's scroll offset** to the new maximum — the clamp is
  not undone when the height returns. Measured on a 42-message transcript at 1280px:
  offset 3143 (exactly the end) → 3110 while the box was 33px short → still 3110 after
  the height went back, and still 3110 half a second later. Typing made the chat move up
  and down by about half a line, at random intervals, because the next pin wrote the
  end back and the next keystroke clamped it again — **the trigger is the measurement,
  not the growth**. `field-sizing: content` sizes the box in the same layout pass, so
  there is no transient box to clamp; engines without it may measure the old way only
  with the offset saved and restored. Verified by typing 1521 characters at 30ms a
  keystroke, at 1280 and 500px: the box grew 38.3 → 54.5 → … → 150px and stopped, the
  transcript followed exactly, and the offset changed on **8** frames out of ~1200, one
  per wrap, every one downward — where before it produced a +14/−14 pair per wrap.
- **`getComputedStyle().height` reports the used height, never `auto`.** Capping a box
  against it collapsed the card stack to its first 48px child and left the workers clipped
  behind the chat while Multi appeared to do nothing. If a rule needs to know which layout
  it is in, test the media query, not a computed box.
- **A scroll event from our own write is not the reader's place.** The event is
  dispatched after the frame's layout, so measuring the distance from the end then
  reads a box that has already changed again — every reading a little larger than the
  last, and over one switch a 300px scroll-up compounded to 496px, drifting the chat
  196px under the reader. Writes record the offset they landed on (`chatScrollWritten`)
  and a scroll event matching it is ignored. Tracking the *height change* instead and
  adding it to the offset is the same class of bug: correct once, double-counted the
  moment two paths see one change (12px, then 1px, then 1px — each caller's share).
- **`ResizeObserver` reports after the layout that changed it; rAF runs before paint.**
  When a settle has to land before the frame is drawn, an observer is a frame late and
  every frame paints once at the old offset — invisible in one layout, a shimmer on the
  text in the other. Conversely an observer is exactly right when the job is "something
  above me changed size".
- **`scroll` does not bubble.** A listener on `window` without `capture: true` hears
  only the page, never the transcript — which is the register-you-want for a menu that
  must close "when the page moves" (a capture-phase handler on `window` was dismissing
  the run menu the instant it opened, because the transcript scrolls on every streamed
  line) and the opposite of what a hover preview needs (a chip scrolled out from under a
  still pointer keeps the pointer, because Chromium only dispatches `mouseleave` when the
  pointer moves — so the preview closes on any scroll, wheel or resize, with
  `capture: true`).
- **`hidden` belongs to the engine; paging belongs to a class.** `collectAskAnswer()`
  skips a hidden field, so paging with `hidden` silently drops answers already given.
  `.ask-field.ask-page-off { display: none }` instead.
- **`:empty::after` is for placeholders, never for live text.** A mock that writes text
  into a label the app repaints on a timer makes the label flicker between two writers;
  a CSS placeholder loses the moment the app writes. A fixed grid row is the honest way
  to make cards the same height, where a `min-height` is a guess about the type's
  leading.
- **A container that clips one of its children cannot be the child's measurement
  source.** The ask panel as the dock's child moves with the dock in the same layout
  pass; measuring the chat from outside and copying its rect onto a body-level panel
  drifted up to **34px** during a mode switch, every frame, because a style written from
  a measurement is painted a frame after the layout it measured.

### Measuring the page

- **A picture is not a measurement.** A model reads "centred", "the same size", "one
  column" and is confidently wrong, because those are judgements and cheap to make
  instead of measuring. `shot.mjs` measures four, and `--audit` prints them and exits 1:

  | check | compares | defect |
  |---|---|---|
  | `controls-row` | controls sharing a row | heights or tops differ by ≥2px |
  | `control-label` | a control's text box with its own box | off centre by >1px in x or y |
  | `baseline` | two same-size runs on one line | baselines ≥0.6px apart |
  | `column` | rows that start with a short label, in one block | one row 2–40px right of the rest |

  On the operator's own mock at 876px: **three** findings, and they were the three
  things photographed — a 26px button beside a 30px one, a `span` and its `a` 1px apart,
  a header whose content started at 145px over rows starting at 133px.
- **Four decisions keep it from crying wolf**, each earned by a false positive on that
  page: the baseline is measured with an empty inline-block inserted after the first
  text node (its bottom edge is on the baseline) and removed at once, because the line
  box does not say where the text sits; only **same-size** runs are compared, since
  mono-12 against sans-12 is a 1px step by design; a control's own label is not a
  baseline candidate, because `controls-row` owns that row; and a flex or grid box is
  **not measured at all** — the probe becomes a flex item and lands on the container's
  edge, which reported two identical text rects as "5px apart". One finding per defect,
  six per kind, 24 in total.
- **A repro page needs the palette's own context.** `--green`, `--amber` and the rest are
  declared under `body.dark` and the font comes from `web/vendor/summit.css`, so a page
  linking only `synapse.css` renders in Times with transparent pills and every measurement
  from it is wrong. Link both and set `class="dark"`, or measure in the app.
- **Chromium enforces a minimum window size** — `--window-size=16,16` silently yields a
  cropped shot; the canvas does the scaling for an icon, not the window.
- **A `file://` image taints the canvas** and `toDataURL` throws, unless
  `--allow-file-access-from-files` is passed. The app icon is generated this way.
- **`page.setViewportSize` silently does not exceed the real window** (it reported 1600
  while `innerWidth` stayed 1369). `Emulation.setDeviceMetricsOverride` through CDP is the
  only way to test a wider layout, set *inside* every measurement because it is dropped
  when the call ends.
- **A screenshot from an occluded window is stale.** `Page.captureScreenshot` hands back
  the last composed frame when the QC Edge window sits behind another: the DOM said a post
  was open with 565px of body, the picture showed it closed, and two shots seconds apart
  were byte-identical. Front the window (`SetForegroundWindow` after `ShowWindow`) and
  shoot then — `Page.bringToFront` alone does not make it compose. CDP input is unreliable
  in the same state (a click landed on the button in `elementFromPoint` and the handler
  never ran), so verify the DOM and fall back to `element.click()` plus a value and an
  `input` event.
- **`browser_wait_for` can match stale text.** Waiting for "Waiting on" to confirm a
  delegation matched the transcript's own prose from an earlier run and returned at once.
  For anything live, poll `GET /api/runs` and assert on the API's answer.
- **A hidden window's timers are throttled**, to about once a minute after a few minutes —
  and Synapse in the tray is exactly when "turn the PC off when it finishes" is wanted. The
  server owns both waits (`armPowerOff` in `src/api.js`): the page asks it to arm, draws the
  numbers it broadcasts (`shutdown-warning`, `shutdown-tick`) and asks it to cancel. A
  20-second countdown in the page could have taken twenty minutes, or never come. The last
  second re-checks the config and the runs (`powerRefusal()`), so a cancel that raced the
  timer, or a run that started during the countdown, still leaves the machine on.
- **Layout or pixels, two instruments.** The layout says *where* boxes are; the pixels say
  whether anything was **repainted**: screenshot a fixed clip during an animation and
  compare frames byte-wise — identical frames for `c3..c7` is what separated "the content
  moved" from "the content was re-drawn". For timing, ffmpeg gives raw grey frames
  (`ffmpeg -i in.mp4 -f rawvideo -pix_fmt gray out.gray`) and a band's row signature shows
  a one-pixel shift honestly; a profile compared against itself at offsets −3..3 finds
  frame-to-frame movement without decoding PNGs. That is how the mode button's
  `417..442 / 418..443` alternation was found. A mockup records **shape** — where a spine
  sits, how wide a band is — and the numbers that matter are measured live.
- **Sample three things separately.** `dock.height`, `scrollTop` and the bottom of the last
  transcript child every 25–40ms across a switch: "one movement", "slack 0 on every frame"
  and "the last message visible on every frame" are three claims, and only the first was
  ever true by accident. Measured at 1243px after the geometry work: a switch either way,
  at the end and scrolled up — line **0.00–0.02px**, composer **0.00**, dock bottom
  **0.00**, top edge 361–371px; a 30-second run in Multi — top edge 6px, bottom **0.00**;
  ten seconds idle — **0.00** everywhere. The idle jitter was a poll, not layout:
  `renderMode()` called `settleChatBox()` every eight seconds and `lockTranscriptTop()`
  wrote a fresh fractional margin each time, so the transcript's top moved 59.984 ↔ 60.016
  and a line snapped a whole pixel as it re-rasterised. It settles only when
  `body.dataset.mode` changes, with a 0.05px deadband.

## The finished-work chime

- **Generated, not borrowed.** Windows' chimes are Microsoft's files, so six WAVs are
  written by `scripts/make-sounds.mjs` into `web/sounds/`: mono 16-bit, peaking −14 to
  −18 dBFS. The long pair runs about 2.4s and must stay under half the zero-crossing rate
  of screen-in (`tests/notify.test.mjs` measures it). The envelope is exactly zero at
  t = 0, so a loop stopping below 1e-4 wrote three silent files — the check is
  `t > 0.001 && env < 1e-4`, and the peak read `-Infinity dBFS`.
- **The screen lease has its own pair and its own switch:** screen-in is four bright
  notes rising, screen-out the same four falling; `notify.screenSounds` turns them off
  and leaves the badge and toast, which say it in words.
- **It plays when the chat goes quiet, not when a message arrives.** `noteWorking()` asks
  `sessionWorking()`, the same predicate the card's breathing dot uses; a failed or
  interrupted turn is silent (`workEndQuiet`). **A gap between two pieces of work is not
  a finish:** a coder's run completed at 14:11:35 and the Architect started the next task
  at 14:12:09 — the chime announced the end with two tasks left. `workWillContinue()` is
  the rule: only in Multi, only with Keep running on, only when the plan still has a row
  to do, and a blocked or failed row is not "to do". The plan is re-read on every change
  so a lagging update releases it, and the trade stands: a plan the Architect forgets to
  finish means a quiet finish.
- **The open chat needs the gap too.** With Keep Building off the plan rightly says no
  task is left while the Architect still owes its turn, so `holdFinish()` asks
  `stillGoing()` now and again at **`FINISH_GRACE_MS = 4000`**, plays only if the answer
  is still no, and lets resuming work cancel the hold. A reading that belongs to another
  chat is dropped, and `busyInfoSession` makes an answer carry the chat that asked.
- **Autoplay is not guaranteed, so failure is silent.** `new Audio(url).play()` can be
  refused before a gesture and the rejection is swallowed. The URL must be served as
  `audio/wav` — an octet-stream is the same silent failure — so `src/server.js` carries
  the MIME entry and the test asserts it.
