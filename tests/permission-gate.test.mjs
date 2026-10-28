// The gate: an engine event in, a reply out, or nothing for the operator.
//
// The policy itself is tested in permissions.test.mjs. This is the plumbing —
// which session asked, which directory it runs in, and what the engine is told.
//
// Run: node tests\permission-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPermissionGate } from '../src/permission-gate.js';
import { ROOT } from '../src/paths.js';
import { normalizeSession } from '../src/engines/base.js';

const HOME = 'C:/Users/tester';
const PROJECT = 'F:/dev/Synapse.Projects/demo';
const quiet = { channel: () => ({ info() {}, warn() {}, error() {} }) };

function setup({ directory = PROJECT, metadata = { synapse: { role: 'coder-1', task: 'Add CSV import' } } } = {}) {
  const replies = [];
  const engine = {
    async getSession(id) {
      return { id, directory, metadata };
    },
    async replyPermission(sessionId, requestId, decision) {
      replies.push({ sessionId, requestId, decision });
    },
  };
  const gate = createPermissionGate({ engine, logger: quiet, root: ROOT, home: HOME });
  return { gate, replies };
}

const event = (action, resources, extra = {}) => ({
  type: 'permission.asked',
  sessionId: 'ses_1',
  raw: {
    id: 'evt_1',
    type: 'permission.asked',
    data: {
      id: 'req_1',
      sessionID: 'ses_1',
      action,
      resources,
      source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
    },
  },
  ...extra,
});

test('a write inside the workspace is allowed with "once"', async () => {
  const { gate, replies } = setup();
  await gate.handle(event('edit', ['src/app.js']));
  assert.deepEqual(replies, [{ sessionId: 'ses_1', requestId: 'req_1', decision: 'once' }]);
});

test('a write into the harness is rejected', async () => {
  const { gate, replies } = setup();
  await gate.handle(event('edit', [`${ROOT}/src/api.js`]));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].decision, 'reject');
});

test('a command that reads the harness log is allowed', async () => {
  const { gate, replies } = setup();
  await gate.handle(event('shell', [`Get-Content ${ROOT}/logs/app.log -Tail 5`]));
  assert.equal(replies[0]?.decision, 'once');
});

test('a command that writes the harness is rejected', async () => {
  const { gate, replies } = setup();
  await gate.handle(event('shell', [`Set-Content ${ROOT}/AGENTS.md hi`]));
  assert.equal(replies[0]?.decision, 'reject');
});

test('a write outside the workspace is left to the operator', async () => {
  const { gate, replies } = setup();
  await gate.handle(event('edit', ['C:/Projects/other/main.js']));
  assert.deepEqual(replies, []);
});

test('a secrets file is left to the operator, not decided silently', async () => {
  const { gate, replies } = setup();
  await gate.handle(event('read', ['.env']));
  assert.deepEqual(replies, []);
});

test('a session with no directory is left to the operator', async () => {
  const replies = [];
  const engine = {
    async getSession() { return null; },
    async replyPermission(...args) { replies.push(args); },
  };
  const gate = createPermissionGate({ engine, logger: quiet, root: ROOT, home: HOME });
  await gate.handle(event('edit', ['src/app.js']));
  assert.deepEqual(replies, []);
});

test('an event without a request id is ignored', async () => {
  const { gate, replies } = setup();
  await gate.handle({ type: 'permission.asked', sessionId: 'ses_1', raw: { data: { action: 'edit' } } });
  assert.deepEqual(replies, []);
});

test('a failed reply is logged, not thrown at the event loop', async () => {
  const engine = {
    async getSession() { return { directory: PROJECT, metadata: {} }; },
    async replyPermission() { throw new Error('engine gone'); },
  };
  const gate = createPermissionGate({ engine, logger: quiet, root: ROOT, home: HOME });
  const verdict = await gate.handle(event('edit', ['src/app.js']));
  assert.equal(verdict.effect, 'allow');
});

test('the request is read from the event envelope the engine actually sends', () => {
  const { gate } = setup();
  const request = gate.requestOf(event('edit', ['src/app.js']));
  assert.deepEqual(request, {
    requestId: 'req_1',
    sessionId: 'ses_1',
    action: 'edit',
    resources: ['src/app.js'],
    toolCallId: 'call_1',
  });
});

test('a decision is recorded against the tool call that asked', async () => {
  const seen = [];
  const engine = {
    async getSession() {
      return { directory: PROJECT, metadata: { synapse: { role: 'coder-1', task: 't1' } } };
    },
    async replyPermission() {},
  };
  const gate = createPermissionGate({
    engine,
    logger: quiet,
    root: ROOT,
    home: HOME,
    onDecision: (entry) => seen.push(entry),
  });
  await gate.handle(event('edit', ['src/app.js']));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolCallId, 'call_1');
  assert.equal(seen[0].outside, false);
  assert.equal(seen[0].scope, 'project');
  assert.equal(seen[0].decided, true);
  assert.equal(seen[0].decidedBy, 'harness');
  assert.equal(seen[0].asked, false, 'an auto-answer did not ask the operator');
});

