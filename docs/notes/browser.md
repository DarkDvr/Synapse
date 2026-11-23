# SynaBrowse — the harness's own browser

A browser Synapse owns, on its own profile, driven over the Chrome DevTools Protocol.
Models get it as a set of tools; the operator sees one window, only when a person is
genuinely needed. It is not an option: SynaBrowse ships with Synapse, and the WebView2
host is always the browser. Edge with its hidden desktop is kept only as a test fallback
behind `SYNAPSE_BROWSER_ENGINE=edge`, never as an operator choice.
`web_search` uses a **separate off-screen host page** of its own, never this window and
never a new tab — see `docs/notes/web-search.md`.

## Why a browser at all

`webfetch` reads public pages and nothing else. Two walls it cannot pass, both
measured: **Cloudflare's interstitial** (`webfetch` gets "Just a moment…") and **a
sign-in** (a deep route answers "Something went wrong" until the profile has the
session). Measured 11 Nov: hidden headed Edge cleared the challenge in **2.6 s**; on
screen it took 14 s and then showed an error page; headless never cleared it in 30 s.
That is why the browser is headed and off-screen rather than headless.

## The engine: the WebView2 host (1.77.0)

`shell/SynaBrowseHost` is a separate WPF exe (`bin\browser-host\SynaBrowseHost.exe`) that
owns a window and a WebView2 controller. It is the app's own Chromium runtime, with no
browser chrome: no downloads panel, no first-run or crash bubbles, no Edge taskbar button.
`src/browser/webview2.js` launches it and reads its state and download JSONL;
`createBrowser({ host })` attaches the CDP page and agent-browser to it.

- **Off-screen by default**: the WPF window at -32000, `ShowInTaskbar=false`. It cleared
  Nexus's Cloudflare in about 12–15 s with `navigator.webdriver=false`, and the agent-browser
  saw the page and its refs (including a closed shadow-root button).
- **Downloads are the host's**: `DownloadStarting` sets the project path; the host appends
  `starting`/`progress`/`completed` to `data\browser\webview2-downloads.jsonl`, which the
  provider turns into the chat records. Do **not** call `Browser.setDownloadBehavior`: on
  WebView2 it is accepted and then cancels the host's download (measured 22 Nov).
- **The first download fails** (`FileFailed`); the host absorbs it with a tiny data-URL
  warm-up in `%TEMP%` at startup, deleted afterwards. `DefaultDownloadFolderPath` must be
  set before the first download or `DownloadStarting` never fires.
- **Close by HWND**: the host publishes its window handle in the state; the provider posts
  `WM_CLOSE` so the Closed handler disposes WebView2 and releases the profile. A forced
  tree kill is the fallback, by the pid in the state.
- **The profile is `data\browser\webview2`**. A fresh profile is a guest on Nexus: one
  visible sign-in (Settings → Browser, or a model hand-off) seeds it, then the `sites`
  table and the profile keep it. The Edge profile is not shared.
- **Edge is a test fallback only**: `SYNAPSE_BROWSER_ENGINE=edge` uses the old
  hidden-desktop path and `data\browser\profile`, so the suite can drive a browser on a
  machine with no WebView2 host. The two are one browser at a time, never both.
- **The hidden desktop is a .NET dead end**: WPF, WinForms and even a bare .NET console
  all exit `0xC0000142` on a `CreateDesktop` desktop here; Edge (native) runs there. The
  WebView2 host therefore uses the off-screen window. A native C++ WebView2 host would be
  needed if the hidden desktop itself must be kept.

## The profile

`data\browser\profile` — one per installation, global across projects, in `data/` so it
is never committed. **Never** the operator's Edge profile, and never Brave. The session
lives in the profile because the browser is the thing using it; nothing is copied, and
no cookie is ever read, exported or logged.

A profile cannot be open twice, so `createBrowser()` attaches to an existing instance
(`DevToolsActivePort` + a live `/json/version`) and is idempotent under concurrent
callers.

