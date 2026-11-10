// The temp-folder helper, proved rather than assumed.
//
// The point of `tmpdir()` is the case a test cannot clean up after itself: it
// throws. So the proof is a child process that makes a folder, prints where it is
// and then throws — the parent then looks for the folder. A helper that only
// cleaned up on the happy path would pass every other test in this suite and still
// leak a folder per failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from './tmpdir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = pathToFileURL(path.join(HERE, 'tmpdir.mjs')).href;

/** Run a child that uses the helper, and answer the folder it printed. */
function childThatThrows() {
  const code = [
    `import { tmpdir } from ${JSON.stringify(HELPER)};`,
    `const dir = tmpdir('synapse-hook-throw-');`,
    `console.log(dir);`,
    `throw new Error('a test that failed');`,
  ].join('\n');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  const dir = (run.stdout || '').trim().split(/\r?\n/).pop();
  return { dir, status: run.status };
}

test('it makes a folder that exists, once per call', () => {
  const a = tmpdir('synapse-hook-a-');
  const b = tmpdir('synapse-hook-b-');
  assert.ok(fs.existsSync(a));
  assert.ok(fs.existsSync(b));
  assert.notEqual(a, b);
});

test('a child that throws still leaves nothing behind', () => {
  const { dir, status } = childThatThrows();
  assert.ok(dir && path.isAbsolute(dir), `the child printed no folder (exit ${status})`);
  assert.notEqual(status, 0, 'the child was supposed to fail');
  assert.equal(fs.existsSync(dir), false, `the folder survived a failing test: ${dir}`);
});

test('a folder a test removed early is not a problem for the sweep', () => {
  const dir = tmpdir('synapse-hook-gone-');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
  // No assertion after this: the exit hook runs next, and must not throw on a
  // folder that is already gone (a throw there would fail the whole file).
});
