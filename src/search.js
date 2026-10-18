// Web search, in plain Node with no dependencies.
//
// The engine ships a `websearch` tool, but it needs a search provider key and
// on this machine it answers HTTP 403 — so the models have no working search at
// all. This is the local replacement: DuckDuckGo's HTML endpoints, which need
// no key and no package. (The same approach as the `ddgs` Python package used
// in BotChat's classifier.py, reimplemented so Synapse stays dependency-free.)
//
// Reliability, learned the hard way:
//   - two endpoints, tried in order: html, then lite (both verified reachable)
//   - one retry of the whole chain before giving up
//   - a polite gap between outbound queries, which is what BotChat did to avoid
//     soft-bans from the same IP
//   - a short-lived cache, so repeated questions cost nothing
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ENDPOINTS = [
  (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
];

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const MIN_GAP_MS = 1200;   // polite spacing between outbound queries
const RETRY_DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cache = new Map();
let lastRequestAt = 0;

const ENTITIES = {
  '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'",
  '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&hellip;': '…',
};

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|quot|#x27|#39|lt|gt|nbsp|hellip);/g, (m) => ENTITIES[m] || m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** DuckDuckGo wraps results in a redirect: //duckduckgo.com/l/?uddg=<encoded>. */
function realUrl(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href || '');
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  if (href?.startsWith('//')) return `https:${href}`;
  return href || '';
}

function anchors(html, classRe) {
  const out = [];
  const re = new RegExp(`<a\\b([^>]*class="[^"]*\\b${classRe}\\b[^"]*"[^>]*)>([\\s\\S]*?)<\\/a>`, 'g');
  for (const m of String(html).matchAll(re)) {
    out.push({ attrs: m[1], text: m[2] });
  }
  return out;
}

/** Exported for testing: the markup shape is the only fragile part. */
export function parseResults(html, limit = 5) {
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

async function fetchEndpoint(url, limit, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseResults(await res.text(), limit);
}

async function throttle() {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/**
 * Search the web. Throws on failure so the caller can report it rather than
 * silently returning nothing.
 */
export async function webSearch(query, { limit = 5, timeoutMs = 15000 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('empty query');

  const key = `${q.toLowerCase()}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;

  const remember = (results) => {
    cache.set(key, { at: Date.now(), results });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return results;
  };

  let lastErr = null;
  // Two passes: html then lite, and if both come back empty or fail, one more
  // pass after a pause. DuckDuckGo throttles per-IP, so a second immediate hit
  // is more likely to fail than to help.
  for (let pass = 0; pass < 2; pass += 1) {
    if (pass > 0) await sleep(RETRY_DELAY_MS);
    for (const endpoint of ENDPOINTS) {
      try {
        await throttle();
        const results = await fetchEndpoint(endpoint(q), limit, timeoutMs);
        if (results.length) return remember(results);
        lastErr = new Error('no results');
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw lastErr || new Error('search failed');
}

/** The same results as one block of text, which is what a model wants. */
export function formatResults(results) {
  if (!results.length) return 'No results found.';
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n\n');
}
