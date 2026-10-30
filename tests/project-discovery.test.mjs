// The projects folder is the registry's source as well as its home.
//
// The operator copies a project folder in and expects it to be there on the next
// start, without using Add Project. A project is a directory, so the folder is
// already a project; discovery only has to write the registry entry and give it
// the `.synapse` plan and scratch folder every project owns. The harness's own
// `_scratch` and `_probe` are the exceptions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectStore, ensureProjectFolders } from '../src/projects.js';
import { scratchDir } from '../src/paths.js';

const quiet = { channel: () => ({ info() {}, warn() {}, error() {}, debug() {} }) };

function arena() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-discovery-'));
  const root = path.join(dir, 'projects');
  const scratchRoot = path.join(dir, 'scratch');
  fs.mkdirSync(root, { recursive: true });
  const store = () =>
    createProjectStore({
      file: path.join(dir, 'data', 'projects.json'),
      rootDir: root,
      scratchRoot,
      logger: quiet,
    });
  return { dir, root, scratchRoot, store, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a folder already in the projects root becomes a project with its plan and scratch folder', () => {
  const a = arena();
  try {
    const alpha = path.join(a.root, 'alpha');
    fs.mkdirSync(alpha, { recursive: true });
    fs.writeFileSync(path.join(alpha, 'keep.txt'), 'the operator was here', 'utf8');

    const store = a.store();
    const adopted = store.discover();

    assert.deepEqual(adopted.map((p) => p.name), ['alpha'], 'the folder is the project');
    assert.equal(adopted[0].directory, alpha);
    assert.equal(adopted[0].exists, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.dir, 'data', 'projects.json'), 'utf8')).projects.map((p) => p.name), ['alpha']);

    // The same two things Add Project gives a project.
    const plan = readJson(path.join(alpha, '.synapse', 'plan.json'));
    assert.deepEqual(plan, { version: 1, goal: '', tasks: [] }, 'an empty, valid plan');
    assert.equal(fs.readFileSync(path.join(alpha, 'keep.txt'), 'utf8'), 'the operator was here', 'nothing in the folder is touched');
    assert.ok(fs.existsSync(scratchDir(alpha, a.scratchRoot)), 'the scratch folder the brief names exists');
  } finally {
    a.done();
  }
});

test('the harness folders, dot folders, metadata and loose files are not projects', () => {
  const a = arena();
  try {
    for (const name of ['_scratch', '_probe', '_refuse-check', '.git', '$RECYCLE.BIN', 'System Volume Information']) {
      fs.mkdirSync(path.join(a.root, name), { recursive: true });
    }
    fs.writeFileSync(path.join(a.root, 'notes.txt'), 'not a folder', 'utf8');
    fs.mkdirSync(path.join(a.root, 'beta'), { recursive: true });

    const store = a.store();
    assert.deepEqual(store.discover().map((p) => p.name), ['beta'], 'only the real project is adopted');
    assert.deepEqual(store.list().map((p) => p.name), ['beta']);
    assert.equal(fs.existsSync(path.join(a.root, '_scratch', '.synapse')), false, 'scratch stays scratch');
  } finally {
    a.done();
  }
});

test('an existing project keeps its name, its stamp and its plan', () => {
  const a = arena();
  try {
    const gamma = path.join(a.root, 'gamma');
    const planFile = path.join(gamma, '.synapse', 'plan.json');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    const written = '{\n  "version": 1,\n  "goal": "finish the clock",\n  "tasks": [{ "id": "t1", "status": "done" }]\n}\n';
    fs.writeFileSync(planFile, written, 'utf8');
    fs.mkdirSync(path.join(a.dir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(a.dir, 'data', 'projects.json'),
      JSON.stringify({ projects: [{ id: 'gamma-id', name: 'Gamma Project', directory: gamma, created: 123 }] }, null, 2),
      'utf8',
    );

    const store = a.store();
    assert.deepEqual(store.discover(), [], 'it is already registered');
    assert.deepEqual(store.list().map((p) => [p.name, p.created]), [['Gamma Project', 123]]);
    assert.equal(fs.readFileSync(planFile, 'utf8'), written, 'a real plan is never replaced by the empty one');
  } finally {
    a.done();
  }
});

test('discovery is idempotent and adds only the new folders', () => {
  const a = arena();
  try {
    fs.mkdirSync(path.join(a.root, 'one'), { recursive: true });
    const store = a.store();
    assert.deepEqual(store.discover().map((p) => p.name), ['one']);
    assert.deepEqual(store.discover(), [], 'a second pass finds nothing new');

    fs.mkdirSync(path.join(a.root, 'two'), { recursive: true });
    assert.deepEqual(store.discover().map((p) => p.name), ['two']);
    assert.deepEqual(store.list().map((p) => p.name), ['one', 'two'], 'the rail keeps one row per folder');
  } finally {
    a.done();
  }
});

test('ensuring a project folder leaves an existing plan and reports a failure instead of throwing', () => {
  const a = arena();
  try {
    const project = path.join(a.root, 'delta');
    const planFile = path.join(project, '.synapse', 'plan.json');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, '{"version":1,"goal":"keep me","tasks":[]}', 'utf8');

    const made = ensureProjectFolders(project, { scratchRoot: a.scratchRoot });
    assert.equal(made.error, '', 'nothing failed');
    assert.equal(made.plan.created, false);
    assert.equal(readJson(planFile).goal, 'keep me');
    assert.ok(fs.existsSync(made.scratch));
  } finally {
    a.done();
  }
});
