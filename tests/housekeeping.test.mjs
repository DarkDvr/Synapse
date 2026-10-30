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

const house = (dir, extra = {}) => createHousekeeping({ root: dir, log: { info() {}, warn() {} }, ...extra });

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
