# SynaBrowse — the invisible browser (1.38)

> **Superseded, in part.** The hand-off described here — a window that appears minimized on the
> second monitor — became a **permission card** in 1.49.0: the model asks, the operator allows,
> and only then does a normal window open on their monitor. The measurements below still hold,
> and `docs/notes/browser.md` is the reference for how it works now.

Synapse gets a browser of its own: running hidden, signed in where the operator is, able
to read a page, click, type, take a screenshot and watch an animation — without touching
their Edge, their mouse or their keyboard. When it cannot do something alone, one small
window appears and says what it needs; the model waits. You see the window and nothing
else.

Decided with the operator, 11 Nov 2026:

- **A Synapse-owned browser profile**, not the operator's Edge. One profile, global
  across every project (`data\browser\profile`), so a site is signed into once and every
  project inherits the session. The live Edge profile is *not* used: it can only be used
  from inside Edge (visible windows), and copying or attaching to it destroyed cookies
  on 2 Nov. This is the trade: sign in once, be invisible afterwards.
  **The operator never uses Edge** — Brave and Firefox are theirs, and untouchable (rule
  9) — so the harness's Edge is nobody's but the harness's: no interference is possible.
- **Headed but off-screen** by default — a real browser, which is Cloudflare's best
  case — positioned off the desktop and never activated. `--headless=new` stays for
  renders, where nothing needs to pass a bot check.
- **No extension required.** The browser is driven over CDP. The client already exists:
  `skills/visual-review/bin/shot.mjs` speaks CDP with Node's own `WebSocket`, no
  dependencies, and has been rendering every audit in this project.
- **The hand-off is a minimized window and a chime**, and only when a human is genuinely
  needed: a login, a bot check, a "which of these did you mean". It is moved into the
  second monitor's place, **shown minimized on the taskbar**, its button blinked, and one
  chime played — it never takes focus, so it can wait for as long as the operator is busy.

## What it looks like in use

The Architect, mid-task: *"Check whether the modlist page lists the new version."* The
model calls `open` on nexusmods.com. Nothing appears. It reads the page, returns a compact
outline and a screenshot. If the site asks for a sign-in, the browser appears **minimized
on the second monitor's taskbar**, one chime plays, and the page's notice line says
SynaBrowse is waiting. The model's tool call waits. The operator restores the window when
they are ready, signs in, and the run continues; the session is kept for next time.

## Architecture

```
┌──────────────┐   MCP (stdio)   ┌──────────────────┐   CDP (WebSocket)   ┌──────────────┐
│ engine/roles │ ──────────────► │ src/mcp/          │ ──────────────────► │ Edge, hidden │
│              │                 │ browser-server.js │                     │ data\browser │
└──────────────┘                 └──────────────────┘                     └──────────────┘
                                        │  hand-off (blocking)
                                        ▼
                                 POST /api/browser/handoff  ──►  the one small window
```

1. **`src/browser/lifecycle.js`** — find Edge by its full path (never Brave, never by
   name), launch it with the dedicated profile, wait for `/json/version`, attach, keep
   it warm for ten idle minutes, reap on shutdown. Launch flags: `--user-data-dir`,
   `--window-position=-32000,-32000`, `--window-size=1280,800`, `--no-first-run`,
   `--no-default-browser-check`, `--disable-session-crashed-bubble`.
2. **`src/browser/cdp.js`** — the CDP client lifted out of `shot.mjs` (send, subscribe,
   wait-for-event), shared by the renderer and the browser so there is one
   implementation of the protocol.
3. **`src/mcp/browser-server.js`** — the tools, registered next to `synapse-search`,
   `synapse-delegate` and `synapse-lease` in the engine's isolated config:
   `open`, `navigate`, `read`, `click`, `type`, `press`, `wait`, `scroll`,
   `screenshot` (viewport and full page), `watch` (frames), `back`/`forward`, `tabs`,
   `close`. Every tool answers with a compact outline, never a DOM dump.
4. **Hand-off** — `POST /api/browser/handoff` puts that window on screen (secondary
   monitor when one exists), sets the header to what is wanted, chimes, and *does not*
   steal focus. The tool call blocks until the page reports the signal (a cookie, a
   navigation, a selector) or the operator presses Done.
5. **Settings → Browser** — enable, the profile's location, "Sign in to a site…", the
   allowlist, and a per-project arm switch. Unarmed, the tools are not offered to a model
   at all.
6. **Audit** — every call lands in `tools.log` with its URL and action; screenshots go to
   the project's `.synapse/shots/`.

## Abilities, and the honest limits

| wanted | how | limit |
|---|---|---|
| screenshots | `Page.captureScreenshot`, viewport and full page | a still cannot show movement |
| clicking | `Input.dispatchMouseEvent` at coordinates from a selector or a snapshot ref | no physical cursor, no focus needed |
| typing | `Input.insertText` + key events for Enter/Tab/Escape | — |
| animations | `Page.startScreencast` frames, timestamped; the model gets a strip of 3–6 | a strip is evidence, not a video |
| bot checks | headed, off-screen, real browser | a managed challenge may still refuse; then hand off |
| logins | the operator signs in once in the hand-off window | the session is the harness's, not Edge's |
| reading | visible text + links as a compact outline | not a DOM dump, not a script runner |

**No `eval` tool.** The model gets a fixed set of operations, not a scripting runtime in
the operator's browser.

## Security and consent

- The profile is the harness's own; **no cookie is ever read, exported or copied**, and
  the operator's Edge profile is never opened, copied or attached to.
- Loopback only, random port, a token in `data\browser-token`, and no route that takes a
  path or a command from a model.
