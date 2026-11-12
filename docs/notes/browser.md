# SynaBrowse — the harness's own browser

A browser Synapse owns, on its own profile, driven over the Chrome DevTools Protocol.
Models get it as twelve tools; the operator sees one window, only when a person is
genuinely needed. This note is the "why" behind `src/browser/` and
`src/mcp/browser-server.js`; the plan and the measurements that produced it are in
`docs/plan-synabrowse.md`.

## Why a browser at all

`webfetch` reads public pages and nothing else. Two walls it cannot pass, both measured:

- **Cloudflare's interstitial.** `webfetch` gets the "Just a moment…" page. A *headed*
  Edge clears it; `--headless=new` never does, however long it waits.
- **A sign-in.** A deep route on a logged-in site answers "Something went wrong." until
  the profile has the session. Nothing in `webfetch` can create one.

The measurements, 11 Nov, same machine: hidden headed Edge cleared the challenge in
**2.6 s**; on screen it took 14 s and then showed an error page; headless never cleared it
in 30 s. That is the whole reason the browser is headed and off-screen rather than
headless.

## The profile

`data\browser\profile` — one per installation, global across projects, in `data/` so it is
never committed. **Never** the operator's Edge profile, and never Brave (rule 9). The
session lives in the profile because the browser is the thing using it; nothing is copied,
and no cookie is ever read, exported or logged.

A profile cannot be open twice, so `createBrowser()` attaches to an existing instance when
one is running (`DevToolsActivePort` + a live `/json/version`), and is idempotent under
concurrent callers.

## The launch, flag by flag (`src/browser/browser.js`)

| flag | why |
|---|---|
| `--disable-blink-features=AutomationControlled` | the one that decides the Cloudflare result: without it the page sits on "Verifying…" for ever |
| `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` | a hidden window is a background window; without these its timers are throttled and its frames stop, and a JavaScript challenge never finishes |
| `--disable-features=CalculateNativeWinOcclusion` | stops Windows deciding the off-screen window is occluded and suspending it |
| `--window-position=-32000,-32000` | off the desktop, not on a monitor |
| `--start-minimized` | a launch must not take the foreground; the hand-off decides when the window is shown |
| `--remote-debugging-port=0` + `--user-data-dir` | the port is written into the profile, so no port is chosen by hand |

The window is found again by the command line naming that profile — never by process name.

## The launch is quiet, and the window does not flash

- **No unsupported-flag bar.** `--disable-blink-features=AutomationControlled` makes Chromium
  print "You're using an unsupported command-line flag…" across the top of the page. It was
  in a screenshot the operator sent. `--test-type` suppresses the bar; the profile is a
  disposable automation profile, so the trade is right.
- **Focus comes back within the second.** The launch restores the operator's window as soon
  as the process exists, not when the debugging port opens, so the caret does not leave for
  the two seconds an Edge start takes.
- **No visible flash.** The hand-off used to restore the window, move it and minimize it
  again — a window that appeared and vanished. It now moves only when the window is not
  already inside the target monitor, and the launch already places it there, so the common
  path is one call: minimize.

## The tools (`src/mcp/browser-server.js`)

`open`, `read`, `click`, `type`, `press`, `wait`, `scroll`, `screenshot`, `watch`, `tabs`,
`handoff`, `close`.

- `read` answers the page as a person reads it — headings and text, plus the links that can
  be clicked with their addresses and coordinates. Not HTML: a DOM dump is thousands of
  tokens of markup.
- `watch` records the screencast for a moment and answers a strip of frames, for an
  animation, a spinner, a menu that slides. A still cannot show what changed.
- `screenshot`/`watch` write into the **project** (`<project>\.synapse\browser\shots\`) and answer
  the absolute path *and* the project-relative one the chat can render, so the model
  shows a picture without copying it.
- The page must be an http(s) address. `file://` is refused: it would be a way around the
  harness's own rules.

Registered in the engine's isolated config only when `browser.enabled` is true — the off
state is the *absence* of the tools, not a tool that refuses. The whole config reaches the
adapter as `ctx.whole` (`src/engines/index.js`) because the switch is the harness's, not
the engine's.

## The hand-off is a permission

A page that needs a login is not a window that appears — it is a **question**. The browser
works behind the scenes; when a page is a wall, the model calls `handoff`, and the harness
raises the same card the screen lease uses: **Allow Sign-In**, Reject, Reject With Reason,
Stop Run. There is no auto-allow, and there is no timeout: the card waits for the operator,
and the run's stall clock is suspended while it does (the wait is theirs, not the model's).

