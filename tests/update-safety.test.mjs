// The updater's two failure paths, without closing the app.
//
// 24 Nov: a laptop's 265 MB download timed out after two minutes, the write stream
// kept the partial zip open, and the next try said "the zip is missing Synapse.exe".
// These assertions keep the download and the exe replacement safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('a release download has time to finish and closes a failed stream', () => {
  const src = read('src/synapse-update.js');
  assert.match(src, /AbortSignal\.timeout\(900_000\)/, 'a 120-second abort left a partial zip');
  assert.match(src, /out\.destroy\(\)/, 'a failed download must not keep the zip locked');
  assert.match(src, /fs\.rmSync\(zip, \{ force: true \}\)/, 'the partial file is cleared');
  assert.match(src, /the download is incomplete/, 'a short download is not sent to extraction');
});

test('a missing or truncated staged exe is named, not the archive', () => {
  const src = read('src/synapse-update.js');
  assert.match(src, /the zip is missing \$\{need\}/);
  assert.match(src, /top-level entries extracted/);
  assert.match(src, /the extracted Synapse\.exe is incomplete/);
  assert.match(src, /ErrorActionPreference = 'Stop'/, 'PowerShell must not swallow an extraction error');
});

test('the helper never deletes the working exe before the new one is in place', () => {
  const src = read('update-apply.mjs');
  assert.doesNotMatch(src, /fs\.rmSync\(to, \{ force: true \}\)/, 'the old exe was removed before the rename');
  assert.match(src, /fs\.renameSync\(tmp, to\)/);
  assert.match(src, /the new Synapse\.exe is incomplete/);
});

test('the release publishes a small tagged update and an untagged full install', () => {
  const script = read('make-release.ps1');
  assert.match(script, /\$fullName = 'Synapse-full-win-x64'/, 'the full install name must not contain the tag');
  assert.match(script, /\$updateStage =/, 'the update asset is staged separately');
  assert.match(script, /SHA256SUMS[\s\S]*\$fullName\.zip[\s\S]*\$name\.zip/, 'both hashes are published');
});

test('the app repairs a runtime that does not match the release', () => {
  const repair = read('src/runtime-repair.js');
  assert.match(repair, /Synapse-full-win-x64\.zip/);
  assert.match(repair, /ENGINE_VERSION/);
  assert.match(repair, /bin.*opencode/, 'the engine is replaced');
  assert.match(repair, /engine\.stop\(\)[\s\S]*engine\.start\(\)/, 'the engine is stopped before the binary changes');
  const boot = read('src/index.js');
  assert.match(boot, /repairRuntime\(\{ engine, log: app \}\)/, 'boot calls it before the UI reads the catalog');
});

test('a newer engine cannot be installed before the Synapse that understands it', () => {
  const src = read('src/engine-update.js');
  assert.match(src, /Update Synapse first/);
  assert.match(src, /compareVersions\(online\.latest, ENGINE_VERSION\) > 0/);
});