## The launch, flag by flag

| flag | why |
|---|---|
| `--disable-blink-features=AutomationControlled` | decides the Cloudflare result: without it the page sits on "Verifying…" for ever |
| `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` | a hidden window is a background window; without these its timers are throttled and a JavaScript challenge never finishes |
| `--disable-features=CalculateNativeWinOcclusion` | stops Windows suspending the off-screen window |
| `--window-position=-32000,-32000` | off the desktop, not on a monitor |
| `--start-minimized` | a launch must not take the foreground |
| `--remote-debugging-port=0` + `--user-data-dir` | the port is written into the profile; no port is chosen by hand |

The window is found again by the command line naming that profile — never by process
name. `--test-type` suppresses Chromium's "unsupported flag" bar. The launch restores
the operator's window as soon as the process exists, not when the debugging port opens,
and moves the window only if it is not already inside the target monitor — so the
common path is one call: minimize.

## The desktop of its own (22 Nov)

The window is not hidden; it is somewhere else. `src/browser/hidden-desktop.ps1` creates a
Windows desktop (`CreateDesktop`), launches Edge there (`CreateProcess` with `lpDesktop`),
writes its pid and desktop to `data\browser\hidden-desktop.json`, and waits on the process
as its keeper. The browser is a normal headed window on that desktop, so it renders, keeps
the fingerprint that clears a bot check, and is never on the operator's desktop to flash a
taskbar button.

Measured 22 Nov: **0** windows of the browser's pids on the operator's desktop, **11** on
the hidden one, with the Nexus page loaded; Cloudflare cleared in about 8 s. A second
desktop has no shell, so nothing is drawn there.

If the launcher fails (a policy, a service session), `browser.js` logs it and falls back to
the old off-screen window — a brief flash is better than no browser, and the log says which
one ran. `hiddenDesktop: false` forces the fallback; the suite uses it so CI does not need
an interactive desktop.

**What it cannot do:** a live window on one desktop cannot be moved to another with a
supported Windows API. The hand-off is therefore a relaunch, described below.

## The action layer: refs, not coordinates

`src/browser/agent.js` wraps **agent-browser**, a native Windows binary vendored in
`bin\agent-browser` (Apache-2.0; `vendor-agent-browser.ps1` restores it). It attaches to the
Edge Synapse already owns over `--cdp`, walks the accessibility tree, and answers:

```
- button "Manual download" [ref=e145]
- link "Slow download" [ref=e324]
```

`click` and `type` take that ref. A click fails loudly when the control is covered, hidden
or off-screen, and refs do not survive navigation — the model takes a new snapshot. This is
the reliable route; the x/y fields remain as the fallback. The spike of 22 Nov drove the
Nexus manual/slow download in seven tool calls (open, three snapshots, three clicks), with
no screenshot needed to choose a click.

## The tools

`open`, `read`, `snapshot`, `click`, `type`, `press`, `wait`, `scroll`, `screenshot`,
`watch`, `tabs`, `handoff`, `download`, `save`, `dom`, `close`.

`snapshot` is the action surface: each line names a control and its ref, and `click`/`type`
take that ref. It is the one a model should use before acting; `read` is for what the page
says.

The model sees them namespaced — `synapse-browser_open` — because the engine prefixes a
server's tools with its key. The names travel in `synapse.harness`, one copy for every
role, always: a brief that says `open` sends the model to a tool that does not exist
(17 Nov, a Single chat that then guessed nine URLs with `webfetch`).

- `read` answers the page as a person reads it — headings and text, plus the links and
  **controls** (buttons, tabs, menu items, anything that draws a pointer) with the
  address and coordinate a click uses. Not HTML: a DOM dump is thousands of tokens.
  `mode: "text"` keeps the page's own lines for a thread or profile; article mode keeps
  standalone labels (an author, a date) that a paragraph would drop.
