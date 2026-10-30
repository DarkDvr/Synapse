// Disk housekeeping: the files Synapse leaves behind and can prove are dead.
//
// Separate from cleanup.js, which stops stray processes and sweeps a project's
// own scratch during a run. This is the slow, boring kind, and it runs once at
// boot, after the server is up:
//
//  - **An applied update leaves its staging behind.** The helper downloads the
//    release zip (~196 MB), extracts it (~351 MB) and then copies the program
//    files out of it. Nothing deletes the download afterwards, so every update
//    adds about 1.1 GB to `data\update` for good (deleted by hand once, 30 Oct).
//  - **The updater keeps a backup folder per update**, and only the newest one
//    is a plausible restore point.
//  - **`dist` keeps every release zip ever built**, 196 MB each. One is enough:
//    the code is in git and the assets are on GitHub.
//
// Nothing here deletes a file the operator might still want *this* boot: an
// update is only swept once its `last.json` says it succeeded AND is more than a
// minute old, because the helper starts Synapse before it finishes writing that
// record. A failed update is left alone entirely — its staging is the diagnosis.
//
// Run it by hand to see what it would do:
//
//   bin\node\node.exe src\housekeeping.js --dry-run
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from './paths.js';

const MINUTE = 60 * 1000;
const KEEP_BACKUPS = 1;
const KEEP_RELEASES = 1;
// The update helper writes `last.json` after it has started the app, so a record
// younger than this belongs to an update that may still be finishing.
const UPDATE_SETTLED_MS = MINUTE;

const sizeOf = (target) => {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
    return fs
      .readdirSync(target, { withFileTypes: true })
      .reduce((n, entry) => n + sizeOf(path.join(target, entry.name)), 0);
  } catch {
    return 0;
  }
};

export function createHousekeeping({ root = ROOT, log = null, now = Date.now, dryRun = false } = {}) {
  const dataDir = path.join(root, 'data');
  const updateDir = path.join(dataDir, 'update');
  const backupsDir = path.join(dataDir, 'backups');
  const distDir = path.join(root, 'dist');

  const say = (message) => log?.info?.(message);
  const warn = (message) => log?.warn?.(message);

  /** Remove one file or folder, in dry-run mode only counting it. */
  function drop(target, report) {
    const bytes = sizeOf(target);
    if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
    report.removed += 1;
    report.bytes += bytes;
    return bytes;
  }

  /**
   * A successful update has been applied: keep the record, drop the download,
   * the extracted tree, the helper copies and every backup but the newest.
   */
  function sweepUpdate() {
    const report = { removed: 0, bytes: 0, skipped: null };
    if (!fs.existsSync(updateDir)) return { ...report, skipped: 'no update staging' };
    const record = path.join(updateDir, 'last.json');
    let last = null;
    try {
      last = JSON.parse(fs.readFileSync(record, 'utf8'));
    } catch {
      return { ...report, skipped: 'no update record' };
    }
    if (last?.ok !== true) return { ...report, skipped: 'the last update did not succeed' };
    const at = Date.parse(String(last.at || ''));
    if (!Number.isFinite(at)) return { ...report, skipped: 'the update record has no time' };
    if (now() - at < UPDATE_SETTLED_MS) return { ...report, skipped: 'the update finished less than a minute ago' };

    let entries = [];
    try {
      entries = fs.readdirSync(updateDir, { withFileTypes: true });
    } catch {
      return { ...report, skipped: 'no staging folder' };
    }
    for (const entry of entries) {
      const name = entry.name;
      // Keep the record and the log: they are what says an update happened.
      if (name === 'last.json' || name === 'apply.log') continue;
      if (!entry.isDirectory() && !/\.(zip|mjs|ps1)$/i.test(name)) continue;
      if (entry.isDirectory() && !/^\d+(\.\d+)+/.test(name)) continue;
      drop(path.join(updateDir, name), report);
    }

    // The updater's backups: `1.2.5-20261030T105954` and friends. Keep the
    // newest; a folder it copied for the projects (`Synapse.Projects`) is small
    // and is left alone.
    try {
      const backups = fs
        .readdirSync(backupsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+(?:\.\d+)+-/.test(e.name))
        .map((e) => ({ name: e.name, at: fs.statSync(path.join(backupsDir, e.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const old of backups.slice(KEEP_BACKUPS)) drop(path.join(backupsDir, old.name), report);
    } catch {
      /* no backups folder is normal */
    }
    return report;
  }

  /** One release zip (the newest) and its checksum, not one per version ever built. */
  function pruneReleases({ keep = KEEP_RELEASES } = {}) {
    const report = { removed: 0, bytes: 0, kept: null, skipped: null };
    let files = [];
    try {
      files = fs
        .readdirSync(distDir, { withFileTypes: true })
        .filter((e) => e.isFile() && /^Synapse-.*-win-x64.*\.zip$/i.test(e.name))
        .map((e) => ({ name: e.name, at: fs.statSync(path.join(distDir, e.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
    } catch {
      return { ...report, skipped: 'no dist folder' };
    }
    if (files.length <= keep) return { ...report, kept: files[0]?.name || null, skipped: 'nothing older to remove' };
    report.kept = files[0].name;
    for (const old of files.slice(keep)) drop(path.join(distDir, old.name), report);
    // The checksum file named the zips that just went. Rewrite it for the one
    // that stayed; a stale checksum is worse than none.
    if (!dryRun && report.removed) {
      const sums = path.join(distDir, 'SHA256SUMS');
      try {
        const hash = createSha256(path.join(distDir, files[0].name));
        fs.writeFileSync(sums, `${hash}  ${files[0].name}\n`, 'ascii');
      } catch (err) {
        try { fs.rmSync(sums, { force: true }); } catch { /* nothing to remove */ }
        warn(`could not rewrite ${sums}: ${err.message}`);
      }
      try { fs.rmSync(path.join(distDir, 'SHA256SUMS-FULL'), { force: true }); } catch { /* fine */ }
    }
    return report;
  }

  /** Everything, in the order that keeps the record of an update. */
  function run({ update = true, releases = true } = {}) {
    const result = { removed: 0, bytes: 0, update: null, releases: null };
    if (update) {
      const r = sweepUpdate();
      result.update = r;
      result.removed += r.removed;
      result.bytes += r.bytes;
      if (r.removed) {
        say(`housekeeping: ${dryRun ? 'would drop' : 'dropped'} ${r.removed} update leftover(s), ${mb(r.bytes)}`);
      }
    }
    if (releases) {
      const r = pruneReleases();
      result.releases = r;
      result.removed += r.removed;
      result.bytes += r.bytes;
      if (r.removed) {
        say(
          `housekeeping: ${dryRun ? 'would remove' : 'removed'} ${r.removed} old release zip(s), ` +
            `${mb(r.bytes)}; kept ${r.kept}`,
        );
      }
    }
    return result;
  }

  return { run, sweepUpdate, pruneReleases };
}

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function createSha256(file) {
  // One synchronous read: a release zip is ~200 MB and this runs only when an
  // old one was actually removed.
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Run by hand: `bin\node\node.exe src\housekeeping.js [--dry-run]`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  const log = { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  const result = createHousekeeping({ dryRun, log }).run();
  const freed = dryRun ? 'would free' : 'freed';
  console.log(`housekeeping: ${result.removed} item(s), ${freed} ${mb(result.bytes)}${dryRun ? ' (dry run)' : ''}`);
}
