# Handover — the chat dock, 25 Oct 2026

Written the day the chat's geometry was rebuilt. It is a *state of play*, not a lesson:
the durable rules are in `ui-lessons.md` under "The chat's geometry", and this file should
be deleted (index row and test entry too) once the three open items below are closed.

HEAD at time of writing: `ebf3a3d`. Suite: **49 pass, 0 fail**.

---

## What this session was

Two things, and they are unrelated except that both were reported as "the UI is wrong":

1. **Eight small UI corrections** — every corner fillet to 8px, the probe and census tables
   aligned (first column left, the rest centred), chat errors kept in the transcript, picture
   chips on attachments, and the project/rail colours.
2. **The chat dock's geometry.** This was most of the time. Reported first as "the chat
   disappears when I switch Multi → Single, and the text shimmers"; it took four separate
   causes and two wrong diagnoses to get to a state where the numbers are stable.

The second one is the reason this document exists.

---

## The contract, in the operator's own words

> "Have the chat sit in its current spot. The only thing that moves is its top edge,
> uncovering more of the chat history."

Three facts follow, and each has exactly one implementation in `web/app.js`:

| Fact | Implementation |
|---|---|
| the bottom edge is the window's and never moves | `fitChatHeight()` — height is `window bottom − dock top`, both measured now |
| the top edge is wherever the cards end | `watchChatGeometry()` — reads the geometry once per frame and refits |
| nothing inside the box moves | `chatSlack` — the reader's distance from the end, restored after every change |

Read `ui-lessons.md` → "The chat's geometry" before touching any of it. The two things most
likely to be re-broken by a well-meaning change:

- **Do not put a transition on the chat's height.** It looks like it makes the chat "move with
  the cards"; it does not, because the top already moves with them. All it does is make the
  bottom edge lag, and during a run the Architect's card changes height several times a second.
- **Do not observe the cause; read the effect.** Three attempts to watch "the boxes above the
  chat" each found one more source and missed the next. `ResizeObserver` reports *sizes*, and a
  row can move without any observed box changing size. The top edge is read per frame instead,
  and a frame is the only granularity that works — an observer reports *after* the layout, so
  every frame paints once at the old offset.

---

## What is measured, and what is not

Measured (both layouts, switch in either direction, at the end and 300px scrolled up):
message moves **0.0–0.1px**, slack **unchanged**, composer **0.0**, dock bottom **0.0**. Ten
seconds idle: **0.0** everywhere. The transcript's bottom now equals the composer's top at
1243 / 1369 / 1600.

**Not measured, and not claimed: the shimmer.** The operator has reported it twice and the
last report ("still there", 14:46 recording) came after the geometry was already stable. I could
not reproduce it: comparing screenshots of a fixed clip during a switch gave **byte-identical**
frames once settled, in both the 1359–1460 band and above 1461. So either it needs the
operator's actual display (scaling, a non-100% DPI, a GPU path this harness does not use) or
the remaining suspect below is right. Do not close this item on the strength of these
measurements alone.

Remaining suspect, untested: the card block animates `max-height` on a wrapper, so the grid row
above the chat changes height by a fraction every frame, and the browser re-rasterises the text
below it at a new sub-pixel offset. If that is the cause, the fix is to stop animating the
reveal (instant, like the chat's own height) or to composite the transcript as a translated
layer for the duration. Both are visible product changes, which is why neither was made
unilaterally.

---

## Instruments (reusable, and two traps)

```powershell
# frames from a recording, no PNG decoding needed
$ff = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*ffmpeg*\**\ffmpeg.exe" -Recurse |
       Select-Object -First 1).FullName
& $ff -y -i in.mp4 -f rawvideo -pix_fmt gray out.gray    # 826x584 gray, one frame per W*H
```

- ffmpeg is installed (winget, `Gyan.FFmpeg`) but **not on `PATH`** — call it by full path.
- A band's row signature, compared against itself at offsets −3..3, finds a one-pixel shift
  honestly. Screenshots + a `zlib` PNG reader also work and are what found the mode button's
  `417..442 / 418..443` alternation.
- **Trap 1: `page.setViewportSize` does not exceed the real window.** It reported 1600 while
  `innerWidth` stayed 1369, so every "wide layout" test ran in the 1359–1460 band. Use CDP:
  `Emulation.setDeviceMetricsOverride` — and re-apply it *inside* every measurement, because it
  is dropped when the call ends.
- **Trap 2: a `<video>` cannot seek without byte ranges.** A static file server without
  `Range` support yields N identical frames and looks like "nothing moved".

---

## Dead ends — do not spend time here again

- **A `requestAnimationFrame` loop that rewrites the height for 380–500ms.** Guesses when an
  animation ends. Replaced by reading the geometry and refitting only when it changed.
- **Adding the height delta to `scrollTop`.** Correct exactly once; double-counts when two paths
  see the same change. That was a 12px jump, then 1px, then 1px — three callers' shares.
- **Recording the reader's place inside the scroll handler.** Our own writes fire that event,
  and it is dispatched *after* the frame's layout, so it recorded the next frame's height
  against this frame's offset. One switch compounded a 300px scroll-up into 496px.
- **`will-change` / `translateZ(0)` on the dock during the animation.** Kept for a while, then
  removed with the animation class; it made no measurable difference.
- **`ResizeObserver` on anything but the transcript.** See above.

---

## Closed since writing

- **The plan panel below the chat could not be reached at all.** In Multi at ~1243px the page
  scrolls 434px because the plan sits under the chat — but scrolling did not get to it:
  `fitChatHeight` measured the dock against the *viewport* bottom, which moves with the page,
  so the dock grew by exactly the distance scrolled, the document grew with it, and the plan
  stayed one screen below the fold for ever ("scrolling down simply raises the chat's top bar
  infinitely"). The height is now measured from the dock's place in the document, and JS uses
  the same 1359px breakpoint as the CSS instead of 1461. The 434px scroll is the layout and
  stays; the plan is reachable and fully in view at the end of it. Measurements and the two
  new rules: `ui-lessons.md` → "The chat's geometry".

## Open items, with what would settle each

1. **The shimmer.** Needs one answer from the operator: the window's **CSS width** (or whether
   the display is scaled — 125% makes a 1920-wide window about 1536 CSS px). That decides which
   layout to look at, and whether the reveal animation is the thing to change.
2. **Carried from earlier, untouched this session:** the per-session Tools-in-Use feed (item
   3.4 in `AGENTS.md`); no target picker in the composer; the `skill` probe case still reports
   "Unable to load skill list"; a 208MB `bin\opencode\opencode.exe.bak` that is safe to delete;
   the Architect's context budget and compaction.

`config/synapse.config.json` has one uncommitted change (`server.openBrowser: false`, so a
restart does not hijack a browser tab). Left uncommitted deliberately — it is local state, and
the file is source of truth only while its password field is empty.

---

## Checking it yourself

```powershell
cd F:\dev\Synapse
.\shell\build.ps1             # makes Synapse.exe; the tray stops and starts the server
node --test tests\*.test.mjs  # expect 56 pass
```

Then in the running UI: open a long session, scroll to the bottom, switch modes both ways, and
watch the bottom edge and the mode button. They should not move at all; the chat's top edge
should travel.