- `read { full: true }` scrolls to the end in viewport steps, extracts once, and writes
  the page into `.project\browser\pages\<slug>-<stamp>.md` with a title, source, size
  and short contents. Bounded at 400,000 characters and 25 seconds, and a cut says so.
- `screenshot`/`watch` write into `<project>\.project\browser\shots\` and answer the
  absolute path *and* the project-relative one the chat can render.
- `save` fetches an address **in the page's own context** (`credentials: 'include'`), so
  the request carries the session's cookies, origin and headers. It takes `method`,
  `form`, `xhr` and `json`, and the cross-origin leg is automatic: when the page cannot
  read the answer, the same address is fetched from Node with that host's cookies and
  the page as referrer. Measured on a mod page: a real file in **84 ms**, and an address
  that answered `text/html` refused as "answered a page, not a file".
- `dom` reads what elements state — `data-*`, `href`, `title`, a form's action —
  because a page puts the facts a script needs in attributes, where `read` cannot see
  them.
- `read` names each visible iframe with its src, size and click coordinate: a widget's
  words are not in the parent document, and navigating to the widget's src loses the
  turn.
- A bot check is **named, never worked around**: `botWall()` recognises a captcha or
  “checking your browser” from the page's **visible** text, or from an empty page whose
  frame is a challenge. A Turnstile script on an ordinary page is not a wall; matching the
  script URL alone made the signed-in Nexus page look like one (22 Nov). The answer says a
  person has to clear it and points at `handoff`. A challenge clicked at gets longer, not
  shorter.
- Every call is timed to stderr and always answers; an error with no message says "the
  browser did not say why".

The page must be an http(s) address or a local `.html` mock (below). The server is
registered in the engine's isolated config at every start; there is no off state and no
tool that refuses because a switch is off.

## The hand-off is a permission

A page that needs a login is not a window that appears — it is a **question**. When a
page is a wall, the model calls `handoff`, and the harness raises the same card the
screen lease uses: **Allow Sign-In**, Reject, Reject With Reason, Stop Run. No
auto-allow, and no timeout: the card waits, and the run's stall clock is suspended while
it does (the wait is the operator's, not the model's).

Only an Allow opens a window, and then it is an ordinary one: normal and focused, on the
monitor they are looking at, loading that site with **no time limit**. The two hollow knocks
play when the card appears.

For a model's `handoff` the window is a **relaunch**, because a window on the hidden desktop
cannot be moved: the hidden browser is stopped (so the profile is free), a visible one opens
on the operator's desktop at the same page, and the call waits for them to **close** it.
Closing is the Done — a bot check has no password box, so the watcher must not auto-hide a
page that has merely loaded. Then the visible browser stops, the hidden one comes back on
the same page, and the site is recorded in the Signed In table. The card says to close the
window. A close without a session is a Reject, and the model carries on without the site.

The Settings → Browser **Sign In…** path has no model waiting: it shows the same window and
watches it, and when the page stops asking to be signed into — no password box, no sign-in
route, loaded, twice in a row — the window is hidden and the site recorded.

### The window has to be findable (22 Nov)

The live test found the window missing, not the page: the hidden browser had stopped and the
visible one was running, but the operator pressed Stop because nothing appeared on their
taskbar or their screen. Three fixes, all measured:

- **AddTab.** The hide path removes the button with `ITaskbarList::DeleteTab`; setting
  `WS_EX_APPWINDOW` on show does not put it back. The show path calls `AddTab` after the
  window is shown.
- **Topmost while it takes the foreground.** A full-screen Synapse covers a restored
  window. It is shown `HWND_TOPMOST`, focused with the attach-to-foreground trick, then
  returned to `HWND_NOTOPMOST` after 200 ms.
- **The primary monitor when the foreground is unknown.** The focus path uses the monitor
  of the foreground window; the fallback used to be the second monitor. A sign-in now
  falls back to the primary.

`askToSignIn` logs one line: `sign-in window shown on \\.\DISPLAY2
(toolWindow=false, onScreen=true)`. That is the check for the next live test.

`browser.stop()` gives `Browser.close` **three seconds**, not the protocol's minute. The
window the operator just closed has a half-open socket, and waiting out the full minute
made every hand-off take about eighty seconds after the close (22 Nov). With the short
timeout the same cycle returns in about thirty seconds end to end.

A Stop can kill the server in the middle of a hand-off: the Node `finally` never runs and
the visible window is left on the desktop (22 Nov). Two keepers close by pid: the hidden
keeper takes `-ParentPid` and ends its Edge when the server is gone; the visible hand-off
spawns `visible-watch.ps1` with the same two ids. Neither matches a process name.

The hidden keeper is launched **not detached**. A detached PowerShell could not set up the
desktop and the launch fell back silently — the state file never appeared (22 Nov). The
parent check is what cleans up; detachment is not needed.

**The keepers are a safety net, not a kernel.** A job/tree kill can take a keeper with it;
in the 22 Nov probe a `child.kill()` of the server killed the watchdog too, and the Edge
survived. The app's Stop is not a tree kill, so the keeper normally gets its chance. If a
browser is left behind, the next start attaches to it on the same profile (a profile cannot
be open twice), and closing the window by hand is the fallback.

## What the first live run found (22 Nov)

The Nexus Music Merged run worked end to end: it found the mod, saved the 86 KB zip and
the real `MusicMerged.esp`, and the final slow download was one `click { ref }`. The
friction was in four places, and each is now fixed:

- **A Turnstile script is not a bot check.** `botWall()` matched `cf-turnstile` /
  `challenge-platform` in the page's script URLs, so the signed-in mod page was reported as
  a wall, `download` refused twice, and the hand-off failed on its post-restart read. A wall
  is now the page's **visible** challenge text, or an empty page with a challenge frame.
- **A dialog needs a plain snapshot.** The model opened the manual-download popup, then
  scoped `snapshot` to guessed `.popup-box` selectors; the one link that matched was the
  page behind it, so it concluded “no popup” and fell back to a screenshot and an (x,y)
  click. The selector is a scope, not a search; the snapshot answer now says so when a
  scoped result is nearly empty, and the description says to take a plain one after a click
  opens a dialog.
- **A 404 page is named.** The model guessed Nexus's search route, got its styled “Page not
  found”, and tried more routes before falling back to websearch. `read` and `open` now say
  **Page not found (404)** and that the address, not the site, is wrong.
- **A download card belongs to the click, not the finish.** It was placed by `endedAt`, and
  the finish landed after the report had begun, so the card sat under the report. It is now
  anchored by `startedAt`: with the tool calls that earned it, above the report.

## The second run: the site refused, the model looped (22 Nov)

The next run, on `synabrowse_test2`, got further and then hit the site's own limit. It found
the file page, opened the download options, and clicked **Slow download**; Nexus answered
**“Something went wrong. The download link for the file could not be retrieved. Please try
again later.”** The page also marked the file **Downloaded 22 Nov 2026** — the first run had
downloaded the same file 34 minutes earlier. The hand-off succeeded and the site was
recorded; the site still would not issue a second link. The first run's zip is in
`synabrowse_test\.project\downloads`.

The model then looped for eight minutes: the same Slow control twice, two guessed widget
endpoints (`PremiumDownload` 403 Cloudflare, `DownloadPopUp` 404), a needless hand-off for
the endpoint, and a reopen of the UI. Three tool fixes came out of it:

- **`pageRefused` / `pageDownloaded`.** `read`/`open` say when the site marked a file
  downloaded and when the site says the download link could not be retrieved. `download`
  says plainly that a site refusal is not a missing click and that retrying the same
  control will not change it.
- **The download-options dialog.** After the file-row button, the page needs a second click
  (the modal's `Manual download` link) before the Slow/Fast options appear. A plain
  snapshot has them; `snapshot` now says to drop **selector, compact and depth** after a
  dialog, because a depth limit can cut the buttons out. `click`/`wait` say that `text` is
  the page's own text and does not see a shadow-root dialog.
- **Do not reverse-engineer endpoints.** `save` says a 403/404 HTML is the site answering,
  not a file; the page's own control is the way.

The lesson: a download that the site refuses is an answer, not a prompt to try another
button. Report it; a different file or the site's cooldown decides whether it can run.

## The third run: the downloads panel hid the page (22 Nov)

The Music Merged retry downloaded at 17:14. Its Edge downloads panel stayed. On the next mod
— Skyrim Audio Amplifier, 198886, uploaded 12 Nov, 139 KB — every `snapshot` returned the
panel's **Downloads / Open downloads folder / Search downloads** controls and none of the
page's. The screenshot was page-only (`Page.captureScreenshot` excludes browser chrome), so
the model saw a page it could not snapshot, pressed Escape (page input; no effect), clicked
the panel's Downloads button (which opens the full hub instead of closing it), and spent
seven minutes on coordinates before Stop.

`snapshot` now detects the bubble or the hub, waits while a file is still saving, restarts
the browser at the current URL and returns the page with a note that a half-filled form was
lost. On the same page that gave `button "Manual download"` e125, its dialog link e128 and
`Slow download` e236; three ref clicks saved the 140 KB zip. The panel is browser UI: page
input cannot close it, and
`--disable-features=DownloadBubble,DownloadBubbleV2,msDownloadsHub` did not suppress it on
Edge 158 (measured 22 Nov), so the restart is the reliable path.

## Being invisible, exactly

A hidden browser must be invisible *and* still render, and those pull apart. This is the
**fallback** path (`hiddenDesktop: false`); the main path is the desktop above. The hide
rules still matter when the desktop cannot be created, and for the tests.

- **the hide starts before the browser is ready.** `show.ps1 -Hide -WaitMs` starts the
  moment the process exists and grabs the window within 40 ms of its creation.
- **no taskbar button: hide, style, show, then DeleteTab.** Hide, set
  `WS_EX_TOOLWINDOW`, clear `WS_EX_APPWINDOW`, show off-screen, call
  `ITaskbarList::DeleteTab`. Setting the style on an already-visible window does nothing
  — Windows re-reads it on hide/show, which is why three earlier attempts failed (14
  Nov).
- **off-screen and normal, never minimized.** A minimized Chromium window stops
  compositing, so `Page.captureScreenshot` never answers; off-screen it is invisible and
  still renders. Measured: minimized → no answer in 15 s; off-screen → 55 ms.
- **no "Restore pages" bubble.** Edge shows it at the top-left after a kill and it was
  mistaken for ours; two flags suppress it and the window search ignores it by title.
- **a sign-in window is the exception:** on Allow the tool-window bit is cleared, the
  window is placed on the operator's monitor, restored and brought forward, because they
  asked for it and are about to type. After the session lands it is hidden again.

### Hiding it: the attempts, and the one that works

| attempt | what it did | result |
|---|---|---|
| 12 Nov | tool-window bit off, parked at −32000, left normal so Chromium keeps rendering | button stayed; parking worked |
| 13 Nov | the same on **every** top-level window of the profile | button stayed |
| 14 Nov | untitled windows accepted, a **watcher** re-applying the bits every 1.2 s | button stayed; watcher removed |
| 14 Nov | **hide → set the style → show**, then `DeleteTab` | **button gone** |

The first three failed because the bit was set on a window the shell had **already put
on the taskbar**, and Windows re-reads it when a window is hidden or shown — not while
it stays visible. What is still not covered: a window Edge creates **later** (a popup),
because the watcher is gone. One pass at launch is not a watcher; if a stray button
appears mid-session, that is the line to move back.

**What the rule may touch:** only an `msedge.exe` whose command line carries
`--user-data-dir=<SynaBrowse's own profile>` **as an argument**, matched literally.
Edge a person or Windows opened runs on its own profile and is never matched; WebView2
is a different process (`msedgewebview2.exe`), so Synapse's own window cannot be caught.

