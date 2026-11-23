// The browser's settings, read once from the operator's config.
//
// One reader, because two callers need the same answer: the SynaBrowse MCP server
// (src/mcp/browser-server.js) and the search fallback that opens a result page in
// the same browser (src/browser/search.js). A second copy of this logic would drift
// the moment the profile changed, and the first symptom would be a search that
// starts a browser nobody is looking at.
//
// SynaBrowse is not an option any more: it ships with Synapse, so there is no
// enabled switch, no browser engine to choose and no profile path to edit. The
// Edge path below exists only for the suite: a machine with no WebView2 host (CI)
// sets SYNAPSE_BROWSER_ENGINE=edge, and a temp profile through
// SYNAPSE_BROWSER_EDGE_PROFILE, so the browser tests never touch the operator's
// own profile.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CONFIG_FILE } from '../paths.js';
import { hostBinary, hostFiles } from './webview2.js';

/** The throwaway profile a test asked for, or the one the app owns. */
function profileFrom(envName, fallback) {
  return String(process.env[envName] || '').trim() || fallback;
}

/**
 * The browser settings, read once.
 *
 * `SYNAPSE_BROWSER_CONFIG` is the test seam: the suite drives the servers against a
 * throwaway config, so a test never reads the operator's settings.
 */
export function browserSettings() {
  const file = process.env.SYNAPSE_BROWSER_CONFIG || CONFIG_FILE;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No config file yet: the defaults are the answer.
    raw = {};
  }
  const b = raw?.browser || {};
  // The Edge path is a test seam, not an operator choice. `!host` keeps a dev
  // checkout usable when shell\build.ps1 has not produced the host yet; the
  // shipped app always has it.
  const wantsEdge = process.env.SYNAPSE_BROWSER_ENGINE === 'edge';
  const host = hostBinary();
  const engine = wantsEdge || !host ? 'edge' : 'webview2';
  if (!wantsEdge && !host) process.stderr.write('browser: the WebView2 host is not built; using the Edge test fallback\n');
  const profile = engine === 'edge'
    ? profileFrom('SYNAPSE_BROWSER_EDGE_PROFILE', path.join(DATA_DIR, 'browser', 'profile'))
    : profileFrom('SYNAPSE_BROWSER_WEBVIEW2_PROFILE', path.join(DATA_DIR, 'browser', 'webview2'));
  const files = hostFiles({ profile });
  return {
    engine,
    profile,
    // The host files live beside the profile, not inside the WebView2 user-data folder.
    host: {
      exe: host,
      stateFile: files.stateFile,
      downloadsFile: files.downloadsFile,
      visible: false,
    },
    // One chime when the window is put on the second monitor; the operator's switch,
    // beside the screen sounds in Settings > General.
    sounds: raw?.notify?.browserSounds !== false,
    idleMinutes: Number(raw?.browser?.idleMinutes) || 5,
    // A desktop of its own is the default; a machine that refuses CreateDesktop has the
    // off-screen window as the fallback, and the suite pins the old path so CI never
    // depends on an interactive desktop.
    hiddenDesktop: process.env.SYNAPSE_BROWSER_HIDDEN_DESKTOP === '0'
      ? false
      : b.hiddenDesktop !== false,
  };
}
