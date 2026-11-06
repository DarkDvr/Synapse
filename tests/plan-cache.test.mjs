// The plan is parsed once per change, not once per poll.
//
// The plan pane asks for it while a run streams, on the same thread that serves the
// stream. The file is small, but the parse is not free, and it happened on every
// poll. A stat is cheap; a matching mtime and size means the parsed result is still
// the answer.
//
// The dangerous half of a cache is the stale read, so this test proves freshness
// after a write that does not change the file's size — "doing" to "todo" is the same
// length, and the invalidation is the only thing that catches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readPlan, setTaskStatus, invalidatePlan, clearPlanCache } from '../src/plans.js';

const plan = (tasks) => ({ version: 1, goal: 'a test', summary: '', tasks });

function project(tasks = [
  { id: 't1', title: 'First', role: 'coder-1', status: 'doing' },
  { id: 't2', title: 'Second', role: 'coder-1', status: 'todo' },
]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-plan-cache-'));
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.synapse', 'plan.json'), `${JSON.stringify(plan(tasks), null, 2)}\n`, 'utf8');
  return dir;
}

/** Count the reads of a plan file without touching the module's own code. */
function countPlanReads() {
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function counted(...args) {
    if (String(args[0]).endsWith('plan.json')) reads += 1;
    return real.apply(fs, args);
  };
  return {
    get reads() {
      return reads;
    },
    stop() {
      fs.readFileSync = real;
    },
  };
}

test('two reads of an unchanged plan parse the file once', () => {
  const dir = project();
  clearPlanCache();
  const counter = countPlanReads();
  try {
    const first = readPlan(dir);
    const second = readPlan(dir);
    assert.equal(first.plan.tasks.length, 2);
    assert.equal(second.plan.tasks.length, 2);
    assert.equal(counter.reads, 1, 'the second read came from the cache');
    assert.notEqual(first, second, 'and it is a copy, so a caller cannot poison it');
  } finally {
    counter.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed file is seen at once, even when its size is the same', () => {
  const dir = project();
  clearPlanCache();
  assert.equal(readPlan(dir).plan.tasks[1].status, 'todo');
  // "todo" and "done" are both four characters, so the file's size does not move:
  // the invalidation is the only thing that catches this, and it must.
  assert.equal(setTaskStatus(dir, 't2', 'done'), true);
  assert.equal(readPlan(dir).plan.tasks[1].status, 'done', 'the write invalidated the cache');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a change made by someone else is caught by the stat', () => {
  const dir = project();
  clearPlanCache();
  const file = path.join(dir, '.synapse', 'plan.json');
  assert.equal(readPlan(dir).plan.tasks.length, 2);
  // The Architect owns the file, so this is the normal case: a tool writes it and
  // Synapse never hears about it.
  const bigger = plan([
    { id: 't1', title: 'First', role: 'coder-1', status: 'done' },
    { id: 't2', title: 'Second', role: 'coder-1', status: 'todo' },
    { id: 't3', title: 'Third', role: 'coder-1', status: 'todo' },
  ]);
  fs.writeFileSync(file, `${JSON.stringify(bigger, null, 2)}\n`, 'utf8');
  assert.equal(readPlan(dir).plan.tasks.length, 3, 'a different size is a different plan');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('invalidatePlan forces the next read to look again', () => {
  const dir = project();
  clearPlanCache();
  readPlan(dir);
  const counter = countPlanReads();
  try {
    readPlan(dir);
    assert.equal(counter.reads, 0, 'still cached');
    invalidatePlan(dir);
    readPlan(dir);
    assert.equal(counter.reads, 1, 'the invalidated entry was re-read');
  } finally {
    counter.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
