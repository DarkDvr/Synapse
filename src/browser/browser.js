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
import { connect, waitForPort, readPort } from './cdp.js';
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
  arrowup: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  arrowdown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  arrowleft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  arrowright: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  pagedown: { code: 'PageDown', key: 'PageDown', vk: 34 },
  pageup: { code: 'PageUp', key: 'PageUp', vk: 33 },
  space: { code: 'Space', key: ' ', vk: 32 },
};

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

export function createBrowser({ profile, log = null, startMinimized = true, width = 1280, height = 800, idleMs = 5 * 60 * 1000 } = {}) {
  let child = null;
  let page = null;
  let starting = null;
  let pageWindowId = null;
  let lastUsed = Date.now();

  /** Every action says "still in use", so the idle clock follows the work, not the clock. */
  const used = () => { lastUsed = Date.now(); };

  const note = (msg) => log?.info?.(msg);

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
    if (page) return page;
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
      if (!existing) {
        const hidden = await early;
        if (hidden?.toolWindow) note('browser: window hidden (tool window yes)');
      }
      note(`browser: ${existing ? 'attached to' : 'started'} Edge on port ${port}`);
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
      for (const el of root.querySelectorAll('h1,h2,h3,h4,p,li,pre,blockquote,td,th,figcaption')) {
        if (el.closest('nav, header, footer, aside, form, script, style, [aria-hidden=true]')) continue;
        if (el.parentElement && el.parentElement.closest('p, li')) continue;
        const tag = el.tagName.toLowerCase();
        const value = textOf(el);
        if (tag === 'h1') push('# ' + clean(value));
        else if (tag === 'h2') push('## ' + clean(value));
        else if (tag === 'h3' || tag === 'h4') push('### ' + clean(value));
        else if (tag === 'li') push('- ' + clean(value));
        else if (tag === 'blockquote') push('> ' + clean(value));
        else if (tag === 'pre') lines.push('\\u0060\\u0060\\u0060\\n' + value.trim() + '\\n\\u0060\\u0060\\u0060');
        else push(value);
      }
      const article = lines.join('\\n').slice(0, limit);
      const plain = clean(textOf(body)).slice(0, limit);
      const text = ${JSON.stringify(String(mode))} === 'text' || article.trim().length < 40 ? plain : article;

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

      return { url: location.href, title: document.title, text, links: anchor, wall, chars: text.length };
    })()`);
    return page;
  }

  /** Click by selector, by visible text, or by coordinates. */
  async function click({ selector = null, text = null, at = null, settle = 700 } = {}) {
    const p = await start();
    used();
    let point = at;
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
      if (!found) throw new Error(`nothing to click: ${selector || text}`);
      point = found;
    }
    const [x, y] = point;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await new Promise((r) => setTimeout(r, settle));
    return p.evaluate('location.href');
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

  /** A key press, for the keys that end a form or move a page. */
  async function press(name) {
    const p = await start();
    used();
    const key = KEYS[String(name || '').toLowerCase()];
    if (!key) throw new Error(`unknown key: ${name}`);
    for (const type of ['keyDown', 'keyUp']) {
      await p.send('Input.dispatchKeyEvent', {
        type,
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.vk,
        nativeVirtualKeyCode: key.vk,
      });
    }
    return true;
  }

  /** Wait for text, for a selector, or for a fixed time — whichever was asked for. */
  async function wait({ text = null, selector = null, ms = null, timeoutMs = 20000 } = {}) {
    const p = await start();
    used();
    if (ms) {
      await new Promise((r) => setTimeout(r, Number(ms)));
      return true;
    }
    const began = Date.now();
    while (Date.now() - began < timeoutMs) {
      const hit = await p.evaluate(selector
        ? `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        : `(document.body?.innerText || '').includes(${JSON.stringify(String(text))})`);
      if (hit) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
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

  return { start, running, alive, pageState, goto, read, click, type, press, wait, scroll, screenshot, watch, tabs, clearSite, hideWindow, stop, profile };
}
