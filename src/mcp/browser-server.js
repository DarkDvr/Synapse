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
//   - a screenshot or a strip of frames is written under the **project** (`.synapse\browser\`),
//     so it is deleted with the project and never mixes two projects' browsing; the path is
//     answered, so the model can look at it.
//
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, WEB_DIR } from '../paths.js';
import { artifactDir } from '../browser/artifacts.js';
import { createBrowser, findEdge } from '../browser/browser.js';
import { checkUrl, hostOf } from '../browser/allow.js';
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
try { process.chdir(DATA_DIR); } catch { /* the harness folder exists; nothing to do */ }

const cfg = settings();
const browser = createBrowser({
  profile: cfg.profile,
  idleMs: cfg.idleMinutes * 60 * 1000,
  log: { info: (m) => process.stderr.write(`${m}\n`) },
});



function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const result = (id, payload) => send({ jsonrpc: '2.0', id, result: payload });
const toolText = (id, text, isError = false) => result(id, { content: [{ type: 'text', text }], isError });

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
            return toolText(id, `Opened ${url}\n\n${outline(page, { maxChars: 6000, links: 60 })}${wallNote(page)}`);
          }
          case 'read': {
            const page = await browser.read({
              maxChars: Math.min(30000, Math.max(1000, Number(args.maxChars) || 6000)),
              links: Math.min(120, Math.max(0, Number(args.links ?? 60))),
              mode: args.mode === 'text' ? 'text' : 'article',
            });
            noteUsed(page.url);
            return toolText(id, `${outline(page, { maxChars: args.maxChars, links: args.links })}${wallNote(page)}`);
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
            const file = path.join(ARTIFACTS, `shot-${stamp()}.png`);
            const png = await browser.screenshot({ full: args.full === true, file });
            const rel = path.relative(START_DIR, file).replace(/\\/g, '/');
            return toolText(
              id,
              `Screenshot: ${file} (${Math.round(png.length / 1024)} KB, ${args.full ? 'whole page' : 'viewport'}).` +
                ` Read it to see the page. In the chat, cite it exactly as ![](${rel}) — it is already inside the project, so there is nothing to copy.`,
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
