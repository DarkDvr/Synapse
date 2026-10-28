# The desktop app, and what it is allowed to touch

`Synapse.exe` is the app: a WPF window around a WebView2 page, and the only thing
the operator launches. This note is the rule it obeys about the machine it runs
on, the parts it installs for itself, and the traps that cost time getting there.

---

## 1. A good tenant

The machine is borrowed. Synapse may read what is on it and may run what it finds
(there is no harm in using an existing Node, an existing engine, an existing
`git`), but **the only place it may write is its own folder and the projects root
beside it.**

That is one rule with several consequences, and each one used to be broken:

| Never | Because |
|---|---|
| `winget install …`, MSI, an installer of any kind | it changes the machine, needs elevation, and leaves something behind that Synapse cannot uninstall |
| a global npm install | it lands in `%APPDATA%\npm`, outside the folder, and survives deleting Synapse |
| editing `PATH`, now or in the registry | the change outlives the app and changes what every other program finds |
| writing `%APPDATA%`, `~/.config`, `%LOCALAPPDATA%` | these are the user's, and a portable folder that scatters state is not portable |
| asking the operator to install a prerequisite | the app is meant to be copied and run |

The test for a new dependency is: **if this folder is deleted, is the machine
exactly as it was?** If the answer is no, the dependency is installed wrongly.

---

## 2. What Synapse needs, and where each part lives

| Part | Lives in | How it gets there |
|---|---|---|
| Node | `bin\node\node.exe` | `vendor-node.ps1`, or `src\npm-check.js` when the runtime asks for it |
| npm | `bin\node\node_modules\npm` | same download as Node; only used for engine updates |
| Engine | `bin\opencode\opencode.exe` | `vendor-engine.ps1`, or the update flow in `src\engine-update.js` |
| .NET packages | `vendor\nuget-packages` | `vendor-nuget.ps1`, so a worker's `dotnet build` needs no network |
| Fonts | `web\vendor\fonts.css` | vendored, never a CDN |
| WebView2 runtime | the machine | shipped with Windows 11, present on nearly every Windows 10 box through Edge. Not ours to install: if it is missing the app says so and stops |

