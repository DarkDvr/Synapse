// Web search: the HTTP engines, the walls they answer with, and the fallback.
//
// No network: `webSearch` takes the fetch it should use, so every case here is a
// fixture. The 202 page is copied from what DuckDuckGo actually answered on
// 23 Nov 2026, after two or three ordinary queries — the failure the test project
// hit, and the reason a wall is no longer reported as "no results".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  webSearch,
  formatResults,
  parseDuckResults,
  parseBingResults,
  clearSearchCache,
  SearchError,
  SearchBlocked,
} from '../src/search.js';

const DDG_OK = `<!doctype html><html><body>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fmod">Mod Organizer 2</a>
  <a class="result__snippet">A mod manager for 64-bit games.</a>
</body></html>`;

const BING_OK = `<!doctype html><html><body><ol id="b_results">
  <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9yZWxlYXNlcw">Releases</a></h2>
    <div class="b_caption"><p>The release page.</p></div></li>
</ol></body></html>`;

const DDG_WALL = `<!doctype html><html><head><title>DuckDuckGo</title></head>
  <body><div class="anomaly-modal">Our systems have detected unusual traffic.</div></body></html>`;

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    for (const [match, reply] of routes) {
      if (String(url).includes(match)) {
        const r = typeof reply === 'function' ? await reply(url) : reply;
        return new Response(r.body ?? '', { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'text/html' } });
      }
    }
    throw new Error(`no fixture for ${url}`);
  };
  fn.calls = calls;
  return fn;
}

test.beforeEach(() => clearSearchCache());

