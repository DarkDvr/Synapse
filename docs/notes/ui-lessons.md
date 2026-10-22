# UI lessons

Layout invariants, the chat dock, the ask panel, the role cards and the model
picker — with the measurements that prove them. Split out of `AGENTS.md`
verbatim; read it before changing anything in `web/`.

- **A model name is the model's name.** The picker used to strip the word "free"
  from every label and cut the rest at 28 characters, because a `<select>` cannot
  ellipsize — so `Beam Free` read `Beam`, and the nine zen models that cost nothing
  looked like nine models with no particular property. The name is shown whole now
  and the ellipsis is the layout's job. That made the menu the place a name is
  actually read in, so it sizes to its content: `width: max-content` with a 320px
  floor and a 560px cap, measured **484px** on a catalog whose longest row is
  `qwen3.8-9b-distill-slerp-f451-pro-writer-uncensored` plus an ISSUES chip, with
  no row clipped. The card's own box still ellipsizes — it has a tooltip, and the
  list is where the choice happens.

## Questions: a panel over the chat, never in it

A model asking the operator something is not a chat message — it is a blocked
session. The engine raises a form (see "Tools and models"), and Synapse renders
it as a panel **painted over the chat, anchored just above the composer**.

- **It cannot change the chat's size, and that is structural, not careful.** The
  host is `position: absolute` inside `.chat-dock` (`position: relative`), and
  `placeAskPanel()` sets its `bottom` and `max-height` from the composer's and
  the dock's measured heights — the composer grows with the textarea, so CSS
  alone cannot express it. Measured with the panel shown and hidden on the same
  transcript: dock 269/619/888, composer top 829, transcript 559 — identical in
  both states, and page overflow 0.
- **The panel is polled, so it must never rebuild for nothing.** `refreshPending`
  runs every 8s; rebuilding the panel's HTML threw away answers the operator had
  already given (reproduced: pick a radio, wait for a poll, the radio cleared and
  Submit disabled itself again). `state.askSig` is the form's id plus its fields
  and option values — nothing about the answers — and an unchanged signature only
  re-places the panel. Same lesson as `renderSig` for the transcript.
- **The action row is the panel's last column row, not a sticky one.** A six-field
  form is taller than the chat, so Submit is pinned to the panel's bottom edge
  rather than something to scroll to. It was `position: sticky; bottom: 0` first,
  which only holds while the content is taller than the panel: on a short form the
  row sat where the content ended and the panel went on being empty underneath it —
  a strip that reads as the chat showing through. The panel is now a flex column,
  the fields take the room and scroll inside it, and the row ends at the panel's
  bottom edge either way (measured: `stripBelowSubmit: 0` in both cases).
- **Choice questions get radios, `multiselect` gets checkboxes**, `boolean` a
  single checkbox, numbers a number input, `external` a link. Every option shows
  its label and its description — the descriptions are the model's own reasoning
  about each choice and are most of the value.
- **One question per page.** A five-question form was one long scroll and the
  questions below the fold were missed outright. The panel shows one at a time,
  `Question 2 of 5` in the action row, `Back` from the second page on, and the
  orange fill only on the last page's **Submit Answer**. `Next` is gated on
  *that* page's required fields and carries "Answer this question to continue.";
  Submit still speaks for the whole form ("Answer every required question to
  send." — a warning about a question further down the form, while Next is
  available, is a warning about something the operator cannot see yet). A
  one-question form keeps the old shape: no counter, no paging, just Submit.
  **Paging hides a question by class, never by `hidden`.** `hidden` belongs to
  the engine's `when` rules, and `collectAskAnswer()` skips a hidden field — so
  paging with it would silently drop every answer already given. Verified on a
  fabricated three-question form: paged 1 → 2 → 3, back to 2, across a poll
  boundary, and the reply still carried
  `{stack:"page", features:["sky","quote","world"], skin:"warm"}`.
  **A form opens the dock.** The panel is the dock's child and takes its height
  from it, so a freshly opened session (a strip of composer) squeezed the panel
  to 64px with its action row hanging outside it. `has-history` now holds while a
  form is pending, and a form measures 634px with `stripBelowSubmit: 1`.
- **`custom: true` becomes "Something Else…"**: a radio/checkbox row with a text
  input that stays disabled until that row is picked, and whose text becomes the
  answer. That is how these models phrase an escape hatch, and the engine's
  question tool always sets it.
- **Required fields gate Submit**, with "Answer every required question to send."
  next to the button rather than an error after the click.
