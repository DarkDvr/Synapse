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

## Questions: a post in the chat, and the composer closes

A model asking the operator something is not a chat message — it is a blocked
session. The engine raises a form (see "Tools and models"), and Synapse renders it as
**the last post in the conversation**, in the chat's own colours with an orange
border, above a composer that is switched off until it is answered.

It used to be a panel painted *over* the chat. That was wrong for a reason the
operator named on 2 Nov: the overlay covered the reply the question was about, so
answering meant guessing what had been said. As a post, the answer is one scroll up.

- **The panel is moved, never rebuilt.** `renderTranscript()` replaces the
  transcript's markup on every change, so an element living inside it would be
  destroyed — and its radios, its page and its focus with it. `#askHost` is created
  in the shell, and `mountAskPost()` appends the *same node* as the transcript's last
  child after each render. That is what lets the polling rule below keep working.
- **It posts whole — no cap, no inner scroll.** An earlier version capped the panel to
  the chat's height so Submit could not fall below the fold (measured: a 319px panel in
  a 294px chat). The operator overruled it: a question you scroll *inside* a box inside
  a chat is a question with two scrollbars. The panel has no `max-height` and
  `.ask-fields` does not scroll; if it is taller than the chat, the chat scrolls, as for
  any long message. The padding came down so a typical four-option question (287px) fits
  a 294px chat without clipping its own header — measured after: header 5px inside the
  chat, Submit visible, zero inner overflow.
- **It opens at its start, not its end.** Scrolling to the bottom of a chat shorter than
  the question hid the question's own header and title. On a new form the transcript is
  positioned so the panel's top sits a few pixels below the chat's top, and the chat's
  follow is released so streaming text cannot yank it back.
- **Dense, not boxed.** Every answer used to be its own orange-bordered box inside an
  orange-bordered panel — too much orange, and three options took a screenful. The panel
  keeps its orange border (that is what marks it as a question), the fill is neutral, and
  the answers are a plain list divided by hairlines: one above every row, the first
  included, with a radio/checkbox, a 12.5px label and a 10.5px description.
- **The question is a jump target, and it lands at the top.** The chat's next/previous
  buttons step through messages, and the question is one of them — it was not, so
  "next" walked past it and the only way to read a question was to drag the chat
  (reported 2 Nov). It lands as the first thing in the chat, with the panel's header
  reserving 104px on its right: the floating jump buttons sit there, and landing the
  header underneath them hid it.
- **The Architect's live reasoning is inside its own post — and still a box.** It used
  to be a second grey block after the message, with its own "Architect · Thinking" head
  and its own gap, so it read as somebody else's post under a green one.
  `renderMessage(m, tail)` now takes the live panel as a tail and puts it inside
  `.msg-body`, which carries the speaker's 2px rule — one green line down the whole
  block, the reasoning in grey, no head (the post already says who is speaking) and no
  gap. `.trace.is-own` drops the head line and the left rule *only*: the 11-line
  scrolling window keeps its hairline box, radius and padding, the same frame a worker
  gets. 1.13.4 stripped the box too, and a long reasoning turn became a wall of italic
  text with no edge — reported and restored 2 Nov.
- **One question, one title.** The engine often sends the same sentence as both the
  field's title and its description, which printed the question twice. The title is now
  skipped when it is the description.
- **A question takes the whole composer.** The text box is disabled and says "Answer
  the question to continue"; Send, Attach, the mode switch and the run menu are
  disabled too — a half-dead composer invites a click that goes nowhere. **Stop stays
  live**: it is the way out of a question nobody can answer, and the engine treats a
  stop while a card is waiting as the immediate one.
- **A new question takes the chat's place.** On a new form signature the page arms
  the follow and scrolls to the end, because that is what the run is waiting on. The
  rest of the time the reader's position is respected as everywhere else.
- **The panel is polled, so it must never rebuild for nothing.** `refreshPending`
  runs every 8s; rebuilding the panel's HTML threw away answers the operator had
  already given (reproduced: pick a radio, wait for a poll, the radio cleared and
  Submit disabled itself again). `state.askSig` is the form's id plus its fields
  and option values — nothing about the answers — and an unchanged signature only
  re-places the panel. Same lesson as `renderSig` for the transcript.
- **The poll must not repaint the session at all when it learned nothing.** 27 Oct:
  on a laptop, typing in the chat moved it up and down by about a line every
  several seconds. The eight-second poll called `renderTranscript()` every time;
  the transcript's own signature guard returns early, but `fitChatHeight()` runs
  *before* that guard and re-settles the dock's height and the chat's scroll
  offset. `paneSig()` — the permission ids, the form ids, busy, canStop and the
  busy reason — is compared before and after, and an unchanged poll now paints
  nothing. A rebuild is not free just because its output is identical.
  **The dock's floor follows the composer, not the clock.** That poll was also the
  only thing re-measuring the dock after the composer grew, so a long draft left
  the transcript's bottom 112px behind the composer (measured at 1076px wide). A
  `ResizeObserver` on `#composer` now calls `fitChatHeight()` when its box changes
  — typing, attaching a file — which is the event that actually means the floor
  moved. Re-measured: dock 404px, transcript bottom 576, composer top 575.
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
  pending form is shown, and its head says where it came from — `asked in another
  chat — open that chat to answer`. The wording is `web/ask-note.js`, not a template
  string, because the first version read `another chat is waiting on you · full auto
  answers on its next check`: the first clause is false under Full auto (the run
  answers itself) and "check" is engine vocabulary for a poll nobody sees (2 Nov).
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

## The permission card: name the role, not the AI

