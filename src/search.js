// Web search, in plain Node with no dependencies.
//
// The engine ships a `websearch` tool, but it needs a search provider key and
// on this machine it answers HTTP 403 — so the models have no working search at
// all. This is the local replacement.
//
// The hard lesson from the test project (23 Nov 2026): DuckDuckGo does not say
// "no results" when it has had enough. After a few queries it answers **HTTP 202**
// with an anti-bot page and no result links. The old code treated that as an empty
// success, retried the same two endpoints twice, and every later query failed for
// minutes. A wall is now named, the engine is put on a cooldown, and the next
// engine — or SynaBrowse — gets the query.
//
// Order:
//   1. DuckDuckGo HTML, then Lite (fast, no key)
//   2. Bing HTML (a second index, so one soft ban is not the whole tool)
//   3. SynaBrowse (a real browser, on a page of its own, never on screen)
//
// Reliability rules:
//   - one retry of a *network* failure, never of an answer or a wall
//   - a polite gap between outbound queries to the same engine
//   - a short-lived success cache, so repeated questions cost nothing
//   - identical concurrent queries share one request
import { browserSearch, browserSearchReady } from './browser/search.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const MIN_GAP_MS = 1200; // polite spacing between DDG queries
const BING_GAP_MS = 1000;
const RETRY_DELAY_MS = 1500;
const COOLDOWN_MS = 5 * 60 * 1000; // a wall is not a transient error

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cache = new Map();
const inflight = new Map();
const cooldown = new Map(); // engine id -> don't ask again until
const lastRequestAt = new Map(); // engine id -> when its last request started

/**
 * One search at a time per search-server process.
 *
 * Models fire tool calls in parallel, and a burst is exactly what trips a search
 * engine's rate limit. The queue is the answer that does not depend on the model
 * behaving: five searches take five short turns, not five simultaneous browser pages. The
 * engine has a 15 s ceiling of its own, so even a bad run stays under a minute or
 * so rather than several minutes.
 */
let searchQueue = Promise.resolve();
function enqueue(task) {
  const run = searchQueue.then(task, task);
  searchQueue = run.catch(() => { /* a failed search must not poison the queue */ });
  return run;
}

const ENTITIES = {
  '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'",
  '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&hellip;': '…',
  '&mdash;': '—', '&ndash;': '–', '&rsquo;': '’', '&lsquo;': '‘',
  '&ldquo;': '“', '&rdquo;': '”',
};

/** A search question the tool cannot answer, with what each path said. */
export class SearchError extends Error {
  constructor(message, { attempts = [] } = {}) {
    super(message);
    this.name = 'SearchError';
    this.attempts = attempts;
  }
}

/** One engine refused this query on purpose. Not a network error, and not retryable. */
export class SearchBlocked extends Error {
  constructor(message, { engine = '', status = 0 } = {}) {
    super(message);
    this.name = 'SearchBlocked';
    this.engine = engine;
    this.status = status;
    this.blocked = true;
  }
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/&(?:amp|quot|#x27|#39|lt|gt|nbsp|hellip|mdash|ndash|rsquo|lsquo|ldquo|rdquo);/g, (m) => ENTITIES[m] || m);
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** DuckDuckGo wraps a redirect: //duckduckgo.com/l/?uddg=<encoded>. */
function realUrl(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href || '');
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  if (href?.startsWith('//')) return `https:${href}`;
  return href || '';
}

/** Bing wraps results in /ck/a?...&u=a1<base64url>. */
function bingRealUrl(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    const raw = u.searchParams.get('u');
    if (raw) {
      let decoded = raw;
      if (/^a1/i.test(raw)) decoded = Buffer.from(raw.slice(2), 'base64url').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
    if (/^https?:\/\//i.test(href)) return href;
    return '';
  } catch {
    // A malformed redirect is not a wall; keep the link the page gave us.
    return href || '';
  }
}

function anchors(html, classRe) {
  const out = [];
  const re = new RegExp(`<a\\b([^>]*class="[^"]*\\b${classRe}\\b[^"]*"[^>]*)>([\\s\\S]*?)<\\/a>`, 'g');
  for (const m of String(html).matchAll(re)) out.push({ attrs: m[1], text: m[2] });
  return out;
}

/** Parse DuckDuckGo's HTML or Lite result page. */
export function parseDuckResults(html, limit = 5) {
  const out = [];
  const seen = new Set();
  // html.duckduckgo.com uses result__a; lite uses result-link.
  for (const cls of ['result__a', 'result-link']) {
    for (const a of anchors(html, cls)) {
      const url = realUrl(/href="([^"]+)"/.exec(a.attrs)?.[1] || '');
      const title = stripTags(a.text);
      if (!title || !url || seen.has(url)) continue;
      seen.add(url);
      out.push({ title, url, snippet: '' });
    }
  }

  const snippets = [
    ...anchors(html, 'result__snippet').map((a) => stripTags(a.text)),
  ];
  if (!snippets.length) {
    for (const m of String(html).matchAll(
      /<td\b[^>]*class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/g,
    )) {
      snippets.push(stripTags(m[1]));
    }
  }
  for (let i = 0; i < out.length && i < snippets.length; i += 1) out[i].snippet = snippets[i] || '';

  return out.slice(0, limit);
}

/** Parse Bing's organic result cards. */
export function parseBingResults(html, limit = 5) {
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(
    /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi,
  )) {
    const block = m[1];
    const a = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const url = bingRealUrl(decodeEntities(a[1]));
    const title = stripTags(a[2]);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const snippet =
      /<(?:p|div)\b[^>]*class="[^"]*(?:b_caption|b_snippet|b_lineclamp)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i.exec(block)
      || /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({ title, url, snippet: snippet ? stripTags(snippet[1]) : '' });
    if (out.length >= limit) break;
  }
  return out;
}

