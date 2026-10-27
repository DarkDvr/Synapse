// What one session's plan pane and role cards are allowed to say.
//
// 27 Oct: a fresh session's plan opened with two rows already dashed ("handed
// back, waiting for review") and already carrying an hour of time. Both had run
// in an earlier session, under the same task ids, on the same project. The same
// sum gave the QC card a clock while it was dimmed as unused. A task id means
// nothing across sessions, so the run log has to be read as a ledger per session.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runLedger } from '../src/plans.js';

const MINE = 'ses_mine';
const THEIRS = 'ses_theirs';

const delegate = (callId, architect, role = 'coder-1', task = 't2') => ({
  kind: 'delegate',
  callId,
  task,
  role,
  architect,
});

const result = (callId, { task = 't2', ms = 60_000, outcome = 'completed', role = 'coder-1', architect } = {}) => ({
  kind: 'result',
  callId,
  task,
  role,
  outcome,
  ms,
  ...(architect ? { architect } : {}),
});

test('a session counts only the runs it asked for', () => {
  const records = [
    delegate('a', MINE),
    result('a', { ms: 60_000 }),
    delegate('b', THEIRS),
    result('b', { ms: 3_600_000 }),
  ];
  const { spent, reported } = runLedger(records, MINE);
  assert.deepEqual(spent, { t2: 60_000 });
  assert.deepEqual(reported, ['t2']);
});

test('the other session sees its own, not ours', () => {
  const records = [
    delegate('a', MINE),
    result('a', { ms: 60_000 }),
    delegate('b', THEIRS),
    result('b', { ms: 3_600_000 }),
  ];
  assert.deepEqual(runLedger(records, THEIRS).spent, { t2: 3_600_000 });
});

test('runs of one task add up, and other tasks stay separate', () => {
  const records = [
    delegate('a', MINE, 'coder-1', 't2'),
    result('a', { task: 't2', ms: 1_000 }),
    delegate('b', MINE, 'coder-1', 't2'),
    result('b', { task: 't2', ms: 2_000 }),
    delegate('c', MINE, 'qc', 't3'),
    result('c', { task: 't3', role: 'qc', ms: 500 }),
  ];
  const { spent } = runLedger(records, MINE);
  assert.deepEqual(spent, { t2: 3_000, t3: 500 });
});

test('a result that names its asker needs no delegation to match', () => {
  // Newer records carry `architect` themselves; a restart's interrupted result
  // copies it from the delegation it closes.
  assert.deepEqual(runLedger([result('a', { architect: MINE, ms: 800 })], MINE).spent, { t2: 800 });
  assert.deepEqual(runLedger([result('a', { architect: THEIRS, ms: 800 })], MINE).spent, {});
});

test('only a completed run is "handed back"', () => {
  const records = [
    delegate('a', MINE),
    result('a', { outcome: 'stopped' }),
    delegate('b', MINE),
    result('b', { outcome: 'failed' }),
    delegate('c', MINE),
    result('c', { outcome: 'interrupted' }),
  ];
  const { reported, spent } = runLedger(records, MINE);
  assert.deepEqual(reported, []);
  // A stopped or failed run still spent the time it spent.
  assert.equal(spent.t2, 180_000);
});

test('an unattributed result belongs to nobody', () => {
  // A result with no `architect` and no delegation to look it up: there is no
  // honest way to give it to a session, so no session is shown it.
  const { spent, reported } = runLedger([result('ghost')], MINE);
  assert.deepEqual(spent, {});
  assert.deepEqual(reported, []);
});

test('no session means no view to scope to', () => {
  const records = [delegate('a', MINE), result('a')];
  assert.deepEqual(runLedger(records, null), { spent: {}, reported: [] });
  assert.deepEqual(runLedger(records, ''), { spent: {}, reported: [] });
});

test('a record with no usable time is history, not a clock', () => {
  const records = [
    delegate('a', MINE),
    result('a', { ms: 0 }),
    delegate('b', MINE),
    result('b', { ms: 'nonsense' }),
    delegate('c', MINE),
    result('c', { ms: -50 }),
  ];
  assert.deepEqual(runLedger(records, MINE).spent, {});
});

test('the log is read, not transformed: junk lines are ignored', () => {
  const records = [null, { kind: 'delegate' }, { kind: 'result' }, delegate('a', MINE), result('a')];
  const { spent } = runLedger(records.filter(Boolean), MINE);
  assert.equal(spent.t2, 60_000);
});
