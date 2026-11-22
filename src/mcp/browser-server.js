// SynaBrowse's MCP server: the tools a model uses to drive the harness's own browser.
//
// Registered next to synapse-search, synapse-delegate and synapse-lease in the engine's
// isolated config. The browser is real Edge — its own profile, never the operator's, never
// Brave — hidden until a human is needed; see src/browser/browser.js for why each launch
// flag is there.
//
// Rules this server keeps, because a tool is a promise:
//   - a page must be an http(s) address — no file://, nothing that reaches past a URL;
//   - nothing here reads a cookie, exports a session or runs an arbitrary script: the
//     toolset is a fixed list of operations;
//   - a screenshot or a strip of frames is written under the **project** (`.project\browser\`),
//     so it is deleted with the project and never mixes two projects' browsing; the path is
//     answered, so the model can look at it.
//
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, WEB_DIR, PROJECTS_ROOT } from '../paths.js';
import { artifactDir } from '../browser/artifacts.js';
import { clickSummary, createBrowser, findEdge, savedAnswer, requestAnswer, domAnswer } from '../browser/browser.js';
import { formatBytes, safeDownloadName, uniqueDownloadPath } from '../browser/downloads.js';
import { checkUrl, hostOf, localPageAllowed } from '../browser/allow.js';
import { askOperator } from '../browser/handoff.js';
import { watchForSignIn } from '../browser/session-watch.js';
// The descriptions a model reads live in their own file, so they can be tested without
// starting this server — importing this one starts it, and it waits on stdin (13 Nov).
import { TOOLS } from './browser-tools.js';

const PROTOCOL_VERSION = '2024-11-05';
// Its own sound: two hollow knocks on a plastic cup, not the finished-work chime.
const CHIME = path.join(WEB_DIR, 'sounds', 'hollow.wav');

/** The browser settings, read once: the operator edits the config file, not a UI here. */
function settings() {
  // A test seam: the suite drives this server against a throwaway profile
  // rather than the operator's config, so the tools can be proved without touching it.
  const file = process.env.SYNAPSE_BROWSER_CONFIG
    || path.join(DATA_DIR, '..', 'config', 'synapse.config.json');
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No config file yet: everything is off, which is the safe answer.
    raw = {};
  }
  const b = raw?.browser || {};
  return {
    enabled: b.enabled === true,
    profile: String(b.profile || '').trim() || path.join(DATA_DIR, 'browser', 'profile'),
    // One chime when the window is put on the second monitor; the operator's switch,
    // beside the screen sounds in Settings > General.
    sounds: raw?.notify?.browserSounds !== false,
    idleMinutes: Number(raw?.browser?.idleMinutes) || 5,
  };
}

// The engine starts this server with the *project* as its working directory, which is how
// the artifacts folder is found — and a process whose cwd is inside a folder keeps that
// folder undeletable on Windows: deleting the project then failed with "The directory is
// not empty" from the Recycle Bin (11 Nov, reproduced: EPERM). So the path is taken once,
// and then the process steps out of the project and holds nothing of the operator's.
const ARTIFACTS = artifactDir();
const START_DIR = process.cwd();
// A download is a project file. A server whose cwd is not a project (the projects root,
// the harness) has no folder to put one in; it must not invent one under the harness.
const IN_PROJECT = path.resolve(START_DIR).toLowerCase().startsWith(`${path.resolve(PROJECTS_ROOT).toLowerCase()}${path.sep}`);
const DOWNLOADS = IN_PROJECT ? path.join(START_DIR, '.project', 'downloads') : null;
try { process.chdir(DATA_DIR); } catch { /* the harness folder exists; nothing to do */ }

const cfg = settings();

/**
 * Tell the page about a download. The browser owns the bytes; Synapse only draws the
 * progress. Progress is throttled to four a second — a fast download would otherwise
 * put hundreds of SSE frames on the page for one file — and every state change is sent.
 */
const reported = new Map();
function reportDownload(rec) {
  const now = Date.now();
  const final = !['starting', 'inProgress', 'saving'].includes(rec.state);
  const last = reported.get(rec.id) || 0;
  if (!final && now - last < 250) return;
  reported.set(rec.id, now);
  const rel = rec.path ? path.relative(START_DIR, rec.path).replace(/\\/g, '/') : '';
  fetch('http://127.0.0.1:8700/api/browser/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dir: START_DIR,
      id: rec.id,
      name: rec.name,
      received: rec.received,
      total: rec.total,
      state: rec.state,
      path: rel,
      error: rec.error || '',
      startedAt: rec.startedAt,
      at: now,
    }),
  }).catch(() => { /* the app may be down; the file is still saved */ });
}

