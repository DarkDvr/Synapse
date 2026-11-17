// The background-shell mirror: the engine's own output path is unreadable to a model, so
// the harness copies it into the project. Two halves are worth pinning — the transcript
// shape the path is read from, and the copy landing where the brief says it will.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backgroundShells, mirrorPath, mirrorShells, adoptEngineCopy, MIRROR_RULE } from '../src/shell-mirror.js';
import { tmpdir } from './tmpdir.mjs';

const part = (output, extra = {}) => ({ type: 'tool', name: 'shell', output, ...extra });
const messages = (...parts) => parts.map((p, i) => ({ id: `m${i}`, type: 'assistant', parts: [p] }));

test('the backgrounded shell is found in the transcript, with its source path', () => {
  const text =
    'Command moved to the background (shell ID: sh_1eb1b11d4001JCeSPtUFhaG6G8). ' +
    'Output is streaming to: F:\\dev\\Synapse\\data\\engine\\opencode\\data\\opencode\\shell\\abc\\sh_1.out';
  assert.deepEqual(backgroundShells(messages(part(text))), [
    { id: 'sh_1eb1b11d4001JCeSPtUFhaG6G8', source: 'F:\\dev\\Synapse\\data\\engine\\opencode\\data\\opencode\\shell\\abc\\sh_1.out' },
  ]);
  // A foreground result, and an ordinary message, name nothing.
  assert.deepEqual(backgroundShells(messages(part('done, 12 files'))), []);
  assert.deepEqual(backgroundShells([]), []);
});

test('the output is copied into the project, and a growing file is copied again', () => {
  const dir = tmpdir('synapse-mirror-');
  const source = path.join(dir, 'engine', 'sh_1.out');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'first\n');
  const shells = [{ id: 'sh_1', source }];

  assert.deepEqual(mirrorShells(dir, shells), ['sh_1']);
  const copy = mirrorPath(dir, 'sh_1');
  assert.equal(copy, path.join(dir, '.project', 'logs', 'shell-sh_1.out'));
  assert.equal(fs.readFileSync(copy, 'utf8'), 'first\n', 'the copy is inside .project/logs');

  fs.writeFileSync(source, 'first\nsecond\n');
  assert.deepEqual(mirrorShells(dir, shells), ['sh_1']);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'first\nsecond\n', 'the copy grows with the command');

  // A source that has gone is not an error: the copy that exists is the record.
  fs.rmSync(source);
  assert.deepEqual(mirrorShells(dir, shells), []);
  assert.equal(fs.existsSync(copy), true);
});

test('the brief says where the copy is, and that waiting is not finishing', () => {
  assert.match(MIRROR_RULE, /\.project\/logs\/shell-<id>\.out/);
  assert.match(MIRROR_RULE, /do not end the turn waiting/);
});

test('a refused read of the engine copy is answered with the project path', () => {
  const dir = tmpdir('synapse-adopt-');
  const source = path.join(dir, 'data', 'engine', 'opencode', 'data', 'opencode', 'shell', 'abc', 'sh_deadbeef.out');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'night suite: 74 asserts, 0 failed\n');
  const adopted = adoptEngineCopy([`Get-Content "${source}"`], dir);
  assert.ok(adopted, 'the engine copy is recognised inside a command line');
  assert.equal(adopted.id, 'sh_deadbeef');
  assert.equal(adopted.path, path.join(dir, '.project', 'logs', 'shell-sh_deadbeef.out'));
  assert.match(fs.readFileSync(adopted.path, 'utf8'), /74 asserts, 0 failed/);
  // Anything else is not adopted: the rule is about the engine's shell store only.
  assert.equal(adoptEngineCopy(['F:/dev/Synapse/data/engine/opencode/data/opencode/opencode.db'], dir), null);
});
