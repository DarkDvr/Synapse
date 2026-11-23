// Search through SynaBrowse, the harness's own browser.
//
// Why this exists: the search engines do not treat an HTTP client and a browser
// the same way. On 23 Nov 2026 DuckDuckGo answered the HTTP search with HTTP 202
// and an anti-bot page after two or three queries; the same query in SynaBrowse
// returned ten results in about one second. This module opens a **new tab** in
// the browser the harness already owns, reads the result cards, closes the tab,
// and leaves the page a model is working on untouched.
//
// It never starts a browser that is switched off, never reads a cookie, and never
// runs a page's own script: the extraction is a fixed expression with fixed
// selectors.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.js';
import { browserSettings } from './settings.js';
import { connect, connectBrowser } from './cdp.js';
import { hostAlive, launchHost, readHostState, stopHostProcess } from './webview2.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

/** DuckDuckGo Lite wraps links in /l/?uddg=<encoded>. */
export function decodeDdgRedirect(href) {
  const m = /[?&]uddg=([^&]+)/.exec(String(href || ''));
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  return String(href || '');
}

/** Bing wraps links in /ck/a?...&u=a1<base64url>. */
export function decodeBingRedirect(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    const raw = u.searchParams.get('u');
    if (raw) {
      let decoded = raw;
      if (/^a1/i.test(raw)) {
        let body = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        while (body.length % 4) body += '=';
        decoded = Buffer.from(body, 'base64').toString('utf8');
      }
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
    return /^https?:\/\//i.test(href) ? href : '';
  } catch {
    // A malformed redirect is not a wall; keep the link the page gave us.
    return String(href || '');
  }
}

/** The engine-specific pages, in the order a blocked HTTP query should try them. */
export const BROWSER_ENGINES = [
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web`,
    extract: (limit) => ddgSpaScript(limit),
  },
  {
    id: 'duckduckgo-lite',
    label: 'DuckDuckGo Lite',
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    extract: (limit) => ddgLiteScript(limit),
  },
  {
    id: 'bing',
    label: 'Bing',
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&cc=us`,
    extract: (limit) => bingScript(limit),
  },
];

/**
 * The page expression for DuckDuckGo's rendered results.
 *
 * A result card is `article[data-testid=result]`; the title link carries the real
 * address, and `[data-result=snippet]` is the paragraph. Ads have neither, so the
 * title-link requirement filters them without knowing their class names.
 */
function ddgSpaScript(limit) {
  return `(() => {
    const limit = ${Number(limit)};
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const body = clean(document.body ? document.body.innerText : '');
    const results = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('article[data-testid="result"]')) {
      const a = el.querySelector('a[data-testid="result-title-a"]');
      const href = a ? a.href : '';
      if (!a || !/^https?:/i.test(href) || seen.has(href)) continue;
      seen.add(href);
      const sn = el.querySelector('[data-result="snippet"]');
      const src = el.querySelector('a[data-testid="result-extras-url-link"]');
      results.push({
        title: clean(a.innerText),
        url: href,
        snippet: clean(sn ? sn.innerText : ''),
        source: clean(src ? src.innerText : ''),
      });
      if (results.length >= limit) break;
    }
    const wall = results.length ? '' : (/captcha|unusual traffic|verify you are human|automated queries/i.test(body) ? 'an anti-bot challenge' : '');
    return {
      results,
      wall,
      noResults: !results.length && /no results|did not match any documents/i.test(body),
      chars: body.length,
    };
  })()`;
}

/** The same answer from DuckDuckGo Lite, whose results are a table. */
function ddgLiteScript(limit) {
  return `(() => {
    const limit = ${Number(limit)};
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const body = clean(document.body ? document.body.innerText : '');
    const results = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a.result-link')) {
      let href = a.href;
      const m = /[?&]uddg=([^&]+)/.exec(href);
      if (m) { try { href = decodeURIComponent(m[1]); } catch (e) { /* keep the link */ } }
      if (!/^https?:/i.test(href) || seen.has(href)) continue;
      seen.add(href);
      const tr = a.closest('tr');
      const next = tr ? tr.nextElementSibling : null;
      const sn = next ? (next.querySelector('.result-snippet') || next) : null;
      results.push({
        title: clean(a.innerText),
        url: href,
        snippet: clean(sn ? sn.innerText : ''),
        source: '',
      });
      if (results.length >= limit) break;
    }
    const wall = results.length ? '' : (/captcha|unusual traffic|verify you are human|automated queries/i.test(body) ? 'an anti-bot challenge' : '');
    return {
      results,
      wall,
      noResults: !results.length && /no results|did not match any documents/i.test(body),
      chars: body.length,
    };
  })()`;
}