const browser = createBrowser({
  profile: cfg.profile,
  idleMs: cfg.idleMinutes * 60 * 1000,
  downloadDir: DOWNLOADS,
  onDownload: reportDownload,
  log: { info: (m) => process.stderr.write(`${m}\n`) },
});



function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const result = (id, payload) => send({ jsonrpc: '2.0', id, result: payload });
// The call in flight, for the one line that says how long it took and whether it worked. A
// tool that answers nothing is invisible in the logs; a tool that answers "click 41ms failed"
// is a bug with a shape.
let timing = null;
const toolText = (id, text, isError = false) => {
  if (timing) {
    process.stderr.write(`tool ${timing.name} ${Date.now() - timing.began}ms ${isError ? 'failed' : 'ok'}\n`);
    timing = null;
  }
  return result(id, { content: [{ type: 'text', text }], isError });
};

// ── helpers ──────────────────────────────────────────────────────
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * A readable outline: what the page says, and what can be clicked.
 *
 * `maxChars` and `links` are the caller's, not this function's: the tool used to cut every
 * page at 6,000 characters however much was asked for, and said nothing when it did, so a
 * model reading a long thread believed it had the whole thing (13 Nov — two models benched
 * against one thread, both handed a cut).
 *
 * A cut now says so, with the size of what is missing and the two ways to get it.
 */
const outline = (page, { maxChars = 6000, links = 60 } = {}) => {
  const lines = [`# ${page.title || '(no title)'}`, page.url, ''];
  const total = Number(page.total) || String(page.text || '').length;
  const shown = String(page.text || '').slice(0, maxChars);
  lines.push(shown);
  if (total > shown.length) {
    lines.push(
      '',
      `[… truncated: ${shown.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters. ` +
        'Ask again with a larger maxChars (up to 30000), or scroll and read again for the rest.]',
    );
  }
  if (page.links?.length) {
    lines.push('', 'Links:');
    for (const link of page.links.slice(0, links)) lines.push(`- ${link.text} -> ${link.href} (${link.at.join(',')})`);
  }
  // Not everything clickable is a link. A button, a tab or a row that behaves like one is
  // listed with its coordinate, so a model clicks what it read instead of guessing from a
  // picture: the Nexus download row was invisible here, and the guess landed on a link.
  if (page.controls?.length) {
    lines.push('', 'Buttons and tabs (click by text, or by x,y as it is):');
    for (const c of page.controls) lines.push(`- ${c.text} (${c.at.join(',')})`);
  }
  return lines.join('\n');
};

/**
 * Refuse what the browser must not open, in words the model can act on.
 *
 * There is no host list any more: the operator's short answer was "the sites I am logged
 * into", so the fence is the master switch, and the Sites table is a record of the
 * sessions rather than a permission list. What is still refused is a scheme a browser
 * would not treat as a page, and a local file outside the projects folder — `file://` must
 * not become a way around the harness's own rules (14 Nov: a model's own mock is allowed,
 * the harness and the rest of the machine are not).
 */
function guard(url) {
  const text = String(url || '').trim();
  if (/^file:/i.test(text)) {
    const local = localPageAllowed(text, { root: PROJECTS_ROOT });
    if (!local.ok) throw new Error(local.reason);
    return { ok: true, host: '', local: true, path: local.path };
  }
  const verdict = checkUrl(text, ['*']);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict;
}

/** The sentence a download leaves in the tool answer. */
function downloadAnswer(rec) {
  if (!rec) return '';
  const rel = rec.path
    ? path.relative(START_DIR, rec.path).replace(/\\/g, '/')
    : path.relative(START_DIR, path.join(DOWNLOADS || START_DIR, rec.name)).replace(/\\/g, '/');
  if (rec.state === 'completed') {
    return `Downloaded ${rec.name} (${formatBytes(rec.received || rec.total)}) to ${rel}. ` +
      `In the chat, cite it as [${rec.name}](${rel}).`;
  }
  if (rec.state === 'canceled' || rec.state === 'interrupted') {
    return `The download of ${rec.name} ${rec.state}: ${rec.error || 'the browser stopped it'}.`;
  }
  const pct = rec.total > 0 ? ` (${Math.round((rec.received / rec.total) * 100)}%)` : '';
  return `Downloading ${rec.name}: ${formatBytes(rec.received)}${rec.total ? ` of ${formatBytes(rec.total)}` : ''}${pct}. ` +
    `It is being saved to ${rel}; the chat shows the progress.`;
}

