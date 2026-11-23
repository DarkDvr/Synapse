// The browser's settings, read once from the operator's config.
//
// One reader, because two callers need the same answer: the SynaBrowse MCP server
// (src/mcp/browser-server.js) and the search fallback that opens a result page in
// the same browser (src/browser/search.js). A second copy of this logic would drift
// the moment the profile or the engine changed, and the first symptom would be a
// search that starts a browser nobody is looking at.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CONFIG_FILE } from '../paths.js';
import { hostBinary, hostFiles } from './webview2.js';

/**
 * The browser settings, read once.
 *
 * `SYNAPSE_BROWSER_CONFIG` is the test seam: the suite drives the servers against a
 * throwaway config and profile, so a test never touches the operator's settings.
 */
export function browserSettings() {
  const file = process.env.SYNAPSE_BROWSER_CONFIG || CONFIG_FILE;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No config file yet: everything is off, which is the safe answer.
    raw = {};
  }
  const b = raw?.browser || {};
  const wantsEdge = b.engine === 'edge';
  const host = hostBinary();
  const engine = wantsEdge || !host ? 'edge' : 'webview2';
  if (!wantsEdge && !host) process.stderr.write('browser: the WebView2 host is not built; using Edge\n');
  const profile = engine === 'edge'
    ? String(b.profile || '').trim() || path.join(DATA_DIR, 'browser', 'profile')
    : String(b.webview2Profile || '').trim() || path.join(DATA_DIR, 'browser', 'webview2');
  const files = hostFiles({ profile });
  return {
    enabled: b.enabled === true,
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
    // The search fallback is on unless the operator turns it off. It uses the same
    // browser switch: a search may not start a browser that is switched off.
    searchBrowser: b.searchBrowser !== false,
  };
}
