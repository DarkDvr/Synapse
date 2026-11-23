# Web search — the engines, the walls, and SynaBrowse

`synapse-search_websearch` is the model's search tool. It is not one scraper: it is
a small stack, because the engines change their answer to an HTTP client without
changing their answer to a browser.

## The lesson that built the stack (23 Nov 2026)

The test project's Architect ran seven searches. The first two or three returned
results; then every one failed with `no results`. The raw answer was **HTTP 202**
with a 15 KB anti-bot page and zero result links. DuckDuckGo was not saying "no
such page"; it was refusing the IP for a few minutes.

The old `src/search.js` treated 202 as a normal response, parsed no results,
retried DuckDuckGo HTML and Lite twice, and reported "no results". The retry made
the penalty longer. A wall is now **named**, the engine is cooled down for five
minutes, and the next path gets the query.

## The order

1. **A warm search browser** — the separate off-screen SynaBrowse host described
   below. Measured in the live test: about **1 s** for ten result cards. It cannot be
   HTTP-202'd because it is the real page with a real profile.
2. **DuckDuckGo HTML**, then **Lite** — about 0.7–1.3 s when it is not blocked.
3. **Bing HTML** — a second index; about 1–2 s when it answers.
4. **A cold search browser** — only after the HTTP engines are walled. A simple query
   does not pay for a browser launch nobody needed.

`auto` is the only path a model sees. Engine selection is a harness decision; the tool
schema has no engine argument.

## How the browser search works

`src/browser/search.js` runs its own **off-screen SynaBrowse host**, with its own
profile (`data\browser\search`), and drives its one page to DuckDuckGo. It reads
`article[data-testid=result]`, then navigates the same page to DuckDuckGo Lite or Bing
if needed. It never creates a tab or a window, never touches the main browser's page,
never reads a cookie, and runs only a fixed extraction expression.

- **No `Target.createTarget`.** WebView2 treats a CDP target as a real top-level window;
  that call put the search results on the operator's screen for a second (live flash,
  23 Nov). The search host keeps one page and `Page.navigate`s it.
- The host window is created at `-32000,-32000`, `ShowInTaskbar=false`, like the main
  browser's off-screen window. Nothing it shows is on the operator's desktop.
- A second session starting at the same moment is not allowed to race the profile:
  `search-state.json.launch` is a lock, and the loser waits for the winner's port.
- A ready state with a dead port is cleaned up by the pid it names, never by a
  process name.
- The host is left running for the next search and closed after the configured idle
  time (default five minutes). Search never stops the main browser.
- `src/search.js` holds a **serial queue**: two model searches never run at once. A
  burst becomes a short line of searches instead of a rate-limit trigger. The
  per-search ceiling is 15 s, so even a queue of a few queries is measured in seconds,
  not minutes.

The engine order inside the browser is DuckDuckGo rendered → DuckDuckGo Lite → Bing.
Each gets a few seconds; the total stays under the tool's timeout.

## Cache, cooldown and provenance

- A successful query is cached for ten minutes. The model sees
  `(cached from an earlier search, at most 10 minutes old)` and **not** the old
  search's elapsed time. A live test reported a 12 s fallback for a 173 ms cache hit
  because the header still carried the original number.
- A 202, 429 or a challenge page cools that engine for five minutes. A network
  failure does not — it is retried (one retry) and then the next engine is tried.
- The header names the path that answered: `via DuckDuckGo`, `via Bing`, or
  `via DuckDuckGo (SynaBrowse)`. `attempts` carries the reasons the others gave.

## What still does not work

- **The Edge test fallback** cannot drive the search fallback. The WebView2 host is
  the one that has a state file and a port the search can attach to; the Edge path
  exists only for the suite and uses a fixed test profile.
- A search engine can still decide a browser is a bot. The next engine is the answer;
  the tool reports the wall rather than pretending it found nothing.
- `webfetch` is still the reader for public pages; a Reddit page that refuses an
  anonymous fetch is not fixed by search. The browser's `read`/`handoff` path is the
  way to read a walled page.

## Where things live

| | |
|---|---|
| `src/search.js` | the HTTP engines, 202 detection, cooldown, cache, queue, browser-first decision |
| `src/browser/search.js` | the off-screen search host page, extraction, lock, idle close and host lifecycle |
| `src/browser/settings.js` | the one reader of the browser profile and idle minutes, shared with the browser server |
| `src/mcp/search-server.js` | the model's tool: schema, formatting, error text |
| `tests/search.test.mjs` | 202/challenge fixtures, cooldown, cache, queue, browser-first, fallback |
| `tests/browser-search.test.mjs` | redirect decoding, result normalization, engine order |
