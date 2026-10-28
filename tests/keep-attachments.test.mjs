// "Keep" writes the operator's attachment into the project, so it survives the
// transcript. These checks are about the two things that can go wrong: a file
// escaping the folder, and a second keep of the same name overwriting the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { keepAttachments, safeAttachmentName } from '../src/keep-attachments.js';

const b64 = (text) => Buffer.from(text).toString('base64');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-keep-'));

test('a kept file lands in .synapse/attachments with its bytes', () => {
  const dir = temp();
  const kept = keepAttachments(dir, [{ name: 'log.txt', mime: 'text/plain', data: b64('hello'), keep: true }]);
  assert.equal(kept.length, 1);
  assert.match(kept[0].path, /^\.synapse\/attachments\//);
  assert.equal(fs.readFileSync(path.join(dir, kept[0].path), 'utf8'), 'hello');
  assert.equal(kept[0].bytes, 5);
});

test('unchecked files are not written', () => {
  const dir = temp();
  const kept = keepAttachments(dir, [
    { name: 'no.txt', data: b64('x') },
    { name: 'yes.txt', data: b64('y'), keep: true },
  ]);
  assert.deepEqual(kept.map((k) => k.name).map((n) => n.endsWith('yes.txt')), [true]);
  assert.equal(fs.existsSync(path.join(dir, '.synapse', 'attachments')), true);
  assert.equal(fs.readdirSync(path.join(dir, '.synapse', 'attachments')).length, 1);
});

test('two files with one name do not overwrite each other', () => {
  const dir = temp();
  const kept = keepAttachments(
    dir,
    [
      { name: 'same.txt', data: b64('one'), keep: true },
      { name: 'same.txt', data: b64('two'), keep: true },
    ],
    { at: Date.parse('2026-10-28T12:00:00Z') },
  );
  assert.equal(kept.length, 2);
  assert.notEqual(kept[0].name, kept[1].name);
  assert.equal(fs.readFileSync(path.join(dir, kept[1].path), 'utf8'), 'two');
});

test('a name with separators cannot escape the folder', () => {
  const dir = temp();
  const kept = keepAttachments(
    dir,
    [{ name: '../../evil.txt', data: b64('nope'), keep: true }],
    { at: Date.parse('2026-10-28T12:00:00Z') },
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name.includes('/'), false);
  assert.equal(kept[0].name.includes('\\'), false);
  assert.equal(path.resolve(path.join(dir, kept[0].path)).startsWith(path.resolve(dir)), true);
});

test('the safe name keeps a readable tail and drops a leading dot', () => {
  assert.equal(safeAttachmentName('../secret.txt'), '_secret.txt');
  assert.equal(safeAttachmentName('.env'), 'env');
  assert.equal(safeAttachmentName('a/b\\c.txt'), 'a_b_c.txt');
});
