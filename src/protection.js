// The PROHIBITED tier: paths Synapse may read but must never change.
//
// This is not the permission system's "outside the project" rule, which asks the
// operator and can be answered yes. These are the files a wrong answer would cost
// the machine: the Windows install, the program folders, the Synapse folder itself,
// and — by default, as an entry the operator added rather than a built-in — the
// Brave browser data, because touching it resets the operator's browser.
//
// A write, an edit or a shell command that would change one of these is refused
// before any permission card exists. The way out is deliberate and visible: untick
// the entry in Settings > Prohibited (the normal permission rules apply again), or,
// for an entry the operator added, delete it. Built-in entries can be switched off
// but not removed — a half-ticked list must not be able to lose the Windows folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from './paths.js';

/** Forward slashes, no trailing separator, lower case: one spelling per path. */
const key = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Is `child` the same as, or under, `parent`? Case-insensitive, like Windows. */
export function covers(parent, child) {
  const p = key(parent);
  const c = key(child);
  if (!p || !c) return false;
  return c === p || c.startsWith(`${p}/`);
}

/**
 * The entries Synapse always knows about. They exist on every machine with that
 * folder; a missing one (no Program Files (x86), a different SystemRoot) is simply
 * not listed. The ids are stable, because the operator's "switched off" list is
 * stored by id.
 */
export function builtinEntries(env = process.env) {
  const list = [
    { id: 'windows', path: env.SystemRoot || '', label: 'Windows' },
    { id: 'program-files', path: env.ProgramFiles || '', label: 'Program Files' },
    { id: 'program-files-x86', path: env['ProgramFiles(x86)'] || '', label: 'Program Files (x86)' },
    { id: 'program-data', path: env.ProgramData || '', label: 'ProgramData' },
    { id: 'synapse', path: ROOT, label: 'Synapse itself' },
  ];
  return list.filter((entry) => {
    if (!entry.path) return false;
    try {
      return fs.existsSync(entry.path);
    } catch {
      return false;
    }
  });
}

/** A browser profile folder is not merely protected: reading it resets the browser. */
export const sealedPath = (value) => /bravesoftware/i.test(String(value || ''));

/**
 * Every entry, built-in and added, in the order Settings shows them.
 *
 * Each entry carries **two permissions**, because they are independent: `write`
 * (may it be changed?) and `read` (may it be looked at?). A Windows folder is
 * write:false, read:true; Brave is false on both. The list is the operator's, and
 * each box is one answer.
 *
 * Built-ins come from the machine's variables and are switched off by id, never
 * removed. Added entries are data in the config and can be deleted.
 */
export function protectionEntries(config, { env = process.env } = {}) {
  const writeOff = new Set((config?.protection?.builtinsOff || []).map(String));
  const readOff = new Set((config?.protection?.builtinsSealed || []).map(String));
  const builtins = builtinEntries(env).map((entry) => ({
    ...entry,
    builtin: true,
    write: writeOff.has(entry.id),
    read: !readOff.has(entry.id),
  }));
  const custom = (Array.isArray(config?.protection?.paths) ? config.protection.paths : [])
    .filter((entry) => entry && String(entry.path || '').trim())
    .map((entry) => ({
      id: `added:${key(entry.path)}`,
      path: String(entry.path),
      label: String(entry.label || path.basename(String(entry.path)) || entry.path),
      builtin: false,
      // A config written before the two boxes existed carried one `enabled` and a
      // Brave-by-name seal. Both are folded here, so an old file opens with the
      // same answers the old row showed.
      write: entry.write !== undefined ? entry.write === true : entry.enabled === false,
      read:
        entry.read !== undefined
          ? entry.read === true
          : entry.sealed !== undefined
            ? entry.sealed !== true
            : !sealedPath(entry.path),
    }));
  return [...builtins, ...custom];
}

/** The entries in the shape permissions.js judges with: write and read allowed. */
export function protectionFor(config, { env = process.env } = {}) {
  return protectionEntries(config, { env }).map((entry) => ({
    path: entry.path,
    label: entry.label,
    write: entry.write,
    read: entry.read,
    builtin: entry.builtin,
  }));
}

/** The first entry covering `target`, or null. */
export function entryCovering(target, config, { env = process.env } = {}) {
  const at = String(target || '');
  return protectionFor(config, { env }).find((entry) => covers(entry.path, at)) || null;
}

/** The first entry covering `target` whose writes are refused, or null. */
export function entryBlockingWrite(target, config, { env = process.env } = {}) {
  const at = String(target || '');
  return (
    protectionFor(config, { env }).find((entry) => entry.write === false && covers(entry.path, at)) || null
  );
}

/**
 * Brave folders that should be on the list because they exist on this machine.
 *
 * Brave is an *added* entry, not a built-in: the operator can delete it, and the
 * deletion sticks because the path is remembered in `protection.removed`. This is
 * seeded at boot, so a fresh install gets the protection without a machine-specific
 * path in the shipped config.
 */
export function braveEntries(config, { home = os.homedir() } = {}) {
  const candidates = [
    path.join(home, 'AppData', 'Local', 'BraveSoftware'),
    path.join(home, 'AppData', 'Roaming', 'BraveSoftware'),
  ];
  const removed = new Set((config?.protection?.removed || []).map(key));
  const known = protectionEntries(config).map((entry) => entry.path);
  const added = [];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
    } catch {
      continue;
    }
    const target = key(candidate);
    if (removed.has(target)) continue;
    if (known.some((entry) => covers(entry, candidate) || covers(candidate, entry))) continue;
    added.push({ path: candidate, label: 'Brave browser data', write: false, read: false });
  }
  return added;
}
