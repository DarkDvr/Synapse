---
name: visual-review
description: Render a local HTML file or an http(s) URL with the machine's own browser, get the picture AND the measurements back, and judge a UI by both. Use when a mock or a built page has to be reviewed - where things sit, how the colours and type read, whether a state renders as intended, whether anything overflows or is too small to hit.
---

# Visual Review

You have no browser tool. This skill gives you two things you lack: a still image
of a rendered page, and the numbers behind it. The image is a real screenshot from
a real browser, not a description of one — so look at it, and be careful about what
a still cannot tell you. The numbers are facts you cannot get wrong.

## Render it

This skill ships its own script, `bin/shot.mjs`, in the same folder as this file.
**Your brief names its full path — use that one.** It is the only copy on this
machine, so do not go looking for another: a search of the disk is a turn spent
and, if it names the harness, an alarm the operator has to read. If the path in
your brief does not work, say so in your report and review the HTML/CSS
structurally instead.

```
node "<the shot.mjs path from your brief>" <file|url> --widths 1280,390 [options]

  --widths 1280,390     widths to capture (default 1280)
  --height 900          viewport height
  --out DIR             where the PNGs go (default .synapse/design/shots)
  --do "steps"          drive the page before the capture, per width:
                          click:#start   wait:600   key:s   eval:<js>
  --audit               print the layout findings; exit 1 if there are any
  --diff MOCK.png       compare the render with a saved mock, at the mock's size;
                          write a picture of where they differ
  --diff-threshold N    per-pixel difference that counts as a change (default 16)
  --fail-over PCT       exit 1 when more than PCT percent of the picture differs
  --file                keep the page on file:// (default: it serves the folder)
  --no-sheet            do not build the contact sheet
  --eval "<js>"         answer one expression instead of taking a picture
  --help                the full usage
```

A local file is **served from its own folder on a random port**, because `file://`
is not a web page: localStorage is per-file and often blocked, a reload behaves
differently, and relative fetches fail. That server lives inside the script and
dies with it — never start your own (`python -m http.server`, a `serve.js`), and
never leave one running.

`<target>` is a path to an HTML file or an `http(s)://` URL. Paths use forward
slashes.

## What comes back

One JSON line per width, then one line for the contact sheet:

```
{"target":"http://127.0.0.1:2749/index.html","width":390,"height":900,
 "path":"…/index-390.png","bytes":23324,
 "report":{"status":200,"viewport":{"w":390,"h":900},"doc":{"scrollW":390,"scrollH":900},
   "painted":{"elements":36,"textChars":133,"images":0},
   "overflow":[],"small":[{"el":"button#sw-start","w":93,"h":37}],
   "contrast":[{"el":"kbd","text":"S","ratio":2.47,"need":4.5}],"focusables":6}}
{"target":"…","sheet":"…/index-sheet.png","bytes":91996}
```

- **`overflow`** — elements crossing the viewport edge. Non-empty means the layout
  is broken at that width; name the element and its coordinates in your report.
- **`contrast`** — text below WCAG for its size (`need` is 4.5, or 3 for large
  text). **Quote the ratio and the element**; never write "the contrast looks
  okay" when the report has the number.
- **`small`** — controls under 44px in either direction. A fact about the build,
  not necessarily a fault: say what it is and let the brief decide.
- **`painted`** — visible elements, characters of text, images. The script
  **fails** rather than returning a picture when a page painted nothing, or when
  the server answered 4xx/5xx. A blank PNG is the most dangerous thing this tool
  could give you, because it looks like success.
- **`layout`** — the alignment audit, below. Non-empty findings are defects, not
  opinions.

## The layout audit: four things a picture cannot prove

"Centred", "the same size", "one column", "one line" are numbers. This tool measures
them on every run, whether or not you asked:

| check | what it compares | what a defect looks like |
|---|---|---|
| `controls-row` | controls that share a row | one is 26px tall and its neighbour 30px — the tops or the heights differ by 2px or more |
| `control-label` | a control's text box against its own box | the label sits more than 1px left/right or high/low of the middle |
| `baseline` | two same-size text runs on one line | one run's baseline is more than 0.6px off the other — the "182.0 MB / Open page" step |
| `column` | rows that begin with a short label, in one block | one row's content starts 2–40px right of the rest — the header with an extra margin |

`--audit` prints the findings and **exits 1**, so it can gate a report. Fix every
finding: a row of controls with two heights, a label 2px off centre, two labels a
pixel apart and a block indented from its own rows are the four things a person
notices instantly and cannot name.

Findings arrive as `{"check","el","vs","px","detail"}` — `el` is the element, `vs`
the one it was compared with, `detail` the sentence to quote in your report.

Read the sheet first, then the numbers, then the full-size PNG if something in the
sheet needs a closer look.

