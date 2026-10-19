---
name: visual-review
description: Render a local HTML file or an http(s) URL to a PNG with the machine's own browser, then read that image to review a UI. Use when a mock or a built page has to be judged visually - where things sit, how the colours and type read, whether a state renders as intended.
---

# Visual Review

You have no browser tool. This skill gives you the one thing you lack: a still
image of a rendered page. It is a real screenshot from a real browser, not a
description of one — so look at it, and be careful about what a still cannot tell
you.

## Render it

```
node "C:/Users/Andrew/.agents/skills/visual-review/bin/shot.mjs" <target> [--out DIR] [--widths 1280,390] [--height 900]
```

`<target>` is either an absolute path to an HTML file or an `http(s)://` URL.
Paths use forward slashes. The script prints one JSON line per shot:

```
{"target":"…","width":1280,"height":900,"path":"F:/…/mock-1-1280.png"}
```

Then open each PNG with the read tool and describe it. If the script exits with
code 2 it found no browser: fall back to reviewing the HTML/CSS structurally and
say in your report that you did not see it rendered.

The script uses its own throwaway browser profile. It never touches the
operator's browser, and it must never be pointed at one.

## Where the images go

Put them in the project: `.synapse/design/shots/` (the default). What you looked
at is then an artifact the operator can open too. Never write screenshots into
`C:/Users/Andrew/.agents`.

## Budget

Two widths at most — one desktop, one narrow. Each image costs roughly a thousand
tokens, so five widths is a budget leak dressed up as thoroughness.

## What you may and may not say

- **Say what is measurable**: where the main element sits, what the heading says,
  how many rows are visible, what the background and text colours are, whether
  controls are aligned, what is cut off at the narrow width.
- **Do not invent detail.** If something is too small or too similar to read, say
  that. "I cannot read the label at this size" is a useful finding; a guessed
  label is a defect you just introduced.
- **A still cannot show** hover, focus, animation, scrolling, or what happens on
  a click. Say so when the question depends on it, and test that part another way.
- **Judge against the brief**, not against taste you invented. If the design spec
  says three themes, check that three exist and name the colours you actually see.
- **You are not the operator.** Report what you see and what looks wrong; the
  final verdict on design is theirs.