The card sits in the transcript and the engine blocks the session until it is
answered. It has to say, in words a person reads once: **who** is asking — the
role's own name ("Coder 1", "The Architect"), with the task id on the right —
**what it wants to do** ("Coder 1 wants to change a file outside this project"),
the exact path or command, and **why** it has to ask ("Only the project may be
changed without asking. This is not in it.").

Never say "The AI", and never phrase the policy as something the operator did.
"The AI" hides which of five roles is blocked; "outside your workspace" reads as
the operator being somewhere they shouldn't. The policy returns a `scope`
(project, outside, harness, secret, unknown) and role-neutral reasons, and the
card builds the sentence with the role name in front.

Every card also says **Nothing has happened yet. You can still say no.** Four
narrow buttons stand in one row at the bottom left, each with its consequence as
a hover tooltip — "Reject" alone does not say whether the role stops or carries
on:

| button | colour | what pressing it does |
|---|---|---|
| Allow Once | green | does it this time only; the next one asks again |
| Always Allow | amber | does it, and remembers this exact path or command for the session |
| Reject | amber | says no; the role is told and carries on |
| Stop Run | red | ends the work, not just the request |

The chip's tooltip is a sentence, not a list of labels: "Coder 1 asked to read
F:/temp/hi.txt. You allowed it." A refusal adds the policy's reason; an allow
does not repeat "Reading is allowed", which says nothing the decision line does.

**Always Allow is ours, not the engine's.** The engine's `always` reply saves the
request's `save` patterns for the whole project — and for an edit those patterns
are `*`, so one click would let the AI edit anything, Synapse included. Synapse
answers `once` and keeps its own narrow memory instead: same action, same exact
resource, this session, and it can only turn an `ask` into an allow — never a
`deny`.

**A click that wakes the window is not an answer — unless the card was already there.**
On Windows, clicking an unfocused window brings it forward and still delivers the
click to the page. On 30 Oct a card "disappeared before I could answer": it had just
appeared under the pointer, and the wake click hit Always Allow. The rule now is
narrower: a permission control ignores a wake click only when the card was drawn in
the last two seconds. A card that has been waiting has been read, and a click on it
answers at once. Keyboard activation is never a wake click, and the refused click
leaves a one-line note on the card instead of a toast — the click after it is taken.
Every operator answer is still logged with the page, the button, the role and the
request (`permission allowed in the page by ANDREWS (coder-1): … — Always Allow`), so
an answered card never looks like one that vanished.

Two invariants:

- **A worker's request is shown too.** Hidden from the rail is not hidden from the
  operator: filtered to the open session, a worker's request blocked the worker
  until its timeout with nothing on screen.
- **An auto-answered request must not flash.** The gate answers in the same second,
  so the card is drawn after a 200ms refresh rather than painted straight from the
  event. A request the policy allows never appears; a real ask appears without a
  perceptible delay. The delay alone was not enough: the engine lists a request as
  pending from the moment it raises it, so a poll could still catch one the gate
  was mid-answer and paint a card for a second — a run with every call allowed
  looked like a stream of permissions appearing and disappearing (30 Oct). The gate
  now marks the requests it is judging (`answering`), `GET /api/pending` skips
  those and anything already decided, and only a request really waiting on the
  operator reaches the page.

**The chip on a tool call** is the same record after the fact: it appears only
when the call reached outside the project, green when the policy allowed it
without asking, amber when you had to, red when it was refused. Hovering says who
asked, what was asked, the policy's reason, and who decided. Four states have to
stay distinct or the chip is decoration: inside the project → no chip; outside and
auto-allowed → green; outside and answered by you → amber; refused by anyone →
red. The record is memory only, so a restart clears the chips and nothing else.

---

## A steer is the operator talking, so it never folds away

The operator's mid-run instruction is drawn twice: the engine keeps the `[steer]`
marker in the message, and the transcript shows a purple **You** with a bright
yellow **STEER:** in front (the tag inside the text span, so the browser aligns it
with the first line instead of a 9.5px word sitting above a 13.5px sentence).

In a worker's trace it is its own line shape: a flex row, so the small tag sits on
the sentence's centre line rather than a baseline nudge; the sentence wraps instead
of being cut with an ellipsis. It carries the same **2px bright yellow rule** the
permission log uses in the chat, drawn over the run trace's own grey rule (the line
reaches back 12px over the trace's border and padding), so there is one rule that
turns yellow where the operator spoke, not two side by side. And it is **pinned**:
the trace keeps the last four steps open and folds the rest into "N earlier steps",
and a steer used to fold with them — the operator's own instruction disappeared
while the run went on (30 Oct).
Every steer stays in the open tail, and a finished trace says `· steered` on its
folded line so the text can never become invisible.

---

## A model change is a repair

Changing a role's model in the picker is the operator saying "this role is fixed".
It must clear the red provider line for that role and lift the project hold —
otherwise a Stop or a failed model outlives the fix: the picker shows a healthy
model while every delegation is refused. The hold also lifts on an operator
message and on keep-building on; those three are the only exits, and the model
change is the one that used to be missing.

The picker's own select has to be updated before the card is re-rendered:
`renderRoleActivity` reads the refused mark from that value, and a stale one keeps
the old model's red line even after the new model is saved.

The ladder has the matching rule on the server: a stop or a restart is not a
failed attempt, and a task planned for a role whose model changed starts over on
that role instead of being stepped down to the next coder.

**A model change also ends a wait.** A role asleep in a provider backoff — a usage
cap, a rate limit, a refused model — is waiting on a clock the operator has just
made irrelevant. Saving a new model for that role wakes the run at once, moves the
session to the new model (the ref *and* its variant), and nudges it to carry on;
the backoff starts short again because the model is a different one. The operator
watched a run sit out a ten-minute cap after they had already fixed its model
(30 Oct). It is a wake, not a stop: the turn is not interrupted. The Architect's
own retry loop is woken the same way — its chat's model is switched and the report
send is tried again immediately.

**The ISSUES badge is not part of that.** It is the model's record, not the
role's, and a model change does not clear it. It clears when the model delivers:
a run that completes — the role finished its work — clears its mark, and the
operator can clear it by hand in the picker at any time. A clean probe does not
clear it: a test is not work.

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
- **The app icon is generated, not drawn.** `web\icon-256.png` is the largest
  rendered copy; `web\icon-{16,32,48,64,180,256}.png` and `favicon.ico`
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
  contents, so every pane that scrolls *inside* the page reserves its gutter —
  `.chat-scroll` and the rail panels. The page itself does **not**: a reserved gutter
  is a 10px empty column down the right-hand edge whether or not anything scrolls,
  and the operator saw it as a band. The page only scrolls in the narrow layout, where
  a bar is expected. Also: any grid column holding prose is `minmax(0, 1fr)`, never
  `auto`, so content cannot stretch it.
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
- **Adding a project can adopt a folder that already has a plan.** A folder can
  outlive its project — the operator may add a directory that already holds work —
  so a reused name like `Test Project 1` resolves to the same slug on disk and the
  new project inherits the old plan: the pane opened onto a finished 4/4 plan and
  the Architect card said DONE before anything was typed. That is now a three-way
  question (see the next bullet) rather than a toast, and `createProject` also
  reports `existingPlan` for API callers. It never wipes the plan by itself:
  re-adding a real project must continue its work.
- **Deleting a project deletes its folder, and the Recycle Bin is the undo.**
  Deleting used to only unregister — defensible for a folder the operator owns, and
  wrong for what it caused: a project deleted and re-created by name opened onto the
  previous run's plan. A project with no sessions has no session that still needs the
  folder, so the folder goes with it, into the **Recycle Bin** rather than out of
  existence (`Microsoft.VisualBasic.FileIO.FileSystem::DeleteDirectory` with
  `SendToRecycleBin`, called through PowerShell with the path in the **environment**,
  never in the command text, so a folder name cannot become code). Measured: a
  project holding `bin\App.exe` and `bin\ui\index.html` left the disk, the bin listed
  it from its parent folder, and the project left the rail.
  The refusals are structural and asserted in `tests/project-delete.test.mjs`: a drive
  root, the projects root, the harness, and anything containing the harness. **A drive
  root has to be judged before the path is normalised** — stripping the trailing
  separator turns `F:\` into `F:`, a drive-relative path that reads as an ordinary
  folder. A sibling whose name merely starts with the harness's (`Synapse.Projects`)
  is not the harness: only a path boundary counts.
  **The deliverables in `bin\` are their own consent.** `bin` is the one folder in a
  project whose contents are the app that was built rather than working state, so
  when it holds anything the dialog shows a checkbox with the count and the size, and
  its **Delete stays disabled until it is ticked**; the server refuses with a 409 as
  well, because a dialog is not the only way to send that request. An empty `bin\`
  needs no consent. `openDialog` re-arms its confirm button on every open, since a
  gated dialog would otherwise leave the next one disabled.
  A folder that fails to move keeps its project registered — a folder still on disk
  with its registry entry gone is the worse half of a failed delete.
  Two traps met on the way: the script was first assembled by joining its lines with
  `;`, which ends the call right after `DeleteDirectory(` and returns
  `MissingEndParenthesisInMethodCall`; and PowerShell's stderr is a stack trace, so
  the message shown to the operator is the first line that is not a `+ CategoryInfo`
  one, not the last line of noise.
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
  **Because it is derived from `used`, a plan rewrite does not reset
  participation** — the role did work in this session, whatever the plan now
  says — and a new session starts with every card dim, because a new session's
  id has no delegate lines yet. A reload or a restart shows the same picture.
  Two consequences worth keeping. The chip replaces the subtitle *text in the same
  slot*, so it cannot change a card's height (measured: all seven cards 106.28px
  with and without it, at 1680 and at 1200). And `state.roleSig` must include the
  dot class, the dim and the done flag, or a poll that changed only a status
  returns early and the dot never repaints — which is also why `loadPlan()` calls
  `renderRoleActivity()`: the plan poll (30s, plus every message event) is the
  only thing that learns a task changed.
  **A clock and a dim are two claims about one card, so they must come from one
  ledger.** 27 Oct: the QC card showed a time and stayed faded. The time was
  `spent`, summed over every run of that task id in the project; the fade was
  `used`, scoped to this session. `runLedger` (see `engine-notes.md`) now scopes
  both: a role's total is the time *this session's* runs of its tasks took, so a
  timer cannot appear on a card that never worked here. `dim` also refuses to
  fade a card whose tasks have session time, belt and braces.
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
- **Cards have a hard minimum width** (`--card-min: 310px`): the operator's own
  screenshot of one card at its minimum — name, full model label, both buttons on
  one line, clock still inside the frame. Two columns + the 66px spine need 686px
  of stage. (It was 250 for one revision; both 250 and 290 were "too narrow" by
  their measurement.)
  **The plan is beside the role cards above 1358, and under the chat at or below
  it.** The operator's rule, verbatim: "Project plan IS ALWAYS to the right of role
  cards, ALWAYS above the chat. There is only 1 exception possible — that is when
  role cards are more narrow than [their minimum]." The switch is their own
  window: at **1358** CSS px they want the plan below the chat, so the
  beside-the-cards media query starts at **1359** — one pixel past their window,
  which is what "unless the window becomes wider than this" means. Above that:
  - the plan sits in the cards' row, to their right, the conversation underneath
    **both** at full width, and the two reference tables under the chat;
  - the plan holds its full **341** and the cards take the rest, so widening the
    window widens the cards;
  - both boxes end on the same line (`contain: size` on the plan keeps the row
    sized by the cards, `max-height: none` lets it stretch to them).
  Below 1359 the plan falls under the chat at full width and the two tables share
  the line beneath it; below 1183 the panels lose the 284–341 range and fill
  whatever they are given; below 760 it is one column.
  The minimums the cards and the plan may not go below are **310** per card
  (`--card-min`) and **330** for the plan (`--plan-min`), both from the
  operator's own screenshots of each box at its limit.
  Neither side is allowed below its measured minimum — that is the whole point of
  measuring them. An earlier revision let the plan shrink to 240 to stay put; the
  operator's screenshot of the pane at 330 said that was too narrow.
  It lives in the stage, not in the inspector, and there is no JS that moves it —
  an earlier version re-parented it into the row of three panels on wide windows
  and the operator rejected that outright: three panels under the chat is not a
  thing they want at any width. The two reference tables are always under the
  chat, two of them, never holding the plan; below 1183 they lose the 284–341
  range and share the room, below 760 they stack.
  `fitChatHeight` counts the plan in the row only while it is placed in row 1
  (`gridRowStart === '1'`), otherwise the plan below the chat would be mistaken
  for part of the cards' row.
  **Beside the cards the plan is as tall as they are.** `contain: size` keeps the
  row sized by the cards, and `max-height: none` (in that band only) lets the plan
  stretch to it — the panel's bottom edge is the Coder 3 row's bottom edge. The
  420 cap belongs to the row of three under the chat, where every panel is the
  same fixed height. A 420 cap beside the cards left the plan 35px short of the
  cards and the operator spotted it immediately.
  Panels are **284 to 341** wide (`--panel-min` / `--panel-max`: the plan's old
  fixed width, and that +20%), two tracks while the plan is upstairs and three
  when it joins them, `justify-content: start` so the spare room waits at the
  right where a fourth panel would go.
  **CSS can place an element in two grids but cannot move it between two
  parents**, so `placePlanPanel()` does that one job: at boot, on resize and at
  the 1355 boundary it re-parents the plan between `.stage` and `.inspector`.
  Anything that assumes a fixed parent for the plan (a `.stage > .rail-plan`
  selector, a `closest('.stage')` in a measurement) is wrong on one side of that
  line.
  Below 1460 the stage is content-sized and the page scrolls.
  `body { min-width: 1100px }` keeps the cards' two columns at the floor;
  narrower windows scroll horizontally rather than squeezing the cards.
  The plan's goal is 11px and its step titles 11.5px — a point down from 12/12.5
  at the operator's request, because the panel is now 300-odd pixels wide rather
  than 400 and the old sizes ran to four lines each.
  **A panel's scroller must not be scoped to where the panel used to live.** The
  rules were written as `.inspector .rail-panel …`; when the plan briefly lived
  in the stage they stopped matching, and its bottom rows were sliced and
  unreachable — the operator saw exactly that and asked whether it was
  acceptable. They are now `.rail-panel …`, independent of the parent.
  **A cut row must read as "more below".** The panels are a fixed 420px tall, so
  a long plan is routinely clipped mid-row: `.rail-plan::after` fades the bottom
  edge into the panel's surface while `updatePlanOverflow()` reports something
  still below (set on repaint, on resize, on the plan's own scroll, and when the
  cards settle). A hard line through a card looks like clipping; a fade looks
  like scrolling.
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
- **A You message is left-aligned, with its parts on one vertical line (29 Oct).**
  The operator meant vertical alignment, not a centred block: `YOU` sat high, the
  text low, and `REUSE`/the clock higher again, because inline `vertical-align`
  values and a float did not agree. `.msg.user .msg-body` is now a flex row with
  `align-items: flex-start`; the role and clock are 1.5em boxes (one line of chat
  text) with their contents centred, so their glyphs share the text's centre line.
  `order: 99` puts the clock after `REUSE` even though it is first in the markup.
  Long messages keep the role on the first line instead of centring it down the
  block; the message stays left-aligned and the 2px rule stays at the left edge.
- **A sent message can be reused.** The small **Reuse** button beside a `You`
  message (29 Oct) copies its words and the attachment bytes the engine kept on
  the message back into the composer. It is a copy, not a resend: the operator can
  edit first, and clicking it must never throw away a draft — an empty box is
  replaced, a draft is appended, and attachments stop at the message's 48 MB
  total (24 files is only a sanity cap). It is quiet (55% opacity) because the
  transcript is for reading, not a toolbar.
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

## The layout audit: four numbers a picture cannot give you

The operator kept getting UI with "text not quite centred, buttons not the same size, something
indented for no reason". They were right that this is a class of defect, not three accidents: a
model looks at its render and *reads* "centred", "the same size", "one column", and it is wrong
confidently, because those are judgements and they are cheap to make instead of measuring.

The renderer already returns numbers (`overflow`, `contrast`, `small`), but none of them is an
alignment. So `shot.mjs` now measures four, on every run, and `--audit` prints them and exits 1:

| check | compares | defect |
|---|---|---|
| `controls-row` | controls sharing a row | heights or tops differ by ≥2px |
| `control-label` | a control's text box with its own box | off centre by >1px in x or y |
| `baseline` | two same-size runs on one line | baselines ≥0.6px apart |
| `column` | rows that start with a short label, in one block | one row 2–40px right of the rest |

Measured on the operator's own mock (`f4-modlist/.synapse/design/mock-1.html`, 876px): **three
findings, and they are the three things they photographed.** `button#p2.btn` was 26px against
`#p1`'s 30px; `span.sz` and its `a` sat 1px apart on one line; `div.h1` started its content at
145px while every row under it started at 133px (a header built from flex with a 12px gap, over
rows built from a 96px grid column). The picture had said "fine" to all three.

Four decisions keep it from crying wolf, and each was earned by a false positive on that page:

- **The baseline is measured, not assumed.** The line box does not tell you where the text sits;
  an empty inline-block inserted after the first text node does, because its bottom edge is on
  the baseline. Removed immediately, so nothing is left in the page.
- **Only same-size runs are compared.** The 1px step was mono-12 against sans-12 — same line box,
  different baseline. A small unit beside a big number is a deliberate pair, and comparing across
  sizes flagged every "17.9" + "GB" on the page.
- **A control's own label is not a baseline candidate.** A 24px button centred in a 30px row has
  its text 4px off the row's baseline by design; `controls-row` owns that row instead.
- **A flex or grid box is not measured at all.** The probe is an inline-block, and inside a flex
  container it becomes a flex item: on the operator's mock-2 the Designer got "5px apart" between
  `span.tier` and `a.link` whose text rects were identical (`y=536, h=16` both), because the
  anchor was `display:flex` and the probe landed on the container's edge. It reported that as a
  false positive instead of "fixing" a page that was right — and the check now skips those boxes.
- **One finding per defect, six per kind, 24 in total.** An archive list has the same 1px step in
  every row; five hundred findings is a report nobody reads.

The fix belongs in two places: the tool measures, and the briefs (designer, coder, QC) say that a
non-empty audit is not a style opinion. A check nobody runs is a check that does not exist.

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

## Speech and work, separated

A single-mode turn arrives as one assistant message whose parts alternate:
`reasoning`, `text`, `tool`, `reasoning`, `text`… all drawn inside the same green rule.
Only the *last* text of a turn was treated as the answer (`.is-answer`): 20px above it,
with the speaker's rule broken for exactly those 20px, so the reply read as a block of
its own.

The operator's report (31 Oct, two pictures): a reply to a completed stretch of work had
**no break above it** when a tool call followed it in the same turn, and **no break
below it** before that tool call. Both boundaries were flat — prose 5px under the
reasoning row above, the `question` card 2px under the last line.

So the break is positional rather than semantic now: wherever prose meets a card,
either way round, the rule is broken for one line and 20px of gap sits between them
(`.msg-body > :is(.reasoning, .tool-card) + .msg-answer` and
`.msg-answer + :is(.reasoning, .tool-card)`). A turn reads as two kinds of thing: what
the Architect said, and what it did. CSS only, no class — the adjacency is the whole
fact, and the same rule covers the last text of a turn, so nothing has to decide
whether a given paragraph is "the answer".

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
- **Views: the count sits with its label, the computer names take the rest.** The
  row reads `Views: 2` on the left and `Andrew-PC, LAPTOP-7G2` across the right.
  Names come from the server, not from the browser: `presence.js` uses the host's
  own name for loopback and a reverse DNS lookup for a LAN address, and the address
  itself only when the lookup has nothing to say. The count is views; the names are
  de-duplicated, because one machine with two tabs is one name. `.status-state`
  needs `min-width: 0` for its ellipsis to be able to apply at all — a flex child
  does not shrink below its content without it — and the row never wraps, so three
  or four clients shorten the names instead of adding a line. A row that grows a
  line on connect is a chat that moves.
- **Two things the operator removed, and why they are not to come back.** The
  rail's `working` chip beside a session name (27 Oct: the rail is a list of names
  and the chip took the width one needed — the yellow dot and the project rule
  already say "working"), and the composer's busy sentence above the controls
  ("this project is working — started from 192.0.2.115", which cost a line of
  chat to repeat what the cards say; a held Send with no caption was accepted in
  exchange, and the server still refuses with a toast if one is pressed).
- **The left panel is yellow now, not violet.** The current project is the
  loudest row in the rail — a **2px** yellow border (a 1px border plus an inset
  ring of the same colour, so selecting a project does not move the tree by a
  pixel) over a `rgba(237,194,90,0.10)` wash. Browse/Cmd use the same yellow on
  hover and press. Violet fills belong to the composer.
- **The rail is a list of projects, one row each (27 Oct).** Clicking a row opens
  the project's one conversation (its newest session, by creation). The row keeps
  a state dot — grey never used, green idle with a conversation, amber breathing
  while it works — a `?` when it is waiting on the operator, and a `⋯` that opens
  Browse, Cmd, Rename and Delete. Right-click and Shift+F10 open the same menu;
  the `⋯` is the visible door, because a menu nobody can see is not a menu. The
  sessions list, its label, the per-row pencil/✕/Browse/Cmd and the collapse
  caret are gone: the name gets the width back, and the row is one click to open.
  An empty registry is a real first run now — "A project is a folder. Make one
  and its conversation opens here." with one New Project button, no General.
- **A session title is generated to fit its row: 22 characters, measured.** (History:
  the rail no longer shows session titles at all — one project is one row — but the
  measurement is why the row's name survives a long project name.) The
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
- **A blocked row is not a page of red text, and a red card is not a crash.** The
  note under a blocked task is the reason, and on 28 Oct it was the Architect's
  whole deliberation — line numbers, contradictions, a verdict — which filled the
  pane and hid the list. It is clamped to two lines now, with the full text in the
  row's tooltip (`-webkit-line-clamp`). The role card for a blocked task used to
  show a red border and no words at all, which the operator read as "the Designer
  errored"; it says "Blocked — <task>" now and the row carries the reason.
- **The working wash and border light (28 Oct).** The finish the operator chose:
  a soft amber wash entering from **both** edges, breathing every 2.7 s (50%
  faster than the 4 s version), 12.3% at the edges (30% lighter again), plus a
  2 px conic light lapping the whole perimeter in 4.2 s. It marks the project row
  with `has-work` and the role card with `is-working` — and the card only while
  its turn is actually running, not while it waits on a question and not the
  Architect while a worker holds the floor. The wash is a pseudo behind the
  content (negative z-index inside an isolated stacking context); the ring is the
  same 2 px masked pseudo the demo proved. The card's `overflow: hidden` clips the
  ring inside its edge, which is deliberate. Reduced motion keeps the still tint
  and a fixed arc.
- **The run menu is fixed, not absolute (28 Oct).** The chat dock clips its
  children, and an empty chat's dock is only as tall as the composer: the menu
  opened 146 px above the cog and was cut off by the dock's top edge, leaving just
  a yellow cog. It is now positioned `fixed` against the viewport when it opens,
  above the button or below it if there is no room, and closes on resize or
  scroll. The empty-chat case was the proof: menu top 662, dock top 736, still
  hit-testable.
- **Paste is the second door to attachments (28 Oct).** Files and images on the
  clipboard become attachments; text over **10 lines or 1,200 characters** becomes
  a `pasted-text-*.txt` attachment instead of a wall in the box; an image copied
  only as HTML (`data:` URI, no File) is decoded too. Everything is read into
  memory and travels as base64 with the message — **no temp file is written**, so
  there is nothing to clean up. The 48 MB total / 8 MB per-file rule is shared with
  the paperclip picker; 24 files is only a sanity cap. Tested with synthetic
  clipboard events: 13 lines produced the text-file chip, a 1×1 PNG produced an
  image chip, a `notes.txt` File produced a file chip, and a small paste was left
  to the browser.
- **"Keep" is a deliberate project copy, not a temp file (28 Oct).** Each attachment
  chip carries a small boxed checkbox and the word **Keep**; the tooltip says it
  saves a copy in `.synapse/attachments/` that survives compaction and workers can
  read. A kept file is written at send (timestamped, name-sanitised), the project
  Log gets a `### attachment` line, and every brief names the folder. The inline
  attachment is still what the model reads that turn. Tested live: after a compact,
  the new session listed `.synapse/attachments/` and quoted the kept file.
- **A picture a model shows is a chip, and the picture is the hover (3 Nov).** A
  markdown image with a project-relative path — `![the mock](.synapse/shots/mock.png)`
  — is not rendered inline: it is one violet chip in the sentence, and hovering it
  shows the picture full size, centred above the chip. Inline put a wall of chat on
  screen for every screenshot; the chip costs a line and the operator chooses to
  look. The bytes come through `/api/image`, which serves only images inside the
  projects root (no SVG, 24 MB cap, realpath checked). Nothing is copied: the chip
  dies with the message at a compaction, and the file is the model's own scratch
  shot rather than a second copy Synapse made. The operator's own attachments use
  the same chip, so a picture sent to the AI and a picture the AI shows read the
  same way in the transcript.
- **The finish-line flag became a cog with two switches (28 Oct).** "Keep running"
  and the new "Full auto" live in a small menu above the button. The icon is the
  familiar settings gear, not a sun-like path: it has to read as a cog at 18px.
  With both switches off it is gray, yellow on hover or while the menu is open;
  with either switch on it is **green**, border and icon, so a standing decision
  is visible without opening the menu. It opens upward because the composer is at
  the bottom edge, and a click outside or Escape closes it. The old green flag and
  its green CSS are gone. Full auto answers permission cards with Allow Once and
  questions with the Recommended (or top) option after `fullAuto.timeoutSec`
  (Settings → Workers), so an unattended project keeps moving. At zero it answers
  a permission at once and draws no card.
- **A plan can stall on the Keep Building rule, and the card has to say why
  (28 Oct).** A two-task request ran t1, then the harness refused t2 because Keep
  Building was off — while the Architect's own last line said it had queued t2.
  The card said only "Waiting on you". It now says "Waiting on you — t2 is ready
  and Keep Building is off", or names the blocked task when nothing is ready, so
  the stall has a visible reason and a next step.
- **The step node is the state's dot with the id under it, both on one axis.** The
  id used to ride inline in front of the title, so a two-line title wrapped around
  a mark that had nothing to do with it. Now `plan-node` stacks the dot and the id
  (centred on each other, measured 1224 = 1224), the row is centred rather than
  top-aligned, and a one-, two- or three-line title all sit level with the dot
  (row centre 127.3, title centre 127.3). Three lines is the budget now.
- **A plan step carries its own stopwatch, and that is what makes a row two lines.**
  The badge and the clock stack in one right-hand column (`plan-side`), so the row
  is as tall as the stack whatever the title does — no `min-height` guessing. The
  time is the sum of that task's runs that *this session* asked for, from
  `runs.jsonl` (served as `spent` on the plan payload, because a client clock only
  knows about the time this browser has been open) plus the live run's start while
  it is in hand. A step nobody has run keeps the line and hides its zeros: the
  height must not jump from row to row, but ten `00:00:00` under ten badges is
  noise. **The same `spent` drives the plan row's review mark** (`reported`): a
  task marked `done` by an earlier session must not open this one already dashed,
  which is what happened on 27 Oct when the log was summed by task id alone.
- **Tokens per second comes from the stream, not from a turn's timestamps.** The
  card used to divide a turn's written tokens by `time.streamed − time.created`.
  That window starts before the engine assembles the request, so it grows with the
  transcript: a turn the model server clocked at 72.8 tok/s read 28 once the
  prompt was 97k tokens, and the number drifted through a run — "completely wrong
  and random", and it was. The honest interval is the first streamed piece to the
  last, which only the page sees; `paintRates` now keeps the run's running average
  (`tokens / streaming-ms`, accumulated per step), so the card settles within a
  few steps and stops jumping. There is deliberately no server-side estimate: the
  server does not see the pieces.
- **The tools panel never met the chat's bottom because the grid had one row too
  many.** `.inspector` declared `auto auto minmax(0,1fr)` and had two children —
  the plan and the tools — so the tools sat in an `auto` row and the slack row
  stayed empty: measured 40px short of the dock. It is now
  `fit-content(55%) minmax(180px, 1fr)`: a short plan sizes to itself, a long one
  scrolls inside its panel, and the census always gets 180px instead of being
  squeezed to nothing. The bottoms now land on the same pixel (988/988 at a
  1000px window).
- **The jump buttons live in the transcript's top-right corner, at 112px.** At the
  middle of the pane they covered two lines of whatever was being read; in the
  corner they cover a sliver of one, and the pair sits side by side rather than
  stacked. The 22px they started at put them under the plan panel's right edge and
  close to the window's own corner; the operator asked for them about 90px further
  left, which is the 112 that `right` now carries.
- **The compact chip joined that corner (27 Oct).** It used to float at the chat's
  top-left and covered the first line of whatever was being read. It is now the
  first item of the same right-anchored row (`.chat-tools`, `right: 112px`), 25px
  tall like a FAB, growing leftward and ellipsing. The row is the only thing at
  that offset; the FAB group is not absolutely positioned any more.
- **A live trace sits at the end of the transcript (27 Oct).** A finished trace
  keeps its start time — a run that began at 19:45 belongs above the report that
  arrives at 19:54. A *running* trace is the newest thing in the chat, so it is
  sorted after every message; otherwise a deferral or an acknowledgement that
  arrives mid-run pushes the live thinking up, and the operator saw the active
  reasoning as "the 3rd chat entry from the bottom". It settles back to its start
  when it reports.
- **Popups go to the window's top-right, not the bottom-right.** The baseline's
  `.toast-region` is `fixed; right: 24px; bottom: 24px`, which parked a toast about
  the run on top of the composer's Send and Stop. It is now `top: 16px; right:
  24px; bottom: auto` (an override in `synapse.css` — `summit.css` is locked), so
  the stack grows downward from the corner and no chat control is ever under it.
  It does overlap the plan panel's head, which is the corner the operator chose.
- **A finished plan row with no clock was a lie of omission (27 Oct).** The
  per-step stopwatch hides at zero, which is right for a task nobody has run yet —
  but the QC row the Architect settled itself is `done` with no worker run, and an
  absent clock read as a timer that failed to appear. Such a row now says "not run"
  in grey, with the reason in its tooltip, and the clock tick skips it instead of
  overwriting it with 00:00:00 a second later.
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
- **Settings is nine tabs, and a tab that holds one field is a place nobody looks.**
  Notices held a single selector — the finished-work sound — and it moved into
  General on 3 Nov; the tab that replaced it is **Automation**, which holds the
  four waits the switches obey. Keep a tab for a *subject*, not for a field.
- **The cog is four switches, and each one says what it will do.** It held two —
  "Keep running" and "Full auto" — which had to be moved together, so an operator
  who wanted questions answered also got every permission allowed. The four rows
  are the project's (Keep Building, Auto-Permissions, Auto-Answer, Auto-Shutdown),
  each with a one-line hint naming the wait in Settings → Automation; the cog is
  green while any of them is on. A toast after a toggle repeats the hint, so the
  switch explains itself where it is flipped rather than in a manual. **Its own
  listener closed it**: a capture-phase `scroll` handler on `window` dismisses the
  menu "when the page moves", and the transcript scrolls on every streamed line —
  so during a run the menu vanished the instant it opened. Scroll does not bubble,
  so the same listener without capture hears only the page, which is what was meant.
- **The tabs are the app's own nouns.** One column of
  fourteen sections gave the server port and the log retention the same weight,
  and the Providers list needed a wider window than 640px. The rail is
  `General · Server · Runtime · Providers · Workers · Tools · Automation · Logging`,
  176px, with
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
- **The save dialog is the only place a restart is offered, and the app owns the
  restart.** The server exits with code 2 and the app starts a new one; the window,
  the tray and the page all survive because none of them is part of the server. One
  restart path, one set of exit codes — see `desktop-app.md`.
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

## The worker's streaming panel, and what speed does to it

- **The text is appended, never rewritten.** The body holds one text node, and the
  page used to assign the whole block to it every frame: up to twenty thousand
  characters re-broken per frame, which is exactly the cost the panel exists to
  avoid. Now the module hands over only the new tail (`takePending`), and the
  panel appends it.
- **The buffer trims in one chunk, not one character.** Capping at 20,000 and
  keeping 20,000 means the next character trims again — a full rewrite on every
  frame for the rest of the step. One long reasoning block reached it in one turn
  on 23 Oct (43,526 characters). It now keeps 15,000 when the guard fires, so the
  rewrite happens about once every few thousand characters.
- **A finished block keeps its last window.** The panel is up to eleven lines
  tall; taking it away when the step ended pulled eleven lines out of the chat and
  put them back at the next step. At 50-60 tok/s a step is long enough that
  nobody saw it; at 100+ tok/s the steps are one to six seconds, so it happened
  several times a second. The window now stays, dimmed (`.is-idle`), until the
  next block replaces it or the run folds to its one-line summary.

### A turn's reasoning folds, and the slide survives a rebuild (8 Nov)

Two reports about one turn. The operator saw a long Architect turn as a wall of
"Reasoning" lines — one per step, **105 of them in a 35-message chat** — and the
reasoning panel jumped the moment a step ended.

- **The early reasoning is one line.** A turn keeps its newest **ten** reasoning
  blocks as folds of their own; everything older is a single
  `<details class="reasoning is-archive">` whose summary is "N earlier reasoning".
  This is the shape the worker trace already uses for its older steps ("N earlier
  steps"), for the same reason: the newest thinking is what is being read, the rest
  is context. Each fold's summary carries the block's **first sentence**, clipped to
  one line (`reasoningGist`), so it says what the block was about instead of only
  that it exists — "Reasoning · The menu is drawn by MainWindow." rather than ten
  identical "Reasoning" lines. Measured after the change on the Fever Tracker chat:
  105 folds became 31, plus 12 archives. The archive takes the oldest block's place,
  so the turn still reads in order. The summary is **sentence case** even inside a
  trace: `.trace summary` is upper case, and a fold that inherited it shouted
  "REASONING · LET'S START…" (8 Nov). It is also bounded by the pane, not by the
  gist's length: a flex item's `min-width: auto` is the whole nowrap sentence, so
  `.trace-lines > * { min-width: 0 }` is what lets the ellipsis land at the edge.
- **A worker's finished thinking is a fold too, and it is kept.** `endStream()`
  pushes a `think` block into `trace.reasons` (last twelve) and the trace draws it as
  `<details class="reasoning is-trace">` — the trace is the only record of a worker's
  reasoning. The steps are also posted to `/api/runs/reason`, so a reload and a
  second view get them back from `/api/runs` the way the notes already did; the file
  is `data/trace-reasons.json`, pruned at boot, forty runs at most.
- **A steer and a compaction sit where the work is.** Both used to render at the top
  of the trace, above the earlier-steps fold and the reasoning folds — off the screen
  while the operator watched the live panel, so a steer looked unsent. They are pinned
  just above the panel now (compaction, loop, then the operator's steers), and at the
  bottom when there is no panel. The line is painted from `run.steer`, which the runner
  emits *before* it delivers the prompt, so the feedback does not wait for the engine.
- **A worker's question is answered here.** The head note said "asked in another chat —
  open that chat to answer", and there is no such chat for a worker: its question is
  posted over the Architect's conversation. It says "a worker is waiting — answer here
  to continue" (`askHeadNote({ worker })`).- **The streaming panel is one node, so a new block has to reconcile with it.**
  `adoptStream()` compares what the node holds with what the stream holds: a
  different block is replaced, a prefix gets only its tail, an identical string
  writes nothing. Two bugs came from skipping that: a new block *appended* to the
  old words (the panel slid from the top of both to the bottom), and the old
  block's `transform` stayed on the node (the empty pane that grew). Every acquire
  also re-applies the offset — a rebuild is a new element with no transform.
- **A compaction says how full the window was while it runs.** The line was
  "⏳ Compacting ×3" until the summary finished and the runner could read the
  compaction's own usage — one moment too late. The size that caused it is the last
  prompt the run reported, handed to the trace with `session.compaction.started`:
  "⏳ Compacting ×3 · context at 47K/205K". The finished line keeps the engine's own
  number, which is the one worth keeping.
- **A rebuild must put the slide back.** The panel's position is a `transform` on
  the text node, and `renderTranscript()` replaces the node: the offset went with
  it, so the panel showed the *first* line of the reasoning at the moment the step
  ended. That is the "scrolls abruptly, can't tell up or down" report — the text did
  not scroll, it teleported to the top. `restoreStreamView()` re-applies the offset
  (and the `is-scrolling` fade) after every render, not only on frames that write.
  The general rule: **a transform is DOM, not state — anything that rebuilds the
  node has to restore it.**

## Reading a mockup: it is a shape record, not a pixel source

A mockup may arrive as a PDF, and there is no PDF renderer on this machine
(no `pdftoppm`, `magick`, `gswin64c`, `mutool`). Chrome renders it: open the
file in a browser session.

## A mode switch: two things move, and neither re-renders

Reported on the Fever Tracker session (15 tasks, wide layout, 1400x900): switching
Multi → Single made the conversation seem to vanish, and the text shimmered and
twitched by about a pixel while the cards slid.

Measured with a 40ms sampler on `.chat-dock` and `#transcript`, both directions:

- The dock went 355 → 366, held for 250ms, then 521 → 733. Two movements, not one.
  `fitChatHeight()` reads the row as `max(wrapper, planInRow ? planEl.height : 0)`,
  and at the moment `setView()` fitted, the plan still had its *Multi* height (472px,
  the pre-repaint list). The chat was squeezed to 366 for the length of the slide,
  then the 340ms settle timer refitted it to 733 — the drop. In Single the plan's
  wrapper is exactly the Architect card, so the plan must not size row 1 at all:
  `planInRow` now also requires `state.mode !== 'single'`.
- The scroll was never re-pinned. A mode switch changes the dock's height with no
  render, so nothing called the follow; a reader at the end in Multi ended up 385px
  short of it in Single and the newest messages sat below the fold. `holdChatFollow`
  holds the pin for 500ms on the frames the browser is already painting, and still
  lets go on an upward wheel, like every other follow.
- The residual twitch is **in the box, not the scroll**. With the height
  interpolated, its edges land on fractions of a pixel, so the text's offset from
  the bottom edge moves by up to ~0.5px per frame. Making the scroll offset
  "stable" (flooring it below the true end instead of letting the browser clamp)
  was measured and changed nothing; forcing the scroller's height to whole pixels
  froze the box at 673px, because a definite height stops following its parent.
  What does help is not re-rasterising: `is-mode-animating` promotes the dock
  (`translateZ(0)`) and the scroller (`will-change: scroll-position`,
  `overflow-anchor: none`, so nothing else nudges the offset we just wrote).

The instrument worth keeping: sample `dock.height`, `scrollTop` and the bottom of
the last transcript child every 25–40ms across a switch. "One movement", "slack 0
on every frame" and "the last message visible on every frame" are three separate
claims, and only the first was ever true by accident.

### The chat's geometry: the bottom edge stays, the top edge moves, nothing else does

This one cost three attempts and two wrong diagnoses, so the statement of the problem
comes first, in the operator's words: **"Have the chat sit in its current spot. The only
thing that moves is its top edge, uncovering more of the chat history."** Everything
below follows from that sentence, and every attempt that drifted from it failed.

The shape of it: the dock's **bottom** edge is the window's and never moves; its **top**
edge is wherever the cards end and moves whenever they do; **nothing inside the box
moves**. Three facts, and each one has exactly one implementation.

**1. The height is measured, not predicted.** It is `window bottom − dock top`, both
read now. It used to be built from the reveal's *target* height (`--reveal-h`), which is
rounded up (a cap must not clip a border) and which, during a slide, describes a layout
that does not exist yet. That is where the two-stage drop came from: the chat was fitted
to 366px for the length of a switch and then to 733. The height carries a *fraction* on
purpose — the top is on a fraction (a card row really is 126.281px), and the edge that
must land on a whole pixel is the bottom, because that is where the composer and every
label in it live.

**2. The offset keeps the reader's place, measured from the end.**
`chatSlack = scrollHeight − clientHeight − scrollTop`, restored after every change as
`scrollTop = scrollHeight − clientHeight − chatSlack`. Keeping the slack constant keeps
the words still whether the reader is at the end or deep in the history. The property
that matters is that it is **idempotent** — restoring it twice, or from two callers,
lands on the same offset. Two earlier versions tracked the *height change* and added it
to the offset: correct exactly once, and double-counted the moment two paths saw the
same change. That measured as a 12px jump, then a 1px one, then a 1px one — each
caller's share of one event.

**3. The top edge is watched by reading it.** `ResizeObserver` reports *sizes*, and the
box above the chat can move without any observed box changing size. Three attempts to
watch "the things above it" each found one more source and missed the next: the cards,
then the plan panel (which sets row 1 in Multi when it is the taller of the two), and
finally a 6px shift during a run that no size change accounted for at all. So the top
edge is read once per frame and the height is fitted when it is not where it was. One
`getBoundingClientRect` and a comparison per frame invalidates no layout, so a still
frame costs nothing, and a moving one is exact.

Two things were removed rather than fixed, and they should stay removed:

- **No transition on the height.** It was there "so the chat moves with the cards". The
  chat's *top* already moves with the cards — it is the row underneath — so all the
  transition did was make the bottom edge lag behind every change above it. During a run
  the Architect's card gains and loses its status line several times a second, and each
  one dragged the composer along for 260ms: 8.8px between two idle samples and the
  1px-per-frame bounce visible in the operator's recording.
- **No per-frame forcing from a timer.** `requestAnimationFrame` loops that rewrote the
  height for a fixed 380–500ms were guessing when an animation ends. The observer and the
  position watch both stop when the change stops, because they are driven by the change.

Why the words showed it and the status dot did not: a line of text is drawn on a whole
pixel, so a fractional drift is a visible jump of one; a circle's antialiased edge moving
the same amount just redistributes its alpha. That clue was right, and it is worth
keeping — it points at sub-pixel position, not at layout.

Measured, at the operator's 1243px window: a switch in either direction, at the end and
scrolled up — line **0.00–0.02px**, composer **0.00**, dock bottom **0.00**, top edge
361–371px as intended. A 30-second run in Multi — top edge 6px, bottom **0.00**,
composer **0.00**, a fixed line **0.00**. Ten seconds idle — **0.00** everywhere.

One thing the invariant alone got wrong, because it is only as right as the number it
holds: a chat that sat **12px short of the end** kept those 12px through a switch. In
Single's tall box that gap is invisible; in Multi's short one there is no spare room
under the last line, so it read as "Single → Multi leaves the chat scrolled up", while
the other direction looked fine. The app already has a definition of *at the end* —
`CHAT_FOLLOW_SLACK`, two lines, the window in which a new message pulls the chat down —
so anchoring uses the same one: within two lines is held *as* the end, not as a gap.
Measured: starting slack 0 / 12 / 30 / 47 ends at **0** in both directions; 60 / 200 /
900 (deliberately scrolled up) is preserved exactly. And the settle happens once, at the
click, not during the animation.

Two more, both of which only showed in the **wide** layout — the one where the grid owns
the chat's height:

- **The settle has to run before the paint, so it cannot be an observer's job.** In the
  narrow layout `fitChatHeight` writes the height and settles the scroll in the same
  call, before the frame is drawn; in the wide layout there is no height to write, so
  the settle ran only from a `ResizeObserver`, which reports *after* the layout that
  changed — every frame painted once at the old offset and corrected afterwards. That is
  a sub-pixel shift per frame: invisible in one layout, a shimmer on the text in the
  other, and it is why exactly the wide window was wrong. `watchChatGeometry` now reads
  the geometry once a frame (rAF runs before paint) and settles there.
- **A scroll event from our own write is not the reader's place.** A scroll event is
  dispatched after the frame's layout, so by the time `noteChatScroll` measured the
  distance from the end, the box had already changed again — every reading a little
  larger than the last. Over one switch a 300px scroll-up compounded to 496px, and the
  chat drifted 196px under the reader. Writes record the offset they landed on
  (`chatScrollWritten`), and a scroll event matching it is ignored.

Measured after both, at 1600px (wide, grid-owned height) and 1243px (narrow, us): switch
either way, at the end and 300px scrolled up — message **0.0–0.1px**, slack **unchanged**,
composer **0.0**, and the box's top edge on whole pixels every frame.

**A floor taller than the room does not grow the room.** `min-height: clamp(150px, 32vh,
360px)` on the chat was written for the content-sized layout, where without it the chat
could collapse to its composer. It applied up to 1460px, and between 1359 and 1460 the
stage has a *definite* height, so the chat's row is the room that is actually left — on a
1369×770 window that is 214.9px, and a 246.4px floor does not enlarge it: the transcript
sits 31.5px lower than its own row, *behind the composer*. The newest lines were covered,
the hidden amount changed with every mode switch, and the words under the composer edge
moved with it. Two rules came out of it: the floor is scoped to the content-sized layout
(`<=1358px`), and the height fit now reads that floor from the stylesheet instead of
assuming one — `composer + computed min-height` — so a floor can be honoured by making
the whole dock overflow the page rather than by the transcript overflowing the dock.

**A height measured against the viewport in a scrolling layout chases the scroll.**
`fitChatHeight` sized the dock as `viewport bottom − dock top`. In the narrow layout the
viewport's bottom *moves with the page*, so the dock grew by exactly the distance scrolled,
the document grew by the same amount, and the plan under the chat stayed one screen below
the fold for ever — the operator's report was "scrolling down simply raises the chat's top
bar infinitely". Measured at 1160×894, scrolling 0 / 120 / … / 600px gave a dock of
349 / 469 / … / 949px, the plan's top pinned at **896** on every sample and the document
growing 1328 → 1928. The height is now the room under the cards in one screen, measured
from the dock's place in the **document** — which does not move — so it comes out identical
at every scroll position: 348.875px for all six samples, the document steady at 1328, the
plan in view after 150px of scroll and fully in view at the 434px maximum. Scrolling the
page also stopped disturbing the transcript (same offset, 15405, before and after). Any box
sized for the `<=1358px` layout obeys this rule, not just the dock.

**One breakpoint, in one place.** CSS switches layout at 1359/1358; `fitChatHeight` and
`stageBudget` still cut at 1461, so the 1359–1460 band was sized by the narrow rules while
the wide layout was on screen — and JS wrote an inline height over the CSS `height: 100%`.
`WIDE_LAYOUT` (`min-width: 1359px`) is now the single predicate for both. Verified at
1400px: no inline height, the plan holds column 2, the page does not scroll, the dock's
bottom and the composer sit at 888/887 of a 900px window — and at 1600px, identically.

**A toggle that tells the engine afterwards must send its patches in order.** The mode was
flipped on screen at once and the permission `PATCH` followed, so two clicks inside one
request left the engine holding whichever answer arrived last — possibly the mode the
operator had already left, which refuses delegation while the cards say Multi. The patches
were chained and only the newest switch could report or revert a failure. Verified by
double-clicking the toggle: the screen and the engine both ended on Multi, the dock back at
348.875px.

**27 Oct — the patch was the problem, so it is gone.** The toggle is now only the page's
pending choice: a click changes the label, the plan pane and the cards, and touches nothing
on the engine. `send` carries `mode`, and the server applies the ruleset once (only if it
differs), then briefs with the same value and prompts. Clicking ten times and sending once
is one apply; clicking and not sending is none. The toggle stays disabled while a run is
live because the running turn's mode is already fixed — not because the engine cares about
the click. A `session.mode` event tells another window the applied mode, so two views do
not show different modes for the same chat.

**The compact chip is only there when it can run.** It is a pill in the chat's top-left,
floating like the scroll buttons, with no padding reserved for it — the operator's call:
text may pass under it, and a chat that loses 30px of every line to chrome is worse. It is
*hidden*, not greyed, when there is nothing to discard, when the project is working, or
while a compact is in flight (when it says "Compacting…"). The first click turns it red and
names what is lost ("Discard 42 messages? The files stay · 2 tasks unfinished"); a second
click within three seconds does it, anything else cancels. Red because that is this
palette's destructive colour and this is the third control that throws work away, after
Stop and Revert.

**Stop is live while Compacting (29 Oct).** The engine can take its time writing the
handover, so leaving Stop disabled kept the whole chat locked on a compact the operator
had already decided against. Stop is enabled by `state.compacting`, the request is
cancelled server-side, and the catch says "Compaction Cancelled" and restores the
composer instead of "Could Not Compact". A failed compaction message is read from the
engine's own transcript at once, not after the three-minute timeout.

**The post is a `<details>`, not a message, and its open state is kept.** It renders from
the new session's metadata (`synapse.compacted`), so a reload still shows it; the summary is
behind the summary line. The transcript re-renders on every streamed delta, so its open
state goes through `state.open` like a reasoning block's — otherwise reading the handover
while a run streamed would snap it shut. It is not in `state.messages`: it is not part of
the conversation, no model ever saw it, and it disappears when the next compact replaces the
chat.

**A compact leaves the post — and nothing else above it.** The fold lines (one per finished
run) and the amber alarm lines are page state kept per project, not messages, so they
outlived the conversation they described: 1 Nov showed the "Compacted" post with eleven folds
and an alarm stacked under it. A compact now calls `forgetConversation(dir, oldSessionId)`
before the new chat opens — those lines were that chat's evidence, and the run log still has
them. What is left is the post, then the new conversation.

**The engine's own "loaded a file" messages are collapsed.** After a compact the engine
announces every instruction file it reads and posts the whole text — `android\AGENTS.md` is
about 10,800 characters, and it landed in the chat as prose the operator had to scroll past.
The text is in the model's context either way, so the chat keeps one line ("Instructions from
android\AGENTS.md", full path on hover) and the text behind it, in the same `<details>` the
compact post uses. Each one carries its own `data-k`, because the post's open state was keyed
`compact-post` in two places and a second collapsible post would have opened the wrong one.

Two ways to measure this, both worth keeping. The layout tells you *where* boxes are; the
pixels tell you whether anything was repainted: screenshot a fixed clip during the
animation and compare frames byte-wise (they came back **identical** for `c3..c7`), which
distinguishes "the content moved" from "the content was re-drawn". And `Emulation.
setDeviceMetricsOverride` through CDP is the only way to test the `>=1461px` layout here —
`page.setViewportSize` silently does not exceed the real window (it reported 1600 while
`innerWidth` stayed 1369), and the override is dropped when the call ends, so it has to be
set *inside* every measurement.




The instrument, since it is reusable: this machine has ffmpeg (winget: `Gyan.FFmpeg`,
not on `PATH`), so a recording becomes frames with `ffmpeg -i in.mp4 -f rawvideo -pix_fmt
gray out.gray`, and a band's row signature then shows a one-pixel shift honestly —
comparing a profile against itself at offsets −3..3 finds the frame-to-frame movement
without decoding PNGs at all. Screenshots + a `zlib` PNG reader also work and are what
found the mode button's `417..442 / 418..443` alternation, but the raw dump is faster and
cannot lie about timing.

Two limits make them awkward to read as pictures. A `#zoom=200` fragment works
only on a *fresh* URL, so add a query string to force one. And the viewer cannot
be scrolled from the page, so only the top-left is readable at a time.

The answer is not to fight the viewer. A mockup records **shape**: where the
spine sits, how wide the band is, how big the cards are. The numbers that matter
are measured live in the page and asserted against, so the mockup is read for
intent and the layout is proved by measurement.

### The composer's height must not be measured by shrinking it

The operator's report (31 Oct): **"when I am typing a message in chat, my chat scrolls
up and down by about half a line of text, seemingly randomly as I type."** Single mode,
and it was the composer, not the chat.

The auto-growing textarea used the idiom everybody uses: `height: auto`, read
`scrollHeight`, write it back. For the instant between those two writes the composer is
**one line tall**, so the transcript above it is one line taller — and the browser, seeing
that the scroller can now travel less far, **clamps the chat's scroll offset** to the new
maximum. The clamp is not undone when the height is restored: the offset stays where the
browser put it. Measured on a 42-message transcript at 1280px: offset **3143** (exactly
the end) → **3110** while the box was 33px short → still **3110** after the height went
back, and still 3110 half a second later — the geometry watcher never saw the transient,
so nothing put it right. The conversation was left one line short of its end. The next
thing that pinned the end (a render, a stream frame, a mode redraw) wrote the bottom
back, and the next keystroke clamped it again: up and down, about half a line, at random
intervals. That is the whole bug, and the trigger is the *measurement*, not the growth.

The fix is to stop measuring: `.composer textarea` carries `field-sizing: content`, so the
browser sizes the box from its text in the same layout pass. There is no transient box, so
there is nothing to clamp, and the inline height is cleared wherever an older build left
one (`autoGrow`). Engines without `field-sizing` still measure the old way, with the
chat's offset saved and put back across the measurement.

Verified by typing 1521 characters at 30ms a keystroke in a live page, at 1280px and at
500px: the box grew 38.3 → 54.5 → … → 150px (its ceiling) and stopped there with the text
scrolling inside it, the transcript followed the end exactly (`top == max`), and the
scroll offset changed on **8** frames out of ~1200 — one per wrap, **all of them
downward**, **none backward**. Before the fix the same probe produced a +14/−14 pair per
wrap.

## A late answer belongs to the chat that asked

Any loader that writes state after an `await` must capture the id it asked about
and compare it before writing. The open chat can be replaced while the request is
in flight — a compact deletes it and opens its replacement in the same second.
Measured 27 Oct: the 8-second message poll was still asking for the old chat, got
the 404 the compact itself had caused, and closed the *new* chat, leaving the
landing page a second after a successful compact; and a plan answer for the
previous project painted "No plan yet" over a project that has three tasks.
`loadMessages` and `loadPlan` now do this; the same pattern applies to any
fetcher keyed by `state.sessionId`.

Two corollaries. A load that is part of a replacement must not read the old id
leaving the list as "the open chat was removed" (`loadProjects({ keepOpen })`).
And a block with content behind it (`<details>`) needs its open state keyed in
`state.open`, or the next render shuts it — the compact post was rebuilt closed
by every poll because only Reasoning blocks were remembered.

## The thinking pane, rewritten

The pane that shows a worker's thoughts arriving was patched four times and never
trusted: a feed-forward spring, an adoption pass that re-anchored its text node to
the newest line on every rebuild, a height reservation that rebuilt the transcript
from inside the animation frame (dropping the node the frame held), and a fade mask
whose 0.5px threshold the settling spring could sit on and flap. The slide never
looked right and the chat blinked.

It is now `web/thinking-pane.js`, and it is small on purpose: one text tail (cut on
a line boundary), one exponential ease (`paneEase`, τ = 120ms), and two states
(open, or one breathing "Thinking…" line). Classes are set by the frame, never by a
render, so no frame is ever thrown away mid-flight; the transcript is rebuilt only
when the pane appears, is collapsed, or the trace around it changes. `chat-scroll.js`
keeps only the data decisions — which trace the words belong to, the fold when a step
ends, and the paragraph speech becomes. The pure halves are tested; the rest is
looked at in the page, which is the part the four patches kept skipping.

## The finished-work chime

The operator asked for "a small sound effect when the Architect has finished work and says
he is done", with a few to choose between. Three decisions carried it.

**The sounds are generated, not borrowed.** Windows' own chimes are Microsoft's files, and
reading `C:\Windows\Media` at runtime would put the app's behaviour in someone else's
folder — the one thing this harness does not do (AGENTS.md, rule 2). Four short WAVs are
written by `scripts/make-sounds.mjs` into `web/sounds/`, which means they travel with the
folder, play on a fresh PC, and carry no licence but ours. All are mono 16-bit, 0.3–1.2s,
peaking between −14 and −18 dBFS: loud enough to notice, quiet enough to talk over.

**The screen lease has its own pair, and its own switch.** Taking the mouse and
keyboard plays screen-in — four bright, thin notes rising, a toy-piano timbre that is
over in four tenths of a second; giving them back plays screen-out, the same four
falling. They are not in the finished-work dropdown because they are not that sound:
the chime means the job is done, these mean the machine is borrowed or returned. One
checkbox — **AI screen usage alerts** (`notify.screenSounds`, on by default) — turns the
pair off and leaves the badge and the toast, which say the same thing in words.

The generator had one bug worth its note: the envelope is `(1 − e^(−t/attack)) · e^(−t/tau)`,
which is **exactly zero at t = 0**, so a loop that stops when the envelope falls below 1e-4
stopped on the first sample and wrote three completely silent files. The check is
`t > 0.001 && env < 1e-4`. Measure the file you produced — the peak read `-Infinity dBFS`,
which is how it was caught.

**When it plays is "the chat went quiet", not "a message arrived".** `noteWorking()` asks
`sessionWorking()` — the same predicate the rail's breathing dot uses — so the sound is the
moment the work the operator was waiting on stops. A Multi run keeps it live while a worker
builds, so the gaps between delegated tasks do not chirp; the chime comes when the Architect
has read the last report and said its piece. A turn that failed or was interrupted is not
"done", so it is silent (`workEndQuiet`), and opening a chat mid-run arms the flag from
where it is rather than firing for the work already done.

**A gap between two pieces of work is not a finish.** That was the second bug, and it only
shows in Multi. Measured from `logs/app.log`: a coder's run **completed at 14:11:35**; the
Architect then read the report, marked the task done (plan change at 14:11:54) and started
the next task at **14:12:09**. For that gap nothing was working — so the chime fired, telling
the operator the job was over with two tasks still to do. The fix is `workWillContinue()` in
`web/notify.js`: *only in Multi, only with Keep running on, and only when the plan still has
a row to do* is a silence a pause rather than an end. A blocked or failed row is not "to do" —
that is the run stopping for the operator, which is exactly when the sound earns its keep.
The page stays armed through a pause, so the cue still comes when the *last* task ends; the
plan is re-read on every change and asks again, which is what releases it when the plan
update lags the turn. The trade is deliberate: a plan the Architect forgets to finish means
a quiet finish, and a sound during the run was worse.

**Autoplay is not guaranteed, so failure is silent.** `new Audio(url).play()` can be refused
before the page has had a gesture. The promise's rejection is swallowed, because a refused
sound must never surface as an error in a chat — the operator will have clicked Send long
before any turn ends, so in practice it plays. Chrome also needs the URL served as
`audio/wav`; an octet-stream is the same silent failure, so the MIME table in
`src/server.js` has an entry and `tests/notify.test.mjs` asserts it.

## Screenshots from an occluded window are stale

`Page.captureScreenshot` hands back the last composed frame when the QC Edge
window sits behind another window: the DOM said the compact post was open with
565 px of body, the picture showed it closed, and two shots seconds apart were
byte-identical. Front the window (`SetForegroundWindow`, after `ShowWindow`) and
shoot then — `Page.bringToFront` alone does not make it compose. CDP input is
unreliable in the same state (a click landed on the button in `elementFromPoint`
and the handler never ran); when the picture matters, verify the DOM before and
after and fall back to `element.click()` and a value plus an `input` event.

## Only a run had somewhere to put its words

The Architect's reasoning panel sat empty for a whole step and then showed the entire
wall at once (reported 2 Nov). Nothing was wrong with the panel: `appendStream()`
looked up its trace with `traceOf(currentRun())`, and the Architect's own turn has no
run — every `session.reasoning.delta` it produced was dropped on the floor, and the
text only arrived when the step's message was rebuilt. The workers looked fine
because a delegation *is* a run.

`liveTrace()` now answers "whose writing is this": the live run's trace if there is
one, otherwise the open session's own (`state.sessionTrace`, keyed `sess:<id>`), which
is drawn by the same `.trace-flow` panel and fed by the same pump. Measured while a
long reasoning turn streamed: the panel held 76 characters at the first sample and
424 at the second, in the same DOM node.

Two details that keep it honest: the panel is hidden once the step's own message
carries the same words (`renderSessionStream()`), or the paragraph appears twice; and
the session stream is cleared on `session.execution.ended`, so a new turn can never
inherit the last one's text.
## The chat's text size is one number
The operator asked for a size control for the conversation alone — "no other
elements", with a floor at two points below the original — and named the risks:
the vertical rules and the scrolling. The implementation is one custom property,
`--chat-fs`, and every size inside the transcript is a multiple of it.

- **One number, or the transcript comes apart.** A rule inside the chat that kept
  a fixed px size would stop following the setting while its neighbours scaled: the
  role label would leave its clock's centre line, a code span would sink into the
  prose, a table would break its column. The rewrite touched 41 declarations, and
  `tests/chat-text.test.mjs` now fails if any rule in the transcript's selector
  families (`msg`, `chat-post`, `trace`, `reasoning`, `tool-card`, `perm-card`,
  `state-pill`, `chat-alarm`) carries a `font-size` in px again. That is the
  invariant, not a style preference.
- **The bounds are in two places on purpose.** 10–20 px in whole pixels since 10 Nov
  (they were 10.5–16.5 in half steps before that): the form (`web/settings-panes.js`)
  and the config (`src/config.js`) both clamp, because a hand-edited file must not
  make the chat unreadable or push the composer off a 900px window. 10 is the floor
  the operator asked for; 20 is the largest that still leaves a full answer above the
  composer.
- **Growing the text steals the scroll position, and that is the real defect.**
  Measured at 1280px on a 32-message transcript: going 16.5 → 10.5 → 16.5 left the
  view **6,895px above the newest line**, because the browser keeps the scroll
  offset while the content grows. `applyChatText()` records whether the transcript
  was within 4px of the bottom, sets the size, and re-pins on the next frame; when
  the operator had scrolled up, it does not move their page at all. Re-measured
  after the fix: distance from the bottom 0 at both extremes, and an operator
  scrolled to the middle (offset 9,828) stayed at 9,828 across a change.
- **It is drawn from the config, once.** Boot applies it, Save applies it, a
  keystroke in the field previews it, Revert and closing the window put the saved
  size back — a preview that outlived its form would be a setting nobody saved.
- **What does not move:** the rail, the cards, the composer, the dialogs, the ask
  panel. Verified by measurement, not by eye: page overflow 0 at 1280 and 760px and
  at both extremes, transcript bottom 829 = composer top 829. The 340px horizontal
  overflow at 760px is the app's own minimum width and is identical at 12.5px.
- **The audit reports content noise on an open chat.** `--audit` on a real
  transcript finds the composer's Send/Run heights (39 vs 36) and `code`/`em` runs
  in different line boxes; those are there at the default size too, and none is
  about the setting. Read them as chat-content findings, not as a size regression.

## A dialog is a layer, and a hidden window has no clock

Two lessons from the timed shutdown (2 Nov). Both were measured on Synapse's own
window, and both would have shipped as "works on my machine".

- **Controls either side of a backdrop are not a row.** The General pane made the
  Settings dialog taller, and its footer button came within a row of the sidebar's
  Settings link *behind* the backdrop — a `controls-row` finding on a screen that is
  perfectly aligned. The audit now asks the browser what is on top at a control's
  centre (`document.elementFromPoint`) and only groups controls in the same layer; a
  modal is a different layer from the page under it. No page has to name its overlay
  anything, and two buttons inside the dialog still compare with each other (the
  test asserts both halves). A dialog that covers the page also means the page is not
  on screen, which is the rule the fix encodes.

- **A hidden window's timers are throttled, so the clock cannot live in the page.**
  The first implementation counted the 20 seconds in the browser. Chromium throttles
  timers in a hidden page — after a few minutes it is about once a minute — and
  Synapse in the tray is *exactly* when "turn the PC off when it finishes" is wanted.
  A 20-second countdown could have taken twenty minutes, or never come. The server
  now owns both waits (`armPowerOff` in `src/api.js`): the page asks it to arm, draws
  the numbers it broadcasts (`shutdown-warning`, `shutdown-tick`), and asks it to
  cancel. The countdown is tested with node's mock clock, so the whole minute-plus-
  twenty-seconds runs in a millisecond.
- **The last second re-checks the config and the runs.** A cancel that raced the
  timer, or a run that started during the countdown, must still leave the machine on:
  `powerRefusal()` is asked again at zero, and a live run cancels the count just as
  an explicit Cancel does. Turning the setting off while a countdown is up therefore
  saves the machine, which is also the safety net if the Cancel click never lands.


- **A countdown that never moves is a claim nobody can check.** The question's head
  said "Auto-Answer replies in 30s" and the 30 never changed, so a sweep that was
  broken looked exactly like one that was about to fire. The server now says *when*
  (`autoAnswerAt`, from the moment its sweep first saw the form) and the page ticks
  the sentence down once a second, writing only that line — never rebuilding the
  panel, which would clear an answer the operator had already given.
- **A reserve for a control the operator does not want is a gap.** The question's
  head held 104px clear on its right for the floating jump buttons. They sit above
  the card and the chat scrolls, so the space was only a note that stopped short of
  the edge it should touch. The head is flush now; the buttons overlap nothing that
  matters.

## Vertical alignment is a measurement, not a taste (4 Nov)

The operator's report: "vertical alignments of UI elements being terribly off
centre almost all the time, and overall nothing is grid-based - buttons and labels
are all over the place, especially vertically. Gaps and margins are seemingly
random." The design brief asked for a direction and a palette; it never asked for
the grid the controls sit on, so every build invented its own spacing.

Two skills now ship with Synapse and are named in the roles:

- **Designer: `frontend-syntax-css-grid-subgrid` is required.** It is the CSS Grid
  and subgrid skill (Baseline, `subgrid` since 2023), and it exists because a card
  title that refuses to line up across columns is a grid problem, not a margin
  problem that needs hand-tuning.
- **Designer: `ui-design` is now the CloudBase skill** (MIT, shipped with its
  licence), replacing the hand-written one. It covers direction, hierarchy and the
  self-audit the old sheet only summarised.

QC was given a third skill, `align-grid`, for the same lesson; the operator took it
out again the same day — the grid skill covers the discipline, and QC judges the
build against the design with the renderer it already has.

The designer's spec must now state the grid as numbers (columns, gutter, baseline,
spacing scale) and the Architect's `design:` rule says the build is measured
against it. A page whose rows drift a few pixels apart is the defect this is for:
"looks fine" is not a measurement.

## The other room's clock (4 Nov)

Both countdowns compared a timestamp the server wrote with `Date.now()` on the
page. On the desktop those are one clock; on a laptop they are two, and a card
that had just appeared said "picked now" in the other room while counting
properly on the desktop. Every response's `Date` header is now read into
`state.clockSkew`, and the countdowns run on `serverNow()`; see
`remote-access.md` for the operator's side of it.

## The rail is a list the operator arranges (4 Nov)

Right-click a project and the menu offers **Move Up** / **Move Down**; the ends are
disabled rather than a click that does nothing. The order is the registry file
(`data\projects.json`), which is a ledger: it is written in the order shown, and a
new project is appended at the bottom. Nothing is sorted by name — a rename must
not move a row the operator is looking for, and a project added five minutes ago
should be where they just put it.

The same idea one pane over: providers can be moved in Settings, and the model
menu in a role card follows the order there (see `models-and-tools.md`). A list the
user arranged and a menu that ignores it is the bug, not a preference.

## Settings speak like a person (4 Nov)

The Settings panes had grown a grey note under almost every control, written in
the voice of whoever built it: how the engine compacts, what a probe run does,
which folder a key lands in. Read once, it is noise; read never, it is a wall of
text between the operator and the one number they came to change.

The rule now: every control carries a plain-English tooltip (`title`), and a pane
has **at most one short visible line**, and only for the thing that would bite if
it were missed — a restart, where keys are stored, what a limit does. A group
heading can carry the rest in its own tooltip. "Running <engine version> from …" stays,
because it is a fact, not an explanation.

## A Settings page wears the footer (6 Nov)

Every tab of the Settings window ends with the same four buttons — Cancel, Revert,
Apply, Close — and one tab did not: **Check for Updates** hid them, because "the
footer has nothing to save here". The operator's report was not about the buttons
being useless; it was that the page *read as a different window*. A window that
keeps its furniture everywhere except one room makes that room look like a
screenshot.

So the footer is on every tab, and on a page with nothing to save the buttons sit in
their resting state: Cancel and Revert are disabled (there is nothing to throw
away), Apply is disabled, and the primary says Close. About is the one exception,
and it is a real one: it is a credits card with its own Close inside it, not a form.

The cost was height, and it is worth knowing how it was paid. That footer is 46px,
and the Updates page had been sized to the last pixel without it: the changelog is
*open by default* whenever a release has notes, so the cards were 520px and the pane
overflowed its body by 70px. The cap on the changelog went from `min(42vh, 420px)` to
`min(26vh, 250px)`. Measured after: 376px cards, no overflow, the window 778 of the
852 it may be. **When a page has a scroll box, measure the box, not the page** —
`scrollHeight - clientHeight` is the number, and it was 70.

## The main panel, rebuilt (9 Nov 2026)

The role cards had been above the chat since the first build, and the chat's height
was whatever was left under them — measured every frame, because its bottom edge
was pinned to the window and its top edge moved with the cards. The operator's
complaint was simple and right: the cards cost the conversation height, and height
is the only axis a conversation uses.

**What it is now.** The stage is the same two-column grid at every window size: the
conversation, and a 360px rail holding the Architect, the five roles and the work
list. Single is that grid with the rail at zero — the Architect as one bar across
the top, the chat under it. Multi opens the rail and the chat gives up width, never
a line of height.

**The measurement machinery went with the layout.** `fitChatHeight`,
`setChatHeight`, `watchChatGeometry` and the `requestAnimationFrame` loop that ran
for the whole life of the page are deleted, not disabled: the chat is a cell with a
definite box, so there is nothing to fit and nothing to watch. The layout's shape is
the rule; a measurement that reproduces it is a second, worse copy of the rule.

**A mode switch animates one property.** `grid-template-columns` over 240ms —
measured 747 → 1107 in fifteen frames, the rail 360 → 0 in step. Two things had to
be true for that to work: the chat sits in column 1 in *both* modes (spanning both
columns pinned its right edge, so the text re-laid out in one frame while only the
rail moved), and the rail's contents are right-anchored while the column shrinks, so
the chat's edge sweeps over the cards rather than clipping them from the wrong end.

**The last line stays put.** A switch re-wraps the text, so the same `scrollTop`
lands on different words. `applyMode` remembers the *element* at the bottom edge and
the gap beneath it, and re-applies that on every frame of the transition — reading
the element's place in the *content* (`rect.top - box.top + scrollTop`), never its
viewport position, because writing `scrollTop` from a viewport reading makes the next
frame's reading depend on this frame's write and the line flickers between two
messages for the length of the switch.

**No dashes. Ever.** The delegation trunk went through three shapes in one evening:
CSS gradients at a corner (beads from two patterns never line up), a stroke
`dasharray` (beads are placed by distance along each piece, so a trunk and a stub
drift apart), and grid-placed 2px squares (still smeared, because the layer does not
begin on a whole pixel). What ships is a **solid 1px hairline** drawn from the cards'
own boxes — and the same geometry in yellow with ants for a live run. A dotted line
is a hundred small judgements the renderer can round differently.

**Two traps worth keeping.**

- A mock that writes text into a label the app repaints on a timer makes that label
  flicker between the two writers. Placeholders belong in CSS (`:empty::after`),
  which loses the moment the app writes.
- A fixed grid row is the honest way to make cards the same height: the readouts are
  one line and ellipsize, so a `13px` row cannot clip them, where a `min-height` is a
  guess about the type's leading.

**Migration, not deletion.** Removing Coder 3 meant the cards, both configs, the
ladder defaults, `ROLES`, the chat's role labels and three brief sentences that
called the coders three — plus a filter in `normalize()` so a saved config that still
names it cannot delegate to a role with no card.


## The post opens on the first token, and the bar shows the work (10 Nov)

Two page behaviours the operator met on the same evening, both of them "nothing
happens, then everything happens".

**The Architect's post.** The engine writes the assistant message on its own
schedule, and the page can only draw messages it has. So a turn that had already
started — the card said "Thinking", tokens were arriving — had nowhere to go: the
chat sat still until the step ended, and then the whole wall appeared at once. The
page now opens the post itself on the first delta of any kind (`ensureLivePost`),
puts the live thinking panel in it, and hands over to the engine's message on the
next transcript load. The rule is the one a steer already keeps: a `local-` message
lives until the engine echoes it and goes when the turn does, so it cannot become a
ghost post at the end of a turn that never wrote one.

**The single-mode bar.** In Single the Architect's card is the only thing that can
show work happening, and it sat still through every turn while Multi's cards
animated. The wash and the turning ring hang on `.is-working`, computed from
`isBusy(sessionId)` — the engine's active list, which the pending poll rewrites
every few seconds — so the class was not there for the frames that matter. It now
also reads `state.busy`, the page's own word for "this session's turn is running",
set on `executionStarted` and cleared when the turn ends.

The stylesheet was never the problem: rendered still, in `data-mode="single"`, the
bar draws both the wash and the ring. A class that is never applied and a rule that
never matches look identical from the sofa, and this one was the class.


## The chat's size is a slider, and Ctrl + wheel moves it (10 Nov)

The size was a number box with two arrows and a half-point step. Two things were
wrong with it: half a point is a change nobody can see, and a box with arrows says
nothing about where you are in the range. It is a slider now — violet fill behind
the thumb, the value in tabular figures beside it, one notch per step — and the
range is whole pixels, 10 to 20, defaulting to 13. The half points went first, then
the half-pixel grid under them: an operator reading at the back of a desk wants 20,
and nobody ever wanted 13.5.

The gesture is the same setting. Ctrl + wheel and Ctrl + plus/minus used to be
WebView2's own zoom, which grew the entire interface — rail, cards, composer — while
`ui.chatTextPx` stayed where it was: two sizes fighting, and the one the operator
had chosen losing. The page now owns all three gestures (`web/chat-zoom.js`), steps
the setting inside the same bounds, and `IsZoomControlEnabled = false` in the shell
turns the browser's zoom off so the two can never both answer. Ctrl + 0 returns to
the designed 13px.

**The one thing that did not scale was a table.** `web/vendor/summit.css` sets
`th { font-size: 9px }` and `td { font-size: 10px }` for its own data tables, and a
direct element rule beats the size a table would inherit — so a table in a chat kept
its cells at 9 and 10px while every word around it followed the setting. The
operator asked whether tables scaled; that question is the whole reason to check
rather than assume. `#transcript th, #transcript td { font-size: inherit }` puts them
back on the chat's own size, and `chat-text.test.mjs` now holds it.

Two details worth keeping:

**The gesture says what it did.** A chip over the top of the conversation reads
`Chat text 15 px`, and at an end of the range `· largest` or `· smallest`. Without
it a wheel spin is a guess about whether anything happened, and pressing again at
the ceiling has to answer "this is the largest" rather than nothing.

**The write is debounced, the picture is not.** Every notch applies to the page
immediately; the config is written once, 600ms after the last notch, because a wheel
produces a dozen a second and each save rewrites the file. A gesture while the
Settings window is open also moves the draft, or pressing Save would put the old
number back and the setting would undo itself.


## Three from the run that followed (10 Nov, later)

**Wheel-up could not escape the follow.** `noteUserScrollIntent` reads positive as
"towards the end" — the keys already said +1 for PageDown — and the wheel handler
passed `-e.deltaY`, which told the follow that wheel-up was the reader coming *back*
to the end. It re-armed on every tick, and once the thinking pane grows every frame
there is no way to scroll away from it. Two changes: the wheel passes the intent
(`e.deltaY > 0 ? 1 : -1`), and the frame loop's pin now asks `chatFollows()` as well
as the geometry. Geometry alone meant "within two lines of the end" was pinned every
frame, however hard the reader scrolled; the pane grows sixty times a second and the
wheel is one notch per gesture, so the pin always won.

**A worker's permissions now have a record where the work is.** The Architect's asks
are cards in its chat and the answers sit on its tool cards as a chip. A worker's
call reaches the trace as a name and a target with no call id, so the answer is its
own line in that trace — a dot, the action, the pill — drawn the moment
`permission.decided` arrives rather than on the next poll, and carrying the same
`permissionTip` sentence in its tooltip, so a refusal's reason is one hover away. The
sentence moved to `web/ask-note.js` so the chip and the line cannot drift. A page
opened mid-run asks the server for the decisions it missed.

**One fold, not two.** "9 earlier steps" above "12 earlier reasoning" was two headers
for one idea — the run's history — and which header a line landed under was an
accident of what the line was rather than when it happened. Both are one
`Older entries (N)` fold now, in time order, with the older thinking as grey text
inside it.

### The same scroll, once more (10 Nov, second report)

Passing the intent was half of it. The other half was *when* the follow lets go: the
release waited for the scroll event to say "the reader moved", and the frame loop's
pin runs before that event is dispatched — so the box was already back at the end when
the event arrived, it reported no movement, and `noteChatScroll` re-armed the follow
on the very write the reader was trying to escape. Twice: the intent now releases it
(`chatFollowArmed = false` the moment an upward gesture arrives), and only the
reader's own scroll re-arms it — our writes never do.

The permission row was also wrong the first time: I drew a new row for a worker's
answer ("allowed a read · permission") when the operator wanted the Architect's own
component. `permissionChip()` lives with `permissionTip()` in `web/ask-note.js`, and a
worker's answer is now the same `.tool-card` the Architect wears — head, action,
target, chip — one component in one place rather than a lookalike that drifts.

### The pin that was left (10 Nov, third report)

The gesture and the frame loop had both been taught to let go; the *render* had not.
`renderTranscript` decided "follow the end" from geometry alone (`chatAtBottom()`), and
during a turn the transcript is re-rendered on every message and tool event — so each
of those renders put the box back at the end a moment after the reader had scrolled
away. One wheel notch lost the fight and only spamming the wheel got out. The render
now asks `chatFollows()` as well: the same hand-off, in the third and last place that
pinned.

### Two type sizes in one row

"The text sits a little higher than the tool name" was arithmetic: the tool head is
0.84 of the chat size, the tool's *name* was 0.888, and `align-items: center` centres
boxes — two line boxes of different heights, so two baselines about a pixel apart. A
bold white name already reads as the name; a second type size only broke the row. One
size, and the name's baseline is the target's to the pixel (measured: both 10.92px in
a 16.38px box, same top).

### Why it took four tries (10 Nov, fourth report)

Every version released the follow correctly and then let something put it back. The
list, in the order they were found:

1. the wheel passed `-deltaY`, so wheel-up *was* "coming back to the end";
2. the release waited for a scroll event the pin had already outrun;
3. `renderTranscript` re-pinned from geometry alone on every message and tool event;
4. **the re-arm itself**: `noteChatScroll` armed the follow whenever the box measured
   within two lines of the end. Chromium animates a wheel scroll and fires a scroll
   event per frame, so each step of an upward gesture still measured "at the end" and
   re-armed the follow the gesture had just released. One notch up, pin, one notch up,
   pin — and only spamming the wheel outran it.

The rule is now a pure function, `followAfterScroll()`, with one sentence: an upward
gesture releases it, and only a reader's *downward* gesture (or the scrollbar landing
exactly at the end) may re-arm it. Geometry alone is never evidence, because the pin
makes geometry true. It has its own test, with the failing case written down: armed
false, an upward intent, 30px from the end, and every frame of that gesture still
saying "near the end".

