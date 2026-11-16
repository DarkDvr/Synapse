// SynaBrowse: a browser the harness owns.
//
// A real Edge — its own profile under `data\browser\profile`, never the operator's and
// never Brave — launched **headed but hidden**: off the desktop when nobody is needed,
// on the second monitor and minimized when a human is. Headed on purpose: measured on
// 11 Nov against a Cloudflare-protected site, a hidden off-screen Edge cleared the
// interstitial in 2.6 s while `--headless=new` never did, and the flag that decides it is
// `--disable-blink-features=AutomationControlled`.
//
// A hidden window is a *background* window, and Chromium throttles timers and stops
// producing frames for one — so the throttling flags below are not tuning, they are what
// makes a JavaScript challenge finish at all.
//
// No cookie is ever read here. The session lives in the profile because the browser is
// the thing using it, which is also why the operator's Edge profile is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connect, connectBrowser, waitForPort, readPort } from './cdp.js';
import { safeDownloadName, uniqueDownloadPath } from './downloads.js';
import { screenState, restoreFocus, hideBrowserWindow } from './handoff.js';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** The Edge that is on this machine, by full path — never by name, never Brave. */
export function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

const HIDDEN_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  // The bubble the operator met at the top-left of the primary screen after a kill:
  // "Restore pages". It is a window of its own, and it is not ours to show (12 Nov).
  '--hide-crash-restore-bubble',
  '--disable-features=Translate,CalculateNativeWinOcclusion',
  // A background window has no timers and renders no frames without these.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // What a bot check actually looks at, measured 11 Nov: without it the interstitial
  // sat on "Verifying…" for ever; with it the same window cleared in 2.6 s.
  '--disable-blink-features=AutomationControlled',
  // Chromium prints an "unsupported command-line flag" bar for the line above. It is a
  // dev flag, and the bar is what the operator photographed in the page (11 Nov).
  '--test-type',
];

/** Key names a model may press, mapped to the protocol's own. */
const KEYS = {
  enter: { code: 'Enter', key: 'Enter', vk: 13 },
  tab: { code: 'Tab', key: 'Tab', vk: 9 },
  escape: { code: 'Escape', key: 'Escape', vk: 27 },
  esc: { code: 'Escape', key: 'Escape', vk: 27 },
  backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  delete: { code: 'Delete', key: 'Delete', vk: 46 },
  home: { code: 'Home', key: 'Home', vk: 36 },
  end: { code: 'End', key: 'End', vk: 35 },
  arrowup: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  arrowdown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  arrowleft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  arrowright: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  pagedown: { code: 'PageDown', key: 'PageDown', vk: 34 },
  pageup: { code: 'PageUp', key: 'PageUp', vk: 33 },
  space: { code: 'Space', key: ' ', vk: 32 },
};