test('DuckDuckGo HTML is parsed, including the redirect wrapper', () => {
  const results = parseDuckResults(DDG_OK, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Mod Organizer 2');
  assert.equal(results[0].url, 'https://example.com/mod');
  assert.match(results[0].snippet, /mod manager/);
});

test('Bing cards are parsed, and the redirect is decoded', () => {
  const results = parseBingResults(BING_OK, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.com/releases');
  assert.match(results[0].snippet, /release page/);
});

test('an HTTP 202 is a wall, not an empty result, and the next engine answers', async () => {
  const fetchImpl = fakeFetch([
    ['html.duckduckgo.com', { status: 202, body: DDG_WALL }],
    ['lite.duckduckgo.com', { status: 202, body: DDG_WALL }],
    ['www.bing.com', { body: BING_OK }],
  ]);
  const found = await webSearch('mod organizer', {
    limit: 5,
    fetchImpl,
    browserFallback: false,
    timeoutMs: 2000,
  });
  assert.equal(found.engine, 'Bing');
  assert.equal(found.results.length, 1);
  assert.match(found.attempts[0].reason, /202/);
  assert.ok(fetchImpl.calls.some((url) => url.includes('bing.com')), 'Bing was not tried');
});

test('a wall on every HTTP engine is reported with each reason', async () => {
  const fetchImpl = fakeFetch([
    ['duckduckgo.com', { status: 202, body: DDG_WALL }],
    ['www.bing.com', { status: 202, body: '<html><body>unusual traffic</body></html>' }],
  ]);
  await assert.rejects(
    () => webSearch('anything', { fetchImpl, browserFallback: false, timeoutMs: 2000 }),
    (err) => {
      assert.ok(err instanceof SearchError);
      assert.match(err.message, /DuckDuckGo: .*202/);
      assert.match(err.message, /Bing: .*202/);
      assert.equal(err.attempts.length, 2);
      return true;
    },
  );
  // Two DuckDuckGo endpoints, not the old two-pass retry of each.
  assert.equal(fetchImpl.calls.filter((url) => url.includes('duckduckgo.com')).length, 2);
});

test('a blocked engine is cooled down instead of hit again for every query', async () => {
  const fetchImpl = fakeFetch([
    ['duckduckgo.com', { status: 202, body: DDG_WALL }],
    ['www.bing.com', { body: BING_OK }],
  ]);
  await webSearch('first query', { fetchImpl, browserFallback: false, timeoutMs: 2000 });
  const ddgCalls = fetchImpl.calls.filter((url) => url.includes('duckduckgo.com')).length;
  await webSearch('second query', { fetchImpl, browserFallback: false, timeoutMs: 2000 });
  assert.equal(
    fetchImpl.calls.filter((url) => url.includes('duckduckgo.com')).length,
    ddgCalls,
    'DuckDuckGo was asked again while cooling down',
  );
});

test('a repeated query is served from the cache', async () => {
  const fetchImpl = fakeFetch([['duckduckgo.com', { body: DDG_OK }]]);
  const first = await webSearch('cached query', { fetchImpl, browserFallback: false, timeoutMs: 2000 });
  const calls = fetchImpl.calls.length;
  const second = await webSearch('cached query', { fetchImpl, browserFallback: false, timeoutMs: 2000 });
  assert.equal(second.cached, true);
  assert.equal(second.elapsedMs, 0, 'a cache hit must not report the earlier search time');
  assert.equal(fetchImpl.calls.length, calls, 'the second query went to the network');
  assert.deepEqual(second.results, first.results);
});

test('a warm browser is preferred before the HTTP engines', async () => {
  let http = 0;
  const found = await webSearch('warm browser', {
    fetchImpl: async () => { http += 1; throw new Error('HTTP should not be called'); },
    timeoutMs: 2000,
    browserReadyImpl: async () => true,
    browserSearchImpl: async () => ({
      results: [{ title: 'A page', url: 'https://example.com/warm', snippet: 'From the browser.' }],
      engine: 'DuckDuckGo (SynaBrowse)',
    }),
  });
  assert.equal(http, 0, 'HTTP was tried before the warm browser');
  assert.equal(found.engine, 'DuckDuckGo (SynaBrowse)');
  assert.equal(found.results.length, 1);
});

test('browser fallback is used only after the HTTP engines refuse', async () => {
  const fetchImpl = fakeFetch([
    ['duckduckgo.com', { status: 202, body: DDG_WALL }],
    ['www.bing.com', { status: 202, body: '<html><body>unusual traffic</body></html>' }],
  ]);
  let asked = '';
  const found = await webSearch('browser fallback', {
    fetchImpl,
    timeoutMs: 2000,
    browserReadyImpl: async () => false,
    browserSearchImpl: async (q) => {
      asked = q;
      return { results: [{ title: 'A page', url: 'https://example.com/a', snippet: 'From the browser.' }], engine: 'DuckDuckGo (SynaBrowse)' };
    },
  });
  assert.equal(asked, 'browser fallback');
  assert.equal(found.engine, 'DuckDuckGo (SynaBrowse)');
  assert.equal(found.attempts.filter((a) => a.blocked).length, 2);
});

test('browser fallback can be switched off for a pure HTTP call', async () => {
  const fetchImpl = fakeFetch([
    ['duckduckgo.com', { status: 202, body: DDG_WALL }],
    ['www.bing.com', { status: 202, body: DDG_WALL }],
  ]);
  await assert.rejects(
    () => webSearch('http only', { fetchImpl, browserFallback: false, timeoutMs: 2000 }),
    SearchError,
  );
});

test('the model sees provenance and a reminder to open the page', () => {
  const text = formatResults(
    [{ title: 'A result', url: 'https://example.com/x', snippet: 'A snippet.', source: 'example.com' }],
    { query: 'a query', engine: 'Bing', elapsedMs: 1234 },
  );
  assert.match(text, /Search results for "a query" via Bing in 1.2 s/);
  assert.match(text, /1\. A result/);
  assert.match(text, /URL: https:\/\/example\.com\/x/);
  assert.match(text, /Snippets are excerpts/);
  const cached = formatResults(
    [{ title: 'A result', url: 'https://example.com/x' }],
    { query: 'a query', engine: 'Bing', elapsedMs: 0, cached: true },
  );
  assert.match(cached, /cached from an earlier search/);
  assert.doesNotMatch(cached, /in 0\.0 s/);
});

test('SearchBlocked is an answer, not a network error', () => {
  const err = new SearchBlocked('DuckDuckGo: the anti-bot page (HTTP 202)', { status: 202 });
  assert.equal(err.blocked, true);
  assert.equal(err.status, 202);
});

test('two searches never run at once', async () => {
  let active = 0;
  let most = 0;
  const fetchImpl = async () => {
    active += 1;
    most = Math.max(most, active);
    await new Promise((r) => setTimeout(r, 40));
    active -= 1;
    return new Response(DDG_OK, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const [a, b] = await Promise.all([
    webSearch('queue one', { fetchImpl, browserFallback: false, timeoutMs: 2000 }),
    webSearch('queue two', { fetchImpl, browserFallback: false, timeoutMs: 2000 }),
  ]);
  assert.equal(a.results.length, 1);
  assert.equal(b.results.length, 1);
  assert.equal(most, 1, 'the two searches overlapped');
});

test('the model is offered no engine choice', () => {
  const src = fs.readFileSync(new URL('../src/mcp/search-server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /name: 'engine'/);
  assert.match(src, /do not repeat it unchanged/);
  assert.match(src, /do not repeat a query that reports every path was blocked/);
});