// Kept for anything that imported the old name; the parser is DuckDuckGo's.
export const parseResults = parseDuckResults;

/** Why a response is a wall rather than an answer. Empty when it is an answer. */
function wallReason(status, body) {
  if (status === 202) return 'the anti-bot page (HTTP 202)';
  if (status === 429) return 'a rate limit (HTTP 429)';
  const head = String(body).slice(0, 30000);
  if (/anomaly-modal|challenge-form|unusual traffic|verify you are human|automated queries/i.test(head)) {
    if (!/result__a|result-link|b_algo/i.test(head)) return 'an anti-bot challenge';
  }
  if (status === 403 && /cloudflare|just a moment|access denied/i.test(head)) return 'a bot check';
  return '';
}

/** What a 200 page says when it has no results, as opposed to hiding a wall. */
function emptyWallReason(body) {
  const head = String(body).slice(0, 30000);
  if (/anomaly-modal|challenge-form|unusual traffic|verify you are human|automated queries/i.test(head)) {
    return 'an anti-bot challenge';
  }
  return '';
}

async function throttle(engineId, gapMs) {
  const wait = gapMs - (Date.now() - (lastRequestAt.get(engineId) || 0));
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(engineId, Date.now());
}

function engineCooling(id) {
  const until = cooldown.get(id) || 0;
  return until > Date.now() ? until : 0;
}

function coolEngine(id, ms = COOLDOWN_MS) {
  cooldown.set(id, Date.now() + ms);
}

