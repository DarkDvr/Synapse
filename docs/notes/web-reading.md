# Reading sites that need a sign-in

`synapse-search_webfetch` (`src/fetch.js`) reads public pages well: GitHub through its
API, X through oEmbed, everything else through a reader. Sites that hide pages from
guests are refused **with the reason** — Reddit's bot challenge, x.com's 403, 4pda's
Cloudflare check — so a model asks the operator instead of inventing an answer.

Getting *past* those walls is where this note lives, because every route was measured
and all but one are dead.

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

## The one route left

**A sign-in window inside Synapse (WebView2).** Synapse's own WebView2 profile
(`data\webview2\EBWebView`) is app-owned, has no app-bound key, and its cookies can be
reused *in process* through `CoreWebView2.CookieManager` — no decryption, no profile
thefts. It needs:

1. a small WPF window sharing the app's WebView2 environment, navigated to the site, so
   the operator signs in once;
2. an IPC message answering "the cookies for this host" (values never logged);
3. a server route that hands them to `src/fetch.js` (which already accepts a `sessions`
   map and follows redirects by hand so a cookie cannot leave its host);
4. a `webfetch` path that says "use my session", or a tool the model can call when a
   fetch comes back walled.

Estimated at about a day. It is deferred, not rejected: the operator said the manual
alternative (pasting a Cookie header into Settings) was too much work, and that editor
was removed in 1.12.0. The storage and the sending rules stayed
(`src/site-sessions.js`, `tests/site-sessions.test.mjs`) because whatever fills that
file must still obey them: a cookie goes to its own host and subdomains, never to a
lookalike, and never across a redirect to another site.