test('an outside ask is recorded as pending, not as a decided chip', async () => {
  const seen = [];
  const engine = {
    async getSession() {
      return { directory: PROJECT, metadata: {} };
    },
    async replyPermission() {
      throw new Error('the gate must not answer an outside request itself');
    },
  };
  const gate = createPermissionGate({
    engine,
    logger: quiet,
    root: ROOT,
    home: HOME,
    onDecision: (entry) => seen.push(entry),
  });
  await gate.handle(event('edit', ['D:/x.txt']));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].effect, 'ask');
  assert.equal(seen[0].decided, false);
  assert.equal(seen[0].outside, true);
  assert.equal(seen[0].scope, 'outside');
});

test('a refusal carries an explanation, an allow does not', async () => {
  const replies = [];
  const notes = [];
  const engine = {
    async getSession() {
      return { directory: PROJECT, metadata: { synapse: { role: 'coder-1' } } };
    },
    async replyPermission(sessionId, requestId, decision) {
      replies.push(decision);
    },
    async synthetic(sessionId, text) {
      notes.push(text);
    },
  };
  const gate = createPermissionGate({ engine, logger: quiet, root: ROOT, home: HOME });
  await gate.handle(event('edit', [`${ROOT}/src/api.js`]));
  assert.equal(replies[0], 'reject');
  // The synthetic note is fired without awaiting; let its microtask run.
  await new Promise((r) => setImmediate(r));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /permanently/);

  await gate.handle(event('edit', ['src/app.js']));
  await new Promise((r) => setImmediate(r));
  assert.equal(replies[1], 'once');
  assert.equal(notes.length, 1, 'an allow has nothing to explain');
});

test('a refusal to the Architect is not repeated as a synthetic note', async () => {
  const replies = [];
  const notes = [];
  const engine = {
    async getSession() {
      return { directory: PROJECT, metadata: {} }; // the Architect has no role metadata
    },
    async replyPermission(sessionId, requestId, decision) {
      replies.push(decision);
    },
    async synthetic(sessionId, text) {
      notes.push(text);
    },
  };
  const gate = createPermissionGate({ engine, logger: quiet, root: ROOT, home: HOME });
  await gate.handle(event('edit', [`${ROOT}/src/api.js`]));
  await new Promise((r) => setImmediate(r));
  assert.equal(replies[0], 'reject');
  assert.equal(notes.length, 0, 'the operator is already in the Architect chat; no extra turn');
});

test('a multi-line command sent as resources still asks', async () => {
  const { gate, replies } = setup();
  await gate.handle(
    event('shell', ['Test-Path F:\\perm-test', 'Set-Content -Path F:\\perm-test\\newline.txt -Value x']),
  );
  assert.deepEqual(replies, [], 'the outside write must be left to the operator');
});

test('a remembered request is allowed once without asking again', async () => {
  const seen = [];
  const replies = [];
  const engine = {
    async getSession() {
      return { directory: PROJECT, metadata: {} };
    },
    async replyPermission(sessionId, requestId, decision) {
      replies.push(decision);
    },
  };
  const gate = createPermissionGate({
    engine,
    logger: quiet,
    root: ROOT,
    home: HOME,
    onDecision: (entry) => seen.push(entry),
  });
  gate.remember('ses_1', 'edit', ['D:/x.txt']);
  await gate.handle(event('edit', ['D:/x.txt']));
  // The engine is told "once", never "always": its own always would save a
  // project-wide pattern.
  assert.deepEqual(replies, ['once']);
  assert.equal(seen[0].effect, 'allow');
  assert.equal(seen[0].asked, false);
  assert.equal(seen[0].decidedBy, 'operator');
  assert.match(seen[0].reason, /earlier/);
});

test('a remembered request does not widen to a different path', async () => {
  const replies = [];
  const engine = {
    async getSession() {
      return { directory: PROJECT, metadata: {} };
    },
    async replyPermission(sessionId, requestId, decision) {
      replies.push(decision);
    },
  };
  const gate = createPermissionGate({ engine, logger: quiet, root: ROOT, home: HOME });
  gate.remember('ses_1', 'edit', ['D:/x.txt']);
  await gate.handle(event('edit', ['D:/y.txt']));
  assert.deepEqual(replies, []);
});

