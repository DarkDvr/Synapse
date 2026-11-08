# Known issues

Bugs found while doing something else. Each one says where it is, how it shows, and
what it would take. They are not fixed on the way past: a bug fixed inside an
unrelated change has two causes and one commit.

Newest first. When one is fixed, delete it here and say so in the commit.

---

## The chat's first line sometimes looks faded under the top panel

Reported 8 Nov as intermittent: "sometimes chat draws over the top panel vignette,
so the top line in chat is sometimes faded, and sometimes clearly visible". Not
reproduced in a headless render at 1600×1000 (the dock sits below the cards, its
own `overflow: hidden`, and there is no gradient on the transcript's top edge). The
one overlay that does touch the chat's box is the question panel, which sets
`.chat-dock.has-ask { overflow: visible }` and draws at `inset: -3px` — so a
screenshot taken *while a question is open* is the place to start.

What it would take: a screenshot of the faded state, plus the layout width. If it
is the ask panel's 3px, the fix is to stop drawing the panel over the dock's edge;
if it is a scroll mask, the mask belongs on `.chat-scroll`, not the page.
