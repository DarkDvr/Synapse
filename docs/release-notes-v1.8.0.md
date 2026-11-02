# Synapse v1.8.0

Settings has a **General** tab where the Windows tab used to be, and the chat has a text
size of its own.

## Added

- **Settings → General**, the first tab. The Windows toolchain pane is retired: it answered
  "what can this PC build", which is a question about a copied folder, not a setting. The
  probe still answers on `GET /api/toolchain` for anyone who asks it directly.
- **Chat text size**, 10.5–16.5px in half steps, default 12.5. It moves the conversation and
  nothing else: the rail, the cards, the composer, the dialogs and the ask panel keep their
  own sizes.

  The whole transcript is drawn from one custom property (`--chat-fs`): prose, headings,
  code, tables, the clock, the role label, the live trace, the tool cards and the permission
  cards are all multiples of it, so nothing drifts out of proportion. 41 declarations were
  rewritten to follow it, and `tests/chat-text.test.mjs` fails if a transcript rule ever goes
  back to a fixed size.

- **The setting previews while you type it**, because a number in a box says nothing about
  whether the transcript still fits. Revert and closing the window put the saved size back.

## Fixed before it shipped

Growing the text threw the view away from what the operator was reading. Measured at 1280px
on a 32-message transcript: 16.5 → 10.5 → 16.5 left the scroll position **6,895px above the
newest line**, because the browser keeps the offset while the content grows. The size change
now re-pins the transcript to the bottom only when it was already there — a reader scrolled
up is left exactly where they were (verified: offset 9,828 before and after).

## Notes

- Bounds are enforced twice: the form clamps, and `src/config.js` clamps, so a hand-edited
  config cannot make the chat unreadable or push the composer off a 900px window.
- Geometry held at both extremes: page overflow 0 at 1280 and 760px, transcript bottom 829
  = composer top 829. The 340px horizontal overflow at 760px is the app's own minimum width
  and is identical at the default size.
- Full suite: 321 tests.
