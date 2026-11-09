// A saved config must not keep a role that has no card.
//
// Coder 3 was removed on 9 Nov 2026 with the main-panel redesign: the stack is
// Inventor, Designer, QC, Coder 1, Coder 2. A config written before that still
// names `coder-3` in `worker.ladder`, and the harness would delegate to it — the
// run would work, and the panel would have no card to put it in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/config.js';

test('a ladder entry with no card is dropped on load', () => {
  const cfg = normalize({ worker: { ladder: ['coder-1', 'coder-2', 'coder-3'] } });
  assert.deepEqual(cfg.worker.ladder, ['coder-1', 'coder-2']);
});

test('a ladder of nothing but unknown roles falls back rather than emptying', () => {
  const cfg = normalize({ worker: { ladder: ['coder-3', 'nobody'] } });
  assert.deepEqual(cfg.worker.ladder, []);
  // An empty ladder is a real answer: a role off it is tried on its own, and the
  // harness says so. What must not happen is an unknown id being carried through.
});

test('the default ladder is the two coders that exist', () => {
  const cfg = normalize({});
  assert.deepEqual(cfg.worker.ladder, ['coder-1', 'coder-2']);
});
