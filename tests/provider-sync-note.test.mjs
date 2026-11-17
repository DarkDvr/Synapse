// The model-list notice: two halves, and different shapes on purpose.
//
// What changed is worth a line per provider; what did not answer is one sentence.
// A provider that answered with the same list is not in it at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerSyncNote } from '../web/provider-sync-note.js';

const sync = (updated, failed = []) => ({ updated, failed });

test('changed providers are bulleted with their counts, failures are a sentence', () => {
  const note = providerSyncNote(
    sync(
      [
        { name: 'OpenCode Go', added: 2, removed: 1 },
        { name: 'Some Other Provider', added: 0, removed: 1 },
      ],
      [{ name: 'Local LLM' }, { name: 'PolyStrata' }],
    ),
  );
  assert.equal(
    note.body,
    'Got updated models from:\n' +
      '- OpenCode Go (+2, -1)\n' +
      '- Some Other Provider (-1)\n' +
      '\n' +
      "Providers that didn't respond: Local LLM, PolyStrata",
  );
});

test('a provider that changed nothing is not mentioned', () => {
  const note = providerSyncNote(sync([{ name: 'Quiet', added: 0, removed: 0 }, { name: 'Loud', added: 0, removed: 3 }]));
  assert.doesNotMatch(note.body, /Quiet/);
  assert.match(note.body, /Loud \(-3\)/);
});

test('failures only: no empty “Got updated” heading', () => {
  const note = providerSyncNote(sync([], [{ name: 'Local LLM' }]));
  assert.equal(note.body, "Providers that didn't respond: Local LLM");
});

test('nothing to say means no notice at all', () => {
  assert.equal(providerSyncNote(sync([])), null);
  assert.equal(providerSyncNote(sync([{ name: 'Same', added: 0, removed: 0 }])), null);
  assert.equal(providerSyncNote(null), null);
});

test('the sign is only on the number that moved', () => {
  const added = providerSyncNote(sync([{ name: 'A', added: 4, removed: 0 }]));
  assert.match(added.body, /A \(\+4\)/);
  const both = providerSyncNote(sync([{ name: 'B', added: 1, removed: 1 }]));
  assert.match(both.body, /B \(\+1, -1\)/);
});