- The **allowlist** is the fence: a site the operator has not added is refused with a
  sentence, not a card. Banking, webmail and anything they name stay off it.
- The hand-off window **never takes focus** (no `SetForegroundWindow`), so a run cannot
  interrupt what the operator is doing. A chime says it is waiting.
- One kill switch: stop the browser, end the hand-off, arm nothing.

## Stages, each shippable

| # | what | effort | state |
|---|---|---|---|
| 0 | **Proof.** Hidden profile, open nexusmods.com, read it, screenshot it, click one thing, screencast a CSS animation; show the frames and timings | half a day | **done** |
| 1 | **Tools.** The server, the lifecycle, the eight tools, offline tests against local pages | one day | **done** (`src/browser/`, `src/mcp/browser-server.js`) |
| 2 | **Hand-off.** The window, the chime, the secondary monitor, minimized on the taskbar, no focus steal | half a day | **done** (`src/browser/handoff.js`, `show.ps1`) |
| 3 | **Settings and arming.** Enable, the Sites table (a record, not a list), sign-in in the table's last row, confirmation before a row is written | half a day | **done** (1.40–1.42) |
| 4 | **Notes.** `docs/notes/browser.md`, the AGENTS row, the what-we-are-changing row | an hour | **done** |

**What stage 1 and 2 shipped.** `src/browser/cdp.js` (the protocol client, shared with the
renderer's ancestor in `shot.mjs`), `src/browser/browser.js` (Edge by full path, the hidden
flags, the settle-and-read toolset), `src/browser/allow.js` (the host fence),
`src/browser/handoff.js` + `show.ps1` (the minimized window and the chime), and
`src/mcp/browser-server.js` (the twelve tools). The engine registers it only when
`browser.enabled` is true, so the off state is the *absence* of the tools rather than a
refusal. Three test files' worth of proof: the allowlist as a rule, the tools driving a
local page, and the server answering real JSON-RPC over stdio.

## Risks

- **Cloudflare may still refuse** an automated browser, headed or not. The hand-off is
  the answer, and it is one click for the operator, not a redesign.
- **A hidden browser costs RAM** (~300 MB). Start it on demand and reap it after ten idle
  minutes; never start it at boot.
- **The Edge path changes** with updates — the renderer already derives it; reuse that.
- **Two environments, two sets of logins.** A site signed in on Edge is not signed in
  here until the operator does it once. That is the price of invisibility, stated plainly.
- **The profile can break** (an Edge upgrade, a crashed write). Recreate it; never copy
  Edge's.

## Out of scope, deliberately

Reading or importing cookies. Driving the operator's own Edge windows. Buying, posting or
deleting without an armed allowlist entry. Recording video (frames are enough). A second
automation framework: this is CDP and nothing else.

---

## Stage 0 — the proof, measured (11 Nov 2026)

A throwaway script (kept out of the repo), Edge 157.0.4341.46, a brand-new profile at
`data\browser\profile`, Nexus Mods as the target. What it found, and the three things the
implementation must carry because of it:

**A hidden real browser gets past Cloudflare; a headless one never does.**

| mode | result |
|---|---|
| headed, off-screen (`--window-position=-32000,-32000`) | **cleared in 2.6 s**, home page loaded |
| headed, on-screen | 14 s, then Nexus's own "Something went wrong." page |
| `--headless=new` | never cleared, 30 s |

The flag that decided it was **`--disable-blink-features=AutomationControlled`**. Without
it, the same hidden window sat on "Verifying…" for ever. The throttling flags matter too
(`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`,
`--disable-renderer-backgrounding`, `--disable-features=…CalculateNativeWinOcclusion`): a
hidden window is a background window, and a challenge that runs on a timer needs its
timers.

**The rest of the mechanics work.** 2,280 characters of the real page read back as text;
a click at the coordinates of "Browse all mods" (549, 294) navigated to `/mods`; 52
screencast frames arrived in 1.06 s (about 16 ms apart), a strip of a CSS animation rather
than a still. The browser was closed and nothing was left running; the profile is 92 MB
and keeps its cookies for next time.

**The open question is depth, not the challenge.** `/` loads; `/mods` and `/games` both
return Nexus's generic error page — with no Cloudflare interstitial — for this session. A
plain HTTP fetch is refused with 403 on every route, so the hidden browser is already
doing better than `webfetch`; what is left is whether a **signed-in session** clears those
routes. That is exactly what the hand-off window is for, so stage 2 moves up: sign in once
in the hidden browser, then re-test the depth.

### Stage 2 — the hand-off, proved (11 Nov 2026)

The window went to the secondary monitor, the operator signed in once, and the depth
question answered itself:

- **Placement**: `DISPLAY2`, `(685, −990)`, `1200×860`, visible — and the *show step* did
  not change the foreground window (`fgBefore == fgAfter`), so presenting the window does
  not steal focus.
- **Sign-in took 5.2 minutes**, once, in a window the operator could use. Nothing was
  copied and no cookie was read: the session lives in the profile, which grew to 500 MB
  with it.
- **Depth is a login question**: `https://www.nexusmods.com/games/skyrimspecialedition/mods`
  now loads as *"Skyrim Special Edition Mods"* with the authenticated header (avatar,
  messages, Upload). The same route returned "Something went wrong." for an anonymous
  session an hour earlier.

**One flaw to fix in the product**, found by measuring instead of trusting: the *launch*
can take the foreground even though the show step does not — `show.ps1` saw our own window
already in front when it measured. The fix is to capture the foreground handle **before**
spawning the browser and restore it after, and to start the browser minimized until the
hand-off actually needs it. The operator's rule stands: a run may never interrupt what they
are doing.

