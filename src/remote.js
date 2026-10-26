// Remote access: the pieces that decide who may open Synapse from the LAN.
//
// The desktop UI runs on loopback and is always allowed. A request from another
// machine must come from a private address AND carry the token, exchanged once
// for an HttpOnly cookie by the login page. The token never leaves the host: the
// status endpoint includes it only when the caller is loopback.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const REMOTE_COOKIE = 'synapse_remote';

export function isLoopback(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1';
}

/** RFC1918 IPv4, normalised from the `::ffff:` form Node reports on a dual stack. */
export function isPrivateAddress(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [first, second] = parts;
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}

export function parseCookies(header) {
  const out = {};
  for (const piece of String(header || '').split(';')) {
    const at = piece.indexOf('=');
    if (at < 0) continue;
    const key = piece.slice(0, at).trim();
    const value = piece.slice(at + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

/** Constant-time compare, so a wrong token cannot be found one character at a time. */
export function tokenMatches(candidate, token) {
  if (!candidate || !token) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The token lives beside the other runtime state, not in the config: the config
 * is source of truth and may be committed, and this is a password for the PC.
 */
export function createRemoteToken({ file, logger } = {}) {
  const log = logger?.channel?.('app');
  let token = '';
  try {
    if (file && fs.existsSync(file)) token = fs.readFileSync(file, 'utf8').trim();
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
        log?.info(`remote access token created: ${file}`);
      }
    }
  } catch (err) {
    log?.warn(`remote access token could not be read or written (${err.message}); using a temporary one`);
    token = token || crypto.randomBytes(32).toString('hex');
  }
  return token;
}

/** Every private IPv4 address this PC can be reached on, home LAN first.
 *  A machine with WSL or a VPN has extra private adapters (172.31.x.x here);
 *  the one a laptop on the house network can use is the 192.168 address, so it
 *  is the URL shown under the switch. */
export function lanAddresses() {
  const rank = (address) =>
    address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2;
  const addresses = [];
  for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (!isPrivateAddress(info.address)) continue;
      addresses.push({ name, address: info.address });
    }
  }
  return addresses.sort((a, b) => rank(a.address) - rank(b.address) || a.address.localeCompare(b.address));
}

const escapeHtml = (value) =>
  String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** One small page, no assets: it has to load before the browser has a cookie. */
export function loginPage({ error = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synapse — Remote Access</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #14161a; color: #e7e8ea;
    font: 14px/1.5 "DM Sans", "Segoe UI", system-ui, sans-serif;
  }
  .card {
    width: min(390px, calc(100vw - 40px)); padding: 26px;
    border: 1px solid #32353b; border-radius: 14px; background: #1a1c21;
  }
  h1 { font-size: 19px; margin: 0 0 4px; letter-spacing: .01em; }
  .sub { color: #94979e; margin: 0 0 18px; font-size: 12.5px; }
  label { display: block; font-size: 11px; color: #94979e; margin-bottom: 6px; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #3a3d44; background: #14161a; color: #e7e8ea;
    font: 12.5px/1.4 "Cascadia Code", Consolas, monospace;
  }
  input:focus { outline: 2px solid #625bf6; outline-offset: 1px; border-color: #625bf6; }
  button {
    margin-top: 12px; width: 100%; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #625bf6; background: #625bf6; color: #fff;
    font: 600 13px/1.4 inherit; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  .err { margin-top: 12px; color: #f0563f; font-size: 12px; }
  .note { margin-top: 16px; color: #6f737b; font-size: 11px; }
  code { color: #b9bcc3; }
</style>
</head>
<body>
  <main class="card">
    <h1>Synapse</h1>
    <p class="sub">This PC is sharing its workspace on the local network.</p>
    <form method="get" action="/login">
      <label for="token">Access token</label>
      <input id="token" name="token" autocomplete="off" spellcheck="false" autofocus placeholder="Paste the token from the host PC">
      <button type="submit">Connect</button>
    </form>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
    <div class="note">On the host PC, open <code>STATUS → Remote Access</code> and click <code>TOKEN</code> under the switch. The address is there too.</div>
  </main>
</body>
</html>`;
}
