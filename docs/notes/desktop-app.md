# The desktop app, and what it is allowed to touch

`Synapse.exe` is the app: a WPF window around a WebView2 page, and the only thing the
operator launches. This note is the rule it obeys about the machine, the parts it
installs for itself, and the traps that cost time.

## 1. A good tenant

The machine is borrowed. Synapse may read what is on it and may run what it finds
(an existing Node, engine or `git`), but **the only place it may write is its own
folder and the projects root beside it.**

| Never | Because |
|---|---|
| `winget install`, MSI, any installer | it changes the machine, needs elevation, and leaves something Synapse cannot uninstall |
| a global npm install | it lands in `%APPDATA%\npm`, outside the folder, and survives deleting Synapse |
| editing `PATH`, now or in the registry | the change outlives the app and changes what every other program finds |
| writing `%APPDATA%`, `~/.config`, `%LOCALAPPDATA%` | these are the user's, and a portable folder that scatters state is not portable |
| asking the operator to install a prerequisite | the app is meant to be copied and run |

The test for a new dependency: **if this folder is deleted, is the machine exactly as
it was?** If not, it is installed wrongly.

## 2. What it needs, and where each part lives

| Part | Lives in | How it gets there |
|---|---|---|
| Node | `bin\node\node.exe` | `vendor-node.ps1`, or the fetch in `src\npm-check.js` |
| npm | `bin\node\node_modules\npm` | same download; only used for engine updates |
| Engine | `bin\opencode\opencode.exe` | `vendor-engine.ps1`, or the update flow |
| Git | `bin\git\cmd\git.exe` | MinGit, once, when the machine has none (`src\git.js`) |
| .NET packages | `vendor\nuget-packages` | `vendor-nuget.ps1`, so `dotnet build` needs no network |
| Fonts | `web\vendor\fonts.css` | vendored, never a CDN |
| WebView2 runtime | the machine | ships with Windows 11 and nearly every Windows 10 box through Edge. Not ours to install: if it is missing the app says so and stops |

**The vendored copy is preferred, always.** `start` resolves `bin\node\node.exe`
first and falls back to `PATH` only for a dev checkout, and says which it used; the
engine does the same for `bin\opencode`. `bin\`, `vendor\` and `node_modules\` are
not in git — caches that travel with a copied folder.

## 3. npm is for one thing

**Settings → Check for Updates**, which installs `@opencode/cli` and copies the binary
over the vendored one. The app is plain Node with zero packages.

Three facts that were wrong before this note existed: `bin\node\npm.cmd` did not work
(the script was copied without `node_modules\npm`); the missing-npm path installed
Node machine-wide with winget, the exact thing rule 3 forbids; and the fix is local —
`ensureLocalNpm()` downloads the Node zip for the version already in `bin\node` and
extracts only `node_modules\npm` into it. Because that npm's global prefix *is*
`bin\node`, `npm install -g` lands inside the folder.

At boot (`src/npm-check.js`): ours is used silently; this machine's is used with one
line saying so; missing, it is fetched in the background; a failed fetch is one
warning, recorded in `data\npm-attempt.json` and not retried for six hours. No prompt
— the app starts the server hidden, so a question would sit unanswered.

## 4. The shell

**Process model.** The shell spawns `bin\node\node.exe src\index.js` with
`SYNAPSE_SUPERVISED=1`, no window, all streams redirected — stdin closed immediately so
a prompt cannot block invisibly. The engine is that child's child. Nothing is matched
by process name: the shell stops what it holds a handle to, and
`Kill(entireProcessTree)` is the fallback after eight seconds.

**Exit codes are the contract.**

| Code | Means | Shell does |
|---|---|---|
| 2 | restart me | respawns and reloads the page |
| 3 | close the whole app — a staged update is waiting | raises `QuitRequested`; `update-apply.mjs` replaces the files and starts it again |
| 0 | stopped on purpose | stays stopped |
| anything else | it died | shows the last useful line and the console; no respawn loop |

**Updates use code 3.** The server downloads and stages a release, starts
`update-apply.mjs` detached and exits 3. The helper waits for both pids, backs up the
program files under `data\backups\`, overlays the stage and starts `Synapse.exe`. The
stage never contains `data\`, `config\` or the projects folder. A failed copy restores
the backup and still starts the old version.

**A crash leaves things running, so the next start adopts them.** A kill from Task
Manager once left the server, the engine and four MCP children alive, still holding
8700 and 8720, and the next launch failed with `EADDRINUSE`. `ServerHost.Start()` now
reads `data\synapse.pid`, proves the pid is still our executable inside this folder, and
asks `/api/status`; a live answer means the server is **adopted**, not killed, so the turn
it is running survives the window coming back. Only when there is no live server does it
fall back to the old cleanup, server first because its tree holds the engine. A stale pid
or a half-started server is not adopted.

**A build can land while the app runs.** Windows locks the image file against a
replacement but allows a rename, so `shell\build.ps1` moves the running `Synapse.exe`
to `Synapse.exe.old-<stamp>` and puts the new one at the root; the running window keeps
the old image, and the next launch runs the new build. The browser host is published
into `dist-host` and swapped the same way. The script never stops a process — the
operator's next restart is the only thing that changes what is running.

**The console is in the window.** `logger` mirrors the `app` channel and every warning
or error to stdout; the shell captures that into `logs\console.log` and a ring buffer
and serves it to the page over the WebView2 channel. The page never reads a file and
never asks the server — the console has to work when the server is stopped. There is
one writer of that file, the shell, so the server's fatal-before-logger errors still
land somewhere. The panel is `min(1180px, 100%)` by `76vh`, wraps rather than scrolling
sideways, is selectable, and polls the tail every 750 ms. It carries Start, Restart
and Stop beside Close, with one of them always disabled.

**The app stops and starts; the window stays.** Stop Server from the tray warns first
in a **native dialog**, because the page may already be down; consent `POST`s
`/api/shutdown` so the engine is stopped rather than orphaned. The server refuses that
request — and `/api/restart` — while work is live, and the shell shows the refusal instead
of falling through to its kill fallback. A deliberate stop or a crash does not swap the
window to the boot panel — the Engine row goes red and the console is one click away. When
the server comes back the shell reloads the page, because everything on it was fetched
from a server that no longer exists. `web/offline.html` carries a Start Server button,
shown only while the server is stopped or has failed.

## 5. The window

No frame; `WindowChrome` keeps the resize borders and a maximised window that fits the
work area.

- **The title bar is the shell's.** A page's scrollbar spans the page viewport, so a
  bar inside the page is a bar the scrollbar draws over. The bar is
  `CaptionHeight="36"`, so dragging, double-click, the system menu and snap layouts
  are the frame's own; the buttons are XAML with Segoe Fluent glyphs and
  `IsHitTestVisibleInChrome`. The page has no `padding-top`: `100vh` is already the
  room under the bar.
- **The WebView is inset by the resize border, because a child window takes the
  mouse.** With it full-bleed, `WindowFromPoint` at every edge returned Chromium's
  window, and forwarding the hit-test through the WebView is impossible — its windows
  belong to another process, and `SetWindowLongPtr` answers **error 5**. The 6px
  strips are painted in the colours the page *renders* there (the rail declares
  `#191B1F` and paints `#111417`), measured within 1–3 units of their neighbours.
