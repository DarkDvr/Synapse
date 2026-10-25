// Deleting a project removes its folder, so the refusals are the part that matters.
//
// These are the safety rules and how `bin\` is measured. The recycle itself needs
// the Windows shell and is not called here — it was proved by hand instead: a
// scratch folder with a nested `bin\app.exe` left the filesystem, exit 0, and the
// Recycle Bin listed it as `_recycle-test` from its original parent folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mayRecycleFolder } from '../src/projects.js';
import { binContents } from '../src/api.js';

const harness = 'F:\\dev\\Synapse';
const projectsRoot = 'F:\\dev\\Synapse.Projects';
const opts = { projectsRoot, harness };

test('a project folder may go to the bin', () => {
  assert.equal(mayRecycleFolder(`${projectsRoot}\\clock-test-2`, opts).ok, true);
});

test('a drive root is refused', () => {
  // The normalised form of `F:\` is `F:`, a drive-relative path, so this has to be
  // judged before the trailing separator is stripped.
  assert.equal(mayRecycleFolder('F:\\', opts).ok, false);
  assert.equal(mayRecycleFolder('F:/', opts).ok, false);
});

test('the projects root is refused', () => {
  const verdict = mayRecycleFolder(projectsRoot, opts);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /projects root/);
});

test('the harness is refused, and so is anything containing it', () => {
  assert.equal(mayRecycleFolder(harness, opts).ok, false);
  const parent = mayRecycleFolder('F:\\dev', opts);
  assert.equal(parent.ok, false);
  assert.match(parent.reason, /contains Synapse/);
});

test('a case-only or separator-only difference is the same folder', () => {
  assert.equal(mayRecycleFolder('f:\\DEV\\synapse', opts).ok, false);
  assert.equal(mayRecycleFolder('F:/dev/Synapse/', opts).ok, false);
});

test('a sibling whose name merely starts with the harness name is not the harness', () => {
  // `F:\dev\Synapse.Projects` starts with `F:\dev\Synapse` as text. Only a path
  // boundary counts, or every project would be refused as "Synapse itself".
  assert.equal(mayRecycleFolder(`${projectsRoot}\\one`, opts).ok, true);
  assert.equal(mayRecycleFolder('F:\\dev\\Synapse.Projects.backup', opts).ok, true);
});

test('bin\\ is measured, not assumed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-del-'));
  const bin = path.join(dir, 'bin');

  // No bin at all: nothing to consent to.
  assert.deepEqual(binContents(dir), { path: bin, exists: false, files: 0, bytes: 0 });

  // An empty bin is still nothing to consent to.
  fs.mkdirSync(bin);
  assert.deepEqual(binContents(dir), { path: bin, exists: true, files: 0, bytes: 0 });

  // Nested deliverables are what the checkbox is about.
  fs.mkdirSync(path.join(bin, 'ui'));
  fs.writeFileSync(path.join(bin, 'App.exe'), 'xxxxx');
  fs.writeFileSync(path.join(bin, 'ui', 'index.html'), '<!doctype html>');
  const full = binContents(dir);
  assert.equal(full.files, 2);
  assert.equal(full.bytes, 5 + '<!doctype html>'.length);

  fs.rmSync(dir, { recursive: true, force: true });
});
