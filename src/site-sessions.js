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

/**
 * "host = cookie" lines → a map. The split is on the *first* `=`, because a Cookie
 * header is full of them (`bb_session=abc; bb_userid=1`).
 */
export function parseSessions(text) {
  const out = {};
  const rejected = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) {
      rejected.push(`"${line.slice(0, 40)}" has no "host = cookie" shape`);
      continue;
    }
    const host = validHost(line.slice(0, at));
    const cookie = line.slice(at + 1).trim();
    if (!host) {
      rejected.push(`"${line.slice(0, at).trim().slice(0, 40)}" is not a host name`);
      continue;
    }
    if (!cookie) {
      rejected.push(`${host} has no cookie value`);
      continue;
    }
    if (cookie.length > MAX_COOKIE) {
      rejected.push(`${host} is over ${MAX_COOKIE} characters`);
      continue;
    }
    out[host] = cookie;
  }
  return { sessions: out, rejected };
}

/** The file as one block of text, which is what the operator edits. */
export function sessionsText(sessions) {
  return Object.entries(sessions || {})
    .map(([host, entry]) => `${host} = ${entry.cookie}`)
    .join('\n');
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

/** What the API may tell a caller: hosts and sizes, never the values — unless the
 *  caller is this machine, which is the operator editing their own settings. */
export function describeSessions({ raw = false, file = FILE } = {}) {
  const sessions = readSessions(file);
  const list = Object.entries(sessions).map(([host, entry]) => ({
    host,
    chars: entry.cookie.length,
    addedAt: entry.addedAt,
  }));
  return { list, text: raw ? sessionsText(sessions) : '' };
}