## Sites: a record, not a permission list

`src/browser/sites.js`, shown as the **Signed In** table in Settings → Browser.

- There is no host allowlist. The master switch is the fence; the table says which hosts
  the profile has sessions for.
- **The table's last row is the form**: type an address, press `Sign In…` or Enter. It is
  not validated — a browser resolves `example.test` or a LAN address; the harness only
  chooses the scheme to try first (https, then http).
- The row is written **only after the operator closes the window and the address is
  opened once more, hidden**. `looksUnconfirmed()` refuses it while the page still has a
  password box or sits on a sign-in route; nothing is added and the toast says why.
- A confirmed row keeps the address it was confirmed at and shows ages, not countdowns:
  when a session expires is the site's decision.
- ✕ forgets a site: the row goes and the browser drops that site's cookies **and its
  storage**. The parent domain matters — clearing `www.reddit.com` left seven cookies on
  `.reddit.com`, so the operator stayed signed in after deleting the row. Cookies are
  listed by name and domain to delete them; a value is never stored, logged or returned.

The sign-in button says what it is doing: **Opening…** then **Saving…**, both breathing.

## Project artifacts, not a shared folder

The engine gives each project's MCP server that project's folder as its working
directory (measured 11 Nov), so screenshots and frame strips go to
`<project>\.project\browser\shots\`: they are deleted with the project, two projects
browsing the same site keep their own pictures, and nothing under the harness has to be
forgiven. `src/browser/artifacts.js` decides; the harness folder is the fallback for a
server whose cwd is not a project.

## A local mock is a page

`open` accepts a `file:` address under a fence: the file must be **inside the projects
folder** (resolved first, so `..` cannot climb out) and must be **`.html`/`.htm`**. The
point is a page to look at, not a reader for arbitrary files. Everything the browser does
with it works the same, and no host is recorded. `localPageAllowed()` in
`src/browser/allow.js` is the rule, tested without a browser.

## Downloads

A download is a file the page hands the browser. It goes to
`<project>\.project\downloads\`: it belongs to the project, is deleted with it, and does
not sit in the operator's Downloads folder.

- **The browser chooses the folder, not the page.** `Browser.setDownloadBehavior` with
  `allowAndName` writes under the download's GUID; on completion it is renamed to the
  suggested filename, made safe as one leaf, and a collision gets ` (1)`.
- **A click that downloads waits for the file**, and its answer carries the
  project-relative path. `download {url}` is the explicit route; `download` with no
  `url` waits for one already in flight.
- **The chat shows an ASCII bar.** The browser reports begin/progress/completed on the
  browser's CDP endpoint (not the page's); the server forwards them throttled to four a
  second to `POST /api/browser/download`, and the page draws a `SynaBrowse · Download`
  card with `[####----] 42%`, bytes and the saved path. A reload asks
  `GET /api/browser/downloads?dir=…`.
- **A card sits in the post where the action started, not at the bottom.** It is anchored
  by `startedAt` — the click or `download` call — so a file that finishes after the report
  has begun stays with the tool calls that earned it; a completed card folds to its
  one-line head. Anchoring by finish time put the Nexus card under the report (22 Nov).
- **Progress is browser-scoped, the folder is the project's** — the folder is set again
  before each action, because one browser and one page are already the rule.
- **No file is ever written outside a project.** The API refuses a `dir` outside the
  projects root, and a failed `setDownloadBehavior` denies downloads rather than falling
  back to the machine's Downloads.

## Names and lines

A model reading a Reddit thread needed two things extraction had thrown away: **who
wrote each comment**, and **the page's line structure**. Text mode used to collapse all
whitespace — a whole thread arrived as one 20,000-character line. Now text mode keeps
one line per block, blank runs collapsed, and article mode emits a standalone link or
`<time>` as its own line. The `read` description says which mode to use: *article* for
prose, *text* for a thread, a forum or a profile.

## A page cut in silence is a page the model thinks it has

`read` used to cut at 6,000 characters whatever `maxChars` said, with no mark. It now
reports the page's own length (`total`), honours `maxChars` (6,000 by default, up to
100,000 in one read, 30,000 in the older outline) and links, and a cut ends with
`[… truncated: 6,000 of 41,210 characters. Ask again with a larger maxChars (up to
30000), or scroll and read again for the rest.]`

