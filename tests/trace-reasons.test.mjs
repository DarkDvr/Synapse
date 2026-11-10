// What a worker thought, kept for the run rather than for the page.
//
// The folds were page state: a reload lost them and a second view never had them.
// The notes already came back from `/api/runs`; the reasoning does too now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTraceReasons } from '../src/trace-reasons.js';
import { tmpdir } from './tmpdir.mjs';

const quiet = { warn() {} };

test('a run keeps its last twenty-four steps, and a reload finds them', () => {
  const dir = tmpdir('synapse-traces-');
  try {
    const file = path.join(dir, 'trace-reasons.json');
    const store = createTraceReasons(file, { log: quiet });
    const run = { dir: 'F:\\dev\\Projects\\demo', task: 't6', startedAt: 1 };
    for (let i = 0; i < 30; i += 1) store.add(run, `step ${i}`);
    const kept = store.get(run);
    assert.equal(kept.length, 24, 'twenty-four is the cap');
    assert.equal(kept[0].text, 'step 6', 'the oldest are the ones dropped');
    assert.equal(kept[23].text, 'step 29');

    // Another run is another list, and a run nobody wrote has none.
    assert.deepEqual(store.get({ ...run, task: 't7' }), []);
    assert.deepEqual(store.get({ dir: 'elsewhere', task: 'x', startedAt: 2 }), []);

    // A second store on the same file sees what the first wrote.
    assert.equal(createTraceReasons(file, { log: quiet }).get(run).length, 24);

    // Empty text is not a step.
    assert.equal(store.add(run, '   '), 24);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runs older than a day are pruned at boot', () => {
  const dir = tmpdir('synapse-traces-');
  try {
    const file = path.join(dir, 'trace-reasons.json');
    const store = createTraceReasons(file, { log: quiet });
    const run = { dir: 'F:\\dev\\Projects\\demo', task: 't6', startedAt: 1 };
    store.add(run, 'a thought');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of Object.values(raw.runs)) entry.at = Date.now() - 2 * 86400000;
    fs.writeFileSync(file, JSON.stringify(raw));
    const reloaded = createTraceReasons(file, { log: quiet });
    assert.equal(reloaded.prune(), 1);
    assert.deepEqual(reloaded.get(run), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
