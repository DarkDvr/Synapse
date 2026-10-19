#!/usr/bin/env node
// Render an HTML file or URL to PNGs using the machine's own browser.
//
// Why a script and not a pile of flags in the skill text: browser discovery,
// quoting, a throwaway profile and waiting for the file to land are all things a
// model gets wrong once and then works around badly. One command, one JSON line
// per shot.
//
// No dependencies. Edge/Chrome already exist on a Windows box; if none is found
// we exit 2 and say so rather than pretend.
import { execFile } from 'node:child_process';
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

function parseArgs(argv) {
  const out = { target: '', outDir: path.resolve('.synapse/design/shots'), widths: [1280], height: 900 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = path.resolve(argv[++i] || '');
    else if (a === '--widths') {
      out.widths = String(argv[++i] || '')
        .split(',')
        .map((w) => Number.parseInt(w, 10))
        .filter((w) => Number.isFinite(w) && w > 0);
    } else if (a === '--height') out.height = Number.parseInt(argv[++i], 10) || 900;
    else rest.push(a);
  }
  out.target = rest[0] || '';
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
if (!args.target) fail(1, 'Usage: shot.mjs <file|url> [--out DIR] [--widths 1280,390] [--height 900]');

// A file path becomes a file:// URL; anything with a scheme is left alone.
const target = /^[a-z]+:\/\//i.test(args.target)
  ? args.target
  : pathToFileURL(path.resolve(args.target)).href;

fs.mkdirSync(args.outDir, { recursive: true });
const base = path.basename(decodeURIComponent(new URL(target).pathname)).replace(/\.[^.]+$/, '') || 'shot';
const profile = path.join(os.tmpdir(), `visual-review-${process.pid}-${Date.now()}`);

const run = (width) =>
  new Promise((resolve, reject) => {
    const out = path.join(args.outDir, `${base}-${width}.png`);
    try {
      fs.rmSync(out, { force: true });
    } catch { /* nothing to remove */ }
    const flags = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${args.height}`,
      `--screenshot=${out}`,
      target,
    ];
    execFile(browser, flags, { timeout: 60000, windowsHide: true }, (err) => {
      // The browser writes its "bytes written to …" notice to stderr; the exit
      // code is the thing to trust, and even then the file is the real answer.
      if (err && !fs.existsSync(out)) return reject(err);
      // The screenshot is written just after the process lets go of it.
      let waited = 0;
      const poll = () => {
        try {
          const size = fs.statSync(out).size;
          if (size > 0) return resolve({ target, width, height: args.height, path: out.replace(/\\/g, '/'), bytes: size });
        } catch { /* not yet */ }
        if (waited >= 5000) return reject(new Error(`no screenshot at ${out}`));
        waited += 100;
        setTimeout(poll, 100);
      };
      poll();
    });
  });

try {
  for (const width of args.widths) {
    const shot = await run(width);
    process.stdout.write(`${JSON.stringify(shot)}\n`);
  }
} catch (err) {
  fail(1, `Screenshot failed: ${err.message}`);
} finally {
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch { /* a locked temp dir is not worth failing a run over */ }
}
