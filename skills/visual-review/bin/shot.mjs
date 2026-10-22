#!/usr/bin/env node
// Render an HTML file or URL to PNGs using the machine's own browser — and
// answer questions about the page it rendered.
//
// Why a script and not a pile of flags in the skill text: browser discovery,
// quoting, a throwaway profile and waiting for the file to land are all things a
// model gets wrong once and then works around badly. One command, one JSON line
// per width.
//
// Two modes, one launch path:
//
//   shot.mjs <file|url> --widths 1280,390                     → PNG for each width
//   shot.mjs <file|url> --eval "document.body.scrollWidth"    → the answer, as JSON
//
// The second exists because a picture cannot say *why* something is clipped. A
// designer needed a measurement, found only screenshots on offer, and spent ten
// minutes writing its own Chrome DevTools driver that then fought a stale
// browser over a profile. Measuring belongs here.
//
// Everything goes through the DevTools protocol, screenshots included, for one
// reason: `--window-size` does not set the *layout* viewport in headless Edge.
// A "390px" shot was laid out at 492px and cropped to 390 — so every mobile
// review judged a page that was never 390 wide. `Emulation.setDeviceMetricsOverride`
// sets the viewport for real.
//
// No dependencies: Node ships `fetch` and `WebSocket`, and Edge/Chrome already
// exist on a Windows box. If none is found we exit 2 and say so rather than
// pretend.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BROWSERS = [
  process.env.VISUAL_REVIEW_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
].filter(Boolean);

const fail = (code, message) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const USAGE =
  'Usage: shot.mjs <file|url> [--out DIR] [--widths 1280,390] [--height 900] [--eval "<js>"]';

function parseArgs(argv) {
  const out = { target: '', outDir: path.resolve('.synapse/design/shots'), widths: [1280], height: 900, evalExpr: '', help: false, unknown: '', extra: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = path.resolve(argv[++i] || '');
    else if (a === '--eval') out.evalExpr = String(argv[++i] || '');
    else if (a === '--widths') {
      out.widths = String(argv[++i] || '')
        .split(',')
        .map((w) => Number.parseInt(w, 10))
        .filter((w) => Number.isFinite(w) && w > 0);
    } else if (a === '--height') out.height = Number.parseInt(argv[++i], 10) || 900;
    else if (a === '--help' || a === '-h') out.help = true;
    // An option this script does not have is not a file to photograph. It used to
    // fall through to the target, so `shot.mjs --help` screenshotted a file called
    // `--help`, wrote `--help-1280.png` — a picture of the browser's error page —
    // and reported success. Three runs in Timer Test 1 believed it had worked.
    else if (a.startsWith('-') && a !== '-') out.unknown = a;
    else rest.push(a);
  }
  out.target = rest[0] || '';
  out.extra = rest.slice(1);
  if (!out.widths.length) out.widths = [1280];
  return out;
}

const browser = BROWSERS.find((p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
});