Only an Allow opens a window, and then it is an ordinary window:

- normal and focused, on the monitor the operator is looking at (the monitor of the window
  that had the foreground when they clicked), because they asked for it;
- loading that site, with **no time limit** — they can fetch a password from a manager, walk
  away, come back;
- watched in the background: when the page stops asking to be signed into — no password
  box, no sign-in route, loaded, twice in a row — the window is hidden, the site is
  recorded, and the tool call answers "signed in";
- if they close it without a session, that is a Reject: the tool answers so, and the model
  carries on without the site.

The two hollow knocks play when the card appears, so an operator looking elsewhere looks up.
Nothing is minimized for a sign-in, and nothing takes the foreground uninvited.

## Being invisible, exactly

A hidden browser must be invisible *and* still render, and those two pull apart:

- **The hide starts before the browser is ready.** `show.ps1 -Hide -WaitMs` is started the moment
the process exists and grabs the window within 40 ms of its creation, so the button is not
there for the second or two a DevTools handshake takes. Edge creates that first window only
when it is ready, so a sub-second button can still be seen on a cold start — the window
itself never appears.
- **No taskbar button, no Alt-Tab.** The window is given `WS_EX_TOOLWINDOW` and loses
  `WS_EX_APPWINDOW` (`show.ps1 -Hide`). Without it, a window parked off-screen still puts a
  button on the taskbar, and clicking that button focuses a window nobody can see — which is
  what the operator met (12 Nov).
- **Off-screen and normal, never minimized.** A minimized Chromium window stops compositing,
  so `Page.captureScreenshot` never answers; off-screen, it is invisible and still renders.
  Measured both ways: minimized → no answer in 15 s; off-screen → 55 ms.
- **No "Restore pages" bubble.** Edge shows it as a window of its own at the top-left of the
  primary after a kill, and it was mistaken for ours. `--hide-crash-restore-bubble` and
  `--disable-session-crashed-bubble` suppress it, and the window search ignores it by title.
- **A sign-in window is the exception.** On Allow the tool-window bit is cleared, the window
  is placed on the monitor the operator is looking at, restored, and brought forward with the
  attach-to-foreground-thread trick — because they asked for it and are about to type. After
  the session lands it is hidden again.

## Sites: a record, not a permission list

`src/browser/sites.js`, shown as the **Signed In** table in Settings → Browser.

- There is no host allowlist. The master switch is the fence; the table says which hosts
  the profile has sessions for.
- **The table's last row is the form**: type an address, press `Sign In…` (or Enter).
- A typed address is not validated: a browser resolves `example.test` or a LAN address;
  the harness only chooses the scheme to try first (https, then http).
- The row is written **only after the operator closes the window and the address is opened
  once more, hidden**. `looksUnconfirmed()` refuses it when the page still has a password
  box or sits on a sign-in route; nothing is added and the toast says why.
- A confirmed row keeps the address it was confirmed at, and shows ages, not countdowns:
  when a session expires is the site's decision.
- ✕ forgets a site: the row goes and the browser drops that site's cookies **and its
  storage**. The parent domain matters: measured 11 Nov, clearing the origin
  `www.reddit.com` left seven cookies on `.reddit.com`, so the operator stayed signed in
  after deleting the row. Cookies are listed by name and domain to delete them; a value is
  never stored, logged or returned.

The sign-in button says what it is doing: **Opening…** while the browser starts, then
**Saving…** while the address is checked, both breathing (`waiting-breathe`).

## What a model receives

- **The article, not the page.** `read` scores the DOM for the element that carries
  paragraphs and little link furniture, then emits Markdown-ish lines — headings, list
  items, quotes, code. A nav or a footer is dropped. `mode: "text"` keeps the whole page
  for the rare site the picker gets wrong.
- **A sign-in wall, named.** A page with a password box, or a form that says sign in,
  comes back with a sentence: *"This page needs a sign-in only the operator can give (a
  password box), and <host> is not in the Signed In table. Call `handoff` …"* — and if
  the host *is* in the table, the sentence says the session has expired instead. The
  model does not have to infer it from the prose, and does not scrape around a login.
- **One card per intention.** Consecutive browser calls fold into a single card
  ("SynaBrowse · 3 calls") with the calls listed inside, because a sign-in is open → read →
  handoff → read and four full cards read as four things happening (11 Nov).