## A wait that fails says which absence it found

`wait` used to match rendered text only, so a model waiting for a collapsed comment got
five red failures with no way to tell "late" from "collapsed" from "not there". It now
checks the page's HTML too and says: *"after 5s the text "193" is not displayed, but it
is in the page's HTML — a collapsed comment, a closed menu or a tooltip. Open that, then
wait again"*; or *"it is in neither the page's text nor its HTML (9,400 characters of
text). Check the spelling, or read the page"*. `browser.wait()` answers
`{ ok, elapsedMs, hidden, textLength }` so the server can say it.

## Where a click lands

Measured in a scratch project: a 1280×800 window gives a 1280×800 PNG at
`devicePixelRatio` 1 (the page is held at `Emulation.setDeviceMetricsOverride`), and a
click asked for 324,444 arrives at 324,444 — delivery error 0,0. So the arithmetic is not
the error; a model reading a picture is, by a few pixels. The click therefore makes the
near-miss harmless:

- the point is **clamped** into the viewport, because a y from a whole-page image can be
  past its bottom;
- if nothing clickable is under it, it **snaps** to the nearest control within **28 px**,
  and the answer says which and how far;
- a point **inside** anything that behaves clickable (`[role=tab]`, `[onclick]`, an
  ancestor with `cursor: pointer`) is the operator's aim, not a near-miss, so it is
  clicked where asked;
