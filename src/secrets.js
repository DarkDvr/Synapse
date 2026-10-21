// Where a provider's API key actually lives.
//
// Not in `config\synapse.config.json`: that file is tracked by git, and a key in
// it is one `git add -A` away from the repository (it happened once — the test in
// tests/provider-config.test.mjs is what caught it). The pattern is the one
// Peri.Scope uses: a small JSON file beside the app's own data
// (`data\provider-keys.json`, which .gitignore already covers), while the config
// keeps only the provider's shape.
//
// `env:NAME` still wins nothing over this file — a stored key is what the
// operator typed in Settings, and the environment is the fallback for someone who
// would rather not have one on disk at all. Nothing here is ever logged.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const SECRETS_FILE = path.join(DATA_DIR, 'provider-keys.json');

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

/** The stored key for a provider, or '' when none is stored. */
export function getProviderKey(id) {
  const key = String(id || '').trim();
  if (!key) return '';
  return String(readAll()[key] || '');
}

/** Store (or, with an empty value, forget) one provider's key. */
export function setProviderKey(id, value) {
  const key = String(id || '').trim();
  if (!key) return false;
  const map = readAll();
  const secret = String(value ?? '').trim();
  if (!secret) {
    if (!(key in map)) return false;
    delete map[key];
  } else {
    map[key] = secret;
  }
  writeAll(map);
  return true;
}

/** `sk-liv***7df` — enough to tell two keys apart, never enough to use one. */
export function maskKey(value) {
  const k = String(value || '');
  if (!k) return '';
  if (k.length <= 8) return `${k.slice(0, 2)}${'*'.repeat(6)}`;
  return `${k.slice(0, 6)}***${k.slice(-3)}`;
}

/** What the UI may know about a provider's key: whether there is one, and its mask. */
export function providerKeyState(id) {
  const stored = getProviderKey(id);
  return stored ? { set: true, masked: maskKey(stored), source: 'stored' } : { set: false, masked: '', source: '' };
}
