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
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHousekeeping } from '../src/housekeeping.js';
import { scratchDir } from '../src/paths.js';
import { reclaimSnapshotStore } from '../src/engines/opencode.js';
import { tmpdir } from './tmpdir.mjs';

function root() {
  const dir = tmpdir('synapse-house-');
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
  createHousekeeping({ root: dir, tempDir: path.join(dir, 'temp'), log: { info() {}, warn() {} }, ...extra });

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

// 3: the temp folder is Synapse's own plumbing, not a model's scratch.
test('spent temp items go, a fresh one stays, and a project scratch is never touched', () => {
  const dir = root();
  try {
    const tempDir = path.join(dir, 'temp');
    const oldProfile = path.join(tempDir, 'visual-review-111-390');
    const oldBuild = path.join(tempDir, 'dotnet-build');
    const fresh = path.join(tempDir, 'fresh');
    const projectScratch = path.join(dir, 'demo', '.project', 'scratch');
    write(path.join(oldProfile, 'Default', 'Cache', 'data_0'), 'x'.repeat(4096));
    write(path.join(oldBuild, 'obj', 'a.dll'), 'x');
    write(path.join(fresh, 'a.txt'), 'still being written');
    write(path.join(projectScratch, 'probe.mjs'), 'the model kept this');
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const p of [oldProfile, oldBuild]) fs.utimesSync(p, longAgo, longAgo);

    const report = house(dir).sweepTemp({ olderThanMs: 6 * 60 * 60 * 1000 });
    assert.equal(report.removed, 2);
    assert.ok(report.bytes >= 4096);
    assert.equal(fs.existsSync(oldProfile), false, 'a spent render profile survived');
    assert.equal(fs.existsSync(oldBuild), false, 'build debris survived');
    assert.equal(fs.existsSync(fresh), true, 'a folder being written now stays');
    assert.equal(fs.existsSync(path.join(projectScratch, 'probe.mjs')), true, 'the project scratch is not temp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the project scratch is inside the project, and the temp sweep never touches it', () => {
  const dir = root();
  try {
    const project = path.join(dir, 'a-project');
    const scratch = scratchDir(project);
    assert.ok(scratch.startsWith(path.join(project, '.project')), 'the scratch left the project');
    write(path.join(scratch, 't1', 'build.bin'), 'x'.repeat(1024));
    const report = house(dir).sweepTemp();
    assert.equal(report.removed, 0, 'the temp sweep removed something');
    assert.equal(fs.existsSync(path.join(scratch, 't1', 'build.bin')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one locked folder does not abort the rest of the sweep', () => {
  const dir = root();
  try {
    const tempDir = path.join(dir, 'temp');
    // The locked one sorts first: if the sweep throws on it, nothing after it is tried.
    const locked = path.join(tempDir, 'a-locked');
    const later = path.join(tempDir, 'z-later');
    write(path.join(locked, 'held.txt'), 'x'.repeat(1024));
    write(path.join(later, 'a.txt'), 'y'.repeat(1024));
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const p of [locked, later]) fs.utimesSync(p, old, old);

    // Windows' EPERM, exactly: one folder cannot be removed. A real open handle does
    // not reproduce it here (Node opens with FILE_SHARE_DELETE), so it is injected.
    const realRm = fs.rmSync;
    let attempts = 0;
    try {
      fs.rmSync = (target, opts) => {
        attempts += 1;
        if (String(target).includes('a-locked')) {
          const err = new Error('EPERM: operation not permitted');
          err.code = 'EPERM';
          throw err;
        }
        return realRm(target, opts);
      };
      const report = house(dir).sweepTemp({ olderThanMs: 60 * 1000 });
      assert.equal(fs.existsSync(later), false, 'the folder after the locked one was still swept');
      assert.equal(fs.existsSync(locked), true, 'the locked folder stays for the next pass');
      assert.equal(report.skipped, 1, 'and the skip is counted, not thrown');
      assert.equal(attempts, 2, 'both folders were attempted');
    } finally {
      fs.rmSync = realRm;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});