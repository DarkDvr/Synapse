// Private projects (15 Nov): the marker lives in the folder, and nothing about the
// project reaches the logs or the records outside it.
//
// The rail's dots are here too: green and amber were removed because the row already
// shows a conversation and the animation already shows work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { tmpdir } from './tmpdir.mjs';
import { MARKER, addSession, hasMarker, isPrivateDir, isPrivateSession, isPrivateText, reset, setMarker, setPrivateDirs } from '../src/privacy.js';
import { logger } from '../src/logger.js';
import { scratchDir } from '../src/paths.js';
import { createProjectStore } from '../src/projects.js';
import { createTraceReasons } from '../src/trace-reasons.js';

const quiet = { channel: () => ({ info() {}, warn() {}, error() {}, debug() {} }) };

test('the marker is a file inside the project, and reading it needs nothing else', () => {
  const dir = path.join(tmpdir('synapse-private-'), 'project');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(hasMarker(dir), false, 'ordinary until marked');
  setMarker(dir, true);
  assert.equal(hasMarker(dir), true);
  assert.ok(fs.existsSync(path.join(dir, MARKER)), 'the marker is inside the folder');
  setMarker(dir, false);
  assert.equal(hasMarker(dir), false, 'and removing it removes the trace');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('a private folder and its sessions are recognised in free text', () => {
  reset();
  const dir = 'F:\\somewhere\\Synapse.Projects\\secret';
  setPrivateDirs([dir]);
  assert.equal(isPrivateDir(dir), true);
  assert.equal(isPrivateDir('F:/somewhere/Synapse.Projects/secret'), true, 'either separator');
  assert.equal(isPrivateText(`plan (${dir}): empty`), true);
  assert.equal(isPrivateText('plan (F:\\somewhere\\Synapse.Projects\\other): empty'), false);
  addSession('ses_private', dir);
  assert.equal(isPrivateSession('ses_private'), true);
  assert.equal(isPrivateText('prompt -> ses_private: hello'), true);
  assert.equal(isPrivateText('prompt -> ses_other: hello'), false);
  reset();
});

test('a private project keeps its scratch inside its own folder', () => {
  const dir = path.join(tmpdir('synapse-private-scratch-'), 'project');
  fs.mkdirSync(dir, { recursive: true });
  assert.ok(scratchDir(dir).toLowerCase().includes('_scratch'), 'ordinary projects use the shared root');
  setMarker(dir, true);
  const inside = scratchDir(dir);
  assert.equal(path.resolve(inside), path.resolve(dir, '.synapse', 'scratch'));
  setMarker(dir, false);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('the logger refuses a line that names a private project', () => {
  const root = tmpdir('synapse-private-log-');
  const logs = path.join(root, 'logs');
  logger.configure({ dir: logs, level: 'info' });
  reset();
  const dir = 'F:\\somewhere\\Synapse.Projects\\secret';
  setPrivateDirs([dir]);
  try {
    logger.channel('app').info(`plan (${dir}): empty`);
    logger.channel('app').info('ordinary line');
    const text = fs.readFileSync(path.join(logs, 'app.log'), 'utf8');
    assert.match(text, /ordinary line/, 'the ordinary line is written');
    assert.doesNotMatch(text, /secret/, 'the private one is not, not even its name');
  } finally {
    reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a marker in the folder reaches the rail, and the trace store forgets the project', () => {
  const root = tmpdir('synapse-private-store-');
  const projectsRoot = path.join(root, 'projects');
  const dir = path.join(projectsRoot, 'secret');
  fs.mkdirSync(dir, { recursive: true });
  const store = createProjectStore({
    file: path.join(root, 'projects.json'),
    rootDir: projectsRoot,
    scratchRoot: path.join(root, 'scratch'),
    logger: quiet,
  });
  const added = store.create({ name: 'secret', directory: dir });
  assert.equal(added.private, false);
  const marked = store.setPrivate(added.id, true);
  assert.equal(marked.private, true);
  assert.ok(fs.existsSync(path.join(dir, MARKER)), 'the marker is in the project');
  assert.equal(store.find(added.id)?.private, true, 'and the rail sees it');
  const reasons = createTraceReasons(path.join(root, 'reasons.json'));
  reasons.add({ dir, task: 't1', startedAt: 1 }, 'a thought');
  assert.equal(reasons.get({ dir, task: 't1', startedAt: 1 }).length, 1);
  assert.equal(reasons.forget(dir), 1, 'a trace written before the switch is removed');
  assert.equal(reasons.get({ dir, task: 't1', startedAt: 1 }).length, 0);
  assert.equal(store.setPrivate(added.id, false).private, false);
  assert.equal(fs.existsSync(path.join(dir, MARKER)), false, 'switching back removes the marker');
  fs.rmSync(root, { recursive: true, force: true });
});

