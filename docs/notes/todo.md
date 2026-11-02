# TODO — things the operator asked to leave for later

Written down on 27 Oct so they are not lost, not designed yet. Each entry says
what was asked, why it is not a small change, and what has to be decided before
anyone builds it. None of these is a rule; the rules are in `AGENTS.md` and the
other notes.

## Russian interface

Asked for on 2 Nov, deferred by the operator on 2 Nov ("moves to a TODO list until
further notice"). The selector is already in Settings → General, holding English
alone, and `src/config.js` accepts `en` only (`UI_LANGUAGES`), so a hand-edited
`"language": "ru"` falls back instead of asking the page for strings that do not
exist. The selector is a place for the translation to land, not a switch that
pretends to work.

What it needs, in the order it has to be decided:

- **Scope.** Every user-facing string in `web/app.js` is written inline — several
  thousand literals, plus composed sentences. Translation means a string table and a
  `t()` call around each one, which is a mechanical pass over a 9,000-line file, and
  this project has no build step by rule (AGENTS #1). The decision is whether the
  whole interface is in scope, or Settings and the shell first.
- **Plurals.** The interface is full of counts ("3 file(s) read, 2 waiting"). Russian
  has three plural forms, so a naive `${n} files` breaks the moment it is translated
  properly. The string table needs a plural form, not just a map.
- **What must never be translated:** model output (it answers in the language it is
  written to), project names, log and console lines, and the briefs in
  `src/plans.js` — those are sent to the engine, and a rule in Russian is a rule the
  next model may not read as well.
- **One word per concept.** The briefs and the UI share vocabulary — `plan`, `run`,
  `task`, `role`, `report`. A translation has to pick one Russian word for each and
  keep it, or the interface and the briefs describe the same thing differently.
- **A test that proves it.** The guard should be the shape of
  `tests/chat-text.test.mjs`: in Russian mode, no English literal may reach the
  screen. That needs the string table to be the only source, which is another reason
  the mechanical pass comes first.

Nothing else is outstanding as of 2 Nov. The last two — the working wash/border light
and the worker-session replacement — are built and recorded in
`docs/notes/ui-lessons.md` and `docs/notes/engine-notes.md`.

## Signed-in web reading (cookies)

**Shipped in 1.11.0: the light option.** Settings → General → *Sites That Need a
Sign-In* takes one line per site, `host = the Cookie header from DevTools`. It is
stored in `data\site-sessions.json` (gitignored, never logged), sent only to that
host or its subdomains, and hand-followed across redirects so it cannot travel to a
different site; a LAN view sees the host names but never the values. Measured end to
end on `httpbin.org/cookies`, which echoed the saved cookie back through
`synapse-search_webfetch`.

**Still deferred: the full solution**, which would not need a paste. Asked 2 Nov: a
4pda thread is readable only when signed in. The options were measured on this
machine rather than assumed:

| option | status |
|---|---|
| Decrypt the browser's own cookies from Node | **Not possible here.** Edge is the only browser besides Brave; all 87 Edge cookies are `v20` (app-bound) and `app_bound_encrypted_key` will not unwrap for a normal process. Brave's store is locked while Brave runs — a copy fails outright. The DPAPI path that would work for `v10` blobs is proven in pieces but there is no `v10` cookie to prove it on. |
| Launch a browser on a copied profile, read cookies over CDP | **Fails.** Edge launched on three copied profiles returned 0 cookies and deleted the copied rows — Chromium drops what it cannot decrypt. |
| A sign-in window inside Synapse (WebView2) | **The real fix, ~a day.** Synapse's own WebView2 profile has no app-bound key, so cookies would land in a jar Synapse owns and can reuse *in process* via `CoreWebView2.CookieManager`. It needs a window, IPC, a server route and a "use my session" flag. |

Two limits of the shipped option, both stated in the pane: a session expires and must
be re-pasted, and Cloudflare may tie the cookie to your browser's User-Agent, which
Synapse cannot match exactly.