- the answer reports where it really landed (`at`), and `screenshot` says the image's
  size and that one image pixel is one CSS pixel.

`Page.captureScreenshot` with `captureBeyondViewport` alone returns the viewport (a 888px
page came back 1280×800), so a full-page image asks `Page.getLayoutMetrics` and clips to
the content size. `open` waits up to 3 s for ~120 characters before returning, because a
storefront renders its text after `load`.

## A key is a character too

`press` takes any printable ASCII character, or several, and dispatches a real
keyDown/keyUp with the physical code and virtual key (`Digit7`/55, `Equal`/187 for both
`=` and `+`), plus `text` on the way down so the character is inserted and `keypress`
fires. `type` inserts text through `insertText`, which fires **no key event at all** —
its description says so. A chord is refused by name.

## When the page is gone

Every protocol request answers or fails within 60 seconds — a minute, because fetching a
password from a manager takes one — and `start()` checks that the page it holds is still
alive. Both came from a real wound: the operator signed in, closed the hand-off window,
and the next `read` sat on a half-open socket for seven minutes (11 Nov).

## Limits, stated

- **Expiry is the site's.** The table shows when a session was made, never "good for N
  days".
- **Confirmation is a page check, not a proof.** A site that renders a sign-in form
  without a password input can pass it.
