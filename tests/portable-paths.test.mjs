// A copy of the Synapse folder on another PC. The config and the project registry travel
// with it, so they still name the machine the copy came from — measured on a second PC:
// the engine could not be spawned (its path was the old one), the engine home was
// *created* on that PC's own F: drive, and a project nobody could open was listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairMachinePaths } from '../src/config.js';
import { createProjectStore } from '../src/projects.js';
import { OpenCodeEngine } from '../src/engines/opencode.js';
import { VENDOR_ENGINE, PROJECTS_ROOT, SCRATCH_ROOT, scratchDir } from '../src/paths.js';

const quiet = { channel: () => ({ info() {}, warn() {}, error() {}, debug() {} }) };

/** A temp folder that cleans up after itself. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-portable-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a runtime path on a drive this machine does not have is cleared', () => {
  const cfg = { engine: { opencode: { binary: 'Q:\\nowhere\\Synapse\\bin\\opencode\\opencode.exe', home: 'Q:\\nowhere\\Synapse\\data\\engine' } } };
  assert.equal(repairMachinePaths(cfg), true, 'the config should report a change');
  assert.equal(cfg.engine.opencode.binary, '', 'binary falls back to the copy that travels');
  assert.equal(cfg.engine.opencode.home, '', 'home falls back to data/engine/opencode');
});

test('a runtime path that is on this machine is left alone', () => {
  const here = process.execPath;
  const cfg = { engine: { opencode: { binary: here, home: path.dirname(here) } } };
  assert.equal(repairMachinePaths(cfg), false, 'nothing to repair');
  assert.equal(cfg.engine.opencode.binary, here);
  assert.equal(cfg.engine.opencode.home, path.dirname(here));
});

test('the scratch root is a sibling of the projects, and each project has its own folder', () => {
  assert.equal(path.dirname(SCRATCH_ROOT), PROJECTS_ROOT, 'the scratch root travels with the projects root');
  const a = scratchDir('F:/dev/Synapse.Projects/demo');
  const b = scratchDir('F:/dev/Synapse.Projects/demo');
  const c = scratchDir('D:/work/demo');
  assert.equal(a, b, 'the same project always gets the same folder');
  assert.notEqual(a, c, 'two projects with the same name do not share scratch space');
  assert.ok(a.startsWith(SCRATCH_ROOT));
});

test('a project whose folder is gone is not listed, and the registry forgets it', () => {
  const { dir, done } = scratch();
  try {
    const file = path.join(dir, 'projects.json');
    const real = path.join(dir, 'real-project');
    fs.mkdirSync(real, { recursive: true });
    const wrote = (projects) => fs.writeFileSync(file, JSON.stringify({ projects }, null, 2), 'utf8');
    wrote([
      { id: 'real', name: 'Real Project', directory: real, created: 1 },
      { id: 'ghost', name: 'Ghost Project', directory: 'Q:\\nowhere\\Synapse.Projects\\ghost', created: 2 },
    ]);

    const store = createProjectStore({ file, rootDir: dir, logger: quiet });
    assert.deepEqual(store.list().map((p) => p.name), ['Real Project'], 'the ghost is not shown, and there is no built-in project');
    assert.deepEqual(store.pruneMissing(), ['Ghost Project'], 'it is reported once');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects.map((p) => p.name), ['Real Project'], 'and removed from the file');
  } finally {
    done();
  }
});

test('an old General folder is adopted as an ordinary, deletable project', () => {
  const { dir, done } = scratch();
  try {
    const file = path.join(dir, 'projects.json');
    const generalDir = path.join(dir, 'general');
    fs.mkdirSync(generalDir, { recursive: true });
    const store = createProjectStore({ file, rootDir: dir, legacyGeneralDir: generalDir, logger: quiet });
    const names = store.list().map((p) => p.name);
    assert.deepEqual(names, ['General'], 'the work in the old folder is not lost');
    const general = store.list()[0];
    // It used to be undeletable; now it is a project like any other.
    assert.equal(store.remove(general.id), true);
    assert.deepEqual(store.list(), []);
  } finally {
    done();
  }
});

test('the engine falls back to the copy that travels when the configured one is absent', () => {
  const { dir, done } = scratch();
  try {
    const engine = new OpenCodeEngine(
      { binary: 'Q:\\nowhere\\Synapse\\bin\\opencode\\opencode.exe', home: 'Q:\\nowhere\\Synapse\\data\\engine\\opencode' },
      { logger: quiet, workspaceDir: dir, dataDir: dir },
    );
    const binary = engine.resolveBinary();
    assert.notEqual(binary, 'Q:\\nowhere\\Synapse\\bin\\opencode\\opencode.exe', 'a path that is not there is not returned');
    if (fs.existsSync(VENDOR_ENGINE)) assert.equal(binary, VENDOR_ENGINE, 'the vendored copy is preferred over PATH');

    // The home is the one that *created* a folder on the other machine, so it must not
    // be the configured path when its drive is absent.
    assert.equal(engine.resolveHome().base, path.join(dir, 'engine', 'opencode'), 'the home stays inside the folder');
  } finally {
    done();
  }
});
