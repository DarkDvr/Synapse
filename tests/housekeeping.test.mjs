// The housekeeping pass: what it may delete, and what it must never touch.
//
// The rules are small and the failure is expensive (an update's only record, or a
// release zip the operator just downloaded), so each one is pinned here:
//
//  - a *successful* update that has settled loses its staging and its older
//    backups, and keeps `last.json` and `apply.log`;
//  - a failed update, a fresh one, or one with no record is left alone;
//  - `dist` keeps the newest release zip, its checksum says so, and the old
//    checksum list is rewritten rather than left naming files that are gone;
//  - a dry run removes nothing.
//
// Run: node --test tests\housekeeping.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHousekeeping } from '../src/housekeeping.js';
import { reclaimSnapshotStore } from '../src/engines/opencode.js';

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-house-'));
  fs.mkdirSync(path.join(dir, 'data', 'update'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'backups'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  return dir;
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function stagedUpdate(dir, { ok = true, at = new Date(Date.now() - 10 * 60 * 1000).toISOString() } = {}) {
  write(path.join(dir, 'data', 'update', 'last.json'), JSON.stringify({ version: '1.2.5', ok, at }));
  write(path.join(dir, 'data', 'update', '1.2.5', 'src', 'api.js'), 'x'.repeat(2048));
  write(path.join(dir, 'data', 'update', 'Synapse-1.2.5-win-x64.zip'), 'z'.repeat(2048));
  write(path.join(dir, 'data', 'update', 'apply-1.2.5.mjs'), 'helper');
  write(path.join(dir, 'data', 'update', 'apply.log'), 'log');
  write(path.join(dir, 'data', 'update', 'started'), 'stamp');
  write(path.join(dir, 'data', 'backups', '1.2.1-20261030T092850', 'src', 'api.js'), 'old');
  write(path.join(dir, 'data', 'backups', '1.2.5-20261030T105954', 'src', 'api.js'), 'new');
  write(path.join(dir, 'data', 'backups', 'Synapse.Projects', '_scratch', 'x.txt'), 'projects');
}

const house = (dir, extra = {}) =>
  createHousekeeping({ root: dir, scratchRoot: path.join(dir, 'scratch'), log: { info() {}, warn() {} }, ...extra });

test('a settled successful update drops its staging and older backups', () => {
  const dir = root();
  try {
    stagedUpdate(dir);
    const report = house(dir).run({ releases: false });
    assert.ok(report.update.removed >= 4, `removed ${report.update.removed}`);
    const updateDir = path.join(dir, 'data', 'update');
    assert.deepEqual(fs.readdirSync(updateDir).sort(), ['apply.log', 'last.json', 'started']);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'update', '1.2.5')), false);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'update', 'Synapse-1.2.5-win-x64.zip')), false);
    const backups = fs.readdirSync(path.join(dir, 'data', 'backups')).sort();
    assert.deepEqual(backups, ['1.2.5-20261030T105954', 'Synapse.Projects'], 'the newest backup and the project copy stay');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two backups written in the same breath: the newer name is the one kept', () => {
  const dir = root();
  try {
    // Same millisecond on the clock, different versions in the name — the state a fast
    // update leaves behind. "Newest by mtime" then has nothing to order them by, and
    // the first one the folder listed would win: a 50/50 between the new backup and
    // the one it was meant to replace (seen once in the suite, 31 Oct).
    stagedUpdate(dir);
    const when = new Date('2026-10-30T12:00:00Z');
    for (const name of ['1.2.1-20261030T092850', '1.2.5-20261030T105954']) {
      fs.utimesSync(path.join(dir, 'data', 'backups', name), when, when);
    }
    house(dir).run({ releases: false, scratch: false });
    assert.deepEqual(
      fs.readdirSync(path.join(dir, 'data', 'backups')).sort(),
      ['1.2.5-20261030T105954', 'Synapse.Projects'],
      'the newer backup stays and the older one goes',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed update is left alone: its staging is the diagnosis', () => {
  const dir = root();
  try {
    stagedUpdate(dir, { ok: false });
    const report = house(dir).run({ releases: false });
    assert.equal(report.update.removed, 0);
    assert.match(report.update.skipped, /did not succeed/);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'update', 'Synapse-1.2.5-win-x64.zip')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an update that just finished is left for the next boot', () => {
  const dir = root();
  try {
    stagedUpdate(dir, { at: new Date().toISOString() });
    const report = house(dir).run({ releases: false });
    assert.equal(report.update.removed, 0);
    assert.match(report.update.skipped, /less than a minute/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no update record: nothing is guessed at', () => {
  const dir = root();
  try {
    write(path.join(dir, 'data', 'update', 'Synapse-1.0.0.zip'), 'z');
    const report = house(dir).run({ releases: false });
    assert.equal(report.update.removed, 0);
    assert.match(report.update.skipped, /no update record/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dist keeps the newest release zip and its checksum names that one', () => {
  const dir = root();
  try {
    for (const [name, age] of [['Synapse-1.2.0-win-x64.zip', 3000], ['Synapse-1.2.4-win-x64.zip', 2000], ['Synapse-1.2.5-win-x64.zip', 1000]]) {
      const file = path.join(dir, 'dist', name);
      write(file, name);
      const when = new Date(Date.now() - age);
      fs.utimesSync(file, when, when);
    }
    write(path.join(dir, 'dist', 'SHA256SUMS'), 'deadbeef  Synapse-1.2.0-win-x64.zip\n');
    write(path.join(dir, 'dist', 'SHA256SUMS-FULL'), 'deadbeef  Synapse-1.1.4-win-x64-full.zip\n');
    const report = house(dir).run({ update: false });
    assert.equal(report.releases.removed, 2);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'dist')).sort(), ['SHA256SUMS', 'Synapse-1.2.5-win-x64.zip']);
    const sums = fs.readFileSync(path.join(dir, 'dist', 'SHA256SUMS'), 'utf8');
    const expected = createHash('sha256').update('Synapse-1.2.5-win-x64.zip').digest('hex');
    assert.equal(sums, `${expected}  Synapse-1.2.5-win-x64.zip\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dry run reports what it would free and deletes nothing', () => {
  const dir = root();
  try {
    stagedUpdate(dir);
    const before = fs.readdirSync(path.join(dir, 'data', 'update')).length;
    const report = house(dir, { dryRun: true }).run({ releases: false });
    assert.ok(report.removed >= 4);
    assert.ok(report.bytes > 0);
    assert.equal(fs.readdirSync(path.join(dir, 'data', 'update')).length, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 3: the renderer's browser profiles are not work; a project's own scratch is.
test('spent render profiles go, a live one stays, and a project’s scratch is never touched', () => {
  const dir = root();
  try {
    const scratch = path.join(dir, 'scratch');
    const oldProfile = path.join(scratch, 'visual-review-111-390-1700000000000');
    const liveProfile = path.join(scratch, 'visual-review-222-390-1790000000000');
    const projectScratch = path.join(scratch, 'test6-1234abcd');
    const nuget = path.join(scratch, 'NuGetScratch');
    write(path.join(oldProfile, 'Default', 'Cache', 'data_0'), 'x'.repeat(4096));
    write(path.join(liveProfile, 'Default', 'Cache', 'data_0'), 'x');
    write(path.join(projectScratch, 'probe.mjs'), 'the model kept this');
    write(path.join(nuget, 'packages', 'a.nupkg'), 'cache');
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (const p of [oldProfile, projectScratch, nuget]) fs.utimesSync(p, longAgo, longAgo);

    const report = house(dir).sweepScratchProfiles();
    assert.equal(report.removed, 1);
    assert.ok(report.bytes >= 4096);
    assert.equal(fs.existsSync(oldProfile), false);
    assert.equal(fs.existsSync(liveProfile), true, 'a profile a render may still be using stays');
    assert.equal(fs.existsSync(path.join(projectScratch, 'probe.mjs')), true, 'a project’s own scratch is work');
    assert.equal(fs.existsSync(nuget), true, 'only visual-review-* is this pass’s business');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 5: the engine's undo store is dropped before the engine starts.
test('the engine snapshot store is emptied before start and its folder kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-snap-'));
  try {
    const dataHome = path.join(dir, 'data');
    const globalDir = path.join(dataHome, 'opencode', 'snapshot', 'global');
    write(path.join(globalDir, 'ad11920401e0', 'objects', 'aa', 'bb'), 'x'.repeat(8192));
    write(path.join(dataHome, 'opencode', 'opencode.db'), 'the chats');
    const freed = reclaimSnapshotStore(dataHome);
    assert.ok(freed >= 8192, `freed ${freed}`);
    assert.deepEqual(fs.readdirSync(globalDir), [], 'the global folder stays for the engine to rebuild in');
    assert.equal(fs.existsSync(path.join(dataHome, 'opencode', 'opencode.db')), true, 'the database is never touched');
    assert.equal(reclaimSnapshotStore(path.join(dir, 'missing')), 0, 'a missing store is not an error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