## Mock or build: the diff

When a mock was approved, the build has to match it, and "it looks like the mock" is
not a measurement. Give `--diff` the mock's PNG — the one you rendered with this
same script, at the size that was approved — and it renders the build at exactly
the mock's size and compares the two pixel by pixel:

```
node "<shot.mjs path>" bin/index.html --diff .synapse/design/mock-1-880.png --out .synapse/shots
diff: 1.08% of 880x900 differs at 880px (2 region(s)) -> …/index-880-diff.png
```

- **The mock is the reference and is never written to.** The build's own render
  lands in `<name>-<width>-build.png` and the comparison in `<name>-<width>-diff.png`
  — the build as a ghost with the pixels that changed in red, at the mock's exact
  size, so you can flip between the two pictures.
- **The number and the regions are in the JSON line:** `diff.different`,
  `diff.percent`, `diff.threshold`, and `diff.boxes` — the rectangles where the
  pictures disagree, largest first. Quote the percentage and name the regions;
  "close enough" is not in the report.
- **Two widths compare two layouts.** The mock's size wins and `--widths` has to
  agree with it, or the run is refused rather than silently compared at the wrong
  size.
- **`--diff-threshold N`** (default 16) is how far a channel may move before a
  pixel counts. Antialiasing moves a little; a different colour moves a lot.
- **`--fail-over PCT`** turns the number into a gate: exit 1 when more differs
  than that. It is for the same screen across builds, where any drift is a
  regression. Against a first build the percentage is information, not a verdict —
  a build legitimately shows data the mock invented, and an empty state is not a
  drifted one.

A diff can show you *where* the build and the mock disagree. It cannot tell you
which one is right: whether the wording is as good, whether a control belongs
there, or whether a difference is drift or an improvement. Judge that yourself and
say which is which.

One thing it will do that looks like a defect and is not: a mock that draws the
window around the page — a title bar, a frame, a status strip the host supplies —
shifts every pixel under it, and the whole picture reads as different. That is a
fact about what was compared, not the build drifting; say so, and compare the
mock's content against the page when the frame is the only difference.

## One look, one picture

Several widths become **one contact sheet** (both images side by side at a common
height, labelled with the width they were laid out at) plus the individual PNGs.
Compare at a glance in the sheet: what disappears at the narrow width, what floats
in empty space at the wide one.

**Budget: two widths at most** — one desktop, one narrow. Each image costs roughly
a thousand tokens. Five widths is a budget leak dressed up as thoroughness.

## A state, not a guess

A still cannot show what happens on a click, so put the page in the state you need
*first*, and photograph that:

```
node "<shot.mjs path>" bin/index.html --widths 390 --do "click:#start; wait:800"
```

Steps are `click:<selector>`, `wait:<ms>`, `key:<key>`, `eval:<js>`, separated by
`;`. Keys are synthetic events on `document` — what a page's own shortcut handler
listens for, not a real keyboard. A `click:` that matches nothing is an error, not
a silent no-op.

## Measure it, do not guess from the picture

The report covers the usual questions. For anything else, ask the page:

```
node "<shot.mjs path>" <target> --widths 390 --eval "JSON.stringify({w: innerWidth, body: document.body.scrollWidth})"
```

`--eval` composes with `--do`. Everything in the page is fair game — a computed
colour, an element's box, a `querySelectorAll(...).length`. The expression runs
after load and may `await`. The viewport is set for real before the page lays
itself out, so `innerWidth` is the width you asked for.

**Do not write your own browser automation.** No Playwright, no Puppeteer, no
DevTools script of your own, no launching Edge by hand and hunting a stray process
that holds a profile. The script owns the browser, the port and the server. If it
cannot answer what you need, say so in your report — that is a finding about the
tool, and worth more than ten minutes of workarounds.

## Where the images go

Put them in the project: `.synapse/shots/` (the default). What you looked
at is then an artifact the operator can open too. Never write screenshots into
the harness's own folders — `skills/`, where `shot.mjs` lives, and `src/` beside
it are not yours to add files to.

## What you may and may not say

- **Say what is measurable**: where the main element sits, what the heading says,
  how many rows are visible, what the background and text colours are, whether
  controls are aligned, what is cut off at the narrow width — and the numbers the
  report gave you, quoted.
- **Do not invent detail.** If something is too small or too similar to read, say
  that. "I cannot read the label at this size" is a useful finding; a guessed
  label is a defect you just introduced.
- **A still cannot show** hover, focus, animation, scrolling, or what happens on
  a click. Say so when the question depends on it, and use `--do` plus `--eval` to
  test that part another way.
- **Judge against the brief**, not against taste you invented. If the design spec
  says three themes, check that three exist and name the colours you actually see.
- **You are not the operator.** Report what you see and what looks wrong; the
  final verdict on design is theirs.