- **A maximised frameless window overhangs.** Measured 2574×1454 at (-7,-7) on a
  2560×1440 screen, which put the taskbar under the window; `MainWindow` answers
  `WM_GETMINMAXINFO` with the monitor's work area in physical pixels.
- **The stage follows the window:** `fitStageHeight()` runs on load and on every
  `resize`, or the page grows a scrollbar at the new size.
- **No scrollbar gutter on the page.** `scrollbar-gutter: stable` on `html` holds a
  10px column open whether or not anything scrolls; the panes that scroll inside keep
  their own reservation. `color-scheme: dark` so Chromium's own scrollbars and
  controls follow.
- **One instance per folder.** A second launch broadcasts "come forward" and exits,
  rather than losing the port race and showing a boot panel with `EADDRINUSE`.
- **The window remembers where it was** (`data\window.json`), and refuses a position
  where the title bar could not be grabbed.

## 6. The folder travels

Copy it to another PC, double-click `Synapse.exe`, and it works — on Windows with the
**.NET 10 Desktop Runtime**, the one thing it does not install for itself.

The release zip (`make-release.ps1`) is the program: `Synapse.exe`, `package.json`,
the updater, `src\`, `web\`, `skills\` and the seed config — no `data\`, no `logs\`, no
projects, no keys, no tests, no docs, no git. **Copying the folder** moves everything,
including this machine's answers, which is what makes it a clone.

The rule that makes the rest true: **a path that names a place on this machine is a
hint, never an instruction.**

- If the **drive or share** is not here, the value is cleared at boot
  (`repairMachinePaths`) and the copy that travels is used. If the drive is here and
  only the file is missing, the config is left alone — that is a typo to fix.
- `config.engine.opencode.home` falls back to `data\engine\opencode` unless its root
  exists, so a copy cannot create a drive it does not have.
- A project whose directory is gone is dropped from the registry at boot
  (`pruneMissing`), silently. The cost is that a project on an unplugged drive is
  forgotten; the folder can be added again, which adopts it.

The guard is `tests/portable-paths.test.mjs`. The rule for anything added later: ask
whether the value would still mean anything on a PC that has never seen this one.

## The taskbar blink

When the work ends and Synapse is not the focused window, its button flashes until the
operator comes back.

- the page posts `/api/attention`; the server writes `[[attention]] work finished`;
- `ServerHost.OnLine` recognises the marker, keeps it out of the console store, and
  raises `Attention`;
- `MainWindow.FlashTaskbar` calls `FlashWindowEx` with `FLASHW_ALL | FLASHW_TIMERNOFG`,
  which stops by itself when the window is activated, and does nothing when Synapse is
  in front or hidden in the tray.

It fires when: the work ends; the harness stopped a run; a permission card appears; a
sign-in or the screen is asked for; a question is asked; the auto-shutdown countdown
starts.