- **The profile can break** (an Edge upgrade, a crashed write). Recreate it; never copy
  Edge's.
- **A hidden browser costs RAM** (~300 MB). It starts on demand, never at boot, is closed
  after `idleMinutes` (default 5) with no tool call, and returns the article rather than
  the page — tokens in the model's context are memory too.
- **Nothing here reads a cookie.** Not for the table, not to "validate", not as a
  fallback.
- **A hidden desktop needs an interactive Windows session.** In a service session
  `CreateDesktop` can be refused; the fallback is the off-screen window, and its launch
  flash comes back. The log says which path ran.
- **The hand-off is a relaunch.** About two seconds and a page reload: the hidden browser is
  stopped, a visible one opens the same URL on the same profile, and the hidden one comes
  back to that URL after the operator closes the window. Mid-flow page state is not
  preserved.
- **agent-browser is a pinned, vendored binary.** If `bin\agent-browser` is missing,
  `snapshot` and ref clicks say what to run; `open`, `read` and the coordinate fallback
  still work through CDP.

## Why a model cannot see it

"SynaBrowse is on and the model says there is no such tool" is almost always one thing:
**the engine registers its MCP servers when it starts**, from
`data\engine\opencode\config\opencode\opencode.json`, which is written at boot from the
harness's config. SynaBrowse is always registered now, but an engine that was already
running from an older build has not seen it yet.

