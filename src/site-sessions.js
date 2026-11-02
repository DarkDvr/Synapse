// Per-site sign-in, kept as cookies the operator pastes once.
//
// Why this and not "read the browser's cookies": measured on 2 Nov on this machine,
// every Edge cookie is `v20` (Chromium's app-bound encryption) and its key will not
// unwrap for a normal process; Brave's store is locked while Brave is running, so
// even a copy fails. A WebView2 sign-in window would work but is a day of shell work
// (see docs/notes/todo.md). Pasting a Cookie header is minutes of work, works on any
// PC whatever browser is installed, and is explicit: the operator can see exactly
// what Synapse may send, site by site.
//
// The rules that make it safe rather than a credential dump:
//   - stored in data\ (gitignored), never in the config file, never in a log;
//   - sent only to the host it was saved for, or a subdomain of it — never to a
//     different site, including across a redirect (see fetch.js);
//   - the API returns the values only to a loopback caller; a LAN view gets the host
//     names and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const FILE = path.join(DATA_DIR, 'site-sessions.json');
const MAX_HOSTS = 50;
const MAX_COOKIE = 8192;

/** A hostname we are willing to hold a credential for: dotted, no scheme, no path. */
export function validHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(h)) return '';
  return h;
}

function readRaw(file = FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** The saved sessions, normalised. Values never leave this module by accident. */
export function readSessions(file = FILE) {
  const out = {};
  for (const [host, entry] of Object.entries(readRaw(file))) {
    const h = validHost(host);
    if (!h) continue;
    const cookie = typeof entry === 'string' ? entry : entry?.cookie;
    if (typeof cookie !== 'string' || !cookie.trim()) continue;
    out[h] = { cookie: cookie.trim(), addedAt: Number(entry?.addedAt) || 0 };
  }
  return out;
}

export function writeSessions(sessions, file = FILE) {
  const clean = {};
  for (const [host, entry] of Object.entries(sessions || {}).slice(0, MAX_HOSTS)) {
    const h = validHost(host);
    if (!h) continue;
    const cookie = String(typeof entry === 'string' ? entry : entry?.cookie || '').trim();
    if (!cookie) continue;
    clean[h] = { cookie: cookie.slice(0, MAX_COOKIE), addedAt: Number(entry?.addedAt) || Date.now() };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  return clean;
}

/**
 * The cookie for this host, if one was saved for it or for a parent domain.
 *
 * Deliberately one-way: a cookie saved for `example.com` may go to
 * `www.example.com`, never to `example.com.evil.test` and never to `notexample.com`
 * (the dot is part of the test).
 */
export function cookieFor(host, sessions = readSessions()) {
  const h = String(host || '').toLowerCase();
  for (const [saved, entry] of Object.entries(sessions)) {
    if (h === saved || h.endsWith(`.${saved}`)) return { host: saved, cookie: entry.cookie };
  }
  return null;
}