- **A line in the brief.** When the switch is on, every role's brief says the browser
  tools reach pages `webfetch` cannot, and that a wall needs `handoff`. Without it the
  brief points at `webfetch` and the tools go unread — a tool a model does not know it
  has is a tool that does not exist.

## Project artifacts, not a shared folder

The engine gives each project's MCP server that project's folder as its working directory —
measured 11 Nov, the server for `test` starts with cwd `F:\dev\Synapse.Projects\test`.
So screenshots and frame strips go to `<project>\.synapse\browser\shots\`:

- they are deleted with the project, and picked up by the project's own cleanup;
- two projects browsing the same site keep their own pictures;
- nothing under the harness has to be forgiven — `src/browser/artifacts.js` decides, and the
  harness folder is only the fallback for a server whose cwd is not a project (the projects
  root, which is the "all projects" context). That fallback is why
  `data\browser\shots\` stays on the read exceptions.

## RAM

The browser is ~300 MB of the operator's RAM while it runs, and a local model lives in
the same memory. Three rules keep that honest:

- it starts on demand and never at boot;
- it is closed after `idleMinutes` (default 5, Settings → Browser) with no tool call —
  the profile keeps every session, so the next call pays a launch, not a login;
- the text it returns is the article, not the page, so what it spends is content: tokens
  in the model's context are memory too.
## When the page is gone

Every protocol request answers or fails within 60 seconds — a minute, because fetching a password from a manager takes one — and `start()` checks that the
page it holds is still alive before using it. Both were added after a real wound: the
operator signed in, closed the hand-off window, and the next `read` sat on a half-open
socket for seven minutes — the tool never returned, the model never spoke, and the run
was stopped twice (11 Nov). A closed window is now a browser to open again, and a
refusing one is an error the model can report.

## Limits, stated

- **Expiry is the site's.** The table shows when a session was made, never "good for N
  days"; the harness cannot know and will not invent it.
- **Confirmation is a page check, not a proof.** A site that renders a sign-in form
  without a password input can pass it. It catches the common case: you were sent back to
  the login page.
- **The profile can break** (an Edge upgrade, a crashed write). Recreate it; never copy
  Edge's.
- **A hidden browser costs RAM** (~300 MB). It starts on demand and is not started at boot.
- **Nothing here reads a cookie.** Not for the table, not for "validate", not for a
  fallback.

## Where things live

| | |
|---|---|
| `src/browser/cdp.js` | the protocol client: requests that answer or fail in 60 s, events, evaluate, screenshot |
| `src/browser/browser.js` | Edge by full path, the launch flags, the toolset, `clearSite`, the idle reaper |
| `src/browser/allow.js` | the http(s) check (`hostOf`, `checkUrl`) |
| `src/browser/artifacts.js` | where a project's screenshots live (`<project>\.synapse\browser\shots`, with the harness folder as the fallback) |
| `src/browser/sites.js` | the sites record: add, touch, forget, de-duplicate |
| `src/browser/session-watch.js` | polls the sign-in window and **hides** it when the session lands |
| `src/browser/signin.js` | address candidates, `looksUnconfirmed`, the sign-in flow |
| `src/browser/handoff.js` + `show.ps1` | the window, `-Hide`/`-Focus`, the chime, `stoleFocus` |
| `src/browser/ask.js` | the sign-in card: one request, no auto-allow, no timeout |
| `src/browser/screen.ps1` | which monitor the operator is on, and the attach-thread focus |
| `src/mcp/browser-server.js` | the twelve tools, the wall sentence, and `handoff` asking through the permission card |
| `tests/browser.test.mjs`, `tests/browser-mcp.test.mjs`, `tests/browser-watch.test.mjs`, `tests/browser-chat.test.mjs`, `tests/sites.test.mjs` | the fence, the tools against a local page, the server over real stdio, the watcher, the chat labels, the record |

**A page cut in silence is a page the model thinks it has (13 Nov).** Two models were benched
against the same long Reddit thread. Both were handed 6,000 characters of it and neither was
told: the tool's `outline` cut the text at 6,000 whatever `maxChars` said, and a cut left no
mark. The page now reports its own length (`total`), the tool honours `maxChars` and `links`,
and a cut ends with `[… truncated: 6,000 of 41,210 characters. Ask again with a larger maxChars
(up to 30000), or scroll and read again for the rest.]` — the size of what is missing, and the
two ways to get it.

The same run showed the browser's window in the taskbar. The hide was applied on launch and
not on **attach**, so a browser that outlived a Synapse restart kept an app-window bit; it is
re-hidden every time `start()` finds one running.