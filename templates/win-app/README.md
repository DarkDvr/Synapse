# win-app — the Windows shell a new app is copied from

A window (WPF) around a web page (WebView2). Copy this folder to start an app.

```
copy /Y   F:\dev\Synapse\templates\win-app   <project>\app     (or copy in Explorer)
cd <project>\app
.\build.ps1
```

## What you change, and what you leave alone

- **`ui\` is the app.** Everything the operator sees lives there: HTML, CSS, JS,
  local assets. Delete the placeholder `index.html` and build the real interface.
- **Do not change the shell** unless the app needs it: `App.csproj`,
  `app.manifest`, `App.xaml*`, `MainWindow.xaml*`. They carry the parts that are
  easy to get wrong — DPI awareness, the dark title bar, the https origin for
  `ui/`, the single-file publish.
- **Window size, minimum size and title** are three attributes at the top of
  `MainWindow.xaml`: `Title`, `Width`/`Height`, `MinWidth`/`MinHeight`.

## Build

```
.\build.ps1                 single-file exe in dist\ (no .NET needed on the target)
.\build.ps1 -Framework      small exe; needs the .NET 10 runtime on the target
```

`dist\` holds `App.exe` (about 59 MB self-contained) and `ui\`. Copy that folder to
another Windows 10/11 machine and run it. The machine needs the **WebView2
runtime** — shipped with Windows 11, present on nearly every Windows 10 machine.

## Verify it, both halves

- The **window**: `node "<app-check.mjs>" --exe dist\App.exe --out .synapse\shots`
  — launches it, waits for the window, photographs it, reports whether it is still
  running.
- The **interface**: `node "<shot.mjs>" ui\index.html --widths 1280,760` — the same
  measurement report and contact sheet used for any web page, because `ui/` is a
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
