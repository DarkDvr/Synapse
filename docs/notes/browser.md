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

## The tools (`src/mcp/browser-server.js`)

`open`, `read`, `click`, `type`, `press`, `wait`, `scroll`, `screenshot`, `watch`, `tabs`,
`handoff`, `close`.

- `read` answers the page as a person reads it — headings and text, plus the links that can
  be clicked with their addresses and coordinates. Not HTML: a DOM dump is thousands of
  tokens of markup.
- `watch` records the screencast for a moment and answers a strip of frames, for an
  animation, a spinner, a menu that slides. A still cannot show what changed.
- `screenshot`/`watch` write under `data\browser\shots\` and answer the path, so the model
  can look and the operator can find it.
- The page must be an http(s) address. `file://` is refused: it would be a way around the
  harness's own rules.

Registered in the engine's isolated config only when `browser.enabled` is true — the off
state is the *absence* of the tools, not a tool that refuses. The whole config reaches the
adapter as `ctx.whole` (`src/engines/index.js`) because the switch is the harness's, not
the engine's.

## The hand-off

When a page needs a person (`handoff`, or Settings → Browser → Sign In…), `show.ps1`:

1. moves the window into the second monitor's working area (the primary's, if there is
   only one);
2. shows it — **minimized on the taskbar** for `handoff`, restored for a sign-in;
3. never activates it (`SetWindowPos … SWP_NOACTIVATE`, `SW_SHOWMINNOACTIVE`), and reports
   `stoleFocus` from the foreground handle before and after, measured;
4. blinks the taskbar button and plays one chime;
5. the page shows the toast (`browser-waiting`), so an operator who was away sees why.

**Then nobody has to close anything.** `session-watch.js` polls the page the window is
standing on every two seconds, and when it stops asking to be signed into — no password
box, no sign-in route, loaded — twice in a row, the window is closed and the site is
recorded. The operator looks up, the window is gone and the chat says the session was
kept. Two polls rather than one, because a two-step sign-in hides the password box
between its steps and closing the window in that gap would be sabotage. If they close the
window first, that is an ending, not a sign-in, and nothing is recorded.

The chime has its own switch under **AI screen usage alerts** in General
(`notify.browserSounds`), because it is neither the finished-work sound nor a screen-lease
one.

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
- ✕ forgets a site: the row goes and the browser drops that origin's storage
  (`Storage.clearDataForOrigin`). Deleting is not reading.

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
| `src/browser/cdp.js` | the protocol client (Node's own `WebSocket`, no dependencies) |
| `src/browser/browser.js` | Edge by full path, the flags, the toolset, `clearOrigin` |
| `src/browser/allow.js` | the http(s) check (`hostOf`, `checkUrl`) |
| `src/browser/sites.js` | the sites record: add, touch, forget, de-duplicate |
| `src/browser/signin.js` | address candidates, the confirmation check, the sign-in flow |
| `src/browser/handoff.js` + `show.ps1` | the window, the chime, `stoleFocus` |
| `src/mcp/browser-server.js` | the twelve tools |
| `tests/browser.test.mjs`, `tests/browser-mcp.test.mjs`, `tests/sites.test.mjs` | the fence, the tools against a local page, the server over real stdio, the record |
