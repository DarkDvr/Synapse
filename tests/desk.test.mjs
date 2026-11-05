// The screen lease: one project at a time, given by the operator, taken back by
// the operator.
//
// Measured 5 Nov: a worker launched an app and brought its window to the front
// while the operator was using the machine. The window grab is the only thing the
// harness does that is not about files — it is the operator's mouse, keyboard and
// focus — so it asks, and "yes" is a lease they can end at any moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDesk } from '../src/desk.js';

const A = 'F:\\dev\\Synapse.Projects\\a';
const B = 'F:\\dev\\Synapse.Projects\\b';

test('the first project to be allowed takes the screen', () => {
  const desk = createDesk();
  const out = desk.take({ dir: A, role: 'coder-1', task: 't5' });
  assert.equal(out.ok, true);
  assert.equal(out.already, false);
  assert.equal(desk.holds(A), true);
  assert.equal(desk.holds(B), false);
});

test('a second project cannot take it while the first holds it', () => {
  const desk = createDesk();
  desk.take({ dir: A, role: 'coder-1', task: 't5' });
  const out = desk.take({ dir: B, role: 'coder-2', task: 't6' });
  assert.equal(out.ok, false);
  assert.equal(out.held.dir, A);
  assert.equal(desk.holds(B), false);
});

test('asking again for the same project keeps the lease, and the clock', () => {
  const desk = createDesk();
  desk.take({ dir: A, role: 'coder-1', task: 't5' });
  const at = desk.state().desk.at;
  const again = desk.take({ dir: A, role: 'coder-1', task: 't5' });
  assert.equal(again.already, true);
  assert.equal(desk.state().desk.at, at);
});

test('a run ending releases only its own project', () => {
  const desk = createDesk();
  desk.take({ dir: A });
  assert.equal(desk.release('the run ended', B).released, false, 'B never had it');
  assert.equal(desk.holds(A), true);
  assert.equal(desk.release('the run ended', A).released, true);
  assert.equal(desk.holds(A), false);
});

test('Take Back releases whatever is held and says why', () => {
  const events = [];
  const desk = createDesk({ notify: (ev) => events.push(ev) });
  desk.take({ dir: A, role: 'coder-1', task: 't5' });
  const out = desk.release('the operator took it back');
  assert.equal(out.released, true);
  assert.equal(out.held.dir, A);
  const said = events.filter((e) => e.type === 'desk.released');
  assert.equal(said.length, 1);
  assert.equal(said[0].why, 'the operator took it back');
});

test('nothing held is nothing to release', () => {
  const desk = createDesk();
  assert.equal(desk.release('x').released, false);
  assert.equal(desk.state().desk, null);
});
