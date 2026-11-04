// The PROHIBITED tier: reads are fine, changes are refused.
//
// This is the layer that does not ask. Its unit is a path; its promise is that a
// write, an edit or a destructive shell command aimed at the Windows folder (or
// Synapse itself, or the Brave data) is denied before a permission card exists.
// The list is the operator's: built-ins can be switched off, added paths deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide } from '../src/permissions.js';
import { normalize } from '../src/config.js';
import {
  braveEntries,
  builtinEntries,
  covers,
  entryCovering,
  protectionEntries,
  protectionFor,
} from '../src/protection.js';

const HARNESS = 'F:/dev/Synapse';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a path covers itself and everything under it, and nothing beside it', () => {
  assert.equal(covers('C:\\Windows', 'C:\\Windows\\System32\\drivers\\etc\\hosts'), true);
  assert.equal(covers('C:\\Windows', 'C:\\Windows'), true);
  assert.equal(covers('C:\\Windows', 'C:\\Windows.old\\x'), false);
  assert.equal(covers('C:/Windows/', 'c:/windows/system32'), true, 'case and slashes do not matter');
});

test('the built-in list is the machine, and it always has Synapse in it', () => {
  const entries = builtinEntries();
  const ids = entries.map((entry) => entry.id);
  assert.ok(ids.includes('synapse'), 'Synapse itself is built in');
  assert.ok(ids.includes('windows'), 'the Windows folder is built in');
  for (const entry of entries) assert.ok(fs.existsSync(entry.path), `${entry.id} exists`);
  // The folder this program runs from is the Synapse entry.
  const synapse = entries.find((entry) => entry.id === 'synapse');
  assert.equal(covers(synapse.path, path.join(ROOT, 'src')), true);
});

test('a disabled entry is off, and an added one is deletable by its absence', () => {
  const config = {
    protection: {
      builtinsOff: ['windows'],
      paths: [{ path: 'D:\\Archive', label: 'Archive', enabled: false }, { path: 'D:\\Data', enabled: true }],
    },
  };
  const entries = protectionEntries(config);
  assert.equal(entries.find((entry) => entry.id === 'windows').enabled, false);
  assert.equal(entries.find((entry) => entry.path === 'D:\\Archive').enabled, false);
  assert.equal(entries.find((entry) => entry.path === 'D:\\Archive').builtin, false);
  const enabled = protectionFor(config).map((entry) => entry.path);
  assert.ok(!enabled.some((p) => /Windows/i.test(p)), 'a switched-off built-in is not enforced');
  assert.ok(enabled.includes('D:\\Data'), 'an enabled added path is');
  assert.equal(entryCovering('D:\\Data\\x.bin', config)?.path, 'D:\\Data');
});

test('Brave is an added, sealed entry, seeded only when its folder exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-brave-'));
  try {
    const brave = path.join(home, 'AppData', 'Local', 'BraveSoftware');
    fs.mkdirSync(brave, { recursive: true });
    const empty = normalize({});
    const seeded = braveEntries(empty, { home });
    assert.equal(seeded.length, 1, 'the folder on this machine is offered once');
    assert.equal(seeded[0].path, brave);

    const listed = { protection: { paths: seeded } };
    assert.equal(braveEntries(listed, { home }).length, 0, 'not added twice');
    const entry = protectionEntries(listed).find((e) => e.path === brave);
    assert.equal(entry.sealed, true, 'a Brave folder refuses reads too');

    const removed = { protection: { paths: [], removed: [brave] } };
    assert.equal(braveEntries(removed, { home }).length, 0, 'a deleted entry does not come back at boot');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── the policy itself ───────────────────────────────────────────
const protection = [{ path: 'C:\\Windows', sealed: false, label: 'Windows' }];
const call = (action, resources, extra = {}) =>
  decide({
    action,
    resources,
    cwd: 'F:/dev/Synapse.Projects/demo',
    projectRoot: 'F:/dev/Synapse.Projects/demo',
    harnessRoot: HARNESS,
    scratchRoot: 'F:/dev/Synapse.Projects/_scratch',
    home: 'C:/Users/tester',
    protection,
    ...extra,
  });

test('a write inside a protected path is refused, not asked', () => {
  const verdict = call('edit', ['C:\\Windows\\System32\\drivers\\etc\\hosts']);
  assert.equal(verdict.effect, 'deny');
  assert.equal(verdict.scope, 'prohibited');
  assert.match(verdict.reason, /PROHIBITED/);
});

test('reading it is allowed: OS logs are the operator’s work', () => {
  const verdict = call('read', ['C:\\Windows\\System32\\winevt\\Logs\\System.evtx']);
  assert.equal(verdict.effect, 'allow');
});

test('a destructive shell command is refused; reading the same file is not', () => {
  const del = call('shell', ['Remove-Item C:\\Windows\\System32\\drivers\\etc\\hosts']);
  assert.equal(del.effect, 'deny');
  assert.equal(del.scope, 'prohibited');
  const read = call('shell', ['Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts']);
  assert.equal(read.effect, 'allow');
  // `cd` first: the write names nothing, and still lands in Windows.
  const cd = call('shell', ['cd C:\\Windows\\System32', 'del hosts']);
  assert.equal(cd.effect, 'deny', 'a write inherits the directory it runs in');
});

test('a sealed entry (Brave) refuses reads too', () => {
  const brave = [{ path: 'C:\\Users\\tester\\AppData\\Local\\BraveSoftware', sealed: true, label: 'Brave' }];
  const verdict = call('read', ['C:\\Users\\tester\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\Cookies'], {
    protection: brave,
  });
  assert.equal(verdict.effect, 'deny');
  assert.equal(verdict.scope, 'prohibited');
});

test('switching the entry off returns the normal rule, not a permanent no', () => {
  const off = call('edit', ['C:\\Windows\\System32\\drivers\\etc\\hosts'], { protection: [] });
  assert.equal(off.effect, 'ask', 'outside the project, the operator is asked again');
  assert.notEqual(off.scope, 'prohibited');
});

test('the config keeps the list, strips junk, and defaults to empty', () => {
  const cfg = normalize({
    protection: {
      builtinsOff: ['windows', '', 7],
      paths: [{ path: 'D:\\Keep', label: 'Keep', enabled: true }, { path: '', label: 'no' }],
      removed: ['C:\\Users\\x\\AppData\\Local\\BraveSoftware'],
    },
  });
  assert.deepEqual(cfg.protection.builtinsOff, ['windows', '7']);
  assert.deepEqual(cfg.protection.paths, [{ path: 'D:\\Keep', label: 'Keep', enabled: true }]);
  assert.deepEqual(cfg.protection.removed, ['C:\\Users\\x\\AppData\\Local\\BraveSoftware']);
  const blank = normalize({});
  assert.deepEqual(blank.protection, { builtinsOff: [], paths: [], removed: [] });
});