`bin\`, `vendor\` and `node_modules\` are not in git — they are caches that travel
with a copied folder, restored by the scripts above.

**The vendored copy is preferred, always.** `start` resolves `bin\node\node.exe`
first and falls back to whatever is on `PATH` only for a dev checkout, and says
which one it used. The engine does the same for `bin\opencode`.

---

## 3. npm is for one thing

`npm` is used by exactly one feature: **Settings → Runtime → Check for Updates**,
which installs `@opencode/cli` and copies the binary over the vendored one. The
app itself is plain Node with zero packages; nothing else at runtime touches npm.

Three facts that were wrong before this note existed:

- **`bin\node\npm.cmd` did not work.** `vendor-node.ps1` copied `node.exe`,
  `npm.cmd` and `npx.cmd` but not `node_modules\npm`, so `npm.cmd` pointed at a
  `npm-cli.js` that was not there. A copied folder therefore looked like it had
  npm and did not.
- **The missing-npm path installed Node machine-wide with winget.** That is the
  exact thing rule 3 forbids, and it happened at boot on a machine that only
  wanted to run a GUI.
- **The fix is local.** `ensureLocalNpm()` downloads the Node zip for the
  version already in `bin\node` and extracts *only* `node_modules\npm` into it.
  No installer, no elevation, no `PATH`, no `%APPDATA%`. It is silent because
  the app has no console to ask in; if it fails, the update button reports it
  and nothing else changes.

So npm's absence is not a boot failure, and npm's presence is never assumed.
A machine with no npm and no network can still run every turn: the engine and the
model provider are all it takes.

---

## 4. The shell

`shell\` is the WPF project; `shell\build.ps1` publishes a lean, single-file
`Synapse.exe` to the folder root. The exe is build output and is not in git.

**Process model.** The shell spawns `bin\node\node.exe src\index.js` with
`SYNAPSE_SUPERVISED=1`, no window, and all three standard streams redirected —
stdin is closed immediately so a prompt can never block invisibly. The engine is
that child's child. Nothing is ever matched by process name: the shell stops what
it holds a handle to, and `Kill(entireProcessTree: true)` is the fallback after
eight seconds, which is the handle-safe version of `taskkill /T`.

**Exit codes are the contract.**

| Code | Means | Shell does |
|---|---|---|
| 2 | "restart me" — Settings → Restart Now | respawns |
| 0 | stopped on purpose | stays stopped |
| anything else | it died | shows the failure with the tail, does **not** respawn in a loop |

**A crash leaves things running, so the next start cleans up after it.** Measured:
killing the app from Task Manager left the server, the engine and its four MCP children
alive, still holding 8700 and 8720 — the next launch then failed with `EADDRINUSE`, which
reads as "Synapse is broken". `ServerHost.Start()` therefore stops what a previous run
left **before** it spawns anything: it reads `data\synapse.pid` and `data\engine.pid`, and
acts only on a pid whose executable is still inside this folder. That is the same identity
rule as everywhere else — never a process name — and it is what makes a recycled pid
harmless: pointed at Notepad, the guard leaves Notepad running and starts normally. The
server goes first, because its tree holds the engine and the engine holds the MCP children.

**The console moved into the window.** `logger` still mirrors the `app` channel
and every warning or error to stdout; that stdout is captured by the shell into
`logs\console.log` and into a ring buffer, and served to the page over the
WebView2 message channel (`{kind:'console', action:'tail', offset}`). The page
never reads a file and never asks the server, which is the whole point: the
console has to work when the server is stopped. There is exactly one writer of
that file — the shell — so the server's fatal-before-logger errors still land
somewhere.

`logs\console.log` duplicates what `logs\app.log` already holds. That is
deliberate: the console is defined as "the app channel plus every warning or
error from any channel", which is a different cut of the same output.

**The app stops and starts; the window stays.** Stop Server from the tray warns
first — a **native dialog on purpose**, because it has to be answerable when the page
is not: the server may already be down, or the page may have failed to load, and a
page-drawn confirmation would be invisible in both. Consent then `POST`s
`/api/shutdown`, so the engine is stopped rather than orphaned.

**The page stays too.** A deliberate stop — or a crash — does not swap the window to
the boot panel. The Runtime row goes red, and the console is one click away. The
panel is for a server that never arrived, which is the only case where there is no
page worth keeping. When the server comes back the shell reloads the page, because
everything on it was fetched from a server that no longer exists. That includes a
restart the *server* asks for (`/api/restart`, which Settings' save uses): the
`ExitRestart` branch reports Stopped before starting the replacement, as the tray's
restart does, so the window reloads too. Verified 28 Oct: `[app] reloading
http://127.0.0.1:8700` followed the restart in `logs\console.log`, and a client
change in `web/` is live after a server restart without Ctrl+R.

**The console is behind `...` on the Runtime row.** A boxed ellipsis, not a label: it
is an affordance, not a fourth row in a block that already has three. The panel is
wide and tall on purpose — `min(1180px, 100%)` by `76vh` — because it is a log to
read, not a peek. Lines wrap rather than scrolling sideways (a stack trace is read),
the text is selectable, and it asks the shell for the tail when it opens and then
every 750 ms. Outside the app it says so instead of showing an empty box.

**The console carries the three server actions.** Start, Restart and Stop sit to the
left of Close, in the tray menu's order, and one of them is always disabled — there is
nothing to start while it runs and nothing to stop while it is down. Colour is the
border and the label only: a filled button would be louder than the dialog it sits in,
and Close is the primary action here. Stop goes through the tray's own confirmation,
because the question is asked in the shell and not in two places that could drift.

**The title bar says the server is stopped**, as well as the Runtime row — that strip
is the only thing on screen that does not depend on the page below it, which is
exactly the state it describes.

**The boot panel can start the server.** `web/offline.html` carries a Start Server
button, shown only while the server is stopped or has failed — while it is starting
there is nothing to press, and a button that does nothing is a mock.


---

## 5. The window

No frame. `shell\MainWindow.xaml` sets `WindowStyle="None"` and keeps
`WindowChrome` for the two things the frame was actually for: the resize borders at
every edge, and a maximised window that fits the work area.

**The title bar is the shell's, and that is not a style choice.** The page drew it
for a while, and it could not work: a page's scrollbar spans the page's viewport, so
a bar inside the page is a bar the scrollbar draws over. Measured on the operator's
screen — the scrollbar ran up through the close button. Outside the page, the
scrollbar starts where the page starts, which is under the bar.

- **The bar is `WindowChrome.CaptionHeight="36"`**, so dragging, double-click to
  maximise, the right-click system menu and the Windows 11 snap layouts are the
  frame's own. Nothing in JavaScript reproduces a drag, and
  `IsNonClientRegionSupportEnabled` is no longer set — the page owns no chrome.
