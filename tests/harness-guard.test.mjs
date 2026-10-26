// The harness guard's per-turn check.
//
// Every finished turn is handed the whole transcript. Before this test existed,
// that meant the same tool call was inspected on every later turn and its alarm
// rang again each time — three identical "shell command naming the harness"
// alarms for one command in the permission test.
//
// Run: node tests\harness-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHarnessGuard } from '../src/harness.js';
import { ROOT } from '../src/paths.js';

const quiet = { channel: () => ({ info() {}, warn() {}, error() {} }) };

const message = (id, part) => ({ id, parts: [part] });
const shell = (id, command) => ({ id, type: 'tool', name: 'shell', input: { command } });

test('one harness call alarms once, not once per finished turn', () => {
  const alarms = [];
  const guard = createHarnessGuard({ root: ROOT, logger: quiet, notify: (event) => alarms.push(event) });
  const messages = [message('m1', shell('p1', `Set-Content -Path ${ROOT}\\logs\\probe.txt -Value x`))];

  guard.checkTurn({ sessionId: 'ses_1', messages, label: 'turn 1' });
  guard.checkTurn({ sessionId: 'ses_1', messages, label: 'turn 2' });
  assert.equal(alarms.length, 1, 'the same call was alarmed twice');

  const later = [
    ...messages,
    message('m2', shell('p2', `Set-Content -Path ${ROOT}\\logs\\probe2.txt -Value y`)),
  ];
  guard.checkTurn({ sessionId: 'ses_1', messages: later, label: 'turn 3' });
  assert.equal(alarms.length, 2, 'a new call must still alarm');
});

test('a read naming the harness is logged, not alarmed', () => {
  const alarms = [];
  const guard = createHarnessGuard({ root: ROOT, logger: quiet, notify: (event) => alarms.push(event) });
  guard.checkTurn({
    sessionId: 'ses_2',
    messages: [message('m1', shell('p1', `Get-Content ${ROOT}\\logs\\app.log -Tail 5`))],
    label: 'turn 1',
  });
  assert.equal(alarms.length, 0);
});