if (!browser) {
  fail(2, 'No browser found. Review the HTML/CSS structurally and say you did not see it rendered.');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (args.unknown) {
  fail(1, `shot.mjs: no such option: ${args.unknown}\n${USAGE}`);
}
if (args.extra.length) {
  fail(1, `shot.mjs: one target at a time, got "${args.extra.join('", "')}"\n${USAGE}`);
}
if (!args.target) {
  fail(1, USAGE);
}
// A file that is not there cannot be rendered. Saying so is the whole point: the
// browser would happily render its own error page and call that a screenshot.
if (!/^[a-z]+:\/\//i.test(args.target) && !fs.existsSync(path.resolve(args.target))) {
  fail(1, `shot.mjs: no such file: ${path.resolve(args.target)}`);
}

// A file path becomes a file:// URL; anything with a scheme is left alone.
const target = /^[a-z]+:\/\//i.test(args.target)
  ? args.target
  : pathToFileURL(path.resolve(args.target)).href;

fs.mkdirSync(args.outDir, { recursive: true });
const base = path.basename(decodeURIComponent(new URL(target).pathname)).replace(/\.[^.]+$/, '') || 'shot';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One browser, one width, one job. Resolves with whatever `job(send)` returns. */
function withPage(width, job) {
  const profile = path.join(os.tmpdir(), `visual-review-${process.pid}-${width}-${Date.now()}`);
  const portFile = path.join(profile, 'DevToolsActivePort');
  return new Promise((resolve, reject) => {
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        `--window-size=${width},${args.height}`,
        'about:blank',
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      setTimeout(() => {
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked temp dir */ }
      }, 300);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('the browser did not answer within 60s')), 60000);
    timer.unref?.();

    (async () => {
      // The port the browser actually chose is written into the profile; polling
      // for it is the only honest way to know when it is ready.
      let port = 0;
      let waited = 0;
      while (!port && waited < 20000) {
        try {
          port = Number(String(fs.readFileSync(portFile, 'utf8')).split(/\r?\n/)[0]) || 0;
        } catch { /* not written yet */ }
        if (!port) {
          await sleep(120);
          waited += 120;
        }
      }
      if (!port) throw new Error('the browser never reported a debugging port');
      let list = [];
      for (let i = 0; i < 40 && !list.length; i += 1) {
        list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
        if (!list || !list.length) await sleep(120);
      }
      const page = (list || []).find((t) => t.type === 'page');
      if (!page?.webSocketDebuggerUrl) throw new Error('the browser opened no page to drive');

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      let id = 0;
      const pending = new Map();
      let loadResolve = null;
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const n = (id += 1);
          pending.set(n, { res, rej });
          ws.send(JSON.stringify({ id: n, method, params }));
        });
      ws.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
        if (msg.method === 'Page.loadEventFired') loadResolve?.();
      });
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('could not open the debugger socket')), { once: true });
      });

      await send('Page.enable');
      await send('Runtime.enable');
      // The whole point: the layout viewport is what we asked for, so a 390px
      // review is a review of a 390px page.
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height: args.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const loaded = new Promise((res) => {
        loadResolve = res;
        setTimeout(res, 15000);
      });
      await send('Page.navigate', { url: target });
      await loaded;
      // A page that lays itself out in a script, or waits on a font, needs one
      // more turn of the loop before it is the page a person would see.
      await sleep(250);

      const out = await job(send, ws);
      try { ws.close(); } catch { /* closing */ }
      clearTimeout(timer);
      finish(resolve, out);
    })().catch((err) => {
      clearTimeout(timer);
      finish(reject, err);
    });
  });
}

/** A full-page PNG at exactly `width`, however tall the page turned out to be. */
async function shoot(width) {
  const out = path.join(args.outDir, `${base}-${width}.png`);
  try { fs.rmSync(out, { force: true }); } catch { /* nothing to remove */ }
  const png = await withPage(width, async (send) => {
    const metrics = await send('Page.getLayoutMetrics');
    const content = metrics.cssContentSize || metrics.contentSize || { width, height: args.height };
    const height = Math.max(args.height, Math.ceil(content.height || 0));
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return Buffer.from(shot.data, 'base64');
  });
  fs.writeFileSync(out, png);
  const size = fs.statSync(out).size;
  if (!size) throw new Error(`the browser captured an empty image for ${width}px`);
  return { target, width, height: args.height, path: out.replace(/\\/g, '/'), bytes: size };
}

/** Load the page at `width` and answer `expr` from inside it. */
async function evaluate(width, expr) {
  return withPage(width, async (send) => {
    const out = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (out.exceptionDetails) return { value: null, error: out.exceptionDetails.text || 'the expression threw' };
    return { value: out.result?.value ?? null, error: null };
  });
}

try {
  if (args.evalExpr) {
    for (const width of args.widths) {
      const answer = await evaluate(width, args.evalExpr);
      process.stdout.write(
        `${JSON.stringify({ target, width, height: args.height, value: answer.value, error: answer.error })}\n`,
      );
    }
  } else {
    for (const width of args.widths) {
      const shot = await shoot(width);
      process.stdout.write(`${JSON.stringify(shot)}\n`);
    }
  }
} catch (err) {
  fail(1, `Screenshot failed: ${err.message}`);
}
