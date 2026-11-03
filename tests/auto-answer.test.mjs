// Full auto's answer for a question: the Recommended option, or the top one.
//
// The question tool's convention is that the recommended label ends with
// " (Recommended)" — the same suffix the panel turns into a chip. With no
// recommendation the first option is the top row the operator would have seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { autoAnswerFor, recommendedOptions } from '../src/auto-answer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const option = (label, value = label) => ({ label, value });

test('the recommended option wins, wherever it is in the list', () => {
  const form = {
    fields: [{ key: 'q', type: 'string', options: [option('No', 'no'), option('Yes (Recommended)', 'yes')] }],
  };
  assert.deepEqual(autoAnswerFor(form), { q: 'yes' });
});

test('with no recommendation the top option is taken', () => {
  const form = { fields: [{ key: 'q', type: 'string', options: [option('First', 'a'), option('Second', 'b')] }] };
  assert.deepEqual(autoAnswerFor(form), { q: 'a' });
});

test('a multi-select takes every recommended option, or the top one', () => {
  const recommended = {
    fields: [
      {
        key: 'q',
        type: 'multiselect',
        options: [option('A (Recommended)', 'a'), option('B (Recommended)', 'b'), option('C', 'c')],
      },
    ],
  };
  assert.deepEqual(autoAnswerFor(recommended), { q: ['a', 'b'] });
  const plain = { fields: [{ key: 'q', type: 'multiselect', options: [option('A', 'a'), option('B', 'b')] }] };
  assert.deepEqual(autoAnswerFor(plain), { q: ['a'] });
});

test('boolean and free text use a sane default', () => {
  assert.deepEqual(autoAnswerFor({ fields: [{ key: 'ok', type: 'boolean' }] }), { ok: true });
  assert.deepEqual(autoAnswerFor({ fields: [{ key: 'name', type: 'string', default: 'Ada' }] }), { name: 'Ada' });
  assert.deepEqual(autoAnswerFor({ fields: [{ key: 'name', type: 'string' }] }), { name: '' });
  assert.deepEqual(autoAnswerFor({ fields: [{ key: 'n', type: 'number', default: 3 }] }), { n: 3 });
  assert.deepEqual(autoAnswerFor({ fields: [{ key: 'n', type: 'number' }] }), { n: null });
});

test('hidden and external fields are not answered', () => {
  const form = {
    fields: [
      { key: 'hidden', hidden: true, type: 'string', options: [option('X', 'x')] },
      { key: 'link', type: 'external', url: 'https://example.com' },
      { key: 'q', type: 'string', options: [option('A', 'a')] },
    ],
  };
  assert.deepEqual(autoAnswerFor(form), { q: 'a' });
});

test('a form with nothing answerable is null', () => {
  assert.equal(autoAnswerFor({ fields: [] }), null);
  assert.equal(autoAnswerFor({}), null);
  assert.equal(autoAnswerFor(null), null);
});

// The matrix that was missing (3 Nov). Every shape the engine can hand us, so a
// change to one branch cannot quietly break another — this is what "surface-level
// testing" looked like the one time it mattered.
test('every field shape, and every recommendation count', () => {
  const cases = [
    {
      name: 'single choice, one recommended in the middle',
      field: { key: 'q', type: 'string', options: [option('A', 'a'), option('B (Recommended)', 'b'), option('C', 'c')] },
      want: { q: 'b' },
    },
    {
      name: 'single choice, two recommended — the first wins, the answer stays one value',
      field: {
        key: 'q',
        type: 'string',
        options: [option('Sydney (Recommended)', 'syd'), option('Rome', 'rome'), option('San Francisco (Recommended)', 'sf')],
      },
      want: { q: 'syd' },
    },
    {
      name: 'single choice, none recommended — the top row',
      field: { key: 'q', type: 'string', options: [option('First', '1'), option('Second', '2')] },
      want: { q: '1' },
    },
    {
      name: 'multi-select, every recommended option is taken',
      field: {
        key: 'q',
        type: 'multiselect',
        options: [option('Sydney (Recommended)', 'syd'), option('Rome', 'rome'), option('San Francisco (Recommended)', 'sf')],
      },
      want: { q: ['syd', 'sf'] },
    },
    {
      name: 'multi-select, no recommendation — one row, never an empty list',
      field: { key: 'q', type: 'multiselect', options: [option('A', 'a'), option('B', 'b')] },
      want: { q: ['a'] },
    },
    { name: 'boolean is true', field: { key: 'q', type: 'boolean' }, want: { q: true } },
    { name: 'number takes its default', field: { key: 'q', type: 'number', default: 7 }, want: { q: 7 } },
    { name: 'number with no default is null', field: { key: 'q', type: 'number' }, want: { q: null } },
    { name: 'free text takes its default', field: { key: 'q', type: 'string', default: 'Ada' }, want: { q: 'Ada' } },
    { name: 'free text with no default is empty', field: { key: 'q', type: 'string' }, want: { q: '' } },
  ];
  for (const c of cases) {
    assert.deepEqual(autoAnswerFor({ fields: [c.field] }), c.want, c.name);
  }
});

test('a contradictory single-choice question is reported, not silently halved', () => {
  const field = {
    key: 'q',
    type: 'string',
    options: [option('Sydney (Recommended)', 'syd'), option('San Francisco (Recommended)', 'sf')],
  };
  assert.equal(recommendedOptions(field).length, 2, 'both recommendations are visible to the caller');
  // The server logs it: a single-choice question with two recommendations is the
  // model contradicting itself, and the operator should see that reason.
  assert.match(read('src/form-auto.js'), /single-choice question that marks/);
});
