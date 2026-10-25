#!/usr/bin/env node
// app-check — launch a Windows app, look at its window, and say what happened.
//
// A web page can be photographed and measured by the visual-review skill. A
// desktop app cannot: it is a window, and a window is not in the DOM. This is the
// missing half — start the exe, wait for its window, photograph the window, resize
// it, and report what a reviewer needs: title, size, DPI, whether it is still
// alive and responding, and whether it printed anything to stderr on the way up.
//
// One command, JSON on stdout:
//
//   node app-check.mjs --exe dist\App.exe --out shots --resize 900x700 --wait 1500
//   node app-check.mjs --pid 1234 --out shots
//
// No dependencies: Node for the orchestration, PowerShell + .NET for the window,
// both already on Windows. The UI inside the window is a web page — review that
// with the visual-review skill, and review the window with this.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_PS1 = path.join(HERE, 'window.ps1');

const USAGE = `Usage: app-check.mjs (--exe <path> | --pid <n>) [options]

  --exe <path>        start this app (and close it afterwards unless --keep)
  --pid <n>           look at an app that is already running
  --out DIR           where the window PNG goes (default .synapse/shots)
  --resize WxH        resize the window before the shot, e.g. 900x700
  --wait <ms>         how long to wait for the window to appear (default 15000)
  --settle <ms>       wait after the window appears, for the first paint (default 1200)
  --method print|screen|auto
  --keep              leave the app running
  --json              one JSON object (default) — there is no other mode
  --help`;

function parseArgs(argv) {
  const out = {
    exe: '',
    pid: 0,
    outDir: path.resolve('.synapse/shots'),
    resize: '',
    wait: 15000,
    settle: 1200,
    method: 'auto',
    keep: false,
    help: false,
    unknown: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--exe') out.exe = path.resolve(String(argv[++i] || ''));
    else if (a === '--pid') out.pid = Number.parseInt(argv[++i], 10) || 0;
    else if (a === '--out') out.outDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--resize') out.resize = String(argv[++i] || '');
    else if (a === '--wait') out.wait = Math.max(500, Number.parseInt(argv[++i], 10) || 15000);
    else if (a === '--settle') out.settle = Math.max(0, Number.parseInt(argv[++i], 10) || 0);
    else if (a === '--method') out.method = String(argv[++i] || 'auto');
    else if (a === '--keep') out.keep = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) out.unknown = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (args.unknown) {
  process.stderr.write(`app-check: no such option: ${args.unknown}\n${USAGE}\n`);
  process.exit(1);
}
if (!args.exe && !args.pid) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(1);
}
if (args.exe && !fs.existsSync(args.exe)) {
  process.stderr.write(`app-check: no such file: ${args.exe}\n`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One call into window.ps1. Resolves with its JSON, or `{ ok: false, error }`. */
function window(action, extra = []) {
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOW_PS1, '-Action', action, ...extra],
    { encoding: 'utf8', timeout: 120000, windowsHide: true },
  );
  const text = String(res.stdout || '').trim();
  if (!text) {
    return { ok: false, error: String(res.stderr || '').trim() || `window.ps1 ${action} said nothing` };
  }
  try {
    const parsed = JSON.parse(text.split(/\r?\n/).pop());
    return { ok: parsed.ok !== false, ...parsed };
  } catch {
    return { ok: false, error: `window.ps1 ${action} printed something that is not JSON: ${text.slice(0, 200)}` };
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const shots = [];
const notes = [];

try {
  fs.mkdirSync(args.outDir, { recursive: true });

  // 1. Get a window to look at.
  let win;
  let launched = 0;
  if (args.exe) {
    const start = Date.now();
    win = window('launch', ['-Exe', args.exe, '-WaitMs', String(args.wait)]);
    launched = win.pid || 0;
    if (!win.ok) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          exe: args.exe,
          after: Date.now() - start,
          error: win.error || 'no window appeared',
          exitCode: win.exitCode ?? null,
        })}\n`,
      );
      process.exit(1);
    }
  } else {
    win = window('query', ['-TargetPid', String(args.pid)]);
    if (!win.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, pid: args.pid, error: win.error || 'no window' })}\n`);
      process.exit(1);
    }
  }

  // 2. Let the first paint happen. A window that exists is not yet a window that
  //    has drawn: WebView2 loads its page after the frame is up.
  if (args.settle) await sleep(args.settle);

  // 3. Optionally set the size the review is about.
  if (args.resize) {
    const m = args.resize.match(/^(\d+)x(\d+)$/i);
    if (!m) throw new Error(`--resize wants WxH, e.g. 900x700 (got "${args.resize}")`);
    const resized = window('resize', ['-TargetPid', String(win.pid), '-Width', m[1], '-Height', m[2]]);
    if (!resized.ok) throw new Error(resized.error || 'could not resize the window');
    win = resized;
    await sleep(400);
  }

  // 4. Photograph it.
  const file = path.join(args.outDir, `window-${stamp()}.png`);
  const shot = window('shot', ['-TargetPid', String(win.pid), '-Out', file, '-Method', args.method]);
  if (shot.ok) shots.push({ path: shot.path.replace(/\\/g, '/'), width: shot.width, height: shot.height, method: shot.method });
  else notes.push(shot.error || 'the window could not be photographed');

  // 5. Is it still alive *after* all that? A window that dies on its first paint
  //    looks exactly like a window that works, in one screenshot.
  const after = window('query', ['-TargetPid', String(win.pid)]);
  const alive = Boolean(after.ok && after.alive);
  if (!alive) notes.push('the app was not running after the screenshot — it may have crashed on start');

  const result = {
    ok: alive && shots.length > 0,
    exe: args.exe || null,
    pid: win.pid,
    title: win.title,
    window: { x: win.x, y: win.y, width: win.width, height: win.height },
    dpi: { dpi: win.dpi, scale: win.scale },
    responding: win.responding,
    alive,
    shots,
    notes,
  };

  // 6. Close what we started, by pid, unless asked to leave it.
  if (launched && !args.keep) {
    const closed = window('close', ['-TargetPid', String(launched)]);
    result.closed = Boolean(closed.ok);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, exe: args.exe || null, error: err.message })}\n`);
  process.exit(1);
}
