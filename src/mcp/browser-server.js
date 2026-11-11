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
//   - a screenshot or a strip of frames is written under `data\browser\shots\` and
//     answered with its path, so the model can look at it and the operator can find it.
//
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, WEB_DIR } from '../paths.js';
import { createBrowser, findEdge } from '../browser/browser.js';
import { checkUrl, hostOf } from '../browser/allow.js';
import { askOperator } from '../browser/handoff.js';

const PROTOCOL_VERSION = '2024-11-05';
const SHOTS = path.join(DATA_DIR, 'browser', 'shots');
const CHIME = path.join(WEB_DIR, 'sounds', 'chime.wav');

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
    headless: b.headless === true,
    // One chime when the window is put on the second monitor; the operator's switch,
    // beside the screen sounds in Settings > General.
    sounds: raw?.notify?.browserSounds !== false,
    idleMinutes: Number(raw?.browser?.idleMinutes) || 5,
  };
}

const cfg = settings();
const browser = createBrowser({
  profile: cfg.profile,
  idleMs: cfg.idleMinutes * 60 * 1000,
  log: { info: (m) => process.stderr.write(`${m}\n`) },
});

const TOOLS = [
  {
    name: 'open',
    description:
      'Open a web page in the harness\'s own browser and answer its address, title, a readable ' +
      'outline of its text and the links on it. The browser is hidden; a host the operator has ' +
      'a browser refuses. Use this instead of webfetch when a page is behind ' +
      'a sign-in or a bot check, then click and read like a person would.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page to open (http or https).' },
        settleMs: { type: 'integer', description: 'How long to let the page finish rendering (default 900).', minimum: 0, maximum: 15000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description:
      'Read the current page: its text as a person sees it, and the links that can be clicked, ' +
      'each with its address. Ask for more characters only when the first part was not enough.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', description: 'Characters of text (1000-30000, default 6000).', minimum: 1000, maximum: 30000 },
        links: { type: 'integer', description: 'How many links to list (0-120, default 60).', minimum: 0, maximum: 120 },
        mode: { type: 'string', enum: ['article', 'text'], description: 'article (default) picks the main content and drops the page around it; text is the whole page.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description:
      'Click something on the page: a CSS selector, the visible text of a link or button, or an ' +
      'x/y pair from `read`. Clicks are synthetic — the operator\'s cursor never moves. Answers the ' +
      'address afterwards, so you can see whether it navigated.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to click.' },
        text: { type: 'string', description: 'Visible text of the link or button (exact, then contains).' },
        x: { type: 'integer', description: 'Page x coordinate, with y.' },
        y: { type: 'integer', description: 'Page y coordinate, with x.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description: 'Type text into the focused field, or into a field named by a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to type.' },
        selector: { type: 'string', description: 'CSS selector of the field to focus first.' },
        submit: { type: 'boolean', description: 'Press Enter afterwards.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press',
    description: 'Press one key: enter, tab, escape, backspace, space, arrows, pageup, pagedown.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'The key name.' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description:
      'Wait until the page contains a piece of text, or a selector, or simply for a time. ' +
      'Use it after a click that loads something, instead of guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for.' },
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        ms: { type: 'integer', description: 'Milliseconds to wait instead.', minimum: 0, maximum: 30000 },
        timeoutMs: { type: 'integer', description: 'How long before giving up (default 20000).', minimum: 1000, maximum: 120000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page by a number of pixels (positive is down) and answer where it stopped.',
    inputSchema: {
      type: 'object',
      properties: { dy: { type: 'integer', description: 'Pixels to scroll (default 600).', minimum: -20000, maximum: 20000 } },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description:
      'Take a picture of the page — the viewport, or the whole document — and answer its path. ' +
      'Read the image to see what a person would see.',
    inputSchema: {
      type: 'object',
      properties: { full: { type: 'boolean', description: 'Capture the whole document, not just the viewport.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'watch',
    description:
      'Watch movement for a moment: answers a strip of frames as image paths, for an animation, ' +
      'a spinner, a menu that slides. A still cannot show what changed.',
    inputSchema: {
      type: 'object',
      properties: {
        ms: { type: 'integer', description: 'How long to watch (200-5000, default 1200).', minimum: 200, maximum: 5000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tabs',
    description: 'List the pages this browser has open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'handoff',
    description:
      'Ask the operator for a moment: brings the browser to the second monitor\'s taskbar, minimized ' +
      'and without taking focus, and chimes once. Use it when a page needs a sign-in or a bot check ' +
      'only a person can pass, then wait and read the page again.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Where to put the browser first (optional).' },
        what: { type: 'string', description: 'One sentence for the operator: what is needed.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'close',
    description: 'Close the browser. The profile and whatever was signed in stay for next time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const result = (id, payload) => send({ jsonrpc: '2.0', id, result: payload });
const toolText = (id, text, isError = false) => result(id, { content: [{ type: 'text', text }], isError });

// ── helpers ──────────────────────────────────────────────────────
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** A readable outline: what the page says, and what can be clicked. */
const outline = (page) => {
  const lines = [`# ${page.title || '(no title)'}`, page.url, ''];
  lines.push((page.text || '').slice(0, 6000));
  if (page.links?.length) {
    lines.push('', 'Links:');
    for (const link of page.links.slice(0, 60)) lines.push(`- ${link.text} -> ${link.href} (${link.at.join(',')})`);
  }
  return lines.join('\n');
};

/**
 * Refuse what is not an http(s) address, in words the model can act on.
 *
 * There is no host list any more: the operator's short answer was "the sites I am logged
 * into", so the fence is the master switch, and the Sites table is a record of the
 * sessions rather than a permission list. What is still refused is a scheme a browser
 * would not treat as a page — `file://` would be a way around the harness's own rules.
 */
function guard(url) {
  const verdict = checkUrl(url, ['*']);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict;
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
            process.stderr.write(`open ${verdict.host} -> ${url}\n`);
            return toolText(id, `Opened ${url}\n\n${outline(page)}${wallNote(page)}`);
          }
          case 'read': {
            const page = await browser.read({
              maxChars: Math.min(30000, Math.max(1000, Number(args.maxChars) || 6000)),
              links: Math.min(120, Math.max(0, Number(args.links ?? 60))),
              mode: args.mode === 'text' ? 'text' : 'article',
            });
            noteUsed(page.url);
            return toolText(id, `${outline(page)}${wallNote(page)}`);
          }
          case 'click': {
            const at = Number.isFinite(args.x) && Number.isFinite(args.y) ? [Number(args.x), Number(args.y)] : null;
            const url = await browser.click({ selector: args.selector || null, text: args.text || null, at });
            // A click can navigate anywhere; the landing page is judged like a new open.
            guard(url);
            return toolText(id, `Clicked ${args.selector || args.text || `${args.x},${args.y}`} -> ${url}`);
          }
          case 'type':
            await browser.type({ text: args.text, selector: args.selector || null, submit: args.submit === true });
            return toolText(id, `Typed ${String(args.text).length} characters${args.submit ? ' and pressed Enter' : ''}.`);
          case 'press':
            await browser.press(args.key);
            return toolText(id, `Pressed ${args.key}.`);
          case 'wait': {
            const ok = await browser.wait({
              text: args.text || null,
              selector: args.selector || null,
              ms: args.ms ?? null,
              timeoutMs: Math.min(120000, Math.max(1000, Number(args.timeoutMs) || 20000)),
            });
            return toolText(id, ok ? 'It happened.' : 'It did not happen in time.', !ok);
          }
          case 'scroll': {
            const y = await browser.scroll({ dy: Number(args.dy ?? 600) });
            return toolText(id, `Scrolled to ${y}.`);
          }
          case 'screenshot': {
            const file = path.join(SHOTS, `shot-${stamp()}.png`);
            const png = await browser.screenshot({ full: args.full === true, file });
            return toolText(id, `Screenshot: ${file} (${Math.round(png.length / 1024)} KB, ${args.full ? 'whole page' : 'viewport'}). Read it to see the page.`);
          }
          case 'watch': {
            const dir = path.join(SHOTS, `watch-${stamp()}`);
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
            if (args.url) {
              guard(args.url);
              await browser.goto(args.url, { settle: 900 });
            }
            // The chime is the operator's own switch: on unless they turned it off.
            const asked = await askOperator({ profile: cfg.profile, sound: cfg.sounds ? CHIME : '' });
            if (!asked.ok) return toolText(id, `Could not reach the operator's screen: ${asked.error}`, true);
            // Tell the page too: the chime is the window's, the notice is Synapse's, and
            // an operator away from the screen still sees why the run is waiting when
            // they come back. Best effort — the app may not be running.
            try {
              await fetch('http://127.0.0.1:8700/api/browser/waiting', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ what: args.what || '', url: args.url || '' }),
              });
            } catch { /* no app listening; the chime and the window still stand */ }
            const w = asked.window || {};
            process.stderr.write(`handoff: window ${w.hwnd} on ${w.screen}, minimized=${w.minimized}, stoleFocus=${w.stoleFocus}\n`);
            return toolText(
              id,
              [
                `The browser is waiting on the taskbar of the second monitor, minimized, and a chime played.`,
                w.stoleFocus ? 'Warning: the window took the foreground; tell the operator.' : 'It did not take focus.',
                args.what ? `It needs: ${args.what}` : '',
                'The operator has to sign in or pass the check. Call `wait` and then `read` again; do not click blindly while they work.',
              ].filter(Boolean).join(' '),
            );
          }
          case 'close':
            await browser.stop();
            return toolText(id, 'Browser closed. The profile and its session stay for next time.');
          default:
            return toolText(id, `Unknown tool: ${name}`, true);
        }
      } catch (err) {
        process.stderr.write(`${name} failed: ${err.message}\n`);
        return toolText(id, `${name} failed: ${err.message}`, true);
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
