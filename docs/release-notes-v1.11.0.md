# Synapse v1.11.0

Sites that hide their pages from guests can be read, with a sign-in you paste once.

## Added

- **Settings → General → Sites That Need a Sign-In.** One line per site:

  ```
  4pda.to = bb_session=…; bb_userid=…
  ```

  Copy the `Cookie` request header from your browser (DevTools → Network → the page
  request → Request Headers) while signed in to that site, paste it, press **Save
  Sessions**. `synapse-search_webfetch` then sends it when it reads that site, and the
  page comes back as prose like any other.

- **The rules are the feature, not the field.** The cookie is stored in
  `data\site-sessions.json` (gitignored, never written to a log), sent only to the host
  it was saved for or its subdomains — never to a lookalike (`not4pda.to`), never to
  another site — and redirects are followed by hand so the header cannot hop domains.
  A LAN view of Settings sees the host names and sizes, never the values, and cannot
  blank them by saving an empty box.

## Measured

- End to end on `httpbin.org/cookies`, which echoes request cookies: saved
  `httpbin.org` in the pane, called `webfetch` through the MCP server, and the reply
  contained `{"synapse_test": "1"}` — the cookie reached the site through the tool.
- A redirect to `evil.test` is refused before the second request, and the other site is
  never contacted; a same-host redirect is followed with the cookie intact.
- 8 tests: host validation, the first-`=` split that keeps a Cookie header whole,
  subdomain matching without lookalikes, the file round-trip, LAN masking, cookie
  sending, the still-walled message, and both redirect cases.

## Notes

- This is the light option, deliberately. Reading the browser's own cookies is not
  possible on this machine (Edge's are `v20` app-bound; Brave's store is locked while
  it runs), and the full fix — a WebView2 sign-in window — is about a day of work and
  remains in `docs/notes/todo.md` with its evidence.
- Two honest limits, stated in the pane: a session expires and needs re-pasting, and
  Cloudflare may tie the cookie to your browser's User-Agent, which Synapse cannot
  match exactly.
- Full suite: 356 tests.