- **The buttons are XAML**, with the Segoe Fluent Icons glyphs Windows uses on its own
  caption buttons, and `WindowChrome.IsHitTestVisibleInChrome="True"` so the caption
  does not swallow their clicks. Maximise and restore share a button; only the glyph
  (E922/E923) changes.
- **The page has no `padding-top` any more.** The viewport starts below the bar, so
  `100vh` is already the room under it and nothing has to subtract 36px.

**The WebView is inset by the resize border, because a child window takes the mouse.**
Measured: with the WebView full-bleed, `WindowFromPoint` at every edge returned
Chromium's window, so the frame was never asked to hit-test and only the caption
behaved. Forwarding the hit-test *through* the WebView is not possible: its windows
belong to another process, and `SetWindowLongPtr` on them answers **error 5**
(access denied). So the 6px belongs to the frame — and the strips left over are
painted in the colours the page **renders** there, which is not what its CSS says: the
rail declares `#191B1F` and paints **`#111417`** (the background image darkens it), and
the content's edge is `#0D161E`. Measured after: within 1–3 units of the pixels beside
them, so there is no visible frame, and `WindowFromPoint` at every edge and corner
returns the top-level window with HTLEFT/HTRIGHT/HTBOTTOM and the corner codes. The
top-right corner is the close button, as in every Windows app.

**A maximised frameless window overhangs.** Measured: 2574×1454 at (-7,-7) on a
2560×1440 screen, which put the taskbar under the window. `MainWindow` hooks
`WM_GETMINMAXINFO` and answers with the monitor's work area in physical pixels, so it
is right at any scaling.

**And the stage has to follow the window.** `fitStageHeight()` measures the room
once on load, so a resize left the old height behind and the page grew a scrollbar at
the new size. It is called on every `resize` as well.

**The page reserves no scrollbar gutter.** `scrollbar-gutter: stable` on `html` holds
a 10px column open whether or not anything scrolls, and the panes that scroll inside
the page keep their own reservation — that is where the rule belongs. The page itself
does not: it only scrolls in the narrow layout, where a bar is expected.

**`color-scheme: dark`.** Chromium's own scrollbars, spinners and date pickers follow
it. Without it a dark window grows a light scrollbar, and a transparent track over an
unpainted gutter is what reads as a black stripe.

**One instance per folder.** A second launch does not start a second server — it would
lose the port race and show a boot panel with `EADDRINUSE` on it, which reads as a
broken app rather than as "it is already open". The folder's path, hashed, names both
a mutex and a registered window message (a SHA-256, not `GetHashCode`, which is salted
per process so two launches would never agree); the second copy broadcasts "come
forward" and exits.

**The window remembers where it was.** `data\window.json`, written when it is hidden
and whenever its state changes. The restore refuses a position where the title bar
could not be grabbed: there is no frame, so that 36px strip is the only thing to drag,
and a saved position that leaves it off the desktop is a window nobody can move back.

---

## 6. The folder travels

Copy the folder to another PC, double-click `Synapse.exe`, and it works — on Windows
with the **.NET 10 Desktop Runtime**, which is the one thing it does not install for
itself. The exe is a small framework-dependent app on purpose; when the runtime is
missing, Windows says so before Synapse has run a line.

The rule that makes the rest true: **a path that names a place on this machine is a
hint, never an instruction.** The config and the runtime state travel with the folder,
so they still name the machine the copy came from. Measured on a second PC:

- `config.engine.opencode.binary` was `F:\dev\Synapse\…\opencode.exe`, so the engine
  could not be spawned at all (`spawn … ENOENT`) and the app served a UI whose runtime
  was dead. Paths are now checked: if the **drive or share** is not here, the value is
  cleared at boot (`repairMachinePaths`) and the copy that travels is used. If the drive
  *is* here and only the file is missing, the config is left alone — that is a typo to
  fix, not a different machine.
- `config.engine.opencode.home` was the same kind of path, and the home is *created* —
  so the copy made an `F:\dev\Synapse\data\engine` on a PC that has no F: drive. The
  home now falls back to `data\engine\opencode` unless its root exists.
- `data/projects.json` listed a project whose folder was on the old machine. A project
  whose directory is gone is not listed, and is dropped from the registry at boot
  (`pruneMissing`), silently: a row nobody can open is not information. The cost is that
  a project on a temporarily unplugged drive is forgotten; the folder can be added again,
  which adopts it, plan and sessions included.

The guard is `tests/portable-paths.test.mjs`. The general rule for anything added later:
ask whether the value would still mean anything on a PC that has never seen this one.


