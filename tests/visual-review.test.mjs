// The renderer refuses what it cannot do.
//
// Timer Test 1: `shot.mjs --help` photographed a file called `--help`, wrote a
// picture of the browser's error page, and exited 0 — three runs believed it had
// looked at the page. These assertions are the cheap half (no browser launched, no
// page rendered): a wrong call must fail, and say why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SHOT = path.resolve('skills/visual-review/bin/shot.mjs');
const run = (...args) => spawnSync(process.execPath, [SHOT, ...args], { encoding: 'utf8', timeout: 30000 });

test('--help prints the usage and exits 0, without needing a page', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: shot\.mjs/);
  assert.match(r.stdout, /--widths/);
});

test('an unknown option is refused, never treated as the target', () => {
  const r = run('--help-typo', 'somewhere.html');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such option: --help-typo/);
  assert.match(r.stderr, /Usage: shot\.mjs/);
});

test('a file that is not there is refused', () => {
  const r = run('nope-does-not-exist.html');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such file/);
});

test('two targets at once are refused', () => {
  const r = run('a.html', 'b.html');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /one target at a time/);
});

test('no target at all prints the usage', () => {
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: shot\.mjs/);
});

// --expect asserts the RENDERED text of a control, because the attribute is the
// lie: a date input can carry lang="en-GB" and still draw "10/22/2026 04:00 PM".
// A malformed expectation is refused before a browser is launched.
test('a malformed --expect is refused without a page', () => {
  const r = run('somewhere.html', '--expect', 'no-pipe-here');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--expect needs "selector\|regex"/);
});

test('--expect with an empty pattern is refused', () => {
  const r = run('somewhere.html', '--expect', '#when|');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--expect needs "selector\|regex"/);
});
