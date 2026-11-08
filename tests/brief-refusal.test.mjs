// A delegation the harness refuses is silent by design: waking the Architect to say
// "stop" would start another turn it could delegate in again. So the brief has to
// carry the truth instead.
//
// 8 Nov: the Architect delegated t12, the runner refused it (Keep Building off, no
// operator message since the last report) and journalled the refusal. The Architect's
// transcript ended on a delegate reply that said "Queued: t12 … you will be told the
// outcome". An hour later the operator said "Continue work." and the Architect answered
// "t12 is already running" — true to its own transcript, false to the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { briefSession } from '../src/plans.js';

const writeProject = (records) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-brief-'));
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.synapse', 'plan.json'),
    JSON.stringify({
      version: 1,
      goal: 'finish the widget',
      summary: '',
      tasks: [
        { id: 't11', title: 'GPU load', role: 'coder-1', status: 'done', origin: 'plan' },
        { id: 't12', title: 'Menu and startup', role: 'coder-1', status: 'todo', origin: 'plan' },
      ],
    }),
  );
  fs.writeFileSync(path.join(dir, '.synapse', 'runs.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
};

const at = Date.now();
const doneT11 = { kind: 'result', at: at - 60_000, task: 't11', role: 'coder-1', outcome: 'completed' };

test('a refused delegation is reported as never started', () => {
  const dir = writeProject([doneT11, { kind: 'delegate', at, callId: 'c1', task: 't12', role: 'coder-1', outcome: 'keep-building-off' }]);
  try {
    const text = briefSession({ dir, role: 'architect', auto: false });
    assert.match(text, /t12 was delegated but never started/, 'the Architect is told the truth');
    assert.match(text, /Keep Building is off/, 'with the reason');
    assert.match(text, /delegate it again/, 'and what to do when the operator says go on');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a delegation that did start says nothing of the sort', () => {
  const dir = writeProject([doneT11, { kind: 'delegate', at, callId: 'c1', task: 't12', role: 'coder-1' }]);
  try {
    const text = briefSession({ dir, role: 'architect', auto: false });
    assert.doesNotMatch(text, /was delegated but never started/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
