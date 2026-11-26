// Archive is a registry preference, not a folder move or a delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProjectStore } from '../src/projects.js';
import { tmpdir } from './tmpdir.mjs';

const quiet = { channel: () => ({ info() {}, warn() {}, error() {}, debug() {} }) };

function arena() {
  const dir = tmpdir('synapse-archive-');
  const root = path.join(dir, 'projects');
  fs.mkdirSync(root, { recursive: true });
  const store = () =>
    createProjectStore({
      file: path.join(dir, 'data', 'projects.json'),
      rootDir: root,
      scratchRoot: path.join(dir, 'scratch'),
      logger: quiet,
    });
  return { dir, root, store, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('archived projects move to the bottom half of the registry list', () => {
  const a = arena();
  try {
    for (const name of ['alpha', 'beta', 'gamma']) fs.mkdirSync(path.join(a.root, name), { recursive: true });
    const store = a.store();
    store.discover();
    const beta = store.list().find((p) => p.name === 'beta');
    assert.equal(beta.archived, false);
    const saved = store.setArchived(beta.id, true);
    assert.equal(saved.archived, true);
    assert.ok(saved.archivedAt > 0);
    assert.deepEqual(store.list().map((p) => p.name), ['alpha', 'gamma', 'beta']);

    // The file is the source: a fresh store reads the same order and flag.
    const fresh = a.store();
    assert.deepEqual(fresh.list().map((p) => p.name), ['alpha', 'gamma', 'beta']);
    assert.equal(fresh.list().find((p) => p.name === 'beta').archived, true);

    // Unarchive restores the original active position.
    const betaAgain = fresh.list().find((p) => p.name === 'beta');
    fresh.setArchived(betaAgain.id, false);
    assert.deepEqual(fresh.list().map((p) => p.name), ['alpha', 'beta', 'gamma']);
    assert.equal(fresh.list().find((p) => p.name === 'beta').archived, false);
  } finally {
    a.done();
  }
});

test('move does not step over an archived project', () => {
  const a = arena();
  try {
    for (const name of ['alpha', 'beta', 'gamma']) fs.mkdirSync(path.join(a.root, name), { recursive: true });
    const store = a.store();
    store.discover();
    const beta = store.list().find((p) => p.name === 'beta');
    const gamma = store.list().find((p) => p.name === 'gamma');
    store.setArchived(beta.id, true);
    // gamma is the last active project; moving down has no active neighbour.
    assert.equal(store.move(gamma.id, 1).moved, false);
    assert.deepEqual(store.list().map((p) => p.name), ['alpha', 'gamma', 'beta']);
  } finally {
    a.done();
  }
});

test('an unknown project cannot be archived', () => {
  const a = arena();
  try {
    assert.throws(() => a.store().setArchived('missing', true), /not found/);
  } finally {
    a.done();
  }
});
