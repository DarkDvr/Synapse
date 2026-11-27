// "Delete Folder And Start Fresh" has to leave nothing of the old project behind.
//
// Measured 28 Nov: the folder was wiped, the folder was made again under the same
// name, and the new chat opened onto the old conversation — because a project is its
// directory and the engine still had the chat keyed to that path. The wipe is one
// operation now: the folder, every session that ran in it, and the registry entry.
// A folder that will not go is an error that names it, never a half-fresh project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createApi } from '../src/api.js';
import { createProjectStore } from '../src/projects.js';
import { tmpdir } from './tmpdir.mjs';

const quiet = {
  channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }),
};

function harness({ sessions = [], active = [], ready = true, failDelete = false } = {}) {
  const log = [];
  const state = {
    ready,
    sessions: sessions.map((s) => ({ ...s })),
    deleteFails: failDelete,
  };
  const engine = {
    status: () => ({ ready: state.ready }),
    listSessions: async () => state.sessions.map((s) => ({ ...s })),
    getSession: async (id) => {
      const found = state.sessions.find((s) => s.id === id);
      if (!found) throw new Error(`no session ${id}`);
      return { ...found };
    },
    listActiveSessions: async () => active,
    listPendingPermissions: async () => [],
    listForms: async () => [],
    deleteSession: async (id) => {
      if (state.deleteFails) throw new Error('the engine refused the delete');
      state.sessions = state.sessions.filter((s) => s.id !== id);
      log.push(['delete', id]);
      return true;
    },
    forgetProject: async (dir) => {
      log.push(['forget', dir]);
      return { projectRows: 1, shells: 0 };
    },
    evictLocation: async (dir) => {
      log.push(['evict', dir]);
      return true;
    },
  };
  const root = tmpdir('synapse-wipe-');
  const projectsRoot = path.join(root, 'projects');
  const store = createProjectStore({
    file: path.join(root, 'data', 'projects.json'),
    rootDir: projectsRoot,
    logger: quiet,
  });
  const api = createApi({
    getConfig: () => ({}),
    engine,
    logger: quiet,
    projects: store,
    runs: { active: () => [] },
    projectsRoot,
    wipeTimeoutMs: 400,
    notePurge: () => {},
  });
  return { api, store, log, projectsRoot, root, state, engine };
}

const mk = (root, name) => path.join(root, 'projects', name);

test('a wipe takes the folder, the conversation and the registry entry', async () => {
  const h = harness();
  const dir = mk(h.root, 'Same');
  h.store.create({ name: 'Same', directory: dir });
  const other = mk(h.root, 'Other');
  h.state.sessions = [
    { id: 'ses_chat', directory: dir, created: 100, title: 'Same' },
    { id: 'ses_worker', directory: dir, created: 50, internal: true },
    { id: 'ses_other', directory: other, created: 60, title: 'Other' },
  ];

  const out = await h.api.wipeProjectDir({ directory: dir });

  assert.equal(out.ok, true);
  assert.equal(out.removed, true, 'the folder is gone');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(out.sessions, 2, 'the chat and the worker session both went');
  assert.deepEqual(
    h.state.sessions.map((s) => s.id),
    ['ses_other'],
    'another project keeps its own conversation',
  );
  assert.ok(h.log.some(([at, d]) => at === 'forget' && d === dir), 'the engine forgets the path');
  assert.ok(h.log.some(([at, d]) => at === 'evict' && d === dir), 'the engine lets go of the folder first');
  assert.equal(
    h.store.list().some((p) => p.directory.toLowerCase() === dir.toLowerCase()),
    false,
    'the registry entry is gone, so the path is not half a project',
  );
});

test('the new project at the same path has no old chat to open', async () => {
  const h = harness();
  const dir = mk(h.root, 'Same');
  h.store.create({ name: 'Same', directory: dir });
  h.state.sessions = [{ id: 'ses_chat', directory: dir, created: 100, title: 'Same' }];

  await h.api.wipeProjectDir({ directory: dir });
  const made = await h.api.createProject({ name: 'Same', directory: dir });

  assert.equal(fs.existsSync(dir), true, 'the new folder exists');
  assert.equal(
    made.project.sessions.length,
    0,
    'the new project has no session, so opening it makes a new chat rather than the old one',
  );
  assert.equal(
    made.project.sessions.some((s) => s.id === 'ses_chat'),
    false,
    'the deleted conversation is not offered',
  );
  const listed = h.store.list().filter((p) => p.directory.toLowerCase() === dir.toLowerCase());
  assert.equal(listed.length, 1, 'one registry entry, not the old one and a duplicate');
});

