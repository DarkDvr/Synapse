# Findings — parked, not forgotten

Things noticed while working on something else. They are **not** the current job:
each says what it is, where it lives, and why it waits. When one becomes work it moves
out of here into its own note or the inventory row it belongs to.

Rule: one entry, three lines at most. If it needs a design, it is not a finding any
more — open a note for it.

## The chat, before the rebuild

- **The transcript never shows more than the newest 200 messages.** `getMessages` asks
  for `limit=200&order=desc`; a long chat silently starts at message 201, with no
  marker and no way to reach what was cut. (18 Nov, `src/engines/opencode.js`.)
- **`state.open` is never pruned.** Every fold and card the operator opens adds a key
  for the page's life; a compact drops the messages but not their keys. (18 Nov,
  `web/state.js`.)
- **Every reasoning delta rebuilds the whole transcript.** `traceSig()` includes the
  stream's text length, so a thinking turn re-renders on every delta — the most
  expensive thing the page does, and why a selection cannot survive a live turn.
  (18 Nov, `web/transcript.js`.)
- **Chat errors are kept in `localStorage` per session and never removed** when the
  chat is deleted or compacted away; capped at 20 per session, so they leak slowly.
  (18 Nov, `web/chat-notes.js`.)
- **The engine's text part has no `time.created` / `time.completed`** (measured 18 Nov:
  reasoning and tool parts do). Anything wanting "how long the report took to write"
  must come from the delta stream.
- **A post's time is `HH:MM` only.** A conversation crossing midnight shows 23:58 above
  00:03 with no date; the engine has the date. (18 Nov, `web/transcript.js`.)
- **The context menu is the page's own** (Copy, Select All, Cut/Paste in fields).
  Richer items — Copy message, Copy as Markdown, Quote in composer — are a design, not
  a finding.

## Elsewhere

- **The chat rebuild was cut on 19 Nov** after the operator judged it a regression from
  the chat that ships. Its code is in the history before 1.64.0
  (`git show 16b2ef5:web/chat-view.js`); the branch, worktree and tests are gone. What
  it found is `docs/notes/chat-inventory.md` §5 — the list of defects in the chat we
  kept, and where the chat work goes from here.
- **The rail, role cards and plan pane** read the same state the chat does. They are
  not part of the chat work, and there is no plan for them beyond the cases in
  `chat-inventory.md`.
