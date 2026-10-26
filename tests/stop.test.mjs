// What a Stop reaches. The measured failure: the Architect was idle, a worker in
// the same project was not, and Stop interrupted the Architect only.
//
// Run: node tests\stop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stopTargets } from '../src/stop.js';

const ARCH = 'ses_architect';
const WORKER = 'ses_worker';
const OTHER = 'ses_other';
const PROJECT = 'F:\\dev\\Synapse.Projects\\demo';

const sessions = [
  { id: ARCH, directory: PROJECT },
  { id: WORKER, directory: `${PROJECT}\\` },
  { id: OTHER, directory: 'F:\\dev\\Synapse.Projects\\other' },
];

test('a worker in the same project is stopped with the session on screen', () => {
  const targets = stopTargets({
    sessionId: ARCH,
    directory: PROJECT,
    active: [WORKER, OTHER],
    sessions,
  });
  assert.deepEqual(targets.sort(), [ARCH, WORKER].sort());
});

test('another project is left alone', () => {
  const targets = stopTargets({ sessionId: ARCH, directory: PROJECT, active: [OTHER], sessions });
  assert.deepEqual(targets, [ARCH]);
});

test('the asked session is stopped even when the active list is stale', () => {
  const targets = stopTargets({ sessionId: WORKER, directory: PROJECT, active: [], sessions });
  assert.deepEqual(targets, [WORKER]);
});

test('an active session the engine cannot describe is not guessed at', () => {
  const targets = stopTargets({
    sessionId: ARCH,
    directory: PROJECT,
    active: ['ses_unknown'],
    sessions,
  });
  assert.deepEqual(targets, [ARCH]);
});

test('with no directory, only the asked session is stopped', () => {
  const targets = stopTargets({ sessionId: ARCH, directory: null, active: [WORKER], sessions });
  assert.deepEqual(targets, [ARCH]);
});
