// What this machine can build, in one place.
//
// The point is a *copied* Synapse: drop the folder on another PC and the Settings
// window should say what that PC has and what it lacks, instead of a build failing
// three turns into a project with "dotnet is not recognised". The probe is cheap
// (one PowerShell call, no builds) and cached, so opening Settings is instant.
//
// Windows apps today are the C# shell in `templates/win-app`: a WPF window hosting
// a WebView2 page. That needs the .NET SDK to *build* and the WebView2 runtime to
// *run*. Rust is listed but not required — it is only for the smaller Tauri shell
// that may come later, and saying so once is better than an operator installing
// 6 GB to find out.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './paths.js';

const TEMPLATE = path.join(ROOT, 'templates', 'win-app');
const APP_CHECK = path.join(ROOT, 'skills', 'app-check', 'bin', 'app-check.mjs');

// One call, one JSON object: spawning PowerShell five times for five versions is
// five process starts for something nobody should ever wait for. Newlines, not
// semicolons — a semicolon inside `@( … )` ends the array and the script dies with
// "Missing expression after ','".
const PS = [
  '$out = @{ dotnet = ""; rust = ""; webview2 = "" }',
  'if (Get-Command dotnet -ErrorAction SilentlyContinue) { $out.dotnet = ((& dotnet --version) -join "").Trim() }',
  'if (Get-Command rustc -ErrorAction SilentlyContinue) { $out.rust = ((& rustc --version) -join "").Trim() }',
  '$keys = @(',
  "  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',",
  "  'HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'",
  ')',
  'foreach ($k in $keys) { $v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).pv; if ($v) { $out.webview2 = $v; break } }',
  '$out | ConvertTo-Json -Compress',
].join('\n');

const run = (cmd, args, timeout = 20000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });

let cache = { at: 0, value: null };
const TTL_MS = 60000;

/** Everything the Windows tab shows. Cached for a minute unless `force`. */
export async function probeToolchain({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < TTL_MS) return cache.value;

  const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS]);
  let ps = { dotnet: '', rust: '', webview2: '' };
  try {
    if (raw) ps = { ...ps, ...JSON.parse(raw.split(/\r?\n/).pop()) };
  } catch {
    /* a machine without PowerShell still gets the filesystem half */
  }

  const value = {
    at: Date.now(),
    node: { ok: true, version: process.version, note: 'Synapse itself. Present because you are reading this.' },
    dotnet: {
      ok: Boolean(ps.dotnet),
      version: ps.dotnet || '',
      note: 'Builds the window shell. Needed to build a Windows app; not needed to run one.',
    },
    webview2: {
      ok: Boolean(ps.webview2),
      version: ps.webview2 || '',
      note: 'The Edge engine the app draws its interface with. Windows 11 ships it; most Windows 10 machines have it.',
    },
    rust: {
      ok: Boolean(ps.rust),
      version: ps.rust || '',
      note: 'Not needed. Only for the smaller Tauri shell, if you ever want a 5 MB app instead of 60 MB.',
    },
    template: {
      ok: fs.existsSync(path.join(TEMPLATE, 'App.csproj')),
      path: TEMPLATE,
      note: 'The shell a new Windows app is copied from.',
    },
    appCheck: {
      ok: fs.existsSync(APP_CHECK),
      path: APP_CHECK,
      note: 'Launches a built app, photographs its window and says whether it is still running.',
    },
  };
  value.ready = value.dotnet.ok && value.webview2.ok && value.template.ok && value.appCheck.ok;
  cache = { at: Date.now(), value };
  return value;
}