/** The physical key each printable ASCII character sits on, and its virtual key code. */
const PRINTABLE = {
  ' ': ['Space', 32], '=': ['Equal', 187], '-': ['Minus', 189], '.': ['Period', 190], ',': ['Comma', 188],
  '/': ['Slash', 191], ';': ['Semicolon', 186], "'": ['Quote', 222], '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221], '\\': ['Backslash', 220], '`': ['Backquote', 192],
  '+': ['Equal', 187], '*': ['Digit8', 56], '(': ['Digit9', 57], ')': ['Digit0', 48],
  '!': ['Digit1', 49], '@': ['Digit2', 50], '#': ['Digit3', 51], '$': ['Digit4', 52],
  '%': ['Digit5', 53], '^': ['Digit6', 54], '&': ['Digit7', 55], '_': ['Minus', 189],
  '<': ['Comma', 188], '>': ['Period', 190], '?': ['Slash', 191], ':': ['Semicolon', 186],
  '"': ['Quote', 222], '{': ['BracketLeft', 219], '}': ['BracketRight', 221], '|': ['Backslash', 220],
  '~': ['Backquote', 192],
};

/**
 * The key event for one printable character, or null.
 *
 * A page with a keyboard handler — a calculator, a game, anything listening for `keydown`
 * and reading `event.key` — cannot be driven by `type`, which inserts text without firing
 * a key event at all. A model that asked to press "7" was told "unknown key: 7" while it
 * was testing exactly that (14 Nov). The mapping is the physical key a person would press:
 * `Digit7` for "7", `Equal` for "=", and a shifted glyph on its unshifted key.
 */
/**
 * Where a click landed, in the words the tool answer uses.
 *
 * Kept out of the MCP server so it can be tested without a browser: the sentence is
 * the part a model reads, and "the point missed a control, so the nearest one was
 * used" is what turns a near-miss into a next step instead of a mystery.
 */
export function clickSummary(res) {
  if (!res || typeof res !== 'object') return '';
  const at = Array.isArray(res.at) ? res.at : null;
  const where = at ? ` at ${at[0]},${at[1]}` : '';
  const snap = res.snapped
    ? ` (the point missed a control, so the nearest one was used: ${res.snapped.label ? `"${res.snapped.label}" ` : ''}${res.snapped.px} px away)`
    : res.clamped
      ? ' (the point was outside the viewport, so it was clamped into it)'
      : '';
  return where + snap;
}

export function keyForChar(ch) {
  const value = String(ch ?? '');
  if (value.length !== 1 || value < ' ' || value > '~') return null;
  if (value >= '0' && value <= '9') return { code: `Digit${value}`, key: value, vk: value.charCodeAt(0) };
  if (value >= 'a' && value <= 'z') return { code: `Key${value.toUpperCase()}`, key: value, vk: value.toUpperCase().charCodeAt(0) };
  if (value >= 'A' && value <= 'Z') return { code: `Key${value}`, key: value, vk: value.charCodeAt(0) };
  const entry = PRINTABLE[value];
  return entry ? { code: entry[0], key: value, vk: entry[1] } : null;
}

/**
 * One browser for the harness, opened on demand.
 *
 * `start()` is idempotent: two tools calling it at once get the same browser, because
 * an Edge profile cannot be open twice and the second launch would fail on the lock.
 */
/**
 * The cookie domains that belong to a site: the host itself, its `www.` twin, and the
 * parent domain its session usually lives on (`.example.com` for `www.example.com`).
 *
 * Pure and exported: the matching rule is the part worth testing, and it is the part that
 * was wrong — an origin clear reached `www.example.com` and left seven cookies on the
 * parent, so a "forgotten" site stayed signed in (11 Nov).
 */
export function siteDomains(host) {
  const key = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!key) return [];
  const base = key.replace(/^www\./, '');
  return [...new Set([key, `.${key}`, base, `.${base}`])];
}

/** Does a cookie set for `domain` belong to `host`? */
export function cookieBelongsTo(domain, host) {
  const d = String(domain || '').toLowerCase();
  if (!d) return false;
  const base = String(host || '').toLowerCase().replace(/^www\./, '');
  return siteDomains(host).includes(d) || (base ? d.endsWith(`.${base}`) : false);
}

export function createBrowser({
  profile,
  log = null,
  startMinimized = true,
  width = 1280,
  height = 800,
  idleMs = 5 * 60 * 1000,
  downloadDir = null,
  onDownload = null,
} = {}) {
  let child = null;
  let page = null;
  let starting = null;
  let pageWindowId = null;
  let lastUsed = Date.now();
  let browserConn = null;
  let browserPort = null;
  // guid -> one download's record. Kept after completion so a page reload mid-download
  // still has something to draw, and pruned on access rather than by another timer.
  const downloads = new Map();

  /** Every action says "still in use", so the idle clock follows the work, not the clock. */
  const used = () => { lastUsed = Date.now(); };

  const note = (msg) => log?.info?.(msg);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── downloads ───────────────────────────────────────────────────
  // The protocol reports a download on the *browser* endpoint, not the page: begin,
  // progress, completed/cancelled. `allowAndName` writes the bytes under the GUID, so a
  // site cannot choose a path; the GUID becomes the suggested name once the file is whole.
  const pruneDownloads = () => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, rec] of downloads) if (rec.endedAt && rec.endedAt < cutoff) downloads.delete(id);
  };
  const emitDownload = (rec) => {
    try { onDownload?.({ ...rec }); } catch (err) { log?.warn?.(`browser: download report failed: ${err.message}`); }
  };

  async function finalizeDownload(rec) {
    const source = path.join(downloadDir, rec.id);
    if (!fs.existsSync(source)) {
      rec.state = 'interrupted';
      rec.error = 'the downloaded file is missing';
      rec.endedAt = Date.now();
      emitDownload(rec);
      return;
    }
    const target = uniqueDownloadPath(downloadDir, rec.name);
    let last = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.promises.rename(source, target);
        rec.path = target;
        rec.name = path.basename(target);
        rec.state = 'completed';
        rec.endedAt = Date.now();
        emitDownload(rec);
        return;
      } catch (err) {
        last = err;
        await sleep(200);
      }
    }
    rec.state = 'interrupted';
    rec.error = last?.message || 'could not save the download';
    rec.endedAt = Date.now();
    emitDownload(rec);
  }

  function handleDownloadEvent(msg) {
    if (!downloadDir) return;
    const p = msg?.params || {};
    if (msg.method === 'Browser.downloadWillBegin') {
      const id = String(p.guid || '');
      if (!id) return;
      const rec = {
        id,
        url: String(p.url || ''),
        name: safeDownloadName(p.suggestedFilename),
        received: 0,
        total: 0,
        state: 'starting',
        startedAt: Date.now(),
        path: null,
        error: null,
      };
      downloads.set(id, rec);
      emitDownload(rec);
      return;
    }
    if (msg.method !== 'Browser.downloadProgress') return;
    const rec = downloads.get(String(p.guid || ''));
    if (!rec) return;
    rec.received = Number(p.receivedBytes) || 0;
    rec.total = Number(p.totalBytes) || 0;
    const state = String(p.state || 'inProgress');
    if (state === 'completed') {
      rec.state = 'saving';
      finalizeDownload(rec).catch((err) => {
        rec.state = 'interrupted';
        rec.error = err.message;
        rec.endedAt = Date.now();
        emitDownload(rec);
      });
      return;
    }
    rec.state = state;
    if (state === 'canceled' || state === 'interrupted') {
      for (const file of [path.join(downloadDir, rec.id), path.join(downloadDir, `${rec.id}.crdownload`)]) {
        try { fs.rmSync(file, { force: true }); } catch { /* a partial that is already gone */ }
      }
      rec.error = state;
      rec.endedAt = Date.now();
    }
    emitDownload(rec);
  }

  /** Set the download folder on every start/attach: the profile is shared, the folder is
   *  this project's, and another project's server may have set it last. */
  async function ensureDownloadBehavior() {
    if (!downloadDir || !page) return;
    fs.mkdirSync(downloadDir, { recursive: true });
    if (!browserConn || browserPort !== page.port) {
      try { browserConn?.close?.(); } catch { /* a replaced connection */ }
      browserConn = await connectBrowser(page.port);
      browserPort = page.port;
      browserConn.onEvent(handleDownloadEvent);
    }
    try {
      await browserConn.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: downloadDir,
        eventsEnabled: true,
      });
    } catch (err) {
      // Never fall back to the user's Downloads folder. Denying is the safe failure; the
      // model gets a sentence instead of a file it cannot find.
      log?.warn?.(`browser: could not choose the download folder: ${err.message}`);
      try { await browserConn.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: false }); } catch { /* gone */ }
    }
  }

  /** Wait for a download that began at or after `since`; null when none began. */
  async function waitForDownload({ since = 0, graceMs = 1500, timeoutMs = 120_000 } = {}) {
    if (!downloadDir) return null;
    const began = Date.now();
    let rec = null;
    while (Date.now() - began < graceMs) {
      rec = [...downloads.values()]
        .filter((d) => d.startedAt >= since)
        .sort((a, b) => a.startedAt - b.startedAt)[0] || null;
      if (rec) break;
      await sleep(75);
    }
    if (!rec) return null;
    while (Date.now() - began < timeoutMs) {
      if (!['starting', 'inProgress', 'saving'].includes(rec.state)) return rec;
      await sleep(100);
    }
    return rec;
  }

  /** A URL that is itself a file, rather than a page: navigate and wait for the download. */
  async function downloadFrom(url, { timeoutMs = 120_000 } = {}) {
    const p = await start();
    used();
    const since = Date.now();
    try {
      await p.send('Page.navigate', { url });
    } catch {
      // A download aborts the navigation; the event is the answer, not the error.
    }
    return waitForDownload({ since, graceMs: 4000, timeoutMs });
  }

  const downloadList = () => {
    pruneDownloads();
    return [...downloads.values()].sort((a, b) => a.startedAt - b.startedAt);
  };

  const launchArgs = ({ position }) => [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    ...HIDDEN_FLAGS,
    ...(position ? [`--window-position=${position}`] : []),
    ...(startMinimized ? ['--start-minimized'] : []),
    `--window-size=${width},${height}`,
    'about:blank',
  ];

  /** Start the browser if it is not running, and attach to its page. */
  async function start() {
    // The page we hold may be gone: the operator closed the window after signing in, or
    // the idle reaper closed it from another process. A dead page is not an error to
    // report — it is a browser to open again (11 Nov).
    if (page && !(await alive())) {
      log?.info?.('browser: the page is gone — starting again');
      page = null;
      child = null;
    }
    if (page) {
      await ensureDownloadBehavior();
      return page;
    }
    if (starting) return starting;
    starting = (async () => {
      const edge = findEdge();
      if (!edge) throw new Error('no Edge on this machine');
      fs.mkdirSync(profile, { recursive: true });

      // Someone else may already own this profile — another MCP server process, or the
      // hand-off window the operator is using. Attaching is the correct answer: a profile
      // cannot be open twice, and the session is the point.
      const existing = await waitForPort(profile, { timeoutMs: 1200 });
      let port = existing;
      // Where the window belongs, decided before the spawn: the second monitor's centre.
      let placeX = null;
      let placeY = null;
      let early = null;
      if (!port) {
        // A port file from an earlier instance names a port that is gone.
        try { fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true }); } catch { /* fine */ }
        // Edge takes the foreground even with --start-minimized, so the launch captures the
        // operator's window first and gives it back afterwards. The window is positioned on
        // the second monitor rather than off-screen, so its taskbar button appears there —
        // off-screen, Windows put the button on the primary (11 Nov).
        const before = startMinimized ? await screenState().catch(() => null) : null;
        const area = before?.screens?.find((s) => !s.primary) || before?.screens?.[0] || null;
        placeX = area ? area.workX + Math.round((area.workW - width) / 2) : null;
        placeY = area ? area.workY + Math.round((area.workH - height) / 2) : null;
        // Off-screen for the moment it exists, so nothing is visible; the protocol puts it on
        // the right monitor and minimizes it a second later.
        const position = '-32000,-32000';
        // cwd outside the project: a process whose working directory is a folder keeps that folder
        // undeletable, and Edge is long-lived (11 Nov).
        child = spawn(edge, launchArgs({ position }), { stdio: 'ignore', detached: false, cwd: path.dirname(profile) });
        // Before the port is even open: the window is grabbed the instant it exists, so the
        // taskbar button it wears for those first seconds is gone (12 Nov).
        early = hideBrowserWindow({ profile, waitMs: 15000 }).catch(() => null);
        // Immediately, not after the port is ready: the operator must not lose the caret for
        // the two seconds a browser takes to open (11 Nov).
        if (before?.foreground) restoreFocus(before.foreground).catch(() => {});
        port = await waitForPort(profile, { timeoutMs: 30000 });
        if (!port) throw new Error('the browser did not open a debugging port');
        child.port = port;
        if (before?.foreground) {
          // Measured, not assumed: the answer says which window has the focus now.
          const back = await restoreFocus(before.foreground).catch(() => null);
          if (back) note(`browser: launch placed on ${area?.device || 'the primary'}; focus restored ${back.ok ? 'yes' : 'no'}`);
        }
      }
      const conn = await connect(port);
      page = { ...conn, port, profile };
      await conn.send('Page.enable');
      await conn.send('Runtime.enable');
      // The tab must be the active one or a challenge that runs on a timer never ends.
      try { await conn.send('Page.bringToFront'); } catch { /* a hidden window may refuse */ }
      try { await conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); } catch { /* fine */ }
      // The window is hidden properly: a tool window (no taskbar button, no Alt-Tab), parked
      // off-screen and left *normal* so it still renders. The "Restore pages" bubble Edge
      // shows after a kill is suppressed by a flag; it used to appear at the top-left of the
      // primary and was mistaken for our window (12 Nov).
      // Always, not only on a fresh launch: a browser that outlived a Synapse restart is
      // attached with whatever window state it had, and a window with an app-window bit
      // is a taskbar button the operator can see and click — they reported exactly that
      // while two models were reading one thread (13 Nov).
      const hidden = existing ? await hideBrowserWindow({ profile }).catch(() => null) : await early;
      if (hidden?.toolWindow) {
        note(`browser: window hidden (tool window yes${existing ? ', attached' : ''}, taskbar buttons removed ${hidden.tabsRemoved ?? 0})`);
      }
      note(`browser: ${existing ? 'attached to' : 'started'} Edge on port ${port}`);
      await ensureDownloadBehavior();
      return page;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  /** Is the browser up and still answering? A dead process keeps no page. */
  async function alive() {
    if (!page) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${page.port}/json/version`);
      return res.ok;
    } catch {
      // The port is gone: the process died, which is exactly the question asked.
      return false;
    }
  }

  /** Is the browser up and still answering? */
  const running = () => Boolean(page);

  /** Go somewhere and wait for the page to settle, not for a guessed sleep. */
  async function goto(url, { settle = 900, timeoutMs = 30000 } = {}) {
    const p = await start();
    used();
    const loaded = p.waitEvent('Page.loadEventFired', timeoutMs);
    const nav = await p.send('Page.navigate', { url });
    // The protocol answers a *user-visible* failure here rather than throwing: a host
    // that does not resolve, a refused connection. A caller that means "did it open?"
    // needs to know, so this is an error like any other.
    if (nav?.errorText) throw new Error(nav.errorText);
    await loaded;
    // Sub-resources and a client-side render happen after load; the page is not readable
    // the instant the event fires. This is a settle, not a wait-for-the-work.
    await new Promise((r) => setTimeout(r, settle));
    return p.evaluate('location.href');
  }

  /**
   * What the page says, as a person would read it.
   *
   * Not the HTML: a DOM dump is thousands of tokens of markup. Instead the main content is
   * chosen (the element with paragraphs and little link furniture — the article, not the
   * page around it) and emitted as Markdown-ish lines, so a model spends its context on
   * the words. `mode: 'text'` keeps the old whole-page text for a page the picker gets
   * wrong.
   *
   * It also answers whether the page is a **sign-in wall** — a password box, or a form
   * that says sign in — because a model reading a login page as if it were content is the
   * expensive mistake, and the wall is visible right here.
   */
  async function read({ maxChars = 6000, links = 60, mode = 'article' } = {}) {
    const p = await start();
    used();
    const page = await p.evaluate(`(() => {
      const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const body = document.body || document.documentElement;
      const textOf = (el) => (el && el.innerText ? String(el.innerText) : '').replace(/\\u00a0/g, ' ');
      const limit = ${Number(maxChars)};

      // A wall, as the page shows it.
      const passwords = document.querySelectorAll('input[type=password]').length;
      const opening = clean(textOf(body)).slice(0, 4000);
      const saysSignIn = /(sign in|log in|login|create an account|sign up)/i.test(opening);
      const form = document.querySelector('form');
      let wall = '';
      if (passwords > 0) wall = 'a password box';
      else if (form && saysSignIn) wall = 'a sign-in form';

      // The article: paragraphs weigh, link furniture costs.
      let best = null;
      let bestScore = 0;
      for (const el of document.querySelectorAll('article, main, [role=main], .post, .entry-content, #content, .content, div')) {
        const t = textOf(el);
        if (t.length < 300) continue;
        const paras = el.querySelectorAll('p,li,pre,blockquote').length;
        const linkChars = [...el.querySelectorAll('a')].reduce((n, a) => n + clean(textOf(a)).length, 0);
        const density = linkChars / Math.max(t.length, 1);
        const score = paras * 30 + t.length * (1 - Math.min(density, 0.9));
        if (score > bestScore) { bestScore = score; best = el; }
      }
      const root = best || body;
      const lines = [];
      const push = (s) => { const v = clean(s); if (v) lines.push(v); };
      for (const el of root.querySelectorAll('h1,h2,h3,h4,p,li,pre,blockquote,td,th,figcaption,a,time')) {
        if (el.closest('nav, aside, form, script, style, [aria-hidden=true], button, [role=button]')) continue;
        if (el.parentElement && el.parentElement.closest('p, li')) continue;
        const tag = el.tagName.toLowerCase();
        const value = textOf(el);
        if (tag === 'a' || tag === 'time') {
          // A link or a timestamp standing on its own — not inside a paragraph — is a
          // label: an author, a date, a tag. Dropping those stripped the attribution from
          // a thread (14 Nov: the model had the comments and none of the names). The
          // page's own footer is still furniture, so it stays out.
          if (el.closest('p, li, blockquote, td, th, h1, h2, h3, h4, pre, figcaption, footer')) continue;
          const label = clean(value);
          if (label.length >= 2 && label.length <= 80) push(label);
          continue;
        }
        if (el.closest('header, footer')) continue;
        if (tag === 'h1') push('# ' + clean(value));
        else if (tag === 'h2') push('## ' + clean(value));
        else if (tag === 'h3' || tag === 'h4') push('### ' + clean(value));
        else if (tag === 'li') push('- ' + clean(value));
        else if (tag === 'blockquote') push('> ' + clean(value));
        else if (tag === 'pre') lines.push('\\u0060\\u0060\\u0060\\n' + value.trim() + '\\n\\u0060\\u0060\\u0060');
        else push(value);
      }
      const articleFull = lines.join('\\n');
      // The whole page in its own line structure. Calling clean() here was the "one long
      // line": a thread of ninety comments arrived as one paragraph with every name
      // somewhere inside it (14 Nov), so the model shell-split it and still lost the
      // nesting.
      const plainLines = textOf(body)
        .replace(/\\u00a0/g, ' ')
        .split('\\n')
        .map((line) => line.replace(/[ \\t]+/g, ' ').trim())
        .filter((line, i, all) => line || (i > 0 && all[i - 1]));
      const plainFull = plainLines.join('\\n').trim();
      const usePlain = ${JSON.stringify(String(mode))} === 'text' || articleFull.trim().length < 40;
      const full = usePlain ? plainFull : articleFull;
      const text = full.slice(0, limit);

      const seen = new Set();
      const anchor = [...document.querySelectorAll('a[href]')].map((a) => {
        const label = clean(a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '').slice(0, 80);
        const box = a.getBoundingClientRect();
        const href = a.href;
        if (!label || box.width < 4 || box.height < 4 || !/^https?:/i.test(href)) return null;
        const key = label.toLowerCase() + '|' + href;
        if (seen.has(key)) return null;
        seen.add(key);
        return { text: label, href, at: [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)] };
      }).filter(Boolean).slice(0, ${Number(links)});

      // total is what the page held, chars is what this read returns: the tool says
      // the difference so a model knows it is reading a cut (13 Nov).
      return { url: location.href, title: document.title, text, links: anchor, wall, chars: text.length, total: full.length };
    })()`);
    return page;
  }

  /**
   * Walk a page to its end and read the whole of it.
   *
   * A long thread is loaded as it is scrolled, so one `read` at the top can only see the top.
   * This scrolls in viewport steps until the document stops growing (twice, so a lazy section
   * that arrives late is not missed), then extracts once with a large ceiling. It is bounded
   * by time and by characters: a page that never ends is stopped at the cap rather than
   * scrolling for ever, and the answer says which cap it hit.
   *
   * Returns the same shape as `read`, plus `scrolled` (how far it walked) and `capped`.
   */
  async function captureFull({ maxChars = 400000, maxMs = 25000, links = 0, mode = 'article', step = 0.9 } = {}) {
    const p = await start();
    used();
    const started = Date.now();
    let stable = 0;
    let lastHeight = 0;
    let scrolled = 0;
    for (let i = 0; i < 400; i += 1) {
      if (Date.now() - started > maxMs) break;
      const info = await p.evaluate(
        `(() => {
          const el = document.scrollingElement || document.documentElement;
          const before = el.scrollTop;
          el.scrollTop = Math.min(el.scrollHeight, before + Math.round(innerHeight * ${Number(step)}));
          return { top: el.scrollTop, height: el.scrollHeight, atEnd: el.scrollTop + innerHeight >= el.scrollHeight - 2 };
        })()`,
      );
      scrolled += 1;
      if (Math.abs(Number(info.height) - lastHeight) < 4) stable += 1;
      else stable = 0;
      lastHeight = Number(info.height);
      if (info.atEnd && stable >= 2) break;
      await new Promise((r) => setTimeout(r, 220));
    }
    const page = await read({ maxChars, links, mode });
    return { ...page, scrolled, capped: Number(page.chars) >= Number(maxChars) };
  }

  /**
   * Click by selector, by visible text, or by coordinates.
   *
   * A coordinate is a CSS pixel in the viewport, which is also a pixel of a viewport
   * screenshot: measured 16 Nov, a 1280x800 window gives a 1280x800 PNG at device scale
   * 1, and a click at 324,444 arrives at exactly 324,444. So the arithmetic is not the
   * error — a model reading a picture is, by a few pixels or by a scale factor. A click
   * that lands near a control is therefore allowed to find it: the point is clamped to
   * the viewport and, if nothing clickable is under it, snapped to the nearest control
   * within `snapPx`, and the answer says what it snapped to.
   */
  async function click({ selector = null, text = null, at = null, settle = 700, snapPx = 28 } = {}) {
    const p = await start();
    used();
    const since = Date.now();
    let point = at;
    let snapped = null;
    if (!point) {
      const found = await p.evaluate(`(() => {
        const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const pick = (el) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          if (b.width < 2 || b.height < 2) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const c = el.getBoundingClientRect();
          return [Math.round(c.x + c.width / 2), Math.round(c.y + c.height / 2)];
        };
        if (${JSON.stringify(selector)}) return pick(document.querySelector(${JSON.stringify(selector)}));
        const want = ${JSON.stringify(text)}.toLowerCase();
        const candidates = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],summary,label')];
        return pick(candidates.find((el) => clean(el.innerText || el.value || '').toLowerCase() === want))
          || pick(candidates.find((el) => clean(el.innerText || el.value || '').toLowerCase().includes(want)));
      })()`);
      // A page can show text that is not a control — a hint, a label, an overlay's
      // message. Saying which is what turns a failed click into the next step.
      if (!found) {
        throw new Error(
          `nothing to click: ${selector || text}. That is not a link, a button or a form control — ` +
            'use an x/y from read, or a CSS selector.',
        );
      }
      point = found;
    }
    const [wantedX, wantedY] = point;
    const aim = await p.evaluate(`(() => {
      const snapPx = ${Number(snapPx) || 0};
      const control = 'a,button,[role=button],input,select,textarea,summary,label';
      const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
      const x = Math.round(clamp(${Number(wantedX)}, 0, Math.max(0, innerWidth - 2)));
      const y = Math.round(clamp(${Number(wantedY)}, 0, Math.max(0, innerHeight - 2)));
      const label = (el) => String(el?.innerText || el?.value || el?.getAttribute?.('aria-label') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 60);
      const under = document.elementFromPoint(x, y);
      const direct = under && under.closest(control);
      if (direct) return { x, y, snapped: null, clamped: [x !== ${Number(wantedX)}, y !== ${Number(wantedY)}] };
      let best = null;
      let bestD = snapPx * snapPx;
      for (const el of document.querySelectorAll(control)) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const ex = clamp(x, r.left, r.right);
        const ey = clamp(y, r.top, r.bottom);
        const d = (ex - x) ** 2 + (ey - y) ** 2;
        if (d <= bestD) { bestD = d; best = el; }
      }
      if (!best) return { x, y, snapped: null, clamped: [x !== ${Number(wantedX)}, y !== ${Number(wantedY)}] };
      const r = best.getBoundingClientRect();
      const tx = Math.round(r.left + r.width / 2);
      const ty = Math.round(r.top + r.height / 2);
      return { x: tx, y: ty, snapped: { from: [x, y], to: [tx, ty], px: Math.round(Math.sqrt(bestD)), label: label(best) },
               clamped: [x !== ${Number(wantedX)}, y !== ${Number(wantedY)}] };
    })()`);
    const x = Number(aim?.x ?? wantedX);
    const y = Number(aim?.y ?? wantedY);
    snapped = aim?.snapped || null;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await new Promise((r) => setTimeout(r, settle));
    // An object, not a bare address: the caller says where the click really landed. The
    // address is still there, and a string is still accepted, so no caller breaks.
    let url = '';
    try {
      url = await p.evaluate('location.href');
    } catch {
      // A click that replaces the document has no address to read yet (14 Nov).
      url = '';
    }
    // A link can be a file: wait a moment for the browser to announce one. A click that
    // downloads often never navigates, so the old answer said only "clicked".
    const download = downloadDir ? await waitForDownload({ since, graceMs: 900 }) : null;
    return {
      url,
      at: [x, y],
      requested: [wantedX, wantedY],
      snapped,
      clamped: Boolean(aim?.clamped?.some(Boolean)),
      ...(download ? { download } : {}),
    };
  }

  /** Type into whatever has focus (or into a selector first). */
  async function type({ text, selector = null, submit = false } = {}) {
    const p = await start();
    used();
    if (selector) await p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
    await p.send('Input.insertText', { text: String(text ?? '') });
    if (submit) await press('Enter');
    return true;
  }

  /**
   * A key press, for the keys that end a form, move a page, or drive a page's own
   * keyboard handler. A printable character (or several) is pressed as a real key, so a
   * calculator sees `keydown` with `key: "7"`.
   */
  async function press(name) {
    const p = await start();
    used();
    const raw = String(name ?? '');
    const named = KEYS[raw.toLowerCase()];
    // A chord is not a sequence: "ctrl+c" typed one character at a time would put
    // "ctrl+c" into whatever has focus. There are no modifier combinations in this tool,
    // so the model is told rather than silently fed the wrong keys.
    if (!named && raw.length > 1 && /^(ctrl|control|shift|alt|meta|cmd|command|win)\+/i.test(raw)) {
      throw new Error(`unknown key: ${name}. Chords are not supported — press the keys one at a time, or type the text.`);
    }
    const keys = named ? [named] : [...raw].map(keyForChar);
    if (!keys.length || keys.some((key) => !key)) {
      const names = Object.keys(KEYS).filter((key) => key !== 'esc').join(', ');
      throw new Error(
        `unknown key: ${name}. Press one printable character ("7", "=", "+") or a named key: ${names}.`,
      );
    }
    for (const key of keys) {
      for (const type of ['keyDown', 'keyUp']) {
        const event = {
          type,
          key: key.key,
          code: key.code,
          windowsVirtualKeyCode: key.vk,
          nativeVirtualKeyCode: key.vk,
        };
        // `text` on the way down is what makes the browser insert the character and fire
        // `keypress`; the try/keydown listeners see `key` either way.
        if (type === 'keyDown' && key.key.length === 1) {
          event.text = key.key;
          event.unmodifiedText = key.key;
        }
        await p.send('Input.dispatchKeyEvent', event);
      }
    }
    return true;
  }

  /** Wait for text, for a selector, or for a fixed time — whichever was asked for. */
  async function wait({ text = null, selector = null, ms = null, timeoutMs = 20000 } = {}) {
    const p = await start();
    used();
    if (ms) {
      await new Promise((r) => setTimeout(r, Number(ms)));
      return { ok: true, elapsedMs: Number(ms), visible: true, hidden: false };
    }
    const needle = String(text ?? '');
    const began = Date.now();
    while (Date.now() - began < timeoutMs) {
      const hit = await p.evaluate(selector
        ? `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        : `(document.body?.innerText || '').includes(${JSON.stringify(needle)})`);
      if (hit) return { ok: true, elapsedMs: Date.now() - began, visible: true, hidden: false };
      await new Promise((r) => setTimeout(r, 250));
    }
    // Why it did not happen is the useful half: a collapsed comment, a closed menu and a
    // tooltip are in the page's HTML with no rendered text, so "not shown" and "not
    // there" are two different answers and they lead to different next steps (14 Nov).
    const facts = selector
      ? null
      : await p
          .evaluate(`(() => {
        const needle = ${JSON.stringify(needle)};
        const html = document.documentElement?.outerHTML || '';
        return {
          html: html.length,
          inHtml: needle ? html.includes(needle) : false,
          text: (document.body?.innerText || '').length,
        };
      })()`)
          .catch(() => null);
    return {
      ok: false,
      elapsedMs: Date.now() - began,
      visible: false,
      hidden: Boolean(facts?.inHtml),
      textLength: Number(facts?.text) || 0,
    };
  }

  /** Scrolling, because a page that is 4,000 pixels tall is read in pieces. */
  async function scroll({ dy = 600 } = {}) {
    const p = await start();
    used();
    await p.evaluate(`window.scrollBy(0, ${Number(dy)})`);
    await new Promise((r) => setTimeout(r, 200));
    return p.evaluate('window.scrollY');
  }

  /**
   * A minimized window does not render, so a capture waits for ever. If the hand-off left it
   * minimized, bring it back off-screen for the length of the capture and minimize it again.
   */
  async function renderable() {
    const p = page;
    if (!p) return null;
    try {
      const { windowId } = await p.send('Browser.getWindowForTarget', { targetId: p.target.id });
      const { bounds } = await p.send('Browser.getWindowBounds', { windowId });
      if (bounds.windowState !== 'minimized') return null;
      await p.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', left: -32000, top: -32000 } });
      return async () => {
        try { await p.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }); } catch { /* gone */ }
      };
    } catch {
      // No window to ask about, or the protocol refused: either way a capture goes ahead
      // unchanged rather than failing on the question.
      return null;
    }
  }

  /** A picture of the page: viewport, or the whole document. */
  async function screenshot({ full = false, file } = {}) {
    const p = await start();
    used();
    const back = await renderable();
    let png;
    try {
      png = await p.screenshot({ full });
    } finally {
      if (back) await back();
    }
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, png);
    }
    return png;
  }

  /**
   * Watch movement: the frames of a screencast for `ms`, as files.
   *
   * This is what a still cannot do — a spinner that never stops, a menu that slides, a
   * chart that animates. The model gets a strip of frames, not a video.
   */
  async function watch({ ms = 1200, dir, everyNthFrame = 1 } = {}) {
    const p = await start();
    used();
    const back = await renderable();
    fs.mkdirSync(dir, { recursive: true });
    const frames = [];
    const onFrame = async (params) => {
      const n = frames.length + 1;
      const file = path.join(dir, `frame-${String(n).padStart(2, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(params.data, 'base64'));
      frames.push({ at: params.metadata?.timestamp ?? null, file });
      try { await p.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch { /* closed */ }
    };
    // The client keeps events, not callbacks: poll its queue while the screencast runs.
    const began = Date.now();
    await p.send('Page.startScreencast', { format: 'png', everyNthFrame });
    while (Date.now() - began < Number(ms)) {
      const ev = await p.waitEvent('Page.screencastFrame', 250);
      if (ev) await onFrame(ev);
    }
    await p.send('Page.stopScreencast').catch(() => {});
    if (back) await back();
    return frames;
  }

  /**
   * The page as the sign-in watcher needs it: where it is, and whether it still asks for
   * a password. It answers in a few seconds or not at all — the window it asks about may
   * have just been closed, and the watcher must not wait a minute to find that out.
   */
  async function pageState() {
    if (!page) throw new Error('the window is gone');
    return page.evaluate(
      "(() => ({ url: location.href, passwords: document.querySelectorAll('input[type=password]').length, ready: document.readyState }))()",
      { timeoutMs: 5000 },
    );
  }

  /**
   * Forget a site — the whole site, not one host label.
   *
   * Measured 11 Nov: clearing the origin `https://www.example.com` left seven cookies on
   * `.example.com`, because they are set for the parent domain and an origin clear does not
   * reach them. The operator stays signed in and the table lies. So the cookies are listed
   * by name and domain to delete them, and the parent domain is included.
   *
   * **Values are never read out.** The protocol hands them over with the list; nothing here
   * stores, logs or returns one — only `{name, domain, path}` is used, to delete.
   */
  async function clearSite(host) {
    const p = await start();
    const key = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!key) return false;
    const base = key.replace(/^www\./, '');
    const domains = new Set(siteDomains(key));
    let removed = 0;
    try {
      const listed = await p.send('Network.getCookies', { urls: [`https://${key}/`, `https://${base}/`] });
      for (const cookie of listed.cookies || []) {
        const domain = String(cookie.domain || '').toLowerCase();
        const match = domains.has(domain) || cookieBelongsTo(domain, key);
        if (!match) continue;
        try {
          await p.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path });
          removed += 1;
        } catch { /* one stubborn cookie must not stop the rest */ }
      }
    } catch (err) {
      log?.warn?.(`browser: could not list cookies for ${key}: ${err.message}`);
    }
    for (const origin of [`https://${key}`, `http://${key}`, `https://${base}`, `http://${base}`]) {
      try { await p.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }); } catch { /* nothing there */ }
    }
    note(`browser: forgot ${key} — ${removed} cookie(s) and its storage removed`);
    return removed;
  }

  /**
   * Take the window off the screen without closing the browser.
   *
   * Closing it was the wrong tool: the model is often still mid-turn (a read after the
   * sign-in), and killing the process left it talking to about:blank — "the tab is empty,
   * this is strange" (11 Nov). Minimizing keeps the page and the session, and the idle
   * reaper closes the browser when nobody needs it.
   */
  async function hideWindow() {
    const hidden = await hideBrowserWindow({ profile }).catch(() => null);
    return Boolean(hidden && hidden.state === 'hidden');
  }

  /** The tabs this browser has open. */
  async function tabs() {
    const p = await start();
    used();
    const list = await (await fetch(`http://127.0.0.1:${p.port}/json/list`)).json();
    return list.filter((t) => t.type === 'page').map((t) => ({ url: t.url, title: t.title, id: t.id }));
  }

  /** Close the browser: the profile and its session stay. */
  async function stop() {
    const exited = [];
    try { browserConn?.close?.(); } catch { /* gone */ }
    browserConn = null;
    browserPort = null;
    if (page) {
      try { await page.send('Browser.close'); } catch { /* already gone */ }
      try { page.close(); } catch { /* fine */ }
      page = null;
    }
    if (child) {
      const proc = child;
      child = null;
      // Wait for the process to go: the profile's files stay locked until it does, and a
      // caller that deletes the folder next (a test, a reset) would get EPERM.
      await new Promise((resolve) => {
        const done = () => resolve();
        const timer = setTimeout(() => {
          try { proc.kill(); } catch { /* gone */ }
          resolve();
        }, 3000);
        proc.once('exit', () => { clearTimeout(timer); done(); });
        if (proc.exitCode !== null) { clearTimeout(timer); done(); }
      });
    }
    return exited.length;
  }

  // Idle reaper: this is ~300 MB of the operator's RAM, and a model that browsed once two
  // hours ago must not still be paying for it. Only the instance that launched the browser
  // closes it, and only when *its* work has been quiet — the profile keeps the sessions,
  // so a later call simply starts it again.
  const reaper = setInterval(() => {
    if (!child || !page) return;
    if (Date.now() - lastUsed < idleMs) return;
    log?.info?.(`browser: idle for ${Math.round(idleMs / 60000)} min — closing it to free the memory`);
    stop().catch(() => {});
  }, 30000);
  reaper.unref?.();

  return { start, running, alive, pageState, goto, read, captureFull, click, type, press, wait, scroll, screenshot, watch, tabs, clearSite, hideWindow, stop, downloadFrom, waitForDownload, downloads: downloadList, profile };
}