Two more things came out of the same clue. The Ctrl+wheel listener was on `window` with
`passive: false`, which makes *every* wheel in the page wait for the main thread — and
during a turn the main thread is painting a pane sixty times a second. The shell
already disables WebView2's zoom, so inside it the listener is passive now; a browser
(a remote view) still gets `preventDefault`, because there it is the page zoom that has
to be stopped. And `restoreChatSlack` snapped a reader within two lines to flush with
the bottom on any dock resize; it now only does that while the chat is following.

### A preview anchored to a chip that is no longer there (10 Nov)

The image preview opens on `mouseenter` and closes on `mouseleave` — and Chromium only
dispatches a mouseleave when the *pointer* moves. A wheel scroll leaves the pointer
exactly where it is and moves the chip instead, so the picture stayed open with its chip
long gone, until the operator happened to hover another one. Any scroll, wheel or resize
closes it now. The scroll listener is on `window` with `capture: true`, because the
transcript is its own scroller and a scroll event does not bubble.

Also, a clean-up pass on the four scroll fixes: every one of them is load-bearing —
the intent's sign, the release on the gesture, the render and the frame loop asking
`chatFollows()` — so nothing was removed but the four-attempt history in the comments,
which now states the rule once: **geometry is not a gesture.**

### The compacted line was a code label in a conversation (10 Nov)

The fold that says a chat was compacted wore `font-family: mono`, `letter-spacing:
0.04em` and 0.8 of the chat size, and its chevron was the same 0.8 rotated 90° — which
at a 14px chat is an 11px triangle reading as a speck at the end of the line. A fold is
a line of the conversation, so it now takes the chat's own type at the size every other
fold uses (0.96), and the marker is the reasoning fold's, to the letter: `▸`/`▾` at
1.3em in its own box. Measured after: summary, label and note all 12.48px DM Sans with
normal letter-spacing, chevron 16.22px — identical to `.reasoning summary::before`.
