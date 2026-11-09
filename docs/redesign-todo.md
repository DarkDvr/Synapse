# The main-panel redesign — what is left

A scratch list, kept while the panel is rebuilt. It is deleted when the work is
done and the lessons move into `docs/notes/ui-lessons.md`.

**Where the work is:** `F:\temp\synapse_redesign` — a copy of the app with its own
engine home, its own projects root (`F:\temp\Synapse.Projects`) and its own ports
(**8710** UI, **8730** engine). The live app on 8700 is untouched. The new layout
is `web/redesign.css` plus one `<link>`; the placeholder data is
`web/redesign-mock.js` and `web/fixture-transcript.html`.

## Done

- **Single**: the Architect is a full-width 36px bar, the conversation fills
  everything under it, no plan, no worker cards. Measured 1107 × 930 at a 1411
  window.
- **Multi**: the rail is 360 wide, the Architect card at its top, the roles stacked
  under it in one column, the work list below them filling to the bottom. The chat
  keeps the full height at 723 wide.
- **No width cap**: `--work-w` (1240) no longer applies to a session, so a 2550
  window gives the chat 2186.
- **The readings are two values, not a sentence**: "128 tok/s    27k/60k ctx" with
  air between them instead of a dot.
- **The plan's goal paragraph is gone** from the rail.
- **The role card is two rows**: the picker with the effort and edit buttons beside
  it on row 1, the readouts and the clock on row 2. Cards are 315×52 at the 1411
  window. (The buttons were moved down beside the clock for one round on 9 Nov and
  the operator put them back.)
- **Coder 3 is out** of the cards, both configs, the ladder defaults, `ROLES`, the
  chat's role labels and the three brief sentences that called the coders three.
  The stack is Inventor, Designer, QC, Coder 1, Coder 2, in that order everywhere.

- **The switch animates, and it is measured.** The stage transitions
  `grid-template-columns` over 240ms, which Chromium does interpolate — but the
  chat spanned both columns in Single, so its right edge stayed pinned and only
  the rail moved. With the chat in column 1 in both modes, per-frame readings at
  1411px: Multi→Single 747 → 805.9 → 916 → 1001 → 1054 → 1084.8 → 1101 → 1107
  over 269ms, columns 360 → 0 in step; Single→Multi 1083 → 970 → 867 → 799 → 758
  → 735 → 723 over 266ms. The rail's content is right-anchored while the column
  shrinks, so the chat's edge sweeps over the cards instead of clipping them from
  the right.

- **The old geometry is gone, all of it.** `fitChatHeight`, `setChatHeight`,
  `watchChatGeometry` and the per-frame loop they ran; `applyRoleCardsLayout`'s
  whole height animation (`stageBudget`, `measureReveal`, `--reveal-h`, the
  `workers-on` timer); the `.link` connector rules; the wrapper's reveal; and the
  `1359/1358` media-query pair that made the stage content-sized on a narrow
  window. At 1100 and 1411 the stage is now the same 874px box and the page never
  scrolls: chat 412 / 723, rail 360, plan 360×447.

- **The saved-config migration is in the loader**: `worker.ladder` is filtered
  against `ROLES` in `normalize()`, so a config written before Coder 3 left cannot
  delegate to a role with no card. Three tests in `tests/config-ladder.test.mjs`.
- **The floor and the empty state were checked**: at 1100 the chat is 412 wide and
  the page does not scroll; a session with no messages now says what it is for
  instead of being blank; and the landing page's empty state was hugging the top of
  a two-row grid — it spans the stage now and is centred again.

## Left to do, in order

1. **Port it back**: `redesign.css` becomes `panel.css` (a permanent module, not a
   merge into a 3300-line file), the mock, the fixture and the `?ants` demo are
   deleted, and the sandbox's files are copied into `F:\dev\Synapse` — which needs
   the live app stopped, a rebuild and a restart.
2. **Tests for the new shape**: the chat fills the stage, the rail is 360, the bar
   is one row, the plan sits under the cards, and a switch does not re-render the
   transcript.
3. **Version, tag, push, release** — and the note in `ui-lessons.md` about what the
   measured height machinery was replaced by.
## Traps paid for so far

- **A one-second writer owns the labels.** The app repaints `.role-rate` every
  second; a mock that writes text into the same node makes the label flicker
  between the two. Placeholders belong in CSS (`:empty::after`), which loses the
  moment the app writes anything.
- **A grid item spanning "row 2 to the end" spans nothing** when every row is
  implicit. The trunk is positioned absolutely in the gutter instead.
- **The dock's old `align-self: end` and the hidden empty scroller** both fight a
  layout that gives the chat a definite box; the composer needs its row named.
