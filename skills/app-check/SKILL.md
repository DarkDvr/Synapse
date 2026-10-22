---
name: app-check
description: Launch a built Windows app, wait for its window, photograph the window, and report whether it is alive and responding - the desktop half of visual review. Use when a task builds a .exe (or any windowed program) and you have to prove it starts, shows a window, and does not crash.
---

# App Check

A web page can be photographed and measured by the visual-review skill. A desktop
app cannot: it is a **window**, and a window is not in the DOM. This skill is the
missing half — it starts the exe, waits for a window to appear, photographs that
window, and tells you what a reviewer needs.

The interface inside the window is still a web page (the template renders `ui/`
in WebView2), so **review both**: the page with visual-review, the window with
this.

## Run it

This skill ships its own script, `bin/app-check.mjs`, beside this file. **Your
brief names its full path** — use that one, and do not go looking for another copy.

```
node "<the app-check.mjs path from your brief>" --exe dist\App.exe [options]

  --exe <path>         start this app and close it afterwards
  --pid <n>            look at an app that is already running
  --out DIR            where the window PNG goes (default .synapse/shots)
  --resize WxH         resize the window before the shot, e.g. 900x700
  --wait <ms>          how long to wait for the window (default 15000)
  --settle <ms>        wait after it appears, for the first paint (default 1200)
  --method print|screen|auto
  --keep               leave the app running
```

One JSON object comes back:

```
{"ok":true,"exe":"…\\App.exe","pid":59356,"title":"App",
 "window":{"x":740,"y":340,"width":900,"height":700},
 "dpi":{"dpi":96,"scale":1},"responding":true,"alive":true,
 "shots":[{"path":"…/window-….png","width":900,"height":700,"method":"print"}],
 "notes":[],"closed":true}
```

- **`ok`** is false when no window appeared, when the app had already exited, or
  when it was gone by the time the screenshot was taken. A window that dies on its
  first paint looks exactly like a working one in a screenshot, which is why the
  process is checked *after* the shot as well as before it.
- **`alive` / `responding`** — is the process still running, and is its message
  loop answering? A frozen app still has a window.
- **`dpi.scale`** — 1, 1.25, 1.5… the window's scaling. Say what you saw at that
  scale; a layout that fits at 100% can clip at 150%.
- **`note`** in `notes` — anything the tool could not do, in plain words.

Then **read the PNG** and describe it, exactly as the visual-review skill says: the
window frame, the title bar (dark or light), where the content sits, what is cut
off, what the states look like.

## Two sizes, one app

A desktop window is resized, not emulated: run it twice, or resize the same window,
and say what changes at the narrow size.

```
node "<app-check path>" --exe dist\App.exe --resize 900x700 --out .synapse/shots
node "<app-check path>" --exe dist\App.exe --resize 420x760 --out .synapse/shots
```

## What this cannot tell you

- **It cannot see inside the page.** For contrast, overflow and tap targets, point
  the visual-review tool at `ui/index.html` — same origin rules, same report.
- **It cannot click.** Steps belong to the page: use visual-review's `--do` for
  states, and this tool for the window that holds them.
- **It cannot judge a still's motion.** Animations between two states need two
  photographs and a sentence about what changed.
- **It leaves the app running** unless you pass `--exe` (which closes what it
  started, by pid) or stop it yourself with `--pid … --keep` avoided.

## When it fails

- *"no window appeared within 15000ms"* — the app is still starting (slow first
  run of a self-contained exe unpacks itself), crashed, or shows a dialog. Try a
  longer `--wait`, then run it by hand and read the error.
- *"the app exited with code N before showing a window"* — a real failure, usually
  a missing file next to the exe (`ui/` not copied) or the WebView2 runtime absent.
- A **black or flat window image** — some windows refuse to be photographed while
  hidden. The tool falls back to the screen automatically (`method: "screen"`),
  which brings the window to the front; if that happened, say so in your report.
