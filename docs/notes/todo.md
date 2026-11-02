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

Asked on 2 Nov: a 4pda thread is readable only when signed in, and Synapse could not
read it. The fetch side now says so plainly ("behind the site's bot check
(Cloudflare) … a signed-in browser session would be needed"), so the model can ask
instead of inventing. Making it *work* needs a decision, and the options were
measured on this machine rather than assumed:

| option | status |
|---|---|
| Decrypt the browser's own cookies from Node | **Not possible here.** Edge is the only browser installed (Chrome is not). All 87 cookies in its store are `v20` — Chrome's app-bound encryption — and `app_bound_encrypted_key` will not unwrap for a normal user process (`Key not valid for use in specified state`). The DPAPI path that would work for `v10` blobs is proven in pieces (node:sqlite reads a copy, PowerShell unwraps the key, AES-GCM decrypts a synthetic v10 cookie) but no v10 cookie exists to prove it on. |
| Launch a browser on a copied profile, read cookies over CDP | **Fails.** CDP works with zero dependencies, but Edge launched on three copied profiles returned 0 cookies each time and deleted the copied rows at launch — Chromium drops what it cannot decrypt. |
| A sign-in window inside Synapse (WebView2) | **Viable, not built.** Synapse's own WebView2 profile (`data\webview2\EBWebView`) exists, runs the same Edge 156 engine, and has no app-bound key — so cookies would land in a jar Synapse owns and can reuse *in process* through `CoreWebView2.CookieManager`. The profile is exclusively locked while Synapse runs, so reuse must be in-process; reading the DB from Node will not work. |

The work for the third option: a small WPF sign-in window sharing the app's WebView2
environment, an IPC message that answers "the cookies for this host" (names and
values, never printed to a log), a server route that hands them to `src/fetch.js`,
and a `webfetch` flag that says "use my session". Decision needed: whether that
window is worth it, and whether a cookie is ever sent to a host other than the one it
came from (it must not be — that is a credential leak, not a feature).
