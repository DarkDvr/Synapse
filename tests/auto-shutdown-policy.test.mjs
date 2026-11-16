// Auto-Shutdown is the operator's switch, not the harness's.
//
// It has powered this PC off under a test run more than once. The fix is not a
// promise in a comment: the page marks its requests, the server refuses an enable
// from anywhere else, and the suite's script leaves the switch off afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.m?js$/.test(entry.name)) out.push(rel);
  }
  return out;
};

test('the page marks every request, and the server reads the mark', () => {
  assert.match(read('web/api.js'), /'x-synapse-ui': '1'/);
  assert.match(read('src/server.js'), /x-synapse-ui/);
  assert.match(read('src/api.js'), /mayEnableAutoShutdown/);
  assert.match(read('src/api.js'), /Auto-Shutdown can only be turned on in the Synapse window/);
});

test('nothing in src or scripts ever asks for Auto-Shutdown on', () => {
  for (const rel of [...walk('src'), 'scripts/checks.mjs']) {
    assert.doesNotMatch(read(rel), /autoShutdown\s*:\s*true/, rel);
  }
});

test('the checks script leaves the switch off, never restores it', () => {
  const script = read('scripts/checks.mjs');
  assert.doesNotMatch(script, /autoShutdown\s*:\s*true/);
  assert.match(script, /never restores/i);
  assert.match(script, /only the Synapse window can turn it on/i);
});
