# Reading sites that need a sign-in

`synapse-search_webfetch` (`src/fetch.js`) reads public pages well: GitHub through its
API, X through oEmbed, everything else through a reader. Sites that hide pages from
guests are refused **with the reason** — Reddit's bot challenge, x.com's 403, 4pda's
Cloudflare check — so a model asks the operator instead of inventing an answer.

Getting *past* those walls is where this note lives, because every route was measured
and all but one are dead.

## Brave is never touched

Brave is the operator's browser and this machine's default. Touching it — opening a
link through the default browser, launching it, reading or copying its profile —
makes it reset itself: extensions uninstalled, cookies gone, every setting back to
default. That has happened more than once, which is why the rule is absolute.

So Synapse and every agent working on it use **Edge or a headless tool**:

- open a URL in Edge by its full path; never `start <url>`, which is the default browser;
- render pages with `skills/visual-review/bin/shot.mjs`, which drives Edge headless
  in a throwaway profile under the temp folder;
- never read, copy, move, clean or delete anything under
  `%LOCALAPPDATA%\BraveSoftware` or `%APPDATA%\BraveSoftware`;
- `src/permissions.js` treats those folders as credential stores, so a model's read,
  write or command there is denied, and `src/index.js` opens Edge by path or not at all.

The cookie routes below are why a profile is never opened "just to read" something,
and Brave is the one browser where even that excuse is refused.

## Dead ends, with the evidence (2 Nov)

| route | what happened |
|---|---|
| Read the browser's cookie file from Node | Edge's cookies are `v20` (app-bound encryption); `app_bound_encrypted_key` will not unwrap for a normal process (`Key not valid for use in specified state`). Brave's store is locked while Brave runs, so even a copy fails. The DPAPI path that decrypts older `v10` cookies works in pieces, but there is no `v10` cookie here to prove it on. |
| Copy the profile, launch a browser on it, read cookies over CDP | **Zero cookies.** Chromium deletes rows it cannot decrypt when it opens a copied profile — the 87 rows plus a planted synthetic one were gone at launch. |
| Launch the browser on the real profile with `--remote-debugging-port` | **Refused:** "DevTools remote debugging requires a non-default data directory." |
| The same through a directory junction (path is not the default, files are the real profile) | The debugger opened, read **0 cookies**, and **emptied the real profile's cookie store** — 87 rows to 0, no WAL to recover from. |

**Do not launch a browser on the operator's real profile to "just read" something.** It
does not merely fail; it destroys. That cost was paid once, on 2 Nov, and the operator
had to sign in to Edge sites again.

## The route we took (Nov 2026)

Not WebView2 cookies: **SynaBrowse**, the harness's own hidden Edge with its own
profile (`data\browser\profile`). A site is signed into once, by the operator, in
a window the `handoff` tool puts on their monitor; the profile keeps the session
for every later run. No cookie is read, copied or exported — the browser already
has it, and the page is read through the browser. `docs/notes/browser.md` is the
reference; `src/site-sessions.js` and its tests stay because the old webfetch
session map still obeys the same host rules.