/**
 * Say it plainly when the page is a sign-in wall.
 *
 * The wall is visible to the page itself (a password box, a sign-in form), so the model
 * does not have to infer it from the prose; and the answer names the tool that fixes it.
 * A model that scrapes around a login page burns a turn and returns junk.
 */
function wallNote(page) {
  if (!page?.wall) return '';
  const host = hostOf(page.url) || 'this site';
  // A bot check is not a sign-in, and the two have different answers: a person clears a
  // captcha once and the session keeps the clearance, while a saved sign-in that expired
  // needs the password again. Saying "sign in" to a Cloudflare challenge sends a model to
  // the wrong move (22 Nov: "Just a moment…" read as a page, then a 403 on the fetch).
  if (/bot check/i.test(page.wall)) {
    return `\n\nThis page is ${page.wall}, and it has to be cleared by a person. ` +
      'Call `handoff` with what="clear the check on ' + host + '", wait for the operator, then try again. ' +
      'Do not keep retrying: a challenge that is clicked at gets longer, not shorter.';
  }
  const known = (cfg.sites || []).some((site) => host === site.host || host.endsWith(`.${site.host}`));
  if (known) {
    return `\n\nThis page is asking you to sign in again (${page.wall}) — the saved session for ${host} has expired. ` +
      `Call \`handoff\` with what="sign in to ${host}", wait for the operator, then read again.`;
  }
  return `\n\nThis page needs a sign-in only the operator can give (${page.wall}), and ${host} is not in the Signed In table. ` +
    `Call \`handoff\` with what="sign in to ${host}", wait for them to finish, then read again. ` +
    'Do not scrape around it or guess at the content.';
}