- the check: that config must list `"synapse-browser"`. If it does, a model that still
  "cannot find" it is looking for the wrong name — the tools are
  `synapse-browser_open`, `synapse-browser_snapshot`, and the rest;
- if the config does not list it, restart Synapse; the engine only reads its MCP servers
  at start.

SynaBrowse is not a permission switch. The sign-in card is the permission: nothing the
browser does as the operator happens without a person saying yes to a card first.

## Where things live

| | |
|---|---|
| `src/browser/cdp.js` | the protocol client: requests that answer or fail in 60 s, events, evaluate, screenshot |
| `src/browser/browser.js` | Edge by full path, the hidden-desktop launch and its fallback, the toolset, `clearSite`, the idle reaper |
| `src/browser/settings.js` | the one reader of the browser's profile, idle minutes and test seams |
| `src/browser/search.js` | the off-screen search host page, result extraction, idle close and the launch lock |
| `src/browser/hidden-desktop.ps1` | the launcher/keeper: `CreateDesktop`, `CreateProcess` with `lpDesktop`, the state file |
| `src/browser/agent.js` | the agent-browser wrapper: snapshot, ref click and fill, the daemon close |
| `vendor-agent-browser.ps1` | restores the pinned binary and its licence into `bin\agent-browser` |
| `src/browser/allow.js` | the http(s) and local-page checks |
| `src/browser/artifacts.js` | where a project's screenshots live |
| `src/browser/downloads.js` | safe names, collision suffixes, the ASCII bar and byte labels |
| `src/browser/sites.js` | the sites record: add, touch, forget, de-duplicate |
| `src/browser/session-watch.js` | polls the sign-in window; hides it, or waits for the operator to close it |
| `src/browser/signin.js` | address candidates, `looksUnconfirmed`, the visible sign-in flow |
| `src/browser/handoff.js` + `show.ps1` | the window, `-Hide`/`-Focus`, the chime, `stoleFocus` |
| `src/browser/ask.js` | the sign-in card: one request, no auto-allow, no timeout |
| `src/mcp/browser-server.js`, `browser-tools.js` | the tools and their descriptions |
| `web/downloads.js` | the chat's download chip, progress and saved path |
| tests | `browser`, `browser-mcp`, `browser-watch`, `browser-chat`, `browser-downloads`, `browser-agent`, `sites`, `browser-tools`, `browser-search` |

## The description is the help

A model never explores a server: the tool list with its descriptions rides in its
context on every request, so a wrong description is worse than a short one. Two were
wrong (13 Nov) and are now pinned by `tests/browser-tools.test.mjs`: `open` promised a
host list that had been removed, and `handoff` described a minimised window it had
stopped opening when it became a permission card. `snapshot` and the ref-taking `click`
and `type` were pinned on 22 Nov; `handoff` was re-pinned when closing the window became
the Done.

There is deliberately **no `help` tool**: it would be a second copy of the same text,
paid for on every turn, and it would drift the way `handoff` did.