- **The composer is disabled while a question waits** (the operator's call): the
  turn is blocked, so a message typed into it would go nowhere. The placeholder
  becomes `Answer the question above`.
- **The `question` tool card stays, as one line.** It is the record, not the
  interface: `renderTool` gives it `questionSummary(part)` (the first question's
  `header`), and the raw payload is one click away like any other tool. On
  answer the engine's own output ("User has answered your questions: …") shows in
  the expanded card.
- **A worker can ask too.** The panel is not limited to the open session: any
  pending form is shown, with the head saying `another session is waiting on you`.
  A worker has the same toolset, and without this its question would be invisible
  and the run would die at the timeout with nothing to look at. **Any** pending
  question blocks the composer, whoever asked it: the operator's attention is what
  the run is waiting for, and a worker's question is no different from the
  Architect's in that.
- **Orange marks the panel; it does not fill it.** The top rule, the QUESTIONS
  heading, the waiting dot, the Recommended chip, the control accents, each option
  row's outline and the Submit fill are orange — nothing else is: the panel
  surface, the row backgrounds and the question text are the ordinary colours. The
  first version was orange all the way down and the operator pulled it back the
  same day ("was too much orange" for something read line by line). Every option is
  an answer and carries the rule; the row you picked is marked by a lifted
  background and a white label, never an orange wash.
- **The panel covers the whole chat, including the composer.** It is the dock's own
  child at `inset: -3px` — 2px past the dock's *border box*, so the chat's border,
  its radius, its jump buttons and the composer (textbox, Stop, Send, the mode
  toggle) are all underneath it. The dock drops its clipping while a question is up
  (`.chat-dock.has-ask { overflow: visible }`), which is what lets the panel be the
  larger box; nothing else escapes, because the transcript clips its own content
  and the composer is behind the panel anyway.
  **Being the dock's child is the point, not a detail.** Measuring the chat from
  outside and copying its rect onto a body-level panel was tried first: it looked
  right at rest but drifted up to **34px** off the chat during a mode switch, every
  frame, because a style written from a measurement is painted a frame after the
  layout it measured. As a child it moves with the dock in the same layout pass —
  traced through a switch, the offset stayed at exactly 2px on all four sides on
  every frame.
- **Question text and option labels are bold** (700); the option descriptions stay
  regular and muted, which is what keeps the bold from being a wall. The question
  itself is the one thing read standing up, so it is **16px** while the option
  labels stay 12.5px and the descriptions 11px — the operator asked for "larger by
  three points" and 3pt is 4px in CSS, which is what took 12px to 16px.
- **"Something Else…" gets its own line for the box.** Sharing one line, the box
  raced the label to the right edge (and wrapped badly when it did not fit), so the
  row is a column and the box is indented 21px to line up with the option labels
  above it.
- **"(Recommended)" becomes a chip.** The question tool's own convention is to
  put the recommendation first and end its label with " (Recommended)". The panel
  strips the suffix and shows a chip beside the label, and the role brief tells
  both roles to write it that way — verified live: the worker's next question came
  back as `Number of notes (Recommended)`.
- **The engine's `header` is a heading only when it separates questions.** It is a
  short label for telling several questions apart; with a single question it just
  sat above the real question, and models often write a slug there ("--reverse
  meaning"). A one-field form drops it and leads with the question text.
- **Verified end to end** on the `field-notes` project: the Architect asked
  "Index colour scheme" through the tool, the panel appeared over the chat while
  its card read `asking the operator`, the answer "Fixed palette" was submitted,
  the tool call completed with that answer, and the Architect carried on in the
  same turn — closed t4 and unblocked t3.

---

## UI lessons

- **A worker's work is shown in the chat, in the quietest grey there is.** A
  delegated worker runs in its own session, so *nothing* of its turn reaches the
  Architect's transcript: the operator watched a nine-minute design run with an
  idle chat and then one report, and asked why. The trace is a light-grey block
  after the last message, built from two sources and nothing invented — the
  runner's `run.progress` gives the newest tool call, and the worker's own newest
  sentence is read from `GET /api/sessions/{workerId}/messages` once per
  `session.text.ended` (the delta payload is the engine's business; the session is
  the honest source). It is placed by **start time, merged into the transcript**,
  so a run that began at 19:45 sits above the report that lands at 19:54 rather
  than under it. When the run ends the block folds to one line — role, task,
  duration, files — because the report is the thing to read and the trace is the
  evidence behind it. A page opened mid-run seeds the trace from `GET /api/runs`
  (`loadRuns`), so the chat is alive immediately; a page reloaded *after* a run
  ends has no trace, which is deliberate for now: the run log keeps the numbers,
  and rebuilding a fold per past run is a second feature.
- **The worker's words stream through a panel that slides, not a block that
  grows.** Deltas are appended to one text node — write once per delta, never per
  frame, and never `textContent` (that replaces the node and re-wraps the line).
  The panel is **11 lines** tall (measured 183px at 11.5px/1.45, 191.4px with its
  3px padding and 1px border) and the text inside it is moved with `transform`.
  Two earlier versions were wrong and each taught half the lesson. Keeping a
  **600-character window** (`text.slice(-600)`) rewrote the *front* of the
  paragraph every frame, which re-breaks every line — a full re-wrap, then a
  `scrollHeight` read and `scrollTop` write forced a layout of the whole chat,
  sixty times a second — and pinned the newest line to the bottom edge, so each
  new line shoved the rest up by a line at a time. Easing that window by
  characters smoothed the removal but not the re-wrap, and the chat's own edge
  still looked like it was eating the text. The panel fixes all three: the text is
  append-only so line breaking is incremental, a frame is one `transform` (compositor
  work, no layout), and the clip is a border the operator can see. The top edge
  **fades** — a hard cut reads as the box eating the text — and only while text is
  leaving through it (`is-scrolling`), so a short block sits unfaded. The bottom
  stays crisp: the newest words are the ones being watched.
- **The slide is a damped spring, not a tween.** It is `nextOffset` in
  `web/stream-view.js`: stiffness 90, damping 18 (ζ ≈ 0.95), integrated in 8ms
  sub-steps against the *real* frame time so 60Hz and 144Hz arrive together, with a
  snap below 0.35px and 6px/s. It reads as laziness — the text is dragged along by
  the writing, lags it by under a couple of lines while the model is fast, and eases
  to a stop when the model pauses — because that lag is where "still generating
  below the mask" comes from. A hidden tab can come back with seconds of debt; the
  step is clamped to 250ms so the text arrives rather than teleporting.
  `tests/stream-view.test.mjs` holds the numbers, including that no frame jumps the
  whole way and that a 60Hz and a 144Hz run land within a pixel of each other.
  Reduced motion skips the spring entirely.
- **The app icon is generated, not drawn.** `references\synapse_icon_full.png`
  (471×472) is the source; `web\icon-{16,32,48,64,180,256}.png` and `favicon.ico`
  are rendered from it, and the sidebar mark and the welcome screen use the same
  files rather than a glyph. There is no image tool on this machine, so the
  rasterizer is the browser: one headless Edge launch draws every size onto a
  canvas and `--dump-dom` hands the data URLs back, which Node decodes and packs
  into an ICO (PNG entries, Vista+). Two traps: Chromium enforces a **minimum
  window size**, so `--window-size=16,16` silently yields a cropped shot — the
  canvas does the scaling, not the window — and a `file://` image **taints the
  canvas** unless `--allow-file-access-from-files` is passed, which makes
  `toDataURL` throw.
- **A grid with a definite height stretches its rows.** `.project-tree` is a grid
  inside the sidebar's flex column; giving it `flex: 1` handed it a height, and a
  grid with free space distributes it across the rows — one project became a
  674px empty box with its name floating in the middle. `align-content: start` is
  the fix, on the list and on each project. It only showed with *few* projects:
  with nine the content exceeded the box and there was no free space to stretch,
  which is exactly how a test with the wrong fixture passes.
- **Scrollbar stability.** A scroll container must never change the width of its
  contents. `scrollbar-gutter: stable` is set on `html` and on `.chat-scroll`.
  Without it, expanding a tool made the page taller, the page scrollbar
  appeared, and the whole app shifted ~15px. Also: any grid column holding prose
  is `minmax(0, 1fr)`, never `auto`, so content cannot stretch it.
- **Scrollbars are ours now.** `::-webkit-scrollbar` (+ `scrollbar-width`/
  `scrollbar-color` for the standard path) is styled thin and dark: Chromium stops
  drawing its native bar as soon as that pseudo-element is styled, which is what
  removes the Windows stepper arrows — a tool card's 200px output box was showing
  two of them and read like a spreadsheet. Tool output also never scrolls
  sideways: `white-space: pre-wrap` + `overflow-wrap: anywhere` + `overflow-x:
  hidden` on `.tool-body pre`, so a wide monospace table wraps instead of growing a
  horizontal bar (measured: 0 of 82 output blocks scrolling sideways on a real
  four-round transcript).
- **Sending puts the newest message in view — and the cards above it.** Two
  scrollers can be live at once: the transcript scrolls itself, and below 1460px the
  page scrolls too. `send()` runs `scrollChatToEnd()`, which sends the transcript to
  its end **and** the page to the top of `#topologyWrap` (8px margin), but only when
  each actually scrolls — in the wide layout the page does not, so nothing moves
  there. The first version made it either/or, which did nothing at all on a window
  where the transcript scrolls *and* the page does.
- **A render never moves the page; only Send and opening a session do.**
  `chatScroller()` returns `null` while the conversation fits its box, and
  `scrollChatToBottom()` used to fall through to
  `window.scrollTo(documentElement.scrollHeight)` — the bottom of the *page*,
  which below 1460px is the rail under the chat, not the chat. Posting a message
  in a young conversation therefore yanked the whole panel down to the very
  bottom, and it "fixed itself" as soon as the conversation grew long enough to
  scroll inside its own box — the branch above took over and only the transcript
  moved. The fallback is gone: a render scrolls the transcript when it scrolls and
  does nothing otherwise. `chatAtBottom()` had the mirror-image bug — it compared
  the page's end with the document's height, so the same case always read
  "scrolled up" — and now compares the transcript's bottom edge with the viewport.
  Measured on a stubbed session at 294×980: one message, `maxScroll 540`, page
  stays at `6` (the cards' top); thirty messages, the transcript ends at its own
  end and the page still does not move.
- **The transcript follows a turn while it streams — and the measurement has to
  happen first.** `renderTranscript()` decides "was the reader at the bottom?"
  *before* `fitChatHeight()` runs: that call resizes the dock, and a shrunken dock
  makes the transcript read as scrolled-up, so reasoning and tool lines arrived
  without the chat following them. While `state.streaming || state.busy` it follows
  unconditionally — the operator's words were "to make sure I always see any new
  info in chat being added" — so reading history mid-turn is pulled back to the end
  by the next part. That is the trade they asked for.
- **Opening a session starts at its end.** `openSession()` puts the transcript at
  its bottom once after `loadMessages()` — a session is opened to read where it got
  to. It does not move the page (unlike Send), because the cards are right there.
- **The two rail tables share one geometry.** They are lists before they are
  tables: 2px cells, `line-height: 15px`, `tbody tr { height: 21px }`, and anything
  that lives in a cell is capped to that height — the probe's Error is a real
  `.btn` (22px min-height) and its own `td` rule set 3px, so one table had 29px rows
  beside 22px ones. Measured after the fix: 8 rows and 14 rows, every one 21px.
- **Adding a project can adopt a folder that already has a plan.** Deleting a
  project only unregisters it (documented, and right: the folder is the operator's),
  so a reused name like `Test Project 1` resolves to the same slug on disk and the
  new project inherits the old plan — the pane opened onto a finished 4/4 plan and
  the Architect card said DONE before anything was typed. That is now a three-way
  question (see the next bullet) rather than a toast, and `createProject` also
  reports `existingPlan` for API callers. It never wipes the plan by itself:
  re-adding a real project must continue its work.
- **A reused folder is a decision, not a toast.** Adding a project to a directory
  that already holds a plan now asks, in a **non-dismissable dialog with a red
  frame**: *cancel and pick another name*, *delete that folder and start fresh*, or
  *re-use it and carry on*. It shows what is at stake, because all three answers are
  about a folder on disk: the path in mono, the **numbers as chips** (`3 tasks`,
  `3 done`, `35 files`, `last touched 4 min ago`), and the old goal as a
  **quotation with a left rule**, clamped to three lines *with an ellipsis* and
  carried in its tooltip. The goal used to be sliced to 160 characters by the
  server, which cut it mid-sentence with no ellipsis and read as a rendering fault.
  `POST /api/projects/inspect` answers without side effects;
  `POST /api/projects/wipe` refuses anything outside the projects root (and the root
  itself), evicts the location first, then deletes with retries. The dialog is the
  one place `openDialog` takes `dismissable: false`, an `extra` button and a
  `tone: 'clash'`; the generic dialog's Cancel/OK pair is unchanged elsewhere.
- **A destructive dialog says what is at stake, in a row, and names the act.** A
  bare checkbox under a sentence reads as a form field with no weight. The delete
  dialog's optional extra is a **bordered option row**: the label is the choice
  ("Forget Shift Test 6's plan too"), the hint is what the choice does to the
  folder, and ticking it turns the row amber and renames the confirm button to
  **Delete and Forget Plan**, so the button says what it will do. The option only
  appears for a session that is the last one on a project whose plan has tasks —
  no plan, no question, and the dialog stays a plain confirm.
- **A name-only create makes its own folder.** `projects.create` derives
  `<projects root>/<slug>` when no directory is given. Before this,
  `normalizeDir('')` resolved to the process's working directory — which is the
  harness — so an API create carrying only a name registered `F:\dev\Synapse` as
  a project. The UI always sends a directory, so only the API could hit it.
- **`.chat-scroll` scrolls internally in the wide layout; the page scrolls in the
  stacked one.** Above 1460px `.stage` has a definite height (set from the
  measured viewport via `--stage-h`, minus any horizontal scrollbar), so the
  composer sits at the bottom of the window. Below 1460px the rail flows under
  the chat and the page scrolls by design. Every scroll helper goes through
  `chatScroller()`, which returns the transcript when it scrolls and `null`
  otherwise.
- **Jump buttons live inside the chat pane.** `.chat-nav` is `position:
  absolute` in the dock (which is `position: relative; overflow: hidden`), so it
  can never drift out over the rail, and it does not reserve a gutter — it
  floats over the transcript's right edge, keeping the conversation's padding
  symmetric (13px each side). It sits at `right: 22px` so it clears the
  transcript's ~15px scrollbar (verified: 7px clear). An earlier
  `position: fixed` version anchored by JS escaped the pane when the dock was
  short.
- **The jump animation is hand-rolled.** `animateScroll()` runs a 280ms
  ease-out rAF scroll instead of `behavior: 'smooth'`, whose duration the
  browser owns and cannot be tuned — roughly 30% quicker than the browser's own
  smooth scroll over these distances (measured ~289ms end to end).
- **The jump buttons anchor on every turn, including Synapse's reports.** They
  used to collect `[data-msg="user"]` and need three of them, so a real run — one
  prompt and a dozen answers — had no jump buttons at all, and the operator read
  that as the feature having been removed. `navMessages()` takes **every**
  `.msg[data-msg]`: the rule between speakers is the only structure the
  transcript has, so the bars are the anchors. Two bars (three messages) show the
  pair; the tooltips say "the previous message", because that is now true.
  Verified on Clock Test 2 — 1 prompt, 10 answers, 9 worker reports — where five
  PREV presses stepped synapse → assistant → synapse → assistant → synapse.
- **The jump buttons step message-by-message from an anchor, not from the raw
  scroll offset.** `navAnchors()` picks the message that owns the fold (last top
  at or above `scrollTop + 12`), and the buttons move `cur ± 1`. A raw
  "first message below the fold" test got stuck: the first message sits ~11px
  below the content top, so UP kept re-selecting it and DOWN never advanced.
  Verified both directions at 1200 and 1680: 0 → 1 → 2 with NEXT disabling at
  the last message, and back with PREV disabling at the first.
- **The rename pencil sits in the row's action slot, same size as the delete.**
  It overlays the name's end (it is hover-only, so it does not reserve 21px of
  every title), but it is positioned at the row's vertical centre rather than a
  fixed `top`, and it is 18×18 with a 2px gap — the same box as `.tree-x` beside
  it. A `top: 2px` version sat visibly high and read as a misplaced icon.
- **The stacked layout caps the chat panel** at `min(70vh, 720px)`
  (`body[data-view="session"] .chat-dock.has-history`). Below 1460px the stage
  is content-sized, so without a cap a long conversation would stretch the page
  forever. The cap is where the panel stops growing and its transcript starts
  scrolling internally — verified 630px at 900px viewport height.
- **Status dots need `display: inline-block`** — as inline spans they ignore
  width/height and paint as a 4px square.
- **No duplicate status labels.** A failed tool card shows the `Failed` pill
  only; a failed probe row shows the `Error` button only.
- **Table cells must not be able to stretch the pane.** `.inspector .tool-table`
  is `table-layout: fixed` with ellipsised cells — a long MCP tool name like
  `synapse-search_websearch` otherwise blows the rail out to the right.
- **The working area is left-anchored and capped.** `.content-wrap` is a column
  flex item; `margin: 0 auto` on it was a real bug — auto cross-axis margins make
  a flex item **shrink-to-fit** instead of filling, so the whole `.room` sized
  itself to its content. Multi (wide topology) looked fine while Single (one
  card) collapsed to ~380px and drifted right. Fixed with `width: 100%;
  margin: 0` and `--work-w: 1240px` as the room's max-width: sidebar → cards+chat
  (1fr, left-anchored) → rail → empty space at the window's right edge. Both
  modes now measure the same room width (verified at 1680 and 1200).
- The full three-column layout is kept at every width: with the rail and the
  sidebar it needs **1460px**, and narrower windows scroll horizontally rather
  than stacking the rail. Stacking made the page taller than the viewport, and
  scrolling it carried the Architect card away.
- **Every role owns its model and effort — there is no "default model".** The
  Architect's choice lives in `roles.architect` like every other role, and is
  persisted in `config\synapse.config.json`; `defaults` holds only the working
  directory now. An older `defaults.model` is folded into `roles.architect` once
  by `normalize()` and the key is deleted. Changing the Architect card switches
  the open session immediately (`POST /api/session/{id}/model`); worker picks are
  stored for the orchestration layer, which is not built yet.
- **The thinking-effort button** shows 1–3 stacked **green** chevrons — dot =
  engine default, chevrons = the three highest variants a model allows. The
  chevrons are **one inline SVG per level** with integer-spaced paths: three
  separate SVGs and fractional negative margins rounded unevenly, so the gaps
  looked different. They are strokes with round caps, not a font and not rotated
  bordered boxes (those alias into odd shapes at 22px). Click cycles
  default → lowest → … → highest → default; the tooltip is
  `Current thinking effort: <label>` where `<label>` is the provider's own
  `reasoningEffort` value, never our id. Models with 2/1 variants get 2/1
  chevrons; a model with none gets a disabled button. The glyph is the Adamant
  assistant oracle chevron *redrawn at 22px*
  (`F:\dev\Obsidian.Adamant\...\adamant-assistant`) — shape only, no code copied,
  and that folder is read-only.
- **The Architect card is always visible; Multi reveals the workers.** The cards
  live in `#topologyWrap`, whose `max-height` animates between the Architect's
  height (Single) and the full topology (Multi). Worker children are hidden by
  `body[data-view="session"] .topology > *:not(.topo-architect):not(.path-layer)`
  and shown by the `workers-on` body class; on Multi→Single the class is removed
  only after the height animation, so the workers do not vanish mid-slide.
  **Single never trusts a measurement for its resting state.** The measured
  height drives only the 320ms collapse animation; afterwards `--reveal-h` is
  `none`, so the wrapper is exactly the Architect card by construction — a stale
  measure can never clip the card or grow a scrollbar.
  **The role-card wrapper is `overflow: clip` in every mode — never `auto`.** It
  must never scroll: not by wheel, keyboard, drag or script, and no scrollbar
  may ever appear beside the cards. `auto` was wrong twice over: it made the
  section scrollable, and a 241.06px topology under a 241px cap grew a hairline
  scrollbar during the Multi→Single switch (scrollHeight rounds down, so the
  overflow was invisible but real). `measureReveal()` now measures the real box
  and rounds UP (`Math.ceil`) so the cap clears the content, and `clip` makes
  any attempt to scroll a no-op (`scrollTop` stays 0). Verified across 41
  frames of a Multi→Single switch at 1680px and at 1200px: every frame
  `overflow: clip`, `scrollTop` forced to 50/60 stayed 0, gutter 0.
  **The height cap is the part that bit twice.** Below 1460px the stage is
  content-sized, so `stageBudget()` tests the *breakpoint* (`matchMedia`), not
  the stage's used height — `getComputedStyle().height` reports the used height,
  never `auto`, and capping against it collapsed the reveal to the 48px
  Architect, leaving the workers clipped behind the chat while Multi appeared to
  do nothing. Measure with `scrollHeight` (integer-rounded, so no half-pixel
  scrollbar), cap by the stage only in the wide layout, and cap by the viewport
  otherwise. **And measure from the topology's top, not the card's height**: the
  absolute `.path-layer` is the first child, so `.topology > * + *` gives the
  Architect's row a 12px top margin — using the card height alone clipped
  exactly that margin, cut the card's bottom border and grew a scrollbar.
  Both mode switches slide through numbers: the collapse shrinks the measured
  height, the reveal pins the current height first (a straight set out of
  `max-height: none` would snap — `none` does not interpolate), forces a
  reflow, then grows to the target. Measured mid-flight: 61→241px in ~300ms
  and 241→61px back, both smooth.
  Re-measure on the topology's `ResizeObserver` and on `document.fonts.ready`:
  the card height changes after the font swap, and a stale `--reveal-h` looked
  like a one-pixel clip.
- **The subtitle slot is a fixed three lines, so the chat never moves.** The
  first version let a card grow when its task appeared, which took its room from
  the transcript's top edge (correct mechanically, 269 → 306px top with the
  bottom pinned at 888) — and read as the whole UI jumping every time an agent
  started. Now every card reserves `--task-lines` (3) of subtitle space whether it
  has anything to say or not, clamped with `-webkit-line-clamp`, so filling it
  changes no height at all (measured: all worker cards 98.28px, Architect 102.28
  because its name is 15px). The full text rides the `title`. The trade is real:
  the topology is ~200px taller for ever, which comes out of the chat. `--task-lines`
  is the one number to change.
  The stage's second row is still `minmax(0, 1fr)` under a definite height, so
  *anything* that does grow (a raised `--task-lines`, a font swap) squeezes the
  transcript and never moves the composer — `applyRoleCardsLayout({ from })` still
  takes the pre-change height so it slides. And a poll that learned nothing must
  not re-measure at all: `state.roleSig` is a signature of every card's role,
  state and text, and an unchanged signature returns early.
- **The live path is measured from the connector cell, not from the cards.** The
  spine is that cell's exact centreline and the band is its `.link-line`'s exact
  centre, both at three decimal places — the arrow has to *cover* the dots it
  replaces, and rounding to whole pixels left a visible step. The destination's
  own edge is the end point, so the arrowhead lands on the card. Which side the
  worker is on is decided by comparing its centre with the topology's, not by a
  hardcoded side. Ant count and duration come from the path length, so the beads
  read as one dotted line whether the run is one row away or three. A card hidden
  by Single mode has a zero-width box, which is the guard that stops a path being
  drawn to nothing.
- **The card's dot is a state, and the whole language is derived — nothing is
  stored.** Four states, all read from the plan file plus the runs the runner
  already serves plus the open session's turn: **grey** never taken part,
  **yellow breathing** taking part right now (`.status-dot.live`, `dot-breathe`,
  `--yellow` — the live path's colour, not amber, which stays the engine's
  "waiting" colour elsewhere), **red** a task of its role is `blocked` or
  `failed`, **green** idle but has taken part. Precedence is running → blocked →
  done → idle. A card whose role has never taken part is dimmed (see below: 55%,
  not the 80% it was first shipped at), which is how "who has actually worked here"
  is readable at a glance; a role goes solid the instant it is running, not when its
  task's status changes. **The dim is 0.55, not 0.8** — at 80% the operator could not
  see it at all — and hovering restores the card to full, so a dimmed picker is never
  unreadable. **A skipped role looks blocked**: red border, red label, and its
  **picker goes red** (border and model name, background unchanged) because the
  model is what failed and swapping it is the fix. The mark is driven by *two*
  sources and survives the run: the live run's `skipped[]` while it lasts, and
  afterwards the role's current model carrying a `provider` issue — so the card
  stays red until the role points at another model or the operator clears the badge,
  which is exactly when the problem is gone. **Participation is per session, not
  per plan** — the operator's rule: a non-Architect card starts dim and goes solid
  the first time that role is used for anything in *this session*, and stays solid
  for the rest of it. A plan rewrite does not reset it; a new session does. The plan
  route returns `used`, computed from `runs.jsonl` by `architect` = the open session
  (every delegate line carries it), and it counts both the role the task was written
  for and the role that actually ran it — which is how coder-2 is solid after the
  ladder handed it coder-1's task. Deriving it from the run log rather than from
  memory is what makes it survive a reload and a restart.
  The Architect has two **chips** for its two resting states, in
  the same slot the task line uses — a green **`Done`** when there is a plan and
  every task is `done`, and a yellow **`Waiting on you`** when nothing is in
  flight and work is outstanding. Both also put the card in `is-settled`, which is
  the **green border**: yellow border means a delegation is in flight, green means
  nothing of ours is and the move is the operator's. Because a chip is the size of
  a line of text it still cannot change a card's height.
  **Because it is all derived, "a new plan resets participation" needs no code:**
  a rewritten plan is all `todo` again, so every card goes back to 80% on its own,
  and a reload or a restart shows the same picture.
  Two consequences worth keeping. The chip replaces the subtitle *text in the same
  slot*, so it cannot change a card's height (measured: all seven cards 106.28px
  with and without it, at 1680 and at 1200). And `state.roleSig` must include the
  dot class, the dim and the done flag, or a poll that changed only a status
  returns early and the dot never repaints — which is also why `loadPlan()` calls
  `renderRoleActivity()`: the plan poll (30s, plus every message event) is the
  only thing that learns a task changed.
  **The known gap:** participation is "a task of that role is not `todo`". A
  worker that ran and was interrupted, whose task the Architect left `todo`, dims
  again — its card is solid while it runs and loses that afterwards. Closing it
  needs `runs.jsonl` as a second source *and* a marker for which plan those runs
  belong to (task ids repeat between plans), which is real machinery for a small
  visual; the honest reading of the file we have was preferred.
- **A chip inside a text slot inherits its line-height, and that is what
  de-centres it.** The `Done` chip sits in the card's subtitle slot, whose
  `line-height` is 1.45 — so the chip's box was the *line box* (13.775px) plus its
  padding, while its text is 9.5px. `line-height: 1` gives the chip a box the size
  of its own text. The rest is optical, not geometric: **uppercase has no
  descenders, so centring the em box still reads half a pixel high.** The answer is
  one pixel more padding above than below (`.role-done`/`.role-waiting`
  `3.75px 7px 1.25px`, `.ask-rec` `2.5px 6px 0.5px`) — and the way to settle it is a
  **4x render with a 1px line drawn at 50% of the pill**, which is exactly what the
  eye compares. Two earlier attempts were "measured" as centred by two different
  metrics and both still looked high; the operator's red line was right and the
  arithmetic was not.
- **A repro page needs the palette's own context.** `--green`, `--amber` and the
  rest are declared under `body.dark`, and the font comes from
  `web/vendor/summit.css` — a repro that links only `synapse.css` renders in Times
  with transparent pills, and every measurement taken from it is wrong. Link both
  and set `class="dark"`, or measure in the app.
- **`browser_wait_for` can match stale text.** Waiting for "Waiting on" to
  confirm a delegation had started matched the *transcript's* own prose from an
  earlier run and returned immediately. For anything live, poll
  `GET /api/runs` from the Code Mode runtime (`fetch` works, and
  `browser_wait_for` with a text that cannot exist is a usable sleep) and assert
  on the API's own answer.
- **A session can be deleted under the UI's feet.** Synapse deletes its own
  scaffolding, and another tab can delete one too. The UI used to keep the dead
  session open, and every control on it answered 404 — which is exactly how a mode
  switch reported `Could Not Switch Mode … 404 Session not found`. Now
  `deleteSession` broadcasts `session.deleted`, `loadProjects()` closes the view
  when the open session is no longer in the project list (guarded on the engine
  being ready — with the engine down that list is empty for reasons that have
  nothing to do with this session), and a 404 from an action re-reads the projects
  instead of reporting a failure the operator can do nothing about.
- **`body { min-width: 1100px }` is the source of the horizontal bar on a narrow
  window.** Below 1100 the page is deliberately wider than the window (the cards
  need ~790px of stage, so the alternative was squeezing them), and the browser
  shows a horizontal scrollbar. At 900px it is 200px of scrolling; at the operator's
  842px window it was 258px, and that is what made the panel look cut off on the
  right and left a bar across the bottom of it. **Not yet decided**: whether the
  floor should come down (stack the card columns below some width instead of
  scrolling) — it is the last layout question open.
- **A ceiling is not a height.** `fitChatHeight` used to set `max-height`, which
  only ever takes room away: a conversation shorter than the ceiling left the chat
  ending above the window's bottom with the rail showing underneath — exactly the
  "not anchored any more" report. It sets a definite `height` now (and clears it in
  the wide layout and on an empty dock), and the dock transitions `height`, not
  `max-height`.
- **The panel needs `overflow: hidden`.** Its action row has a square background
  and sits flush against the panel's bottom edge, so without clipping it painted
  over the 16px radius and hid the orange border's curve at both bottom corners.
- **`.ask-input`'s `width: 100%` beat the custom-answer override.** The "Something
  Else…" box is indented 21px, so 100% of the *row* made it 12px wider than the
  space it had, which gave the fields a horizontal scrollbar. `.ask-opt
  .ask-other-text { width: calc(100% - 21px) }` — two classes beat one.
- **`display: revert` does not mean "back to my stylesheet".** The Multi reveal
  used it to un-hide the worker cards, and `revert` rolls back to the USER-AGENT
  value — `block` for `<article>` — so every worker card silently stopped being a
  grid item. The visible symptom was the missing gap between the name row and the
  task line (`gap: 8px` had never applied to them; measured 0). Worse, the
  show-rule written to replace it lost to the hide-rule's `:not()` specificity,
  so Multi showed no worker cards at all. Hide conditionally instead
  (`body[data-view="session"]:not(.workers-on) …`) and let each element keep its
  own display. Check the *computed* display, not the class list.
- **Below the breakpoint the chat is bottom-anchored.** `fitChatHeight()` caps the
  dock to the room between where the cards *will settle* (`--reveal-h`, the
  reveal's target — never the live position) and the window's bottom, so the
  composer sits on the window's bottom edge in both modes and only the chat's top
  moves as the cards collapse or reveal. There is no `70vh`/`720px` ceiling: a
  ceiling is what left the chat floating short of the bottom with the rail showing
  underneath it. Measured at 900x880, traced frame by frame: the dock's bottom
  held at 868px for the whole slide in both directions while the top moved
  501 ↔ 146.
  Two things make it hold. `.chat-dock` transitions `max-height` with the same
  260ms ease as the card reveal (narrow layout only), so the shrinking height and
  the moving top cancel out; and a **re-measure must not land mid-slide**
  (`revealUntil`): the ResizeObserver fires exactly then — adding `workers-on`
  resizes the topology — and re-driving the layout restarts the wrapper's
  transition while the chat's own curve keeps going, which showed up as a 29px
  bounce of the composer. The observer and the render-time re-measure wait for the
  slide; a mode switch never does. A frame-by-frame correction loop was tried
  first and was worse: the height lags the moving top by a frame, which overshot
  the window by 40px.
- **The subtitle reserve shrinks on a short window**
  (`@media (max-height: 820px) { --task-lines: 2 }`): three lines of empty card is
  a luxury paid out of the chat. It is fixed *within* a window size, so the
  no-shift rule still holds; only a resize across the breakpoint moves anything.
  The ask panel is no longer a floating card at all — it covers the chat's
  transcript area edge to edge, so there is no `max-height` to floor; its fields
  scroll inside it and the action row is pinned to its bottom row.
- **Cards have a hard minimum width** (`--card-min: 290px`): below that the
  name, the picker and the two buttons start colliding. Two columns + the 66px
  spine need 646px of stage.
  **The stage — not the room — is where the plan lives.** It is a child of
  `.stage`, beside the role cards in the cards' row, and *the conversation runs
  underneath both at the full width of the room*. That is the whole point: the
  plan is readable beside the cards the Architect writes it for, and the chat
  pays nothing for it. The operator's mockup is the shape; the census and the
  probe are the two `.inspector` panels below the stage, side by side.
  Two columns of stage, a gap and the plan need **1248px** of window (2 x 290
  cards + 66 spine + 14 gap + 284 plan = 944 of room, + 256 sidebar + 48
  padding). Below 1250 the plan drops under the chat at full width — a narrow
  window can still read it there — and below 1460 the stage is content-sized and
  the page scrolls. `body { min-width: 1100px }` keeps two card columns at the
  floor; narrower windows scroll horizontally rather than squeezing the cards.
  **The plan may not stretch its row.** `.rail-plan` carries `contain: size`, so
  a two-thousand-line plan cannot push the chat off the stage: the row is sized
  by the cards, the plan stretches to it and scrolls inside. The row has a
  `minmax(200px, auto)` floor because in Single the cards collapse to the
  Architect card and the plan would otherwise take the row to nothing. `fitChatHeight`
  counts that floor (it measures the plan, not just the wrapper) or the composer
  sits 60px below the window in Single.
  **The role name does not shrink; the model label does.** With both free to
  shrink, a 290px card turned "Inventor" into "Inven…" and "Coder 1" into "Cod…"
  while the picker kept 137px. Role names are fixed app vocabulary, so the h3 is
  `flex: 0 0 auto` and `.model-search` is the one that gives way.
  The glyph measurements that matter: both button glyphs are centred on the 22px
  button to within 0.01px, with ~1.5px of margin left top and bottom at three
  chevrons — if the glyph or border size changes, re-measure with
  `browser_get_element` rather than eyeballing it.
- **A modal owns the wheel.** `body:has(.modal-backdrop:not([hidden])) { overflow:
  hidden }`, plus `overscroll-behavior: contain` on the backdrop and on
  `.settings-body`. Without it the settings list reached its end and the page
  underneath carried on scrolling, which reads as the dialog itself jumping.
  Measured before: page 877px of content in a 620px viewport with the list already
  at its end; after: `scrollY` stays 0 whatever is attempted, and the page's
  `scrollbar-gutter: stable` means hiding the bar moves nothing.
- **The model menu is at least 320px wide**, not the input's 180. A row is source
  chip + name + ISSUES badge + limits on one line; at the old width the badge
  squeezed the limits and read as a clipped control (the operator: "unless it
  doesn't fit in our drop down, which means it should be made wider").
- **The menu is clamped to the window, and flips up when there is no room below.**
  It is `position: fixed` so it can escape the role cards' clipped wrapper — which
  also means nothing clamped it: in the right-hand card column a 320px menu ran off
  the window, and off the screen on a second monitor. `positionModelMenu` now
  measures from a known left edge **first** (a stale `left` near the right edge
  makes shrink-to-fit report a narrower menu than it can be), sets `min-width: 320`
  capped at `min(560, vw - 16)`, clamps `left` into `[8, vw - 8 - w]`, opens
  **upward** when there is under 180px below and more room above, and takes its
  `max-height` from the space it actually has — the list scrolls inside that, so
  many more models than today cost nothing. Scroll and resize reposition it,
  because it is pinned to the viewport while the thing it points at can move.
  Measured: 1200×900 right edge 1192 of 1200; 900×700 with the input off-screen at
  1008 → menu `572…892`; 900×460 → opens up (top 108, bottom 339); 900×300 →
  `max-height` 164, `scrollHeight` 229, scrolls, `maxScroll` 67. Keyboard
  arrow-navigation already called `scrollIntoView({block:'nearest'})`.
- **A provider error is red *text* on the card, never a border.** While a role is
  retrying, or its wake failed, its subtitle line reads `Retrying at 00:45 — Rate
  limit exceeded` in `--red` at 600 weight, and the card's border keeps its own
  meaning (blocked / live / settled). It is cleared the moment the role works
  again. The text is the first sentence of the provider's own words (`shortErr`),
  clamped by the same three-line slot; the whole sentence is the tooltip. The
  source is `role-error` events kept in `state.roleErrors` keyed `dirKey|role` —
  deliberately *not* a run event, or the UI would read it as a card repaint, and
  `run.progress` cannot clear it because the runner emits one right after the
  notice.
- **Every setting carries a one-sentence tooltip, and units live in the label.**
  Twenty fields, twenty `title`s, in plain English: what it does, what happens
  when it is wrong, and what counts (seconds, minutes, days, attempts). Long
  durations are shown in **minutes** — the config stores seconds, and `data-scale`
  converts on read and on save. "20" beside "Restart after silence (minutes)" is a
  decision the operator can make; "1200" was a number nobody could read.
- **Model pickers are searchable.** Each `.role-model` `<select>` stays in the
  DOM as the source of truth — every handler still works — but is hidden
  (`display: none`) and driven by a `.model-search` input plus one shared
  `#modelMenu` (fixed-position, so it escapes the wrapper's overflow clip).
  Typing only filters (name or ref substring); a model can be set **only** by
  choosing an option, `Enter` on the active one, or Escape to revert. Do not
  make the typed text the value. Rows are compact (22px) and carry a source chip
  — the provider id is part of a model's identity, so `OpenCode` and
  `OpenCode Go` entries read differently, and local providers will slot into the
  same chip.
- **The chat dock fills the stage row in a session.** It stretches from directly
  under the role cards (one 14px grid gap) to the composer at the bottom of the
  window; the transcript scrolls inside it. The transcript is `display: none`
  while empty (`is-empty`), and there is no empty-state copy inside a session:
  a fresh session shows the composer alone — `has-history` (toggled by
  renderTranscript on every render) is absent, so the dock is bottom-pinned and
  exactly one composer row tall. It keeps the same panel surface, border and
  radius as the full dock: the composer lives in a panel, never as a bare bar
  floating on the stage (only its own top divider is suppressed, so it does not
  double the panel's top border). The moment history exists the dock gains the
  class and stretches from the cards to the composer.
- **The transcript shows user and assistant turns only.** System prompts,
  scaffolding and context dumps from the engine are not chat — rendering them
  once leaked AGENTS.md prose and diff hunks into the transcript above the
  user's own message. Errors still show, whatever type carries them.
- **One assistant block per turn, not per step.** The engine emits an assistant
  message per step (reasoning, tool call, reasoning…), so rendering them raw gave
  a three-question chat fourteen "Architect" headers. `groupTurns()` merges
  consecutive assistant messages: one header, the steps in order, the answer
  panels amongst them. Three questions now render as three blocks.
- **Tool rows are deliberately small.** `.tool-head` is 22px high: 7px flat
  status dot (no ring), 10.5px mono, `2px 7px` padding, 5px-radius pill at 9px.
  A busy turn emits dozens of them, so a `2px` margin keeps the transcript
  readable where a `5px` margin plus the standard 9px ringed dot read as noise.
- **Expanded state lives outside the DOM.** The transcript is rebuilt on every
  poll, so an open Reasoning block or tool card used to snap shut whenever the
  next render landed. Two things fix it: every part is tagged with a stable key
  (`<message id>:<index>`) and `state.open` holds the open keys, restored on
  render (`data-k` on `<details>`, `data-tool-card` uses the key directly); and
  `renderTranscript()` computes a signature of the conversation and returns
  early when it has not changed, so a poll that learned nothing new does not
  touch the DOM at all. Verified live: a Reasoning block and a tool card opened
  during turn 1 were still open after turn 2 rebuilt the transcript.
- **Nothing in the transcript has a fill any more.** The three speakers share one
  block (coloured name + 2px rule, see "Speaker headers" above); the Architect's
  answer and Synapse's report are the same markdown body. An earlier design gave
  each a tinted panel with an operator-chosen colour, and it was removed: the
  speaker's name already says who is talking, so the fill was decoration that
  needed a palette exception to justify itself.
- **Mode colours:** Multi is orange, Single is violet, both with white text and
  a white dot; both are filled pills, so the mode is readable at a glance. The
  composer placeholder is `Message` in Single, `Message the Architect…` in Multi.
- **The composer has no target picker, deliberately.** One interface, one lead:
  every message goes to the Architect. Per-role model/effort are card controls.
- **`Ctrl+Enter` sends; `Enter` is a newline.** The operator asked for it once the
  prompts became multi-paragraph: Enter and Shift+Enter insert a line, Ctrl+Enter
  (or the Send button) sends. The textarea's title says so.
- **The UI is live-only.** The `Design preview` entry, every `SAMPLE` badge, the
  sample plan list, the sample tools table and the role cards' mock activity
  were all removed before live testing. Do not put invented content back; label
  unimplemented affordances with `data-soon` instead.
- **There is no Home nav.** The button did nothing; sessions live in the project
  tree and the stage shows the welcome screen when nothing is open. Do not add
  nav items that do not change the view.

---

## The transcript's markdown renderer (`web/md.js`)

A worker's report is prose with headings, lists and code in it, so it is rendered
as markdown in the same body class as the Architect's answer. The renderer is
hand-rolled (no dependencies) and **escape-first**: the source is HTML-escaped
before any markdown rule runs, so a model cannot inject markup through its
answer. Link targets are restricted to `http(s)`, `mailto`, `/` and `#`; images
additionally allow `data:image/`.

It covers fenced code, headings, GFM tables (alignment included — a pipe inside
`code` does not split a cell), blockquotes, ordered and unordered lists
(including `- [ ]` task lists), images, rules and paragraphs, plus inline code,
bold, italic, strikethrough and links: the range these models actually produce.

## Sidebar, clocks and tables (the round after the first real run)

- **The sidebar's status says how long ago, not that it is connected.** There is no
  "Event stream" row: its dot moved onto **Last event**, whose label carries the
  age (`Last event (12s)` / `(2m)` / `(3h)`, rounded down). Two readouts that both
  reset together were one fact printed twice, and "connected" beside a clock is
  the weaker half. The age repaints on a one-second interval; a tick is a text
  node.
- **Only a session's own traffic is liveness, and the clock dies with its session.**
  The age is worth a lot while you are waiting on the engine and nothing at all
  afterwards, so two rules keep it from outliving what it describes. Registry
  events (`project.updated` and friends) arrive whenever the rail is reloaded —
  including on the delete that follows a finished run — and they carry no session,
  so `setEventChip` ignores them: counting them kept the clock ticking over a
  session that was gone. And deleting the session that emitted the event clears
  the readout back to `Last event` / `idle` instead of leaving an age climbing
  beside a name that no longer exists.
- **`opencode v2.1.0`** — the `v` is part of a version, not a word.
- **The STATUS label is yellow**, like every other section heading in the rail,
  and its block lost 2px of the air above it (13 → 11): the divider and its label
  were reading as two groups.
- **The left panel is yellow now, not violet.** The current project is the
  loudest row in the rail — a **2px** yellow border (a 1px border plus an inset
  ring of the same colour, so selecting a project does not move the tree by a
  pixel) over a `rgba(237,194,90,0.10)` wash; the current session is one step
  quieter, a 1px inset ring at 0.6 alpha over `0.07`. Browse/Cmd use the same
  yellow on hover and press. Violet fills belong to the composer.
- **A session title is generated to fit its row: 22 characters, measured.** The
  title box is 145px at DM Sans 12.5px and `Ambient Second Monitor` is 145px. It
  got there from 125px by taking the rename pencil **out of the flow** (it now
  overlays the name's end on hover) and tightening the project indent — a control
  that is only visible on hover was costing three characters of every title.
  The CSS ellipsis stays: a title that still overflows must never push the delete
  button out of the row.
- **Three stopwatches, all client-side.** Each card carries `HH:MM:SS / HH:MM:SS`
  at its bottom right — the current task, then the role's total for this session —
  and the plan footer carries the session's own total. They are derived from what
  the cards already show (a live run for a worker, the open turn for the
  Architect), so waiting on a question, on a permission or on a finished plan
  stops them without inventing a second notion of "working". Totals live in
  `localStorage` keyed by session id; the current interval restarts from now on
  reload, because time with the page closed is not time we measured.
  The clock needs a strip of its own, so `.role-card` gained 8px of bottom
  padding: it sits under the clamped subtitle and can never collide with it, and
  every card is still the same height (114px).
- **The plan pane prints the plan, not the plan's homework.** Four yellow lines
  under the plan ("features.json: item 1 … is confirmed for task \"t4\", which is
  not in the plan") were the validator talking to the Architect, and every one of
  them was already in its own instruction block as "Plan problems to fix". The
  operator's rule is the one to apply to any yellow text: either it is theirs to
  act on, in short common English, or it is not on screen. This one was not, so it
  is gone from the UI and stays in `logs\app.log` (`logPlanState`). A plan that
  cannot be read is still shown: that one the operator does need, because the pane
  would otherwise look empty for no reason.
- **The step node is the state's dot with the id under it, both on one axis.** The
  id used to ride inline in front of the title, so a two-line title wrapped around
  a mark that had nothing to do with it. Now `plan-node` stacks the dot and the id
  (centred on each other, measured 1224 = 1224), the row is centred rather than
  top-aligned, and a one-, two- or three-line title all sit level with the dot
  (row centre 127.3, title centre 127.3). Three lines is the budget now.
- **A plan step carries its own stopwatch, and that is what makes a row two lines.**
  The badge and the clock stack in one right-hand column (`plan-side`), so the row
  is as tall as the stack whatever the title does — no `min-height` guessing. The
  time is the sum of that task's completed runs from `runs.jsonl` (served as
  `spent` on the plan payload, because a client clock only knows about the time
  this browser has been open) plus the live run's start while it is in hand.
  A step nobody has run keeps the line and hides its zeros: the height must not
  jump from row to row, but ten `00:00:00` under ten badges is noise.
- **The tools panel never met the chat's bottom because the grid had one row too
  many.** `.inspector` declared `auto auto minmax(0,1fr)` and had two children —
  the plan and the tools — so the tools sat in an `auto` row and the slack row
  stayed empty: measured 40px short of the dock. It is now
  `fit-content(55%) minmax(180px, 1fr)`: a short plan sizes to itself, a long one
  scrolls inside its panel, and the census always gets 180px instead of being
  squeezed to nothing. The bottoms now land on the same pixel (988/988 at a
  1000px window).
- **The jump buttons live in the transcript's top-right corner, at 22px.** At the
  middle of the pane they covered two lines of whatever was being read; in the
  corner they cover a sliver of one, and the pair sits side by side rather than
  stacked.
- **The PHASES line is gone.** It was the Architect's menu choice, not something
  the operator acts on, and it was not always true — a phase can be declared and
  then dropped.
- **The stacked rail's panels end on the same line.** Below 1460px the rail flows
  under the chat in two halves, and `align-items: start` made each panel size to its
  own content: the plan ended 100px below the census (1666 vs 1563) and the operator
  drew a line under the gap. `align-items: stretch` puts both bottoms on 1692, with
  the plan scrolling inside its panel. (Wide, the fault was different and older —
  see the `fit-content(55%)` note above.)
- **A background belongs to the sidebar only.** The central pane is one flat
  `#0E161E` (`.control-room .main-content`): the cards and the chat should be the
  only things in it with edges. It carried a framed photograph for a while, then a
  translucent dock to let that frame continue underneath — both are gone, and the
  dock is an opaque surface again. The sidebar keeps `bg-left2.png`, a 259x931
  image made for that column, at **100%** with `background-size: 100% 100%`: no
  overlay, no crop. `cover` would have cropped up to a third of the ribbon's width
  at a tall window, and a soft abstract tolerates the stretch.
  Two faults found on the way, both worth keeping: **96% overlays** — a photograph
  dark enough to sit under text needs no help being quiet, and at 96% the operator's
  word for it was "pretty much just 1 color"; and **JPEG had no MIME type** in the
  static server, so `bg-left.jpg` was served as `application/octet-stream` — it
  "usually" paints, which is not a reason to leave a type out of a table that exists
  to hold types. `.jpg`, `.jpeg` and `.webp` are there now.
  One selector trap: `body.dark .sidebar`, not `.sidebar` — the locked baseline sets
  that background with a two-class shorthand and resets a bare rule's image.
- **The ask row is right-aligned, state first.** The counter and the buttons sit
  together at the right and the warning text takes the left — which needed the
  DOM order changed as well as `justify-content: flex-end`, since `margin-left:
  auto` on the first button put the counter at the far left of the row.
- **Markdown tables wrap; they never scroll.** The baseline sets
  `white-space: nowrap` on every table, which is right for a rail of numbers and
  wrong for a nine-column report: the table ran off the chat and its right-hand
  columns were unreadable. `.msg-answer th/td` is `white-space: normal` with
  `overflow-wrap: anywhere`, so a long identifier breaks rather than widening the
  table.
- **The alarm popup is one shape at two weights.** A plain error gets the red
  badge and rule; an alarm about an agent naming Synapse gets amber, a sentence
  saying what did **not** happen (nothing was changed automatically, the run was
  not stopped) and the command in a mono block. It no longer repeats its own
  title as the first line of the body.
- **A status row that says "not wired yet" has to be wired when the thing is.** The
  sidebar's `Local LLM` row read `not set` from the day it was written until the
  local provider shipped — a placeholder telling the operator a capability was
  absent while the model was already in every role's menu. It now reads the
  configured local servers out of `engine.opencode.providers`
  (`Bionic · 1 model`) and its tooltip lists the base URL and the models. The dot
  stays grey: registering a server is not evidence it is running, and only a turn
  is. Placeholder copy is a claim; it ages badly.
- **Settings is six tabs, and the tabs are the app's own nouns.** One column of
  fourteen sections gave the server port and the log retention the same weight,
  and the Providers list needed a wider window than 640px. The rail is
  `General · Engine · Providers · Workers · Tools · Logging`, 176px, with
  inline-SVG icons at 15px; the active tab is a violet fill with white text and a
  white icon (violet is this palette's fill, and orange text on violet is still
  forbidden — it is the accent, not a surface colour). The window is 980px wide
  and the body scrolls, not the page: `.set-shell` is `grid-template-columns:
  176px 1fr`, so the rail keeps its own height and the pane scrolls under it.
  `Revert` (ghost, left) and `Save Changes` (primary, right) sit in a footer above
  a rule; the close X and Revert both mean "discard", one closes and one does not.
- **Every pane edits a draft, and the draft survives a tab switch.** Collecting
  the DOM on *save* only would have thrown away a half-typed Engine port the
  moment the operator looked at Providers, so `collectSettings()` runs on every
  tab change into `state.setDraft` (a deep copy taken when the window opens).
  Nothing reaches the file until Save; Revert is then exactly "throw the copy
  away". A provider is the one thing that is not a `data-path` field — it is an
  object in a list, edited straight into the draft as it is typed.
- **A provider's id is derived once, from its name, and then locked.** Model refs
  are `provider/model` (`deepseek/deepseek-flash`), so an id that moved when a
  name was corrected would strand every role's choice. The editor shows the id it
  will get (`test-vendor/…`) while the row is new, and after the first save the
  id is what the row is keyed by. Two providers with one name get `-2`, decided
  in `src/config.js` — the same rule in `src/providers.js` — never in the markup.
- **A key is shown masked, and only while it is being typed or deliberately
  revealed.** `sk-live-0123…7df` renders as `sk-liv***7df` (first six, three
  stars, last three): enough to tell two keys apart, never enough to use one.
  The eye is a drawn SVG at 14px in yellow (an edit affordance, like the pencil),
  toggling `type`-less text rather than the browser's password dots, because a
  row of dots cannot answer "is the right key in there?". Focusing a masked field
  selects it so typing replaces rather than appends; leaving it re-masks; a key
  written as `env:NAME` shows the variable and has no eye at all — there is
  nothing to hide when the file holds a variable name.
- **Refresh List is a real call, and it is the only one.** It posts
  `/api/providers/models`, which fetches `<baseURL>/models` with an 8s timeout and
  returns either a sorted list or one sentence ("The server answered 401. …",
  "Nothing is listening at that address."). It is how the operator learns a local
  server has eight models when the config names one. Nothing periodic touches a
  provider: the sidebar's `Local LLM` row reads the config, and a turn is what
  proves a server is running.
- **The model menu draws a rule between sources.** Eleven rows of five providers
  read as one list, and the selection highlight across a boundary made it worse.
  `.model-sep` is a 1px `--line` rule inset to the text column, inserted only when
  `m.provider` changes (the list is already sorted by provider, so no grouping
  pass). The separators live outside `.model-opt`, which keeps `menuRefs`
  aligned with the options for keyboard navigation.
- **Saving asks a question; it does not print a reminder.** "Restart Synapse to
  apply engine or server changes" was a toast the operator could only answer by
  leaving the app. Save now ends in a dialog with three answers: **Restart Now**,
  **Revert All Changes** (danger, red) and dismiss. Restart shows a curtain
  ("Restarting Synapse", a violet spinner) while the process is replaced, polls
  `/api/status` every second, and then calls `window.close()` — falling back to a
  reload 350ms later, because a tab nobody opened by script cannot be closed and
  a dead tab is worse than a revived one. Revert writes back the config as it was
  when the window opened (`state.settingsSnapshot`), so a save that turns out to
  be a mistake is undone in one click rather than by hand-editing JSON.
- **The save dialog is the only place a restart is offered, and a restart is
  `cmd /c start`.** A *detached* child of the server process does not survive it
  here — measured, three ways: `spawn(..., {detached:true})` never ran, a plain
  `spawn` child died with the parent, `cmd /c start` lived. The command is the
  same `restart.ps1` an operator runs, so there is one restart path and one set of
  pid-file rules.
- **A local provider is badged LOCAL, not by the app serving it.** "Bionic" is one
  machine's runtime; the next is Ollama or vLLM, and the same config has to read
  correctly there. `providerLabel()` asks the config for the provider's *type* and
  returns "Local" for `type: local`, the operator's own name for anything else
  ("DeepSeek"). The sidebar row follows: `Local LLM · 8 models`, never a vendor.
- **Add Provider sits above the list, the list is separated from the editor by a
  rule.** The button was below the rows, where it read as "add to what is above
  me" only after scrolling; the divider is what says the editor belongs to the
  selected row rather than to the list.
- **Revert and Stop are red, not hover-red.** Both throw work away. Stop was a
  neutral icon that blushed on hover — the one destructive control in the row was
  something to discover; Revert was ghost-grey beside a violet Save.
- **A field that needs a restart says so, and the save dialog asks only then.**
  Server host/port, the engine's port, binary, home, password, start timeout and
  the extra skill folders carry a small grey `RESTART` chip after the label, and
  the Providers heading carries one for the whole section (`restartNeeded()` in
  web/app.js lists the same paths by name). Everything else — roles, worker
  timers, log level, the census flag, a provider key — is read at the moment it
  is used, so saving it is done: the toast says "These take effect straight away"
  and no dialog appears. Adding a key to a provider used to demand a restart; it
  never needed one.
- **Provider badges are a fixed vocabulary, and local is not a vendor.** There are
  **two** engine badges: **OC Zen** (provider id `opencode`) and **OC Go**
  (`opencode-go`) — OpenCode *is* Zen, and its free models need no key while a Zen
  key unlocks the paid ones. A configured provider is **Local** when it points at
  this machine, whatever runs it, or its own name otherwise (**DeepSeek**). The
  Providers tab lists the two engine providers as read-only rows with their live
  model counts — "not connected" where the engine has none — because that is the
  honest answer to "why can I not pick OC Go".
- **The add button is violet on grey, not a violet fill.** It is a secondary
  action and Save Changes is the one filled button in the footer.

## Reading a mockup: it is a shape record, not a pixel source

The mockups in `docs/` are **PDFs and there is no PDF renderer on this machine**
(no `pdftoppm`, `magick`, `gswin64c`, `mutool`). Chrome renders them: open
`file:///F:/dev/Synapse/docs/<name>.pdf` in a browser session.

Two limits make them awkward to read as pictures. A `#zoom=200` fragment works
only on a *fresh* URL, so add a query string to force one. And the viewer cannot
be scrolled from the page, so only the top-left is readable at a time.

The answer is not to fight the viewer. A mockup records **shape**: where the
spine sits, how wide the band is, how big the cards are. The numbers that matter
are measured live in the page and asserted against, so the mockup is read for
intent and the layout is proved by measurement.

