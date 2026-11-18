# Findings — parked, not forgotten

Things noticed while working on something else. They are **not** the current job:
each entry says what it is, where it lives, and why it is waiting. When one becomes
work, it moves out of here into its own note or the inventory row it belongs to.

Rule: one entry, three lines at most. If it needs a design, it is not a finding any
more — open a note for it.

---

## The chat, before the rebuild

- **The transcript never shows more than the newest 200 messages.** `engine.getMessages`
  asks for `limit=200&order=desc`; a long chat silently starts at message 201, with no
  marker and no way to reach what was cut. (18 Nov, `src/engines/opencode.js`.)
  Waits: the keyed renderer should page the history, so the "older" state needs a design.
- **`state.open` is never pruned.** Every fold and card the operator opens adds a key for
  the page's life; a compact drops the messages but not their keys. Harmless in size,
  but the new renderer should own this state and clean it per post. (18 Nov, `web/state.js`.)
- **Every reasoning delta rebuilds the whole transcript.** `traceSig()` includes the
  stream's text length, so a thinking turn re-renders the conversation on every delta —
  the most expensive thing the page does, and the reason a selection cannot survive a
  live turn. The keyed renderer removes it. (18 Nov, `web/transcript.js`.)
- **Chat errors are kept in `localStorage` per session and never removed** when that chat
  is deleted or compacted away; they are capped at 20 per session, so they leak slowly.
  (18 Nov, `web/chat-notes.js`.)
- **The engine's text part has no `time.created` / `time.completed`** (measured 18 Nov:
  reasoning and tool parts do). Anything that wants "how long the report took to write"
  must come from the delta stream, not from the stored message. The recorder should
  timestamp deltas for this reason.
- **A post's time is `HH:MM` only.** A conversation that crosses midnight shows 23:58
  above 00:03 with no date; the engine has the date. A candidate for the new header.
  (18 Nov, `web/transcript.js`.)
- **The context menu is the page's own now** (Copy, Select All, Cut/Paste in fields).
  The new chat may want richer items — "Copy message", "Copy as Markdown", "Quote in
  composer" — but that is a design, not a finding.

## Elsewhere

- **The rail, role cards and plan pane will want the same primitives.** They read the
  same state and draw the same cards; the vocabulary in `chat-inventory.md` is built so
  they can follow, but they are the next job after the chat, not part of it.
