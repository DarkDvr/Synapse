// The PROHIBITED tier: two permissions per path — may it be changed, and may it
// be read?
//
// This is the layer that does not ask. Its unit is a path; its promise is that a
// write, an edit or a destructive shell command aimed at Windows (or Synapse
// itself, or the Brave data) is denied before a permission card exists. Reads are
// a separate answer on the same row, because reading the event log is useful work
// and reading Brave is a reset.
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
  entryBlockingWrite,
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
  const synapse = entries.find((entry) => entry.id === 'synapse');
  assert.equal(covers(synapse.path, path.join(ROOT, 'src')), true);
});

test('two boxes per entry: writes refused, reads allowed by default', () => {
  const entries = protectionEntries(normalize({}));
  for (const entry of entries) {
    assert.equal(entry.write, false, `${entry.path} refuses writes`);
    assert.equal(entry.read, true, `${entry.path} allows reads`);
  }
  // Switching a built-in's Write back on is an id list; clearing its Read is another.
  const off = protectionEntries(
    normalize({ protection: { builtinsOff: ['windows'], builtinsSealed: ['program-data'] } }),
  );
  assert.equal(off.find((entry) => entry.id === 'windows').write, true);
  assert.equal(off.find((entry) => entry.id === 'program-data').read, false);
});

test('an added path keeps its own answers, and old ones migrate', () => {
  const cfg = normalize({
    protection: {
      paths: [
        { path: 'D:\\Data', label: 'Data', write: true, read: true },
        { path: 'D:\\Archive', label: 'Archive', write: false, read: false },
        // The one-box list: enabled meant "protected", sealed meant "no reads".
        { path: 'D:\\Old', enabled: true },
        { path: 'D:\\Open', enabled: false },
        { path: 'C:\\Users\\tester\\AppData\\Local\\BraveSoftware' },
      ],
    },
  });
  const by = (p) => cfg.protection.paths.find((entry) => entry.path === p);
  assert.deepEqual(by('D:\\Data'), { path: 'D:\\Data', label: 'Data', write: true, read: true });
  assert.deepEqual(by('D:\\Archive'), { path: 'D:\\Archive', label: 'Archive', write: false, read: false });
  assert.equal(by('D:\\Old').write, false, 'enabled:true meant protected');
  assert.equal(by('D:\\Old').read, true);
  assert.equal(by('D:\\Open').write, true, 'enabled:false meant writes allowed');
  assert.equal(
    by('C:\\Users\\tester\\AppData\\Local\\BraveSoftware').read,
    false,
    'a Brave path written before the boxes is read-refused',
  );

  const entries = protectionEntries(cfg);
  const data = entries.find((entry) => entry.path === 'D:\\Data');
  assert.equal(data.write, true);
  assert.equal(data.builtin, false);
  assert.equal(protectionFor(cfg).find((entry) => entry.path === 'D:\\Archive').read, false);
});

test('Brave is an added entry, seeded once, refused for both answers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-brave-'));
  try {
    const brave = path.join(home, 'AppData', 'Local', 'BraveSoftware');
    fs.mkdirSync(brave, { recursive: true });
    const seeded = braveEntries(normalize({}), { home });
    assert.equal(seeded.length, 1, 'the folder on this machine is offered once');
    assert.equal(seeded[0].path, brave);
    assert.deepEqual([seeded[0].write, seeded[0].read], [false, false]);

    const listed = { protection: { paths: seeded } };
    assert.equal(braveEntries(listed, { home }).length, 0, 'not added twice');
    const entry = protectionEntries(listed).find((e) => e.path === brave);
    assert.equal(entry.read, false, 'a Brave folder refuses reads');
    assert.equal(entry.builtin, false, 'and is not a built-in');

    const removed = { protection: { paths: [], removed: [brave] } };
    assert.equal(braveEntries(removed, { home }).length, 0, 'a deleted entry does not come back at boot');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── the policy itself ───────────────────────────────────────────
const protection = [{ path: 'C:\\Windows', label: 'Windows', write: false, read: true }];
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

test('the Read box is independent: refused reads, allowed writes', () => {
  const brave = [{ path: 'C:\\Users\\tester\\AppData\\Local\\BraveSoftware', label: 'Brave', write: false, read: false }];
  const read = call('read', ['C:\\Users\\tester\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\Cookies'], {
    protection: brave,
  });
  assert.equal(read.effect, 'deny');
  assert.equal(read.scope, 'prohibited');

  // A path with writes allowed but reads refused: the read is denied, and a write
  // inside it is judged by the normal rules (here, outside the project → ask).
  const odd = [{ path: 'D:\\Secrets', label: 'Secrets', write: true, read: false }];
  assert.equal(call('read', ['D:\\Secrets\\x'], { protection: odd }).effect, 'deny');
  assert.equal(call('edit', ['D:\\Secrets\\x'], { protection: odd }).effect, 'ask');
});

test('switching Write back on returns the normal rule, not a permanent no', () => {
  const open = [{ path: 'C:\\Windows', label: 'Windows', write: true, read: true }];
  const verdict = call('edit', ['C:\\Windows\\System32\\drivers\\etc\\hosts'], { protection: open });
  assert.equal(verdict.effect, 'ask', 'outside the project, the operator is asked again');
  assert.notEqual(verdict.scope, 'prohibited');
  assert.equal(
    entryBlockingWrite('C:\\Windows\\System32\\drivers\\etc\\hosts', { protection: { paths: [] } }, { env: {} }),
    null,
  );
});

test('the config keeps both answers, strips junk, and defaults sensibly', () => {
  const cfg = normalize({
    protection: {
      builtinsOff: ['windows', '', 7],
      builtinsSealed: ['program-data'],
      paths: [{ path: 'D:\\Keep', label: 'Keep', write: false, read: true }, { path: '', label: 'no' }],
      removed: ['C:\\Users\\x\\AppData\\Local\\BraveSoftware'],
    },
  });
  assert.deepEqual(cfg.protection.builtinsOff, ['windows', '7']);
  assert.deepEqual(cfg.protection.builtinsSealed, ['program-data']);
  assert.deepEqual(cfg.protection.paths, [{ path: 'D:\\Keep', label: 'Keep', write: false, read: true }]);
  assert.deepEqual(cfg.protection.removed, ['C:\\Users\\x\\AppData\\Local\\BraveSoftware']);
  const blank = normalize({});
  assert.deepEqual(blank.protection, { builtinsOff: [], builtinsSealed: [], paths: [], removed: [] });
});