test('a working project is not wiped, and nothing is deleted', async () => {
  const h = harness({ active: ['ses_chat'] });
  const dir = mk(h.root, 'Busy');
  h.store.create({ name: 'Busy', directory: dir });
  h.state.sessions = [{ id: 'ses_chat', directory: dir, created: 100, title: 'Busy' }];

  await assert.rejects(
    () => h.api.wipeProjectDir({ directory: dir }),
    (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /busy|working|waiting/i);
      return true;
    },
  );
  assert.equal(fs.existsSync(dir), true, 'the folder is untouched');
  assert.deepEqual(h.state.sessions.map((s) => s.id), ['ses_chat'], 'the conversation is untouched');
  assert.equal(h.store.list().length, 1, 'the project is still registered');
});

test('a folder Windows will not let go of is an error that names it, not a half-fresh project', async () => {
  const h = harness();
  const dir = mk(h.root, 'Held');
  h.store.create({ name: 'Held', directory: dir });
  h.state.sessions = [{ id: 'ses_chat', directory: dir, created: 100, title: 'Held' }];

  // A process whose working directory is the folder is the real reason Windows
  // refuses the delete; it is the one case a test can make happen on purpose.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    cwd: dir,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise((r) => setTimeout(r, 400));
  try {
    await assert.rejects(
      () => h.api.wipeProjectDir({ directory: dir }),
      (err) => {
        assert.equal(err.status, 423);
        assert.match(err.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'it names the folder');
        assert.match(err.message, /using it|holding/i, 'it says something is using it');
        assert.match(err.message, /nothing was created/i, 'it says the project was not made');
        return true;
      },
    );
    assert.equal(fs.existsSync(dir), true, 'the files are still there');
    assert.deepEqual(h.state.sessions.map((s) => s.id), ['ses_chat'], 'and so is the chat');
    assert.equal(h.store.list().length, 1, 'the project stays registered, so it can be tried again');
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r).once('error', r));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a folder Synapse creates cannot inherit a chat still keyed to its path', async () => {
  const h = harness();
  const dir = mk(h.root, 'Fresh');
  // The folder is gone (a wipe removed it) but the engine never forgot the chat —
  // the state a failed cleanse leaves behind.
  h.state.sessions = [{ id: 'ses_stale', directory: dir, created: 100, title: 'Fresh' }];

  const made = await h.api.createProject({ name: 'Fresh', directory: dir });

  assert.deepEqual(h.state.sessions, [], 'the stale conversation was removed before registering');
  assert.equal(made.project.sessions.length, 0, 'and the new project starts without a chat');
  assert.ok(h.log.some(([at, id]) => at === 'delete' && id === 'ses_stale'));
});

test('a stale chat the engine will not delete stops the project being registered', async () => {
  const h = harness({ failDelete: true });
  const dir = mk(h.root, 'Fresh');
  h.state.sessions = [{ id: 'ses_stale', directory: dir, created: 100, title: 'Fresh' }];

  await assert.rejects(
    () => h.api.createProject({ name: 'Fresh', directory: dir }),
    (err) => {
      assert.equal(err.status, 423);
      assert.match(err.message, /ses_stale/, 'it names the conversation that will not go');
      assert.match(err.message, /nothing was registered/i);
      return true;
    },
  );
  assert.equal(fs.existsSync(dir), false, 'no folder was made on top of it');
  assert.equal(h.store.list().length, 0, 'no project was registered');
});

test('a wipe refuses a folder outside the projects root', async () => {
  const h = harness();
  const outside = path.join(h.root, 'elsewhere');
  fs.mkdirSync(outside, { recursive: true });

  await assert.rejects(
    () => h.api.wipeProjectDir({ directory: outside }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /not inside/i);
      return true;
    },
  );
  assert.equal(fs.existsSync(outside), true);
});
