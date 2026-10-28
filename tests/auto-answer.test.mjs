// Full auto's answer for a question: the Recommended option, or the top one.
//
// The question tool's convention is that the recommended label ends with
// " (Recommended)" — the same suffix the panel turns into a chip. With no
// recommendation the first option is the top row the operator would have seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autoAnswerFor } from '../src/auto-answer.js';

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
