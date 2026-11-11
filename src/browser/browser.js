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
  '--disable-features=Translate,CalculateNativeWinOcclusion',
  // A background window has no timers and renders no frames without these.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // What a bot check actually looks at, measured 11 Nov: without it the interstitial
  // sat on "Verifying…" for ever; with it the same window cleared in 2.6 s.
  '--disable-blink-features=AutomationControlled',
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
export function createBrowser({ profile, log = null, startMinimized = true, width = 1280, height = 800 } = {}) {
  let child = null;
  let page = null;
  let starting = null;

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
      if (!port) {
        // A port file from an earlier instance names a port that is gone.
        try { fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true }); } catch { /* fine */ }
        child = spawn(edge, launchArgs({ position: '-32000,-32000' }), { stdio: 'ignore', detached: false });
        port = await waitForPort(profile, { timeoutMs: 30000 });
        if (!port) throw new Error('the browser did not open a debugging port');
        child.port = port;
      }
      const conn = await connect(port);
      page = { ...conn, port, profile };
      await conn.send('Page.enable');
      await conn.send('Runtime.enable');
      // The tab must be the active one or a challenge that runs on a timer never ends.
      try { await conn.send('Page.bringToFront'); } catch { /* a hidden window may refuse */ }
      try { await conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); } catch { /* fine */ }
      note(`browser: ${existing ? 'attached to' : 'started'} Edge on port ${port}`);
      return page;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  /** Is the browser up and still answering? */
  const running = () => Boolean(page);

  /** Go somewhere and wait for the page to settle, not for a guessed sleep. */
  async function goto(url, { settle = 900, timeoutMs = 30000 } = {}) {
    const p = await start();
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
   * What the page says, as a person would read it: headings and text, plus the links a
   * model can act on. Deliberately not the HTML — a DOM dump is thousands of tokens of
   * markup and the model needs the words and the affordances.
   */
  async function read({ maxChars = 6000, links = 60 } = {}) {
    const p = await start();
    return p.evaluate(`(() => {
      const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const text = clean(document.body?.innerText || '').slice(0, ${Number(maxChars)});
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
      return { url: location.href, title: document.title, text, links: anchor };
    })()`);
  }

  /** Click by selector, by visible text, or by coordinates. */
  async function click({ selector = null, text = null, at = null, settle = 700 } = {}) {
    const p = await start();
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
    if (selector) await p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
    await p.send('Input.insertText', { text: String(text ?? '') });
    if (submit) await press('Enter');
    return true;
  }

  /** A key press, for the keys that end a form or move a page. */
  async function press(name) {
    const p = await start();
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
    await p.evaluate(`window.scrollBy(0, ${Number(dy)})`);
    await new Promise((r) => setTimeout(r, 200));
    return p.evaluate('window.scrollY');
  }

  /** A picture of the page: viewport, or the whole document. */
  async function screenshot({ full = false, file } = {}) {
    const p = await start();
    const png = await p.screenshot({ full });
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
    return frames;
  }

  /** The tabs this browser has open. */
  async function tabs() {
    const p = await start();
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

  return { start, running, goto, read, click, type, press, wait, scroll, screenshot, watch, tabs, stop, profile };
}
