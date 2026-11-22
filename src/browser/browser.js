// SynaBrowse: a browser the harness owns.
//
// The default engine is the WebView2 host (`shell/SynaBrowseHost`): a separate WPF process
// hosting the app's own Chromium runtime, off-screen, with no browser chrome. `createBrowser`
// in host mode launches it, attaches CDP and agent-browser, and reads its download JSONL.
// The Edge path below — its own profile, a Windows desktop of its own — is the fallback
// (`browser.engine: "edge"`) and is still the code that ran before 1.77.0.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, connectBrowser, waitForPort, readPort } from './cdp.js';
import { safeDownloadName, uniqueDownloadPath, formatBytes } from './downloads.js';
import { screenState, restoreFocus, hideBrowserWindow } from './handoff.js';
import { createAgent } from './agent.js';
import { launchHost, hostBinary, readHostState, hostAlive, stopHostProcess, downloadRecord } from './webview2.js';

/** The launcher that creates a desktop of its own; see the script's own note. */
const HIDDEN_DESKTOP_SCRIPT = fileURLToPath(new URL('./hidden-desktop.ps1', import.meta.url));
/** A visible hand-off must not outlive a server that is killed mid-hand-off. */
const VISIBLE_WATCH_SCRIPT = fileURLToPath(new URL('./visible-watch.ps1', import.meta.url));

/** Windows PowerShell is the launcher the app can always find; a stripped PATH is not. */
function powershellPath() {
  if (process.env.SystemRoot) {
    const full = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try { if (fs.statSync(full).isFile()) return full; } catch { /* fall through */ }
  }
  return 'powershell.exe';
}

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

/**
 * A page that wants a person, not a tool: a captcha, a "checking your browser" challenge, a
 * "verify you are human" interstitial.
 *
 * Two reasons this is a named answer rather than something the model discovers: a site's bot
 * check is the one wall the harness must not try to get around (a human solves it or the work
 * waits), and a model driving a captcha is a model clicking into a dead end for ten minutes
 * (22 Nov, Nexus's slow-download page). The sentence it gets says which kind of wall it is and
 * that handoff is the way through it.
 */
export function botWall(text, srcs = '') {
  const said = String(text || '');
  // A wall is something the page *shows*. A Turnstile or reCAPTCHA script on an ordinary
  // page — a download form, a comment box — is not a wall. Matching the script URL alone
  // made the Nexus mod page a "bot check" after its challenge had cleared, and the hand-off
  // and download tools refused a page that was plainly signed in (22 Nov).
  const visible = /(checking your browser|just a moment|performing security verification|verify (that )?you are (a )?human|are you a robot|attention required|enable javascript and cookies to continue|cf-browser-verification|__cf_chl|cf-challenge)/i;
  if (visible.test(said)) return 'a bot check — a captcha or a “checking your browser” wall';
  // A challenge can also be an empty shell with the challenge in a frame. The URL is
  // evidence only when there is no real page text to read.
  const frame = /(challenges\.cloudflare\.com|cdn-cgi\/challenge-platform|recaptcha\/api|hcaptcha\.com)/i.test(String(srcs || ''));
  const thin = said.replace(/\s+/g, ' ').trim().length < 160;
  if (frame && thin) return 'a bot check — a captcha or a “checking your browser” wall';
  return '';
}

/**
 * A page that says it does not exist. Nexus answers a wrong route with a styled 404 whose
 * title is the site's normal one; the words are the only evidence, so they are read here
 * and the answer says plainly that the address, not the site, is wrong (22 Nov).
 */
