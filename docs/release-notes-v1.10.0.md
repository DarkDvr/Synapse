# Synapse v1.10.0

The models get a reader: `webfetch`, beside `websearch`, turns a URL into the page's text
instead of its chrome.

## Added

- **`synapse-search_webfetch`** — a second tool on the same MCP server. It reads one page
  and returns clean text, with three routes tried in order:

  | route | what it does |
  |---|---|
  | GitHub adapter | repositories (README + stars/language/licence/topics), issues and pull requests (title, state, labels, body), open-issue lists, and file links through `raw.githubusercontent.com` |
  | X adapter | a post's text through `publish.twitter.com/oembed` |
  | reader | everything else: scripts, styles, navigation, headers, footers and forms removed, `<article>`/`<main>` preferred, prose turned into Markdown (headings, lists, links, code, quotes, tables) |

  The reply names its source (`github:repo`, `x:oembed`, `readability`) and the character
  count, so a report can say where the words came from.

- **It refuses walls instead of returning nothing.** Reddit answers a bot challenge, x.com a
  403, 4pda a Cloudflare interstitial. A model handed an empty page writes a confident report
  about nothing; the error now names the wall and says a signed-in browser session would be
  needed — something the operator can act on.

## Measured

- `github.com/DarkDvr/Synapse` as raw HTML: **302 KB** of markup, 11 KB of text, README buried
  in navigation. Through the adapter: **8.3 KB** of exactly the repository's facts and README,
  in **1.2 s**.
- `en.wikipedia.org/wiki/Readability`: 91 KB of article text in 0.4 s.
- `4pda.to/…showtopic=1050118`: refused in 0.3 s, naming Cloudflare — the same answer
  rendering that page in a real browser gives ("Just a moment…"), so the reader is not the
  limiting factor; the session is.
- A dropped connection at `raw.githubusercontent.com` (one bare "fetch failed", 200 on the next
  call) is why network failures get exactly one quiet retry and answers (403/404) get none.

## Notes

- Nine offline tests: extraction, the three adapters, both wall messages, retry-on-network,
  no-retry-on-answer, truncation — all against fixtures, so the suite needs no network.
- Cookies for signed-in sites are **not** done. The evidence and the three options are in
  `docs/notes/todo.md`; the honest summary is that Edge's cookies are app-bound (`v20`) and
  cannot be read from outside the browser, so a WebView2 sign-in window is the way.
- Full suite: 348 tests.
