// The travel-copy helper: the safety that has to survive an edit.
//
// A batch wrapper is easy to make convenient and dangerous at once. These are the
// properties the operator asked for: accept a destination, refuse the Synapse
// folder (and anything that contains it), and never delete a folder that is not a
// previous deliverable.
//
// Run: node tests\deliverable.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bat = fs.readFileSync(path.join(ROOT, 'create_deliverable.bat'), 'utf8');
const ps1Bytes = fs.readFileSync(path.join(ROOT, 'make-deliverable.ps1'));
const ps1 = ps1Bytes.toString('utf8');

test('the batch file accepts a destination and prompts when none is given', () => {
  assert.match(bat, /set "DEST=%~1"/);
  assert.match(bat, /set \/p "DEST=Destination folder: "/);
  assert.match(bat, /-Destination "%DEST%"/);
});

test('the batch file refuses the Synapse folder before staging', () => {
  assert.match(bat, /StartsWith\(\$s\+/);
  assert.match(bat, /errorlevel 3/);
  assert.match(bat, /Nothing was copied or deleted/);
});

test('the worker refuses the source, an ancestor, and the projects folder', () => {
  assert.match(ps1, /the destination is the Synapse folder itself/);
  assert.match(ps1, /the destination contains the Synapse folder/);
  assert.match(ps1, /the destination overlaps the projects folder/);
});

test('an existing folder is replaced only with the marker and an explicit switch', () => {
  assert.match(ps1, /\.synapse-deliverable/);
  assert.match(ps1, /if \(-not \$Force\)/);
  assert.match(ps1, /has no \.synapse-deliverable marker/);
});

test('the PowerShell worker stays readable by Windows PowerShell 5.1', () => {
  // Without the BOM, 5.1 reads UTF-8 as ANSI; a three-byte em dash becomes a
  // right quote and the script stops parsing. The batch file calls powershell.exe.
  assert.deepEqual([...ps1Bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});