/** Record that the profile opened a host it has a session for (best effort). */
function noteUsed(url) {
  const host = hostOf(url);
  if (!host || !(cfg.sites || []).some((site) => host === site.host || host.endsWith(`.${site.host}`))) return;
  fetch('http://127.0.0.1:8700/api/browser/used', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host }),
  }).catch(() => { /* the app may not be listening; a date is not worth an error */ });
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'synapse-browser', version: '1.0.0' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });

    case 'tools/call': {
      const name = String(params?.name || '');
      const args = params?.arguments || {};
      // Every call is timed, and every call answers in words. Three clicks came back with no
      // text at all on 22 Nov, which leaves a model with nothing to act on; the log line is
      // how the next one is found instead of guessed at.
      timing = { name, began: Date.now() };
      try {
        if (!cfg.enabled) {
          return toolText(id, 'SynaBrowse is switched off. The operator turns it on in Settings > Browser.', true);
        }
        if (!findEdge()) return toolText(id, 'There is no Edge on this machine, so SynaBrowse cannot run.', true);

        switch (name) {
          case 'open': {
            const verdict = guard(args.url);
            const url = await browser.goto(args.url, { settle: Number(args.settleMs ?? 900) });
            const page = await browser.read({});
            noteUsed(page.url);
            process.stderr.write(`open ${verdict.local ? verdict.path : verdict.host} -> ${url}\n`);
            return toolText(id, `Opened ${url}\n\n${outline(page, { maxChars: 6000, links: 60 })}${wallNote(page)}`);
          }
          case 'read': {
            // `full` walks the page to its end and leaves the whole of it in the project,
            // because a long thread cannot fit in one answer and a model stitching six
            // pieces together is a model working from a guess (13 Nov).
            if (args.full === true) {
              const whole = await browser.captureFull({
                links: Math.min(120, Math.max(0, Number(args.links ?? 0))),
                mode: args.mode === 'text' ? 'text' : 'article',
              });
              const pages = path.join(ARTIFACTS, 'pages');
              fs.mkdirSync(pages, { recursive: true });
              const slug =
                String(whole.title || whole.url || 'page')
                  .replace(/[^a-z0-9]+/gi, '-')
                  .replace(/^-+|-+$/g, '')
                  .slice(0, 60) || 'page';
              const file = path.join(pages, `${slug}-${stamp()}.md`);
              const headings = (whole.text || '')
                .split('\n')
                .filter((line) => /^#{1,3} /.test(line))
                .slice(0, 40);
              fs.writeFileSync(
                file,
                [
                  `# ${whole.title || '(no title)'}`,
                  '',
                  `Source: ${whole.url}`,
                  `Captured: ${new Date().toISOString()} (${whole.chars} characters, ${whole.scrolled} scroll step(s))`,
                  '',
                  headings.length ? '## In this page' : '',
                  ...headings.map((h) => `- ${h.replace(/^#+ /, '')}`),
                  '',
                  '---',
                  '',
                  whole.text || '',
                ].join('\n'),
                'utf8',
              );
              noteUsed(whole.url);
              const rel = path.relative(START_DIR, file).replace(/\\/g, '/');
              const k = Math.round((whole.chars || 0) / 4000);
              return toolText(
                id,
                `The whole page is saved: ${file}\n` +
                  `${whole.chars} characters (about ${k}K tokens), ${headings.length} heading(s)` +
                  `${whole.capped ? ', cut at the capture ceiling' : ''}.\n` +
                  'Read it in pieces with the read tool (offset and limit), or grep it — ' +
                  'do not ask this page for the same text again.\n' +
                  `It is a file, not a picture: cite it as ${rel} if you need to name it.` +
                  `${wallNote(whole)}`,
              );
            }
            const page = await browser.read({
              maxChars: Math.min(100000, Math.max(1000, Number(args.maxChars) || 6000)),
              links: Math.min(120, Math.max(0, Number(args.links ?? 60))),
              mode: args.mode === 'text' ? 'text' : 'article',
            });
            noteUsed(page.url);
            return toolText(id, `${outline(page, { maxChars: args.maxChars, links: args.links })}${wallNote(page)}`);
          }
          case 'click': {
            const at = Number.isFinite(args.x) && Number.isFinite(args.y) ? [Number(args.x), Number(args.y)] : null;
            const res = await browser.click({ selector: args.selector || null, text: args.text || null, at });
            // The click answers where it landed; a string is the address alone, which is
            // what every earlier caller expected.
            const url = typeof res === 'string' ? res : res?.url || '';
            const snap = typeof res === 'object' && res?.snapped ? res.snapped : null;
            const landed = typeof res === 'object' && Array.isArray(res?.at) ? res.at : null;
            // A click can navigate anywhere; the landing page is judged like a new open.
            // But a click that reloads the document can come back with no address at all —
            // the evaluate ran while the page was being replaced — and judging "no address"
            // as a refused page turned a working click into an error on a local mock
            // (14 Nov: "click failed: that is not an http(s) address").
            if (url) guard(url);
            const download = typeof res === 'object' ? res?.download : null;
            return toolText(
              id,
              `Clicked ${args.selector || args.text || `${args.x},${args.y}`}${clickSummary(res)}${url ? ` -> ${url}` : ''}` +
                `${download ? `\n${downloadAnswer(download)}` : ''}`,
            );
          }
          case 'download': {
            // A direct file URL, or the download a page button just started. The click
            // path already waits; this is the explicit route for a URL that is a file.
            const url = String(args.url || '').trim();
            const timeoutMs = Math.min(600_000, Math.max(1000, Number(args.timeoutMs) || 120_000));
            let rec = null;
            if (url) {
              guard(url);
              rec = await browser.downloadFrom(url, { timeoutMs });
            } else {
              const active = browser.downloads().find((d) => ['starting', 'inProgress', 'saving'].includes(d.state));
              rec = active ? await browser.waitForDownload({ since: active.startedAt, graceMs: 1000, timeoutMs }) : null;
            }
            if (!rec) {
              // The click may have been answered by a wall instead of a file: say which.
              const wall = await browser.read({ maxChars: 800, links: 0 }).then((p) => p?.wall || '').catch(() => '');
              return toolText(
                id,
                wall
                  ? `No download started: the page is now ${wall}. A person has to clear it — use handoff, ` +
                      'or ask the operator to take the download from here.'
                  : 'No download started. If the file is behind a button, click it (click waits for the download); ' +
                      'if it is a direct address, call download with that url, or save to fetch it through the page.',
                true,
              );
            }
            return toolText(id, downloadAnswer(rec), rec.state === 'canceled' || rec.state === 'interrupted');
          }
          case 'save': {
            const url = String(args.url || '').trim();
            if (!url) return toolText(id, 'save needs a url.', true);
            guard(url);
            const dir = browser.saveDir && browser.saveDir();
            if (!dir) {
              return toolText(id, 'This browser session is not inside a project, so there is nowhere to put a file.', true);
            }
            const timeoutMs = Math.min(300_000, Math.max(1000, Number(args.timeoutMs) || 120_000));
            const method = String(args.method || 'GET').toUpperCase();
            const form = args.form && typeof args.form === 'object' ? args.form : null;
            const xhr = args.xhr === true;
            const asJson = args.json === true;
            const rec = await browser.saveFrom(url, { method, form, xhr, json: asJson, timeoutMs });
            if (asJson) {
              const answer = requestAnswer(rec);
              // A request refused while the page is a challenge is the challenge, not the
              // address: say so, and say what clears it (22 Nov, 403 "Just a moment…").
              if (answer.isError) {
                const page = await browser.read({ maxChars: 600, links: 0 }).catch(() => null);
                if (page?.wall) {
                  return toolText(id, `${answer.text}${wallNote(page)}`, true);
                }
              }
              return toolText(id, answer.text, answer.isError);
            }
            const answer = savedAnswer(rec);
            if (answer?.isError) return toolText(id, answer.text, true);
            fs.mkdirSync(dir, { recursive: true });
            const name = safeDownloadName(
              rec.name || decodeURIComponent((String(url).split('?')[0].split('/').pop() || '').slice(0, 120)) || 'download',
            );
            const file = uniqueDownloadPath(dir, name);
            fs.writeFileSync(file, Buffer.from(String(rec.b64 || ''), 'base64'));
            const bytes = fs.statSync(file).size;
            const rel = path.relative(START_DIR, file).replace(/\\/g, '/');
            noteUsed(url);
            process.stderr.write(`save ${method} ${url} -> ${rel} (${bytes} bytes, via ${rec.via || 'page'})\n`);
            const done = savedAnswer({ ...rec, size: bytes, name: path.basename(file) || name }, { dir, rel });
            return toolText(id, done.text, done.isError);
          }
          case 'dom': {
            const rows = await browser.domQuery({
              selector: String(args.selector || ''),
              limit: Math.min(40, Math.max(1, Number(args.limit) || 12)),
            });
            if (!rows.length) {
              return toolText(
                id,
                `Nothing matches ${args.selector} on this page. A selector is CSS: "a[href*=download]", ".mod-file-download", "[data-file-id]". ` +
                  'If the page is a widget, its content is in a frame — read lists the frames.',
                true,
              );
            }
            return toolText(id, domAnswer(String(args.selector || ''), rows));
          }
          case 'type':
            await browser.type({ text: args.text, selector: args.selector || null, submit: args.submit === true });
            return toolText(id, `Typed ${String(args.text).length} characters${args.submit ? ' and pressed Enter' : ''}.`);
          case 'press':
            await browser.press(args.key);
            return toolText(id, `Pressed ${args.key}.`);
          case 'wait': {
            const waited = await browser.wait({
              text: args.text || null,
              selector: args.selector || null,
              ms: args.ms ?? null,
              timeoutMs: Math.min(120000, Math.max(1000, Number(args.timeoutMs) || 20000)),
            });
            const secs = `${Math.round((Number(waited.elapsedMs) || 0) / 100) / 10}s`;
            if (waited.ok) return toolText(id, `It happened after ${secs}.`);
            // The answer to a timeout is the useful part: missing from the page, or in
            // it and hidden — a collapsed comment, a closed menu, a tooltip (14 Nov).
            const what = args.selector ? `the selector ${args.selector}` : `the text "${args.text}"`;
            if (waited.hidden) {
              return toolText(
                id,
                `Not shown: after ${secs} ${what} is not displayed, but it is in the page's HTML — a collapsed comment, ` +
                  `a closed menu or a tooltip. Open that, then wait again; or read the page to see what is rendered.`,
                true,
              );
            }
            return toolText(
              id,
              `Not there: after ${secs} ${what} is in neither the page's text nor its HTML ` +
                `(${waited.textLength} characters of text). Check the spelling, or read the page to see what it says.`,
              true,
            );
          }
          case 'scroll': {
            const y = await browser.scroll({ dy: Number(args.dy ?? 600) });
            return toolText(id, `Scrolled to ${y}.`);
          }
          case 'screenshot': {
            const file = path.join(ARTIFACTS, `shot-${stamp()}.png`);
            const png = await browser.screenshot({ full: args.full === true, file });
            const rel = path.relative(START_DIR, file).replace(/\\/g, '/');
            // The size, and what a pixel of it is worth, because a model reading a picture
            // guesses coordinates from it: the viewport is one CSS pixel per image pixel
            // (measured 16 Nov), and a whole-page image is the document, so its y is a
            // page coordinate rather than a viewport one.
            const w = png.readUInt32BE(16);
            const h = png.readUInt32BE(20);
            const mapping = args.full
              ? ' The image is the whole document: a y taken from it is a page coordinate, so click with the page at the top, or use the `at` values read gives you.'
              : ' One image pixel is one CSS pixel of the viewport, so an x/y read off it can be clicked as it is.';
            return toolText(
              id,
              `Screenshot: ${file} (${Math.round(png.length / 1024)} KB, ${w}x${h} px, ${args.full ? 'whole page' : 'viewport'}).` +
                `${mapping} In the chat, cite it exactly as ![](${rel}) — it is already inside the project, so there is nothing to copy.`,
            );
          }
          case 'watch': {
            const dir = path.join(ARTIFACTS, `watch-${stamp()}`);
            const frames = await browser.watch({ ms: Math.min(5000, Math.max(200, Number(args.ms) || 1200)), dir });
            const span = frames.length > 1
              ? ` over ${Math.round(((frames.at(-1).at || 0) - (frames[0].at || 0)) * 1000)} ms`
              : '';
            return toolText(id, `${frames.length} frame(s)${span} in ${dir}: ${frames.slice(0, 6).map((f) => path.basename(f.file)).join(', ')}${frames.length > 6 ? ', …' : ''}. Read them in order to see the movement.`);
          }
          case 'tabs': {
            const list = await browser.tabs();
            return toolText(id, list.map((t) => `- ${t.title} — ${t.url}`).join('\n') || 'No pages open.');
          }
          case 'handoff': {
            // A sign-in is a permission, not a window that appears: the operator is asked
            // on a card, and only their Allow opens one. The call waits for the outcome —
            // there is no timeout, because the wait is theirs (12 Nov).
            if (args.url) guard(args.url);
            let answer = null;
            try {
              const res = await fetch('http://127.0.0.1:8700/api/browser/ask', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  url: args.url || (await browser.tabs())[0]?.url || '',
                  host: args.host || '',
                  what: args.what || '',
                  // The chat that asked. This server starts in the project's folder,
                  // and a card that cannot name its chat is drawn in whichever one is
                  // open — which is how a sign-in for one project appeared in another
                  // (20 Nov). Empty when the server was started outside a project.
                  directory: IN_PROJECT ? START_DIR : '',
                }),
              });
              answer = await res.json();
            } catch (err) {
              return toolText(id, `Could not ask the operator: ${err.message}`, true);
            }
            if (!answer?.allowed) {
              return toolText(
                id,
                `The operator did not allow a sign-in window. ${answer?.message || ''} Treat the page as unavailable and carry on without it.`.trim(),
                true,
              );
            }
            if (!answer.signedIn) {
              return toolText(id, `A window was opened but no session appeared. ${answer.reason || ''} Treat the site as unavailable.`.trim(), true);
            }
            return toolText(
              id,
              `Signed in to ${answer.host || 'the site'}; the window is gone and the session is kept in SynaBrowse's profile. ` +
                'Read the page again — it should be the signed-in one.',
            );
          }
          case 'close':
            await browser.stop();
            return toolText(id, 'Browser closed. The profile and its session stay for next time.');
          default:
            return toolText(id, `Unknown tool: ${name}`, true);
        }
      } catch (err) {
        // An error with no message used to answer with an empty string — a model has nothing
        // to act on, and the log had a blank line where the reason should be (22 Nov).
        const why = String(err?.message || err?.description || err || '').trim()
          || 'the browser did not say why — read the page and try again';
        process.stderr.write(`${name} failed: ${why}\n`);
        return toolText(id, `${name} failed: ${why}`, true);
      }
    }

    case 'resources/list':
      return result(id, { resources: [] });
    case 'resources/templates/list':
      return result(id, { resourceTemplates: [] });
    case 'prompts/list':
      return result(id, { prompts: [] });

    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      return undefined;
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; /* not JSON */ }
    Promise.resolve(handle(msg)).catch((err) => {
      if (msg?.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
    });
  }
});
process.stdin.on('end', () => { browser.stop().finally(() => process.exit(0)); });
process.stderr.write(`synapse-browser MCP ready (enabled=${cfg.enabled}, profile=${cfg.profile})\n`);