/** Bing's organic result cards: `li.b_algo`, an h2 link and a caption paragraph. */
function bingScript(limit) {
  return `(() => {
    const limit = ${Number(limit)};
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const body = clean(document.body ? document.body.innerText : '');
    const decode = (href) => {
      try {
        const u = new URL(href, 'https://www.bing.com');
        const raw = u.searchParams.get('u');
        if (raw) {
          let decoded = raw;
          if (/^a1/i.test(raw)) {
            let b = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
            while (b.length % 4) b += '=';
            decoded = atob(b);
          }
          if (/^https?:/i.test(decoded)) return decoded;
        }
        return /^https?:/i.test(href) ? href : '';
      } catch (e) { return href || ''; }
    };
    const results = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('li.b_algo')) {
      const a = el.querySelector('h2 a');
      const href = a ? decode(a.href) : '';
      if (!a || !/^https?:/i.test(href) || seen.has(href)) continue;
      seen.add(href);
      const sn = el.querySelector('.b_caption p, .b_snippet, p');
      const cite = el.querySelector('cite');
      results.push({
        title: clean(a.innerText),
        url: href,
        snippet: clean(sn ? sn.innerText : ''),
        source: clean(cite ? cite.innerText : ''),
      });
      if (results.length >= limit) break;
    }
    const wall = results.length ? '' : (/captcha|unusual traffic|verify you are human|automated queries/i.test(body) ? 'an anti-bot challenge' : '');
    return {
      results,
      wall,
      noResults: !results.length && /there are no results|no results/i.test(body),
      chars: body.length,
    };
  })()`;
}

/** A date at the head of a snippet is metadata, not the first sentence. */
const DATE_HEAD = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\s*/i;

/** Dedupe, clean and label what the page returned. */
export function normalizeBrowserResults(results, limit = 5) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(results) ? results : []) {
    const url = String(row?.url || '');
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    let snippet = clean(row.snippet);
    let published = '';
    const date = DATE_HEAD.exec(snippet);
    if (date) {
      published = date[0].trim();
      snippet = snippet.slice(date[0].length).replace(/^[·•\-–—]\s*/, '').trim();
    }
    let source = clean(row.source);
    if (!source || /^https?:/i.test(source) || source.includes('›')) {
      try { source = new URL(url).hostname.replace(/^www\./i, ''); } catch { /* a page's own label is fine */ source = ''; }
    }
    out.push({
      title: clean(row.title) || url,
      url,
      snippet,
      published,
      source,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** The port of a ready WebView2 host, or 0. */
async function readyPort(stateFile) {
  const state = readHostState(stateFile);
  if (state?.state !== 'ready' || !state.port) return 0;
  return (await hostAlive(Number(state.port))) ? Number(state.port) : 0;
}

/** A ready port that is safe to add a search tab to. A visible hand-off is not. */
async function usablePort(stateFile) {
  const port = await readyPort(stateFile);
  if (!port) return 0;
  if (readHostState(stateFile)?.visible === true) {
    throw new Error('SynaBrowse is showing a window for the operator');
  }
  return port;
}

/**
 * Is SynaBrowse already running and safe to put a search tab in?
 *
 * True only for the WebView2 host, with the switch on, and with no visible
 * hand-off window: a search must not add a tab to the window the operator is
 * typing into. A cold browser is not "ready" — the HTTP engines get the first
 * try, so a search does not pay for a browser launch nobody needed.
 */
export async function browserSearchReady() {
  try {
    const cfg = browserSettings();
    if (!cfg.enabled || !cfg.searchBrowser || cfg.engine !== 'webview2' || !cfg.host?.stateFile) return false;
    return Boolean(await usablePort(cfg.host.stateFile));
  } catch {
    // The question is "is it ready?", and an unreadable config means no.
    return false;
  }
}

/** Wait for another process's host to become ready, without launching a second one. */
async function waitForPort(stateFile, timeoutMs) {
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    const port = await usablePort(stateFile);
    if (port) return port;
    await sleep(200);
  }
  return 0;
}

/**
 * The browser the search uses.
 *
 * The existing SynaBrowse host is reused. If it is not running, one is started on
 * the same profile; a small lock file keeps two sessions from launching two hosts
 * on a profile that can only be open once. The host is left running for the
 * browser server (or the next search); this module never stops a browser another
 * tool may be using.
 */
async function ensurePort(cfg, { timeoutMs = 25000 } = {}) {
  if (!cfg.enabled) throw new Error('SynaBrowse is switched off');
  if (!cfg.searchBrowser) throw new Error('the search browser fallback is switched off');
  if (cfg.engine !== 'webview2') {
    throw new Error('browser search needs the WebView2 engine; the Edge fallback is for browsing only');
  }
  if (!cfg.host?.exe) throw new Error('the WebView2 browser host is not built');

  const first = await usablePort(cfg.host.stateFile);
  if (first) return first;

  // A ready state with a dead port is a host that crashed. End the pid it named
  // before opening the profile again; this is the same cleanup browser.js does.
  const stale = readHostState(cfg.host.stateFile);
  if (stale?.state === 'ready' && stale.pid) {
    await stopHostProcess({ pid: stale.pid, hwnd: stale.hwnd, stateFile: cfg.host.stateFile });
  }

  const lock = `${cfg.host.stateFile}.launch`;
  let fd = null;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Another session is starting it. Wait for that host rather than racing it.
    const waited = await waitForPort(cfg.host.stateFile, timeoutMs);
    if (waited) return waited;
    // A lock left by a killed process is not a browser. Age is the only evidence.
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs > 30000) fs.rmSync(lock, { force: true });
    } catch { /* someone else removed it */ }
    const second = await usablePort(cfg.host.stateFile);
    if (second) return second;
    throw new Error('another Synapse process is starting the browser');
  }

  try {
    const again = await usablePort(cfg.host.stateFile);
    if (again) return again;
    const downloadDir = path.join(DATA_DIR, 'browser', 'downloads');
    fs.mkdirSync(path.dirname(cfg.host.stateFile), { recursive: true });
    fs.mkdirSync(downloadDir, { recursive: true });
    const launched = await launchHost({
      exe: cfg.host.exe,
      profile: cfg.profile,
      downloadDir,
      stateFile: cfg.host.stateFile,
      downloadsFile: cfg.host.downloadsFile,
      visible: false,
      parentPid: process.pid,
      width: 1280,
      height: 800,
    });
    return launched.port;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
  }
}