test('a remembered shell command covers the same script with a different tail', async () => {
  const { gate, replies } = setup();
  const script = 'D:/scratch/probe.ps1';
  gate.remember('ses_1', 'shell', [`powershell -NoProfile -File "${script}"`]);
  await gate.handle(
    event('shell', [`powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" 2>&1 | Select-Object -First 30`]),
  );
  assert.deepEqual(replies, [{ sessionId: 'ses_1', requestId: 'req_1', decision: 'once' }]);
});

test('a remembered shell command does not cover another script', async () => {
  const { gate, replies } = setup();
  gate.remember('ses_1', 'shell', ['powershell -NoProfile -File "D:/scratch/probe.ps1"']);
  await gate.handle(event('shell', ['powershell -NoProfile -File "D:/scratch/other.ps1"']));
  assert.deepEqual(replies, [], 'a different file still asks');
});

test('a remembered request never overrides a refusal', async () => {
  const seen = [];
  const replies = [];
  const engine = {
    async getSession() {
      return { directory: PROJECT, metadata: {} };
    },
    async replyPermission(sessionId, requestId, decision) {
      replies.push(decision);
    },
  };
  const gate = createPermissionGate({
    engine,
    logger: quiet,
    root: ROOT,
    home: HOME,
    onDecision: (entry) => seen.push(entry),
  });
  gate.remember('ses_1', 'edit', [`${ROOT}/src/api.js`]);
  await gate.handle(event('edit', [`${ROOT}/src/api.js`]));
  assert.deepEqual(replies, ['reject']);
  assert.equal(seen[0].effect, 'deny');
});

// A permission that nobody answers, when the operator has turned the timeout on:
// it is allowed once after the wait, so an unattended project keeps moving. The
// gate is the only thing that may answer it, and only for `ask` verdicts — a
// harness write or a credential store is denied before a card exists.
test('an unanswered ask is allowed once after the timeout', async () => {
  const seen = [];
  const replies = [];
  const engine = {
    async getSession() { return { directory: PROJECT, metadata: {} }; },
    async replyPermission(sessionId, requestId, decision) { replies.push(decision); },
  };
  const gate = createPermissionGate({
    engine, logger: quiet, root: ROOT, home: HOME, permissionTimeoutMs: 30,
    onDecision: (entry) => seen.push(entry),
  });
  gate.setFullAuto('ses_1', true);
  await gate.handle(event('shell', ['Set-Content D:/scratch/timeout.txt hi']));
  assert.deepEqual(replies, [], 'nothing is answered while the card is up');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(replies, ['once'], 'the timeout answers once');
  const decided = seen.find((entry) => entry.decided);
  assert.equal(decided?.decidedBy, 'timeout');
  assert.equal(decided?.effect, 'allow');
});

test('an operator answer cancels the timeout', async () => {
  const replies = [];
  const engine = {
    async getSession() { return { directory: PROJECT, metadata: {} }; },
    async replyPermission(sessionId, requestId, decision) { replies.push(decision); },
  };
  const gate = createPermissionGate({ engine, logger: quiet, root: ROOT, home: HOME, permissionTimeoutMs: 30 });
  gate.setFullAuto('ses_1', true);
  await gate.handle(event('shell', ['Set-Content D:/scratch/timeout2.txt hi']));
  gate.answered('req_1');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(replies, [], 'the card was answered, so the timer must not fire');
});

test('the timeout is off unless the session says so', async () => {
  const replies = [];
  const engine = {
    async getSession() { return { directory: PROJECT, metadata: {} }; },
    async replyPermission(sessionId, requestId, decision) { replies.push(decision); },
  };
  const gate = createPermissionGate({ engine, logger: quiet, root: ROOT, home: HOME, permissionTimeoutMs: 30 });
  await gate.handle(event('shell', ['Set-Content D:/scratch/timeout3.txt hi']));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(replies, [], 'the card still waits for the operator');
});

test('a session saved with the timeout on honours it without a fresh toggle', async () => {
  const replies = [];
  const engine = {
    async getSession() { return { directory: PROJECT, metadata: { synapse: { permissionTimeout: true } } }; },
    async replyPermission(sessionId, requestId, decision) { replies.push(decision); },
  };
  const gate = createPermissionGate({ engine, logger: quiet, root: ROOT, home: HOME, permissionTimeoutMs: 30 });
  await gate.handle(event('shell', ['Set-Content D:/scratch/timeout4.txt hi']));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(replies, ['once']);
});

test('the session payload carries the permission timeout flag', () => {
  const on = normalizeSession({ id: 's1', metadata: { synapse: { permissionTimeout: true, auto: true } } });
  assert.equal(on.fullAuto, true);
  assert.equal(on.auto, true);
  assert.equal(normalizeSession({ id: 's2' }).fullAuto, false);
});