export function pageMissing(text, title = '') {
  const body = String(text || '');
  const first = `${String(title || '')}\n${body}`.slice(0, 4000);
  if (!/(page not found|404 not found|404 page|this page could not be found|the page you .{0,40}(could not|cannot|can't) be found|content not found)/i.test(first)) return false;
  // A 404 page is short. A long article that merely quotes "page not found" is not one.
  return body.replace(/\s+/g, ' ').trim().length < 6000;
}

/**
 * The date a file page says it was already downloaded, or ''.
 *
 * A file page that says “Downloaded 22 Nov 2026” is telling the model something a free
 * download may enforce; naming it saves the loop where a site refuses a second link and
 * the model keeps clicking the same button (22 Nov).
 */
export function pageDownloaded(text) {
  const match = /Downloaded\s+(\d{1,2}\s+[A-Z][a-z]{2,}\s+\d{4})/i.exec(String(text || ''));
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

/** Does the site itself say the download could not be started? */
export function pageRefused(text, title = '') {
  const said = `${String(title || '')} ${String(text || '')}`;
  return /(download link (for the file )?could not be retrieved|could not (retrieve|get) the download link|download limit (reached|exceeded)|reach(ed)? (your )?download limit|try again later[^.]{0,90}download)/i.test(said);
}

/**
 * Is this accessibility snapshot the browser's own downloads panel?
 *
 * The panel is browser UI, not the page. After a download it becomes the accessibility
 * root: every page snapshot sees its Downloads/Open downloads folder/Search controls and
 * none of the page's own, and clicking its Downloads button opens the full hub instead of
 * closing it. The page controls a page snapshot gets back only after the browser restarts
 * (22 Nov, the second mod). The two shapes are the compact bubble and the full hub.
 */
export function browserDownloadsPanel(text) {
  const said = String(text || '');
  const bubble = /(^|\n)\s*-\s+button "Downloads"/.test(said) && /(^|\n)\s*-\s+button "Open downloads folder"/.test(said);
  const hub = /(^|\n)\s*-\s+heading "Downloads"/.test(said) &&
    /(^|\n)\s*-\s+button "Clear all"/.test(said) &&
    /(^|\n)\s*-\s+button "Open downloads folder"/.test(said);
  return bubble || hub;
}

/** What a saved file's answer says: path, size, type, and whether it was a page after all. */
export function savedAnswer(rec, { dir = '', rel = '' } = {}) {
  if (!rec) return null;
  if (rec.tooBig) {
    return {
      text: `That is ${formatBytes(rec.tooBig)} — larger than a fetch may pull through the page. ` +
        'Use download with the address instead: a real download streams to disk without the whole file in memory.',
      isError: true,
    };
  }
  if (rec.ok === false) {
    const said = String(rec.said || '').trim();
    return {
      text: `The address answered ${rec.status || 'an error'}${said ? `: “${said}”` : ''}. ` +
        'Nothing was saved. If that page is the one that holds the file, click its download control instead — ' +
        'a file address that answers a page is usually a route that needs the site’s own button.',
      isError: true,
    };
  }
  const type = String(rec.type || '');
  const size = formatBytes(rec.size || 0);
  const looksHtml = /text\/html/i.test(type) || (rec.head && /^</.test(String(rec.head).trim()));
  if (looksHtml) {
    const head = String(rec.head || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return {
      text: `That address answered a **page**, not a file** (${type || 'html'}, ${size})**${head ? `: “${head}…”` : ''}. ` +
        'Nothing was saved: a route like “…&action=download” often returns the page it belongs to. ' +
        'Find the page’s own download control with `read` and click it — a click waits for the file.',
      isError: true,
    };
  }
  const where = rel || (dir ? String(dir) : '');
  return {
    text: `Saved ${rec.name || 'the file'} (${size}${type ? `, ${type}` : ''}) to ${where || 'the project’s downloads folder'}.` +
      (rec.from ? `\nIt came from ${rec.from}.` : ''),
    isError: false,
  };
}

/**
 * What a request's answer says when it is JSON rather than a file.
 *
 * The shape that matters is the one a site's own script lives on: a 200 whose body names a
 * link (`{"url": "https://…"}`), which is how a file behind a page's button is fetched. The
 * answer names that link, because the next move is `save` on it, and a model reading a wall
 * of JSON should not have to find the needle (22 Nov, the Nexus mint).
 */
export function requestAnswer(rec) {
  if (!rec) return { text: 'The request answered nothing at all.', isError: true };
  const status = Number(rec.status) || 0;
  const body = String(rec.text || '').trim();
  if (!rec.ok) {
    const retry = Number(rec.retry) > 0 ? ` The site asked to wait ${rec.retry} s (Retry-After).` : '';
    const said = body.replace(/\s+/g, ' ').slice(0, 240);
    return {
      text: `The request answered ${status || 'an error'}${said ? `: “${said}”` : ''}.${retry}`,
      isError: true,
    };
  }
  // A link in the answer is a file waiting to be fetched: name it, once.
  let link = '';
  try {
    const parsed = JSON.parse(body);
    for (const key of ['url', 'generateDownloadUrl', 'download_url', 'URI', 'href', 'link']) {
      const value = parsed?.[key];
      if (typeof value === 'string' && /^https?:/i.test(value)) { link = value; break; }
    }
  } catch { /* not JSON; the body itself is the answer */ }
  const size = body.length;
  const cut = size > 1200 ? `${body.slice(0, 1200)}\n[… ${size - 1200} more characters]` : body;
  return {
    text: `The request answered ${status} (${rec.type || 'no content type'})` +
      `${link ? ` and it names a link:\n${link}\nSave that address with save — it is the file.` : ''}` +
      `\n\n${cut}`,
    isError: false,
  };
}

/** What the dom tool answers: what the elements are, what they state, where they are. */
export function domAnswer(selector, rows = []) {
  const lines = [`${rows.length} element${rows.length === 1 ? '' : 's'} for ${selector}:`];
  for (const row of rows) {
    const attrs = Object.entries(row.attrs || {})
      .map(([k, v]) => `${k}="${String(v).replace(/\s+/g, ' ').slice(0, 90)}"`)
      .join(' ');
    const where = row.at ? ` (${row.at.join(',')})` : '';
    lines.push(`- <${row.tag}>${where}${row.text ? ` “${row.text}”` : ''}${attrs ? `\n    ${attrs}` : ''}`);
  }
  return lines.join('\n');
}

const HIDDEN_FLAGS = [  '--no-first-run',
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
  if (res.ref) return ` by ref ${res.ref}`;
  const at = Array.isArray(res.at) ? res.at : null;
  const where = at ? ` at ${at[0]},${at[1]}` : '';
  const asked = Array.isArray(res.requested) && res.snapped ? ` of the ${res.requested[0]},${res.requested[1]} asked for` : '';
  const snap = res.snapped
    ? ` (the click landed ${res.snapped.px} px from the point, on ${res.snapped.label ? `"${res.snapped.label}"` : 'another element'}${asked})`
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
  hiddenDesktop = true,
  // The visible hand-off window is for the operator, not for a model: it needs no
  // agent-browser daemon, and starting one just adds a slow close to every hand-off.
  actionLayer = true,
  width = 1280,
  height = 800,
  idleMs = 5 * 60 * 1000,
  downloadDir = null,
  onDownload = null,
  // WebView2 host mode. The host is a separate WPF process; `profile` is its user-data
  // folder, `host.stateFile`/`host.downloadsFile` are the two files it talks through.
  host = null,
} = {}) {
  let child = null;
  let page = null;
  let starting = null;
  let pageWindowId = null;
  let lastUsed = Date.now();
  let browserConn = null;
  let browserPort = null;
  let agent = null;
  // True when this instance found a browser already running on the profile rather than
  // launching one. A caller that must show a window to the operator refuses to drive
  // someone else's hidden browser (the Settings sign-in path).
  let attached = false;
  // One browser per profile at a time, so one state file per profile is enough. It is
  // written by the keeper and read back only to stop a pid this profile started.
  const hiddenStateFile = path.join(path.dirname(profile), 'hidden-desktop.json');
  // guid -> one download's record. Kept after completion so a page reload mid-download
  // still has something to draw, and pruned on access rather than by another timer.
  const downloads = new Map();
  // WebView2 host mode: the process, and the JSONL download log it appends.
  let hostChild = null;
  let hostDownloadsTimer = null;
  let hostDownloadOffset = 0;
  let hostDownloadTail = '';

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
    if (host) {
      ensureHostDownloads();
      return;
    }
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
    if (host) {
      // The host's DownloadStarting writes the file; navigation aborts as a download,
      // exactly as it does on Edge, so the event is the answer and not the error.
      try { await p.send('Page.navigate', { url }); } catch { /* the download is the answer */ }
      return waitForDownload({ since, graceMs: 4000, timeoutMs });
    }
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

  // ── WebView2 host downloads ─────────────────────────────────────
  // The host owns the bytes and appends one JSON line per download event. The provider
  // reads only the new lines, so progress is cheap and a restart is not a re-read.
  function applyHostDownload(event) {
    const rec = downloadRecord(event);
    if (!rec) return;
    downloads.set(rec.id, rec);
    emitDownload(rec);
  }

  function ensureHostDownloads() {
    if (!host || !downloadDir || hostDownloadsTimer) return;
    fs.mkdirSync(downloadDir, { recursive: true });
    hostDownloadOffset = 0;
    hostDownloadTail = '';
    const tick = () => {
      let fd = null;
      try {
        const stat = fs.statSync(host.downloadsFile);
        if (stat.size < hostDownloadOffset) {
          hostDownloadOffset = 0;
          hostDownloadTail = '';
        }
        if (stat.size === hostDownloadOffset) return;
        fd = fs.openSync(host.downloadsFile, 'r');
        const length = stat.size - hostDownloadOffset;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, hostDownloadOffset);
        hostDownloadOffset = stat.size;
        hostDownloadTail += buffer.toString('utf8');
        const lines = hostDownloadTail.split(/\r?\n/);
        hostDownloadTail = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { applyHostDownload(JSON.parse(line)); } catch { /* a partial line from a crash */ }
        }
      } catch { /* the host has not written yet */ }
      finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* gone */ } } }
    };
    hostDownloadsTimer = setInterval(tick, 200);
    hostDownloadsTimer.unref?.();
    tick();
  }

  function stopHostDownloads() {
    if (hostDownloadsTimer) clearInterval(hostDownloadsTimer);
    hostDownloadsTimer = null;
  }

  /**
   * A request made **through the page**, and the bytes or the body it answered.
   *
   * The request runs in the page's own context (`fetch` with `credentials: 'include'`), so it
   * carries the session's cookies, the site's origin, the page as referrer and the browser's
   * own TLS fingerprint — the things a Node-side request cannot supply, and the reason a POST
   * that works from the page is refused from anywhere else. That is not a trick: a site's own
   * script makes exactly this call, and the VPA app proved it for Nexus's free-tier download
   * (`GenerateDownloadUrl` → a signed CDN link, 88,436 bytes, 22 Nov).
   *
   * Two shapes, because a page's XHR usually answers JSON and a file answers bytes:
   * `json: true` returns the body as text (capped), and otherwise the bytes are saved.
   *
   * **The cross-origin leg.** A file link is nearly always another host (a CDN), and a page
   * may not read that answer (CORS). The same address is then fetched from Node with the
   * browser's cookies for that host, the page as referrer and an ordinary user agent — which
   * is what the signed link needs, and what makes a minted link worth minting.
   */
  async function saveFrom(url, { method = 'GET', form = null, xhr = false, json = false, timeoutMs = 120_000, maxBytes = 48 * 1024 * 1024 } = {}) {
    const p = await start();
    used();
    const body = form && typeof form === 'object'
      ? Object.entries(form).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';
    const got = await p.evaluate(`(async () => {
      const url = ${JSON.stringify(String(url))};
      const init = { method: ${JSON.stringify(String(method || 'GET').toUpperCase())}, credentials: 'include', cache: 'no-store', headers: {} };
      ${body ? `init.headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      init.body = ${JSON.stringify(body)};` : ''}
      ${xhr ? `init.headers['X-Requested-With'] = 'XMLHttpRequest';` : ''}
      try {
        const res = await fetch(url, init);
        const type = res.headers.get('content-type') || '';
        const disposition = res.headers.get('content-disposition') || '';
        const named = disposition.match(/filename\\*?=(?:UTF-8'')?"?([^";]+)/i);
        const retry = res.headers.get('retry-after') || '';
        if (${json ? 'true' : 'false'}) {
          let text = '';
          try { text = await res.text(); } catch { /* no body */ }
          return { ok: res.ok, status: res.status, type, retry, text: text.slice(0, 12000), from: res.url || url };
        }
        if (!res.ok) {
          let said = '';
          try { said = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 240); } catch { /* no body to read */ }
          return { ok: false, status: res.status, type, retry, said };
        }
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (bytes.length > ${Number(maxBytes)}) return { ok: false, tooBig: bytes.length, type };
        let binary = '';
        const step = 0x8000;
        for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
        const head = new TextDecoder().decode(bytes.subarray(0, 400));
        return {
          ok: true,
          status: res.status,
          type,
          size: bytes.length,
          name: named ? decodeURIComponent(named[1]) : '',
          from: res.url || url,
          head: /</.test(head) ? head.replace(/\\s+/g, ' ').slice(0, 160) : '',
          b64: btoa(binary),
          via: 'page',
        };
      } catch (err) {
        // A cross-origin answer the page may not read is not a failure of the address.
        return { ok: false, crossOrigin: true, error: String((err && err.message) || err) };
      }
    })()`, { timeoutMs });
    if (!got) throw new Error('the page did not answer the fetch');
    if (!got.crossOrigin || json) return got;

    // The CDN leg: from Node, with the session's cookies for that host and the page's referrer.
    let pageUrl = '';
    try { pageUrl = String(await p.evaluate('location.href')); } catch { pageUrl = ''; /* the page went away; the referrer is optional */ }
    let cookie = '';
    try {
      const all = await browserConn.send('Storage.getCookies', {});
      const host = new URL(String(url)).hostname;
      cookie = (all?.cookies || [])
        .filter((c) => host === c.domain || host.endsWith(`.${String(c.domain || '').replace(/^\./, '')}`))
        .map((c) => `${c.name}=${c.value}`).join('; ');
    } catch { cookie = ''; /* no cookies for that host is a valid request */ }
    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
    if (pageUrl) headers.referer = pageUrl;
    if (cookie) headers.cookie = cookie;
    try {
      const res = await fetch(String(url), { headers, redirect: 'follow' });
      const type = res.headers.get('content-type') || '';
      if (!res.ok) {
        return { ok: false, status: res.status, type, said: '', via: 'node' };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) return { ok: false, tooBig: buf.length, type };
      const disposition = res.headers.get('content-disposition') || '';
      const named = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
      const head = buf.subarray(0, 400).toString('utf8');
      return {
        ok: true,
        status: res.status,
        type,
        size: buf.length,
        name: named ? decodeURIComponent(named[1]) : '',
        from: res.url || String(url),
        head: /</.test(head) ? head.replace(/\s+/g, ' ').slice(0, 160) : '',
        b64: buf.toString('base64'),
        via: 'node',
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /**
   * What an element says about itself: its tag, its attributes, its text and where it is.
   *
   * A page states facts in attributes as often as in prose — `data-game-id`, `data-file-id`,
   * `href`, `title` — and a model that can only read text cannot see them. That is what a
   * page's own script reads before it makes its XHR, so the tool offers the same view
   * (22 Nov: the file id was in an attribute and the download never started).
   */
  async function domQuery({ selector = '', attributes = true, limit = 12, timeoutMs = 20000 } = {}) {
    const p = await start();
    used();
    const rows = await p.evaluate(`(() => {
      const sel = ${JSON.stringify(String(selector || ''))};
      if (!sel) return null;
      const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const box = el.getBoundingClientRect();
        const attrs = {};
        if (${attributes ? 'true' : 'false'}) {
          for (const a of el.attributes) {
            if (!/^(data-|href$|src$|title$|aria-|name$|value$|type$|id$|class$)/i.test(a.name)) continue;
            attrs[a.name] = String(a.value).slice(0, 160);
            if (Object.keys(attrs).length >= 12) break;
          }
        }
        out.push({
          tag: el.tagName.toLowerCase(),
          text: clean(el.innerText || el.value || '').slice(0, 160),
          attrs,
          at: box.width && box.height ? [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)] : null,
          size: [Math.round(box.width), Math.round(box.height)],
        });
        if (out.length >= ${Math.max(1, Number(limit) || 12)}) break;
      }
      return out;
    })()`, { timeoutMs });
    return rows || [];
  }

  /** Where a saved file goes, under the project. Null when the server has no project. */
  const saveDir = () => downloadDir;

  const launchArgs = ({ position }) => [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    ...HIDDEN_FLAGS,
    ...(position ? [`--window-position=${position}`] : []),
    ...(startMinimized ? ['--start-minimized'] : []),
    `--window-size=${width},${height}`,
    'about:blank',
  ];

  /** What the keeper last wrote; a missing or half-written file is not an error. */
  const keeperState = () => {
    try {
      // Windows PowerShell's UTF8 encoding writes a BOM; JSON.parse does not accept one.
      const raw = fs.readFileSync(hiddenStateFile, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } catch { /* no keeper state, or not JSON yet */ return null; }
  };

  /** End the browser by the pid the keeper wrote — never by a process name. */
  const killByState = () => {
    const state = keeperState();
    if (state?.state === 'running' && Number(state.edgePid)) {
      try {
        spawnSync('taskkill', ['/PID', String(state.edgePid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch { /* already gone */ }
    }
  };

  /** Give up on a failed hidden launch without leaving an Edge on a dead desktop. */
  const stopKeeper = () => {
    try { child?.kill?.(); } catch { /* gone */ }
    child = null;
    killByState();
  };

  /**
   * Launch on a desktop of its own: headed, invisible, and never in the operator's
   * taskbar. The keeper creates the desktop, launches Edge there, writes its state and
   * waits; this side only sees the port Edge writes into the profile.
   */
  async function launchHidden(edge) {
    fs.mkdirSync(path.dirname(hiddenStateFile), { recursive: true });
    try { fs.rmSync(hiddenStateFile, { force: true }); } catch { /* fine */ }
    try { fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true }); } catch { /* fine */ }
    child = spawn(powershellPath(), [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', HIDDEN_DESKTOP_SCRIPT,
      '-EdgePath', edge,
      '-Profile', profile,
      '-StateFile', hiddenStateFile,
      '-Width', String(width),
      '-Height', String(height),
      '-ParentPid', String(process.pid),
      // Not detached: a detached PowerShell could not set up the desktop and the launch
      // silently fell back. The keeper still outlives a simple child.kill of the server,
      // and its parent check is what closes the Edge.
    ], { stdio: 'ignore', windowsHide: true, cwd: path.dirname(profile) });
    const port = await waitForPort(profile, { timeoutMs: 30000 });
    if (!port) {
      const state = keeperState();
      throw new Error(state?.error || 'the browser did not open a debugging port on the hidden desktop');
    }
    // A separate watchdog, detached, because the keeper can be killed with the server.
    // It needs no desktop, so it survives and ends the Edge tree by the pids it is given.
    const keeper = keeperState();
    if (keeper?.edgePid) {
      try {
        spawn(powershellPath(), [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', VISIBLE_WATCH_SCRIPT,
          '-ParentPid', String(process.pid),
          '-EdgePid', String(keeper.edgePid),
        ], { stdio: 'ignore', windowsHide: true, detached: true });
      } catch (err) {
        log?.warn?.(`browser: no hidden-browser watcher: ${err.message}`);
      }
    }
    child.port = port;
    note(`browser: started on a hidden desktop, port ${port}`);
    return port;
  }

  /**
   * The old off-screen window, kept as the fallback for a machine that refuses a desktop.
   * It is visible for a moment at launch; the operator's memory of that flash is why the
   * hidden desktop exists. It is still the path when `hiddenDesktop: false` is asked for
   * (tests, and a machine where CreateDesktop is refused).
   */
  async function launchVisible(edge) {
    try { fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true }); } catch { /* fine */ }
    const before = startMinimized ? await screenState().catch(() => null) : null;
    const area = before?.screens?.find((s) => !s.primary) || before?.screens?.[0] || null;
    // Off-screen for the moment it exists, so nothing is visible; the protocol puts it on
    // the right monitor and minimizes it a second later.
    child = spawn(edge, launchArgs({ position: '-32000,-32000' }), { stdio: 'ignore', detached: false, cwd: path.dirname(profile) });
    // A hand-off can be interrupted by Stop under the server that opened it; the watcher
    // closes the Edge tree when this process goes, by the two ids it was given.
    if (child.pid) {
      try {
        spawn(powershellPath(), [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', VISIBLE_WATCH_SCRIPT,
          '-ParentPid', String(process.pid),
          '-EdgePid', String(child.pid),
        ], { stdio: 'ignore', windowsHide: true, detached: true });
      } catch (err) {
        log?.warn?.(`browser: no visible-browser watcher: ${err.message}`);
      }
    }
    // Before the port is even open: the window is grabbed the instant it exists, so the
    // taskbar button it wears for those first seconds is gone (12 Nov).
    const early = hideBrowserWindow({ profile, waitMs: 15000 }).catch(() => null);
    // Immediately, not after the port is ready: the operator must not lose the caret for
    // the two seconds a browser takes to open (11 Nov).
    if (before?.foreground) restoreFocus(before.foreground).catch(() => {});
    const port = await waitForPort(profile, { timeoutMs: 30000 });
    if (!port) throw new Error('the browser did not open a debugging port');
    child.port = port;
    if (before?.foreground) {
      const back = await restoreFocus(before.foreground).catch(() => null);
      if (back) note(`browser: launch placed on ${area?.device || 'the primary'}; focus restored ${back.ok ? 'yes' : 'no'}`);
    }
    const hidden = await early;
    if (hidden?.toolWindow) note(`browser: window hidden (tool window yes, taskbar buttons removed ${hidden.tabsRemoved ?? 0})`);
    return port;
  }

  /**
   * The WebView2 host: a separate WPF process, off-screen by default. It can attach to a
   * host left by a previous server (same state file and a live CDP port) or start one.
   */
  async function startHost() {
    if (page && !(await alive())) {
      log?.info?.('browser: the WebView2 page is gone — starting again');
      page = null;
      agent = null;
      hostChild = null;
    }
    if (page) {
      ensureHostDownloads();
      return page;
    }
    if (starting) return starting;
    starting = (async () => {
      const existing = readHostState(host.stateFile);
      let port = 0;
      let reused = false;
      if (existing?.state === 'ready' && existing.port && await hostAlive(existing.port)) {
        port = Number(existing.port);
        reused = true;
        attached = true;
      } else {
        // A stale ready state can name a host whose port is gone; end that pid before the
        // profile is opened again. The pid is the state's, never a process name.
        if (existing?.state === 'ready' && existing.pid) {
          await stopHostProcess({ pid: existing.pid, stateFile: host.stateFile, log });
        }
        const exe = host.exe || hostBinary({ root: host.root });
        const launched = await launchHost({
          exe,
          profile,
          downloadDir,
          stateFile: host.stateFile,
          downloadsFile: host.downloadsFile,
          visible: host.visible === true,
          parentPid: process.pid,
          width,
          height,
          log,
        });
        hostChild = launched.child;
        port = launched.port;
        attached = false;
      }
      const conn = await connect(port);
      page = { ...conn, port, profile };
      await conn.send('Page.enable');
      await conn.send('Runtime.enable');
      try { await conn.send('Page.bringToFront'); } catch { /* an off-screen window may refuse */ }
      try { await conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); } catch { /* fine */ }
      agent = actionLayer ? createAgent({ port, log, session: `synapse-${port}` }) : null;
      if (actionLayer && !agent.available) note('browser: agent-browser is not installed — run vendor-agent-browser.ps1; snapshot and ref clicks will say so');
      ensureHostDownloads();
      note(`browser: ${reused ? 'attached to' : 'started'} the WebView2 host on port ${port}`);
      return page;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  async function stopHostMode() {
    try { await agent?.close?.(); } catch { /* daemon already gone */ }
    agent = null;
    stopHostDownloads();
    try { browserConn?.close?.(); } catch { /* gone */ }
    browserConn = null;
    browserPort = null;
    const pid = hostChild?.pid || readHostState(host.stateFile)?.pid;
    const hwnd = readHostState(host.stateFile)?.hwnd;
    if (page) {
      try { page.close(); } catch { /* fine */ }
      page = null;
    }
    hostChild = null;
    await stopHostProcess({ pid, hwnd, stateFile: host.stateFile, log });
    attached = false;
    return 0;
  }

  /** Start the browser if it is not running, and attach to its page. */
  async function start() {
    if (host) return startHost();
    // The page we hold may be gone: the operator closed the window after signing in, or
    // the idle reaper closed it from another process. A dead page is not an error to
    // report — it is a browser to open again (11 Nov).
    if (page && !(await alive())) {
      log?.info?.('browser: the page is gone — starting again');
      page = null;
      child = null;
      agent = null;
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
      attached = Boolean(existing);
      let port = existing;
      if (!port) {
        if (hiddenDesktop) {
          try {
            port = await launchHidden(edge);
          } catch (err) {
            // A desktop can be refused (policy, a service session). A browser that only
            // flashes is better than no browser, and the log says which one ran.
            note(`browser: the hidden desktop failed (${err.message}); falling back to an off-screen window`);
            stopKeeper();
            await new Promise((r) => setTimeout(r, 500));
            port = await launchVisible(edge);
          }
        } else {
          port = await launchVisible(edge);
        }
      }
      const conn = await connect(port);
      page = { ...conn, port, profile };
      await conn.send('Page.enable');
      await conn.send('Runtime.enable');
      // The tab must be the active one or a challenge that runs on a timer never ends.
      try { await conn.send('Page.bringToFront'); } catch { /* a hidden window may refuse */ }
      try { await conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); } catch { /* fine */ }
      if (existing) {
        // A browser that outlived a Synapse restart may still wear an off-screen window
        // from an older build. Hiding finds nothing on a hidden desktop and costs nothing.
        const hidden = await hideBrowserWindow({ profile }).catch(() => null);
        if (hidden?.toolWindow) note(`browser: window hidden (attached, taskbar buttons removed ${hidden.tabsRemoved ?? 0})`);
      }
      agent = actionLayer ? createAgent({ port, log, session: `synapse-${port}` }) : null;
      if (actionLayer && !agent.available) note('browser: agent-browser is not installed — run vendor-agent-browser.ps1; snapshot and ref clicks will say so');
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
    // A page whose text arrives after its document (a storefront, a forum, a shop) was read
    // as "(no title)" with an empty body: the model then clicked into nothing and started
    // guessing coordinates (22 Nov, Nexus). Give the words a few seconds to exist.
    for (let i = 0; i < 20; i += 1) {
      let words = 0;
      try {
        words = await p.evaluate("String(document.body && document.body.innerText || '').trim().length");
      } catch { break; /* the page went away mid-wait; the address read below will say so */ }
      if (Number(words) > 120) break;
      await new Promise((r) => setTimeout(r, 150));
    }
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

      // What can be *clicked* and is not a link: buttons, tabs, menu items, and anything that
      // draws a pointer because a handler is on it. A model reading only links could not see
      // the download row on Nexus, tried coordinates from a picture, and had its click moved
      // 83 px onto a neighbouring link (22 Nov). Only what is on screen is listed, because
      // these are viewport coordinates a click uses as they are.
      const seenControl = new Set();
      const controlSel = 'button,[role=button],[role=tab],[role=menuitem],[role=link],input[type=submit],input[type=button],select,summary';
      const controls = [];
      const addControl = (el) => {
        if (el.closest('a[href]')) return;         // already listed as a link
        const box = el.getBoundingClientRect();
        if (box.width < 6 || box.height < 6) return;
        if (box.bottom < 0 || box.top > innerHeight) return;
        const label = clean(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 60);
        if (!label || label.length < 2) return;
        const key = label.toLowerCase();
        if (seenControl.has(key)) return;
        seenControl.add(key);
        controls.push({ text: label, at: [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)] });
      };
      for (const el of document.querySelectorAll(controlSel)) addControl(el);
      for (const el of document.querySelectorAll('div,span,li')) {
        if (controls.length >= 40) break;
        const text = clean(el.innerText || '');
        if (!text || text.length > 70 || el.children.length > 3) continue;
        try { if (getComputedStyle(el).cursor !== 'pointer') continue; } catch { continue; /* a detached node */ }
        addControl(el);
      }

      // A widget in its own frame: its words are not in this document, so it is named with
      // the coordinate a click uses. A download popup, a payment box and a map are all this,
      // and navigating to the frame's src is what a model tried and lost a turn to (22 Nov).
      const frames = [...document.querySelectorAll('iframe')].map((f) => {
        const box = f.getBoundingClientRect();
        if (box.width < 40 || box.height < 40) return null;
        if (box.bottom < 0 || box.top > innerHeight) return null;
        return {
          name: clean(f.getAttribute('title') || f.name || '') || 'a frame with no name',
          src: String(f.src || '').slice(0, 160),
          at: [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)],
          size: [Math.round(box.width), Math.round(box.height)],
        };
      }).filter(Boolean).slice(0, 6);

      // The sources of the page's frames and scripts: what a bot check is built out of.
      const srcs = [...document.querySelectorAll('iframe[src],script[src]')]
        .map((el) => String(el.src || '')).join(' ').slice(0, 4000);

      // total is what the page held, chars is what this read returns: the tool says
      // the difference so a model knows it is reading a cut (13 Nov).
      return { url: location.href, title: document.title, text, links: anchor, controls: controls.slice(0, 40), frames, srcs, wall, chars: text.length, total: full.length };
    })()`);
    // The page's own words decide both a wall and a 404: what a person sees, not a guess
    // about the URL.
    page.wall = page.wall || botWall(page.text, page.srcs);
    page.missing = pageMissing(page.text, page.title);
    page.downloaded = pageDownloaded(page.text);
    page.refused = pageRefused(page.text, page.title);
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
  async function click({ selector = null, text = null, at = null, ref = null, settle = 700, snapPx = 28 } = {}) {
    const p = await start();
    used();
    const since = Date.now();
    // A ref from `snapshot` is the reliable click: agent-browser resolves the element,
    // scrolls it into view and refuses when it is covered or hidden, instead of sending a
    // synthetic point and hoping. The rest of this function is the coordinate fallback.
    if (ref) {
      if (!agent?.available) throw new Error('agent-browser is not installed — run vendor-agent-browser.ps1');
      const usedRef = await agent.click(ref);
      await new Promise((r) => setTimeout(r, settle));
      let url = '';
      try { url = await p.evaluate('location.href'); } catch { /* the click replaced the document */ }
      const download = downloadDir ? await waitForDownload({ since, graceMs: 900 }) : null;
      return {
        url,
        ref: usedRef,
        at: null,
        requested: null,
        snapped: null,
        clamped: false,
        ...(download ? { download } : {}),
      };
    }
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
        const candidates = [...document.querySelectorAll('a,button,[role="button"],[role="tab"],[role="link"],[role="menuitem"],[onclick],input[type="submit"],summary,label')];
        const hit = candidates.find((el) => clean(el.innerText || el.value || '').toLowerCase() === want)
          || candidates.find((el) => clean(el.innerText || el.value || '').toLowerCase().includes(want));
        if (hit) return pick(hit);
        // Then anything that behaves clickable: a div with a pointer cursor and a handler
        // (a download row, a card, a tab built out of spans) is a control to the operator.
        // The words are usually on a leaf whose own cursor is auto, with the handler on
        // the box around it, so the leaf is climbed until something behaves like a control.
        const clickable = (el) => {
          let node = el;
          for (let i = 0; node && i < 5; i += 1, node = node.parentElement) {
            if (node.matches && node.matches('a,button,[role],[onclick],[tabindex]')) return node;
            try {
              if (getComputedStyle(node).cursor === 'pointer' && node.getBoundingClientRect().height >= 4) return node;
            } catch { /* detached */ }
          }
          return null;
        };
        const holds = [...document.querySelectorAll('*')].filter((el) => {
          const text = clean(el.innerText || '');
          return text && text.length <= 120 && text.toLowerCase().includes(want);
        }).sort((a, b) => clean(a.innerText).length - clean(b.innerText).length);
        for (const el of holds.slice(0, 30)) {
          const box = clickable(el);
          if (box) return pick(box);
        }
        return pick(null);
      })()`);
      // A page can show text that is not a control — a hint, a label, an overlay's
      // message. Saying which is what turns a failed click into the next step, and so is
      // saying whether the words are on the page at all: "not a control" and "not loaded
      // yet" are two different next moves (22 Nov, Nexus read as an empty page).
      if (!found) {
        const seen = await p.evaluate(`(() => {
          const want = ${JSON.stringify(String(text || '')).toLowerCase()};
          const all = String(document.body ? document.body.innerText : '');
          if (!want) return { where: 'none' };
          const at = all.toLowerCase().indexOf(want);
          if (at < 0) return { where: 'missing', chars: all.trim().length };
          const line = all.slice(Math.max(0, at - 40), at + want.length + 40).replace(/\\s+/g, ' ').trim();
          return { where: 'text', line };
        })()`).catch(() => ({ where: 'none' }));
        const why = seen?.where === 'missing'
          ? ` The page's text does not contain it either (${Number(seen.chars) || 0} characters on the page) — it may still be loading: wait, then read again.`
          : seen?.where === 'text'
            ? ` It is in the page's text (…${seen.line}…) but not on a control — scroll it into view with read's coordinates, or click a CSS selector.`
            : ' That is not a link, a button or a form control — use an x/y from read, or a CSS selector.';
        throw new Error(`nothing to click: ${selector || text}.${why}`);
      }
      point = found;
    }
    const [wantedX, wantedY] = point;
    const aim = await p.evaluate(`(() => {
      const snapPx = ${Number(snapPx) || 0};
      // What can be clicked is not only a link or a button: a row that starts a download can
      // be a div with a pointer cursor and a handler (Nexus's file rows are exactly that),
      // and the old list could not see it — the model's aim was thrown at the nearest link
      // instead, 83 px away, and the answer said it had landed (22 Nov).
      const control = 'a,button,[role=button],[role=tab],[role=link],[role=menuitem],[onclick],input,select,textarea,summary,label';
      const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
      const x = Math.round(clamp(${Number(wantedX)}, 0, Math.max(0, innerWidth - 2)));
      const y = Math.round(clamp(${Number(wantedY)}, 0, Math.max(0, innerHeight - 2)));
      const label = (el) => String(el?.innerText || el?.value || el?.getAttribute?.('aria-label') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 60);
      const under = document.elementFromPoint(x, y);
      // The nearest thing above the point that behaves like a control, however it is built.
      const behavesClickable = (el) => {
        let node = el;
        for (let i = 0; node && i < 6; i += 1, node = node.parentElement) {
          if (node.matches && node.matches(control)) return node;
          try {
            const cs = getComputedStyle(node);
            if (cs.cursor === 'pointer' && node.getBoundingClientRect().height >= 4) return node;
          } catch { /* a detached node */ }
        }
        return null;
      };
      const direct = under ? behavesClickable(under) : null;
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
      // The number that matters is how far the click will land from where it was asked. The
      // distance to the element's *box* said "0 px away" for a click that moved 83 px to the
      // middle of that box, which is how a model came to believe it had hit the row.
      const away = Math.round(Math.sqrt((tx - x) ** 2 + (ty - y) ** 2));
      return { x: tx, y: ty, snapped: { from: [x, y], to: [tx, ty], px: away, label: label(best) },
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

  /** Type into whatever has focus (or into a selector first). A ref fills the field. */
  async function type({ text, selector = null, ref = null, submit = false } = {}) {
    const p = await start();
    used();
    if (ref) {
      if (!agent?.available) throw new Error('agent-browser is not installed — run vendor-agent-browser.ps1');
      // A ref writes into the element itself, not into whatever happens to have focus; it
      // clears the field first, which is what a login or a search box wants.
      await agent.fill(ref, text);
    } else {
      if (selector) await p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
      await p.send('Input.insertText', { text: String(text ?? '') });
    }
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
      `(() => {
        const text = document.body ? String(document.body.innerText || '').slice(0, 3000) : '';
        const links = [...document.querySelectorAll('a,button')].slice(0, 400);
        const visible = (el) => {
          if (!el.getClientRects().length) return false;
          const style = getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const signInLink = links.some((el) => {
          if (!visible(el)) return false;
          const label = String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
          const href = String(el.getAttribute('href') || '');
          return /^(log ?in|sign ?in)$/i.test(label) || /(?:^|\\/)(?:log-?in|sign-?in|signin|auth)(?:[/?#]|$)/i.test(href);
        });
        const wall = /just a moment|checking your browser|performing security verification|verify you are human|attention required/i.test(text)
          || /just a moment/i.test(document.title);
        return { url: location.href, passwords: document.querySelectorAll('input[type=password]').length, ready: document.readyState, signInLink, wall };
      })()`,
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
    // The WebView2 host is out of process and the operator closes it when the sign-in is
    // done. Hiding its WPF window from here would need a window handle; the close is the
    // end of the hand-off either way.
    if (host) return false;
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

  /**
   * The page as controls with stable refs — the surface a model should act on.
   *
   * A screenshot makes the model do geometry; this makes it read a name and click a ref.
   * agent-browser owns the accessibility tree walk, the ref lifecycle and the refusal when
   * an element is covered or hidden, which is why it lives in agent.js rather than here.
   */
  async function snapshot({ interactive = true, compact = false, depth = null, selector = null } = {}) {
    await start();
    used();
    if (!agent?.available) throw new Error('agent-browser is not installed — run vendor-agent-browser.ps1');
    return agent.snapshot({ interactive, compact, depth, selector });
  }

  /** Close the browser: the profile and its session stay. */
  async function stop() {
    if (host) return stopHostMode();
    const exited = [];
    // The action daemon first: it holds a CDP connection to the page that is about to go.
    try { await agent?.close?.(); } catch { /* daemon already gone */ }
    agent = null;
    try { browserConn?.close?.(); } catch { /* gone */ }
    browserConn = null;
    browserPort = null;
    if (page) {
      // The browser may already be closed (the operator closed the hand-off window), and
      // a request to a half-open socket would wait the protocol's whole minute. Three
      // seconds is enough for a live browser; the keeper and the pid wait handle the rest.
      try { await page.send('Browser.close', {}, 3000); } catch { /* already gone */ }
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
        const timer = setTimeout(done, 4000);
        proc.once('exit', () => { clearTimeout(timer); done(); });
        if (proc.exitCode !== null) { clearTimeout(timer); done(); }
      });
      if (proc.exitCode === null) {
        if (hiddenDesktop) {
          try { proc.kill(); } catch { /* gone */ }
          // The hidden keeper may have lost the close race with Edge. Its state file names
          // the pid it launched; that is the identity to end — never a process name.
          killByState();
        } else if (proc.pid) {
          // A visible Edge's children can hold the profile after the window closes; the
          // hidden browser cannot start until they are gone.
          try {
            spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } catch { /* already gone */ }
        }
      }
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

  return { start, running, alive, pageState, goto, read, captureFull, snapshot, click, type, press, wait, scroll, screenshot, watch, tabs, clearSite, hideWindow, stop, downloadFrom, waitForDownload, saveFrom, saveDir, domQuery, downloads: downloadList, profile, hostMode: Boolean(host), isAttached: () => attached };
}