/** Open a blank tab, drive it to `url`, and close it whatever happens. */
async function withTab(port, url, fn) {
  const bc = await connectBrowser(port);
  let page = null;
  let targetId = null;
  try {
    const created = await bc.send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
    for (let i = 0; i < 30 && !page; i += 1) {
      try { page = await connect(port, { targetId }); } catch { /* the target may not be listed yet */ await sleep(100); }
    }
    if (!page) throw new Error('the browser did not give the new tab a page');
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const loaded = page.waitEvent('Page.loadEventFired', 15000);
    await page.send('Page.navigate', { url });
    await loaded;
    return await fn(page);
  } finally {
    try { page?.close(); } catch { /* gone */ }
    try { if (targetId) await bc.send('Target.closeTarget', { targetId }); } catch { /* gone */ }
    try { bc.close(); } catch { /* gone */ }
  }
}

/** Poll the page until it has results, a wall, or says there are none. */
async function waitForResults(page, expression, timeoutMs) {
  const began = Date.now();
  let last = { results: [], wall: '', noResults: false };
  while (Date.now() - began < timeoutMs) {
    try {
      last = await page.evaluate(expression);
    } catch (err) {
      last = { results: [], wall: '', noResults: false, error: err.message };
    }
    if (last?.results?.length || last?.wall || last?.noResults) return last;
    await sleep(250);
  }
  return last;
}

/**
 * Search through SynaBrowse and return the same shape as the HTTP engines.
 *
 * @throws an Error whose `.attempts` says what each page said.
 */
export async function browserSearch(query, { limit = 5, timeoutMs = 15000 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('empty query');
  const cfg = browserSettings();
  const port = await ensurePort(cfg);
  const attempts = [];
  const perEngine = Math.max(4000, Math.floor(timeoutMs / BROWSER_ENGINES.length));

  for (const engine of BROWSER_ENGINES) {
    try {
      const found = await withTab(port, engine.url(q), async (page) => {
        const state = await waitForResults(page, engine.extract(limit), perEngine);
        if (state?.wall) throw new Error(state.wall);
        return normalizeBrowserResults(state?.results, limit);
      });
      if (found.length) {
        return {
          query: q,
          results: found,
          engine: `${engine.label} (SynaBrowse)`,
          attempts,
        };
      }
      attempts.push({ engine: engine.label, reason: 'no results', blocked: false });
    } catch (err) {
      attempts.push({ engine: engine.label, reason: err.message, blocked: true });
    }
  }

  const said = attempts.map((a) => `${a.engine}: ${a.reason}`).join('; ');
  const err = new Error(`SynaBrowse search failed. ${said || 'no page answered'}.`);
  err.attempts = attempts;
  throw err;
}
