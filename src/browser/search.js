// Search through SynaBrowse, the harness's own browser.
//
// Why this exists: the search engines do not treat an HTTP client and a browser
// the same way. On 23 Nov 2026 DuckDuckGo answered the HTTP search with HTTP 202
// and an anti-bot page after two or three queries; the same query in SynaBrowse
// returned ten results in about one second. This module starts its own off-screen
// browser host, drives its one page to the result page, reads the cards, and leaves
// the main browser and the operator's screen alone. It deliberately never creates a
// target: WebView2 makes a CDP target a real window, which flashed on screen once.
//
// It never starts a browser that is switched off, never reads a cookie, and never
// runs a page's own script: the extraction is a fixed expression with fixed
// selectors.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.js';
import { browserSettings } from './settings.js';
import { connect } from './cdp.js';
import { hostAlive, hostBinary, hostFiles, launchHost, readHostState, stopHostProcess } from './webview2.js';

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

/**
 * The search browser is its own off-screen host, with its own profile.
 *
 * It is deliberately not the main SynaBrowse window: a search must never put a new
 * window on the operator's screen, and it must never navigate the page a model is
 * working on. The host starts on demand after the HTTP engines refuse, keeps one
 * page, and is closed again after the configured idle time.
 */
function searchBrowser() {
  const cfg = browserSettings();
  // A subfolder, because the host's state file is named `webview2-state.json` beside
  // the profile's parent. Sharing `data\browser` with the main host would make the
  // search attach to the main browser's state file and drive its page (caught 23 Nov).
  const profile = path.join(DATA_DIR, 'browser', 'search', 'webview2');
  const files = hostFiles({ profile });
  return {
    exe: hostBinary(),
    profile,
    idleMinutes: cfg.idleMinutes,
    host: {
      stateFile: files.stateFile,
      downloadsFile: files.downloadsFile,
    },
  };
}

let lastUsed = 0;
let stopTimer = null;

/** Close the search host after the same idle window as the main browser. */
function scheduleStop(host) {
  const idleMs = Math.max(1, Number(host.idleMinutes) || 5) * 60_000;
  lastUsed = Date.now();
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(async () => {
    stopTimer = null;
    if (Date.now() - lastUsed < idleMs - 1000) {
      scheduleStop(host);
      return;
    }
    const state = readHostState(host.host.stateFile);
    if (state?.state === 'ready' && state.pid) {
      await stopHostProcess({ pid: state.pid, hwnd: state.hwnd, stateFile: host.host.stateFile });
    }
  }, idleMs);
  stopTimer.unref?.();
}

/** The port of a ready WebView2 host, or 0. */
async function readyPort(stateFile) {
  const state = readHostState(stateFile);
  if (state?.state !== 'ready' || !state.port) return 0;
  return (await hostAlive(Number(state.port))) ? Number(state.port) : 0;
}

/** A ready port that is safe to drive the search page on. */
async function usablePort(stateFile) {
  const port = await readyPort(stateFile);
  if (!port) return 0;
  if (readHostState(stateFile)?.visible === true) {
    throw new Error('SynaBrowse is showing a window for the operator');
  }
  return port;
}

/**
 * Is the search browser already running?
 *
 * True only when its own host is ready. A cold one is not "ready" — the HTTP engines
 * get the first try, so a search does not pay for a browser launch nobody needed.
 */
export async function browserSearchReady() {
  try {
    const host = searchBrowser();
    if (!host.exe) return false;
    return Boolean(await usablePort(host.host.stateFile));
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

/** Is a pid still there? Used only to prove a launch lock is stale. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user; this app is
    // single-user, so that is still alive.
    return err.code === 'EPERM';
  }
}

/** A launch lock left by a killed search-server is not a browser. */
function clearStaleLock(lock) {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(lock, 'utf8').trim()) || 0;
  } catch {
    // The lock vanished between the EEXIST and this read; that is the answer.
    return false;
  }
  if (pid && !processAlive(pid)) {
    try { fs.rmSync(lock, { force: true }); } catch { /* another process won the race */ }
    return true;
  }
  if (!pid) {
    // An empty lock is either an old version's lock or a creator that died between
    // open and write. Two seconds is longer than that write takes.
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs > 2000) {
        fs.rmSync(lock, { force: true });
        return true;
      }
    } catch { /* someone else removed it */ }
  }
  return false;
}

/**
 * The search browser the search uses.
 *
 * It is a separate host with a separate profile, not the browser a model may be
 * working in. It starts on demand, keeps one off-screen page, and is closed after
 * the configured idle time. A small lock file keeps two sessions from launching two
 * hosts on a profile that can only be open once.
 */
async function ensurePort(host, { timeoutMs = 25000 } = {}) {
  if (!host.exe) throw new Error('the WebView2 browser host is not built');
  const stateFile = host.host.stateFile;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const first = await usablePort(stateFile);
  if (first) return first;

  // A ready state with a dead port is a host that crashed. End the pid it named
  // before opening the profile again; this is the same cleanup browser.js does.
  const stale = readHostState(stateFile);
  if (stale?.state === 'ready' && stale.pid) {
    await stopHostProcess({ pid: stale.pid, hwnd: stale.hwnd, stateFile });
  }

  const lock = `${stateFile}.launch`;
  let fd = null;
  try {
    fd = fs.openSync(lock, 'wx');
    try { fs.writeSync(fd, String(process.pid)); } catch { /* the mtime is the fallback */ }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Another session may be starting it. Wait for that host, unless the lock's
    // owner is already gone (a search-server killed mid-launch leaves the file).
    if (clearStaleLock(lock)) return ensurePort(host, { timeoutMs });
    const waited = await waitForPort(stateFile, timeoutMs);
    if (waited) return waited;
    if (clearStaleLock(lock)) return ensurePort(host, { timeoutMs });
    throw new Error('another Synapse process is starting the search browser');
  }

  try {
    const again = await usablePort(stateFile);
    if (again) return again;
    const downloadDir = path.join(DATA_DIR, 'browser', 'search-downloads');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.mkdirSync(downloadDir, { recursive: true });
    const launched = await launchHost({
      exe: host.exe,
      profile: host.profile,
      downloadDir,
      stateFile,
      downloadsFile: host.host.downloadsFile,
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

/**
 * Drive the one off-screen page to `url` and read it.
 *
 * There is deliberately no `Target.createTarget`: WebView2 treats a CDP "target" as
 * a real window, so that call put a visible search window on the operator's screen
 * for a second (live flash, 23 Nov). One long-lived page cannot flash.
 */
async function withPage(port, url, fn) {
  const page = await connect(port);
  try {
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const loaded = page.waitEvent('Page.loadEventFired', 15000);
    const nav = await page.send('Page.navigate', { url });
    if (nav?.errorText) throw new Error(nav.errorText);
    await loaded;
    return await fn(page);
  } finally {
    try { page.close(); } catch { /* gone */ }
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
  const host = searchBrowser();
  const port = await ensurePort(host);
  scheduleStop(host);
  const attempts = [];
  const perEngine = Math.max(4000, Math.floor(timeoutMs / BROWSER_ENGINES.length));

  for (const engine of BROWSER_ENGINES) {
    try {
      const found = await withPage(port, engine.url(q), async (page) => {
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