const ENGINES = [
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    gapMs: MIN_GAP_MS,
    // A known-bad endpoint usually answers (or refuses) quickly. This cap is for
    // the one that hangs; the browser fallback should not wait 15 s for it.
    timeoutMs: 6000,
    endpoints: [
      { id: 'html', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckResults },
      { id: 'lite', url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDuckResults },
    ],
  },
  {
    id: 'bing',
    label: 'Bing',
    gapMs: BING_GAP_MS,
    timeoutMs: 5000,
    endpoints: [
      { id: 'html', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&cc=us`, parse: parseBingResults },
    ],
  },
];

async function fetchEndpoint(endpoint, engine, query, limit, timeoutMs, fetchImpl) {
  await throttle(engine.id, engine.gapMs);
  let res;
  try {
    res = await fetchImpl(endpoint.url(query), {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.min(timeoutMs, engine.timeoutMs || timeoutMs)),
    });
  } catch (err) {
    throw new Error(`${engine.label}: ${err.message || 'the request failed'}`);
  }
  const body = await res.text();
  const wall = wallReason(res.status, body);
  if (wall) throw new SearchBlocked(`${engine.label}: ${wall}`, { engine: engine.label, status: res.status });
  if (!res.ok) throw new Error(`${engine.label}: HTTP ${res.status}`);
  const results = endpoint.parse(body, limit);
  if (!results.length) {
    const emptyWall = emptyWallReason(body);
    if (emptyWall) throw new SearchBlocked(`${engine.label}: ${emptyWall}`, { engine: engine.label, status: res.status });
  }
  return results;
}

async function searchEngine(engine, query, limit, timeoutMs, fetchImpl) {
  let lastBlocked = null;
  for (const endpoint of engine.endpoints) {
    try {
      const results = await fetchEndpoint(endpoint, engine, query, limit, timeoutMs, fetchImpl);
      if (results.length) return results;
    } catch (err) {
      if (err instanceof SearchBlocked) {
        lastBlocked = err;
        continue; // the lite endpoint may still answer
      }
      throw err;
    }
  }
  if (lastBlocked) throw lastBlocked;
  return [];
}

function remember(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

/**
 * Search the web.
 *
 * @returns {{query:string, results:Array, engine:string, attempts:Array, elapsedMs:number, cached?:boolean}}
 * @throws {SearchError} when every path refused, naming what each one said.
 */
export async function webSearch(query, {
  limit = 5,
  timeoutMs = 15000,
  fetchImpl = fetch,
  engine = 'auto',
  browserFallback = true,
  browserSearchImpl = browserSearch,
  browserReadyImpl = browserSearchReady,
} = {}) {
  const q = String(query || '').trim();
  if (!q) throw new SearchError('empty query');

  const wantBrowser = engine === 'browser';
  if (!['auto', 'http', 'browser'].includes(engine)) throw new SearchError(`unknown search engine: ${engine}`);

  const key = `${q.toLowerCase()}|${limit}`;
  const hit = cache.get(key);
  if (hit && !wantBrowser && Date.now() - hit.at < CACHE_TTL_MS) {
    // The original search's time is not this call's time. Saying "12.0 s" for a
    // cache hit made a model report the fallback was slow when the answer had
    // arrived in 173 ms (live test, 23 Nov).
    return { ...hit.value, cached: true, elapsedMs: 0, cachedAt: hit.at };
  }
  if (inflight.has(key) && !wantBrowser) return inflight.get(key);

  const run = enqueue(async () => {
    const began = Date.now();
    const attempts = [];
    const canBrowser = engine === 'auto' || engine === 'browser';

    const tryBrowser = async () => {
      if (!canBrowser) return null;
      try {
        const found = await browserSearchImpl(q, { limit, timeoutMs });
        if (found?.results?.length) {
          return remember(key, {
            query: q,
            results: found.results,
            engine: found.engine || 'SynaBrowse',
            attempts,
            elapsedMs: Date.now() - began,
          });
        }
        attempts.push({ engine: 'SynaBrowse', reason: 'no results', blocked: false });
      } catch (err) {
        attempts.push({ engine: 'SynaBrowse', reason: err.message, blocked: true });
      }
      return null;
    };

    // A warm search browser is the fastest reliable path: about one second in the
    // live test, while a DuckDuckGo soft ban leaves Bing to time out before the
    // fallback. A cold one is not preferred — the HTTP engines get the first try,
    // so a simple query does not pay for a browser launch nobody needed.
    let browserReady = false;
    if (browserFallback || wantBrowser) {
      try { browserReady = await browserReadyImpl(); } catch { /* no browser is not an error */ browserReady = false; }
    }
    let browserTried = false;
    if (browserReady) {
      browserTried = true;
      const found = await tryBrowser();
      if (found) return found;
    }

    if (!wantBrowser) {
      for (const eng of ENGINES) {
        const until = engineCooling(eng.id);
        if (until) {
          attempts.push({ engine: eng.label, reason: `cooling down for ${Math.ceil((until - Date.now()) / 1000)} s`, blocked: true });
          continue;
        }
        try {
          const results = await searchEngine(eng, q, limit, timeoutMs, fetchImpl);
          if (results.length) {
            return remember(key, {
              query: q,
              results,
              engine: eng.label,
              attempts,
              elapsedMs: Date.now() - began,
            });
          }
          attempts.push({ engine: eng.label, reason: 'no results', blocked: false });
        } catch (err) {
          if (err instanceof SearchBlocked) {
            coolEngine(eng.id);
            attempts.push({ engine: eng.label, reason: err.message, blocked: true });
          } else {
            attempts.push({ engine: eng.label, reason: err.message, blocked: false });
          }
        }
      }
    }

    if (!browserTried && canBrowser && (wantBrowser || browserFallback)) {
      const found = await tryBrowser();
      if (found) return found;
    }

    const said = attempts.length
      ? attempts.map((a) => `${a.engine}: ${a.reason}`).join('; ')
      : 'no engine was available';
    throw new SearchError(said, { attempts });
  });

  if (!wantBrowser) inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/** The same results as one block of text, which is what a model wants. */
export function formatResults(results, meta = {}) {
  if (!results?.length) {
    const why = meta.error ? ` ${meta.error}` : '';
    return `No results found.${why}`;
  }
  const head = [];
  head.push(meta.query ? `Search results for "${meta.query}"` : 'Search results');
  if (meta.engine) head.push(`via ${meta.engine}`);
  if (meta.elapsedMs && !meta.cached) head.push(`in ${(meta.elapsedMs / 1000).toFixed(1)} s`);
  if (meta.cached) head.push('(cached from an earlier search, at most 10 minutes old)');
  const lines = [`${head.join(' ')} — ${results.length} result(s).`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    if (r.url) lines.push(`   URL: ${r.url}`);
    if (r.source && r.source !== r.url) lines.push(`   Source: ${r.source}`);
    if (r.published) lines.push(`   Published: ${r.published}`);
    if (r.snippet) lines.push(`   Snippet: ${r.snippet}`);
    lines.push('');
  });
  lines.push('Snippets are excerpts. Open a URL before quoting a fact.');
  return lines.join('\n');
}

/** Tests use this so one case cannot poison the next. */
export function clearSearchCache() {
  cache.clear();
  inflight.clear();
  cooldown.clear();
  lastRequestAt.clear();
}
