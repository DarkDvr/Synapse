// Opening a path the chat named, and making sure it stays inside the project.
//
// The path is model output, so the interesting cases are the escapes: `..`, an
// absolute path, a link that points elsewhere. The answer is the same fence the
// permission policy uses for a tool call, applied to the operator's click.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, explorerArgs, inside } from '../src/open-path.js';
import { tmpdir } from './tmpdir.mjs';

test('a file inside the project resolves, and says what it is', () => {
  const dir = tmpdir('synapse-open-');
  fs.writeFileSync(path.join(dir, 'report.md'), '# report\n');
  fs.mkdirSync(path.join(dir, 'shots'));
  const file = resolveProjectPath(dir, 'report.md');
  assert.equal(file.error, undefined);
  assert.equal(file.exists, true);
  assert.equal(file.isDir, false);
  assert.equal(path.basename(file.path), 'report.md');
  const folder = resolveProjectPath(dir, 'shots');
  assert.equal(folder.exists, true);
  assert.equal(folder.isDir, true);
});

test('a path outside the project is refused however it is spelled', () => {
  const dir = tmpdir('synapse-open-');
  assert.equal(resolveProjectPath(dir, '..\\outside.txt').error, 'outside');
  assert.equal(resolveProjectPath(dir, '../outside.txt').error, 'outside');
  assert.equal(resolveProjectPath(dir, 'C:\\Windows\\win.ini').error, 'outside');
  assert.equal(resolveProjectPath(dir, '').error, 'empty');
});

test('a missing file still names its folder, so Open Folder has somewhere to go', () => {
  const dir = tmpdir('synapse-open-');
  fs.mkdirSync(path.join(dir, 'gone'));
  const missing = resolveProjectPath(dir, 'gone\\deleted.txt');
  assert.equal(missing.error, 'missing');
  assert.equal(missing.parent, path.join(dir, 'gone'));
  // A missing parent is not a place to open either.
  assert.equal(resolveProjectPath(dir, 'nowhere\\deleted.txt').parent, undefined);
});

test('a file is revealed with the path attached to /select, and a folder opens as itself', () => {
  assert.deepEqual(explorerArgs({ path: 'C:\\p\\report.md', isDir: false }, { select: true }), [
    '/select,C:\\p\\report.md',
  ]);
  assert.deepEqual(explorerArgs({ path: 'C:\\p\\report.md', isDir: false }, { select: false }), [
    'C:\\p\\report.md',
  ]);
  assert.deepEqual(explorerArgs({ path: 'C:\\p\\shots', isDir: true }, { select: true }), ['C:\\p\\shots']);
});

test('a drive root is still a parent', () => {
  assert.equal(inside('C:\\proj\\a.txt', 'C:\\proj'), true);
  assert.equal(inside('C:\\proj', 'C:\\'), true);
  assert.equal(inside('C:\\other\\a.txt', 'C:\\proj'), false);
});

test('the file route is the host’s, and it goes through the project fence', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'src/api.js'), 'utf8');
  assert.match(api, /openProjectPath: async/);
  assert.match(api, /resolveProjectPath\(project\.directory, body\?\.path\)/);
  assert.match(api, /that file is outside this project/);
  const server = fs.readFileSync(path.join(process.cwd(), 'src/server.js'), 'utf8');
  assert.match(server, /seg\[2\] === 'open-path'/, 'no route for the menu to call');
  assert.match(server, /fromLan[\s\S]{0,120}host only/, 'a remote view must not open windows here');
});
