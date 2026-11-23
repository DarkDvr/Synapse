# Reading sites that need a sign-in

`synapse-search_webfetch` (`src/fetch.js`) reads public pages well: GitHub through its
API, X through oEmbed, everything else through a reader. Sites that hide pages from
guests are refused **with the reason** — Reddit's bot challenge, x.com's 403, 4pda's
Cloudflare check — so a model asks the operator instead of inventing an answer.

Getting *past* those walls is where this note lives, because every route was measured
and all but one are dead.

## Brave is never touched

Touching Brave — opening a link through the default browser, launching it, reading or
copying its profile — makes it reset itself: extensions uninstalled, cookies gone,
every setting back to default. That has happened more than once, which is why the rule
is absolute.

So Synapse and every agent working on it use **Edge or a headless tool**: open a URL
in Edge by its full path, never `start <url>`; render with
`skills/visual-review/bin/shot.mjs`, which drives Edge headless in a throwaway
profile; never read, copy, move, clean or delete anything under
`%LOCALAPPDATA%\BraveSoftware` or `%APPDATA%\BraveSoftware`. `src/permissions.js`
treats those folders as credential stores, and `src/index.js` opens Edge by path or
not at all.

## Dead ends, with the evidence

| route | what happened |
|---|---|
| read the browser's cookie file from Node | Edge's cookies are `v20`, bound to the app; the key will not unwrap for a normal process, and Brave's store is locked while Brave runs |
| copy the profile, launch a browser on it, read cookies over CDP | **zero cookies** — Chromium deletes rows it cannot decrypt when it opens a copied profile |
| launch the browser on the real profile with `--remote-debugging-port` | refused: it requires a non-default data directory |
| the same through a directory junction | the debugger opened, read **0** cookies, and **emptied the real profile's store** — 87 rows to 0 |

**Do not launch a browser on the operator's real profile to "just read" something.**
It does not merely fail; it destroys. That was paid for once, on 2 Nov.

## The route we took

**SynaBrowse**: the harness's own WebView2 browser with its own profile
(`data\browser\webview2`). A site is signed into once, by the operator, in a window the
`handoff` tool puts on their monitor; the profile keeps the session for every later
run. No cookie is read, copied or exported — the browser already has it, and the page
is read through the browser. `docs/notes/browser.md` is the reference;
`src/site-sessions.js` and its tests stay because the old webfetch session map obeys
the same host rules.
