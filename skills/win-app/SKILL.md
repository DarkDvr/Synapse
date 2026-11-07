---
name: win-app
description: The Windows shell a desktop app is built from — a WPF window hosting a WebView2 page, with DPI awareness, a dark frame, a virtual https origin for ui/ and a single-file publish already right. Use when a task asks for a Windows desktop app: copy this template into the project, build it, then verify the window with app-check and the page with visual-review.
---

# Win App — the shell a desktop app is copied from

A window (WPF) around a web page (WebView2). `template/` beside this file is the
shell, complete and correct. Copy it into the project and work in its `ui\` folder.

**This skill is the source.** Synapse's own folders are off limits to you — do not
read `templates\`, `src\` or `data\` looking for a scaffold. Everything needed is in
`template/`.

## Copy it

```
Copy-Item -Path "<this skill>\template" -Destination "<project>\app" -Recurse -Force
```

Then `cd <project>\app` and build. (`<this skill>` is the folder this SKILL.md lives
in — the brief names it.)

## What you change, and what you leave alone

- **`ui\` is the app.** Everything the operator sees lives there: HTML, CSS, JS,
  local assets. Delete the placeholder `index.html` and build the real interface.
- **Do not change the shell** unless the app needs it: `App.csproj`, `app.manifest`,
  `App.xaml*`, `MainWindow.xaml*`. They carry the parts that are easy to get wrong —
  DPI awareness, the dark title bar, the https origin for `ui/`, the single-file
  publish.
- **Window size, minimum size and title** are three attributes at the top of
  `MainWindow.xaml`: `Title`, `Width`/`Height`, `MinWidth`/`MinHeight`.

## Build

```
.\build.ps1                 lean: small exe in dist\; needs the .NET 10 Desktop Runtime
.\build.ps1 -Portable       self-contained single-file exe; runs with no .NET installed
```

Lean is the default. The .NET runtime is a system component: bundling it into every
app duplicates about 140 MB and pins that copy to the build machine's version,
security fixes included. A lean `App.exe` is roughly 1.4 MB — with the WebView2
wrapper DLLs the folder is about 2 MB. `-Portable` exists for a PC with no .NET 10
Desktop Runtime; that is the only thing it buys, and 60 MB is what it costs.

Either way the machine needs the **WebView2 runtime** — shipped with Windows 11,
present on nearly every Windows 10 machine through Edge.

## Verify it, both halves

- The **window**: the `app-check` skill launches the exe, waits for the window,
  photographs it and reports whether it is alive. Point it at `dist\App.exe`.
- The **interface**: the `visual-review` skill renders `ui\index.html` with the same
  measurement report and contact sheet used for any web page, because `ui/` *is* a
  web page. Report at a narrow width too (about 420): this window can be resized.

## Rules that are not negotiable

- **No network at runtime.** No CDN, no web fonts, no fetch to anything remote.
  Assets are local files in `ui\`.
- **No build step in `ui\`**: plain HTML/CSS/JS. If it needs a bundler, it needs a
  different plan.
- **Keep the chrome dark** (the shell already asks Windows for a dark title bar).
  A white frame around a dark page reads as unfinished.
- Test at 100% and 150% scaling: `PerMonitorV2` is set, so the app must not clip
  when the operator's display is scaled.
