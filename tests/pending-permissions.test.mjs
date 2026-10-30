// What the page is allowed to see as a waiting permission.
//
// The engine lists a request as pending from the moment it raises it. A request
// the policy is answering itself — every write inside the project — is therefore
// listed for the few milliseconds before the reply lands, and a page polling in
// that window painted a card and then took it away again. Measured 30 Oct in a
// run where every call was allowed: "a bunch of permissions appear and
// disappear". The gate marks what it is holding; `GET /api/pending` skips it.
//
// Run: node tests\pending-permissions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../src/api.js';

const REQUEST = {
  id: 'per_1',
  sessionID: 'ses_worker',
  action: 'edit',
  resources: ['src/app.js'],
  metadata: { files: [] },
};

function harness({ answering = false, decided = false } = {}) {
  const engine = {
    status: () => ({ ready: true, kind: 'stub' }),
    listPendingPermissions: async () => [REQUEST],
    listActiveSessions: async () => [],
    listSessions: async () => [],
    listForms: async () => [],
    listSessionPermissions: async () => [],
    getSession: async (id) => ({ id, directory: 'F:/dev/Synapse.Projects/demo', metadata: { synapse: { role: 'coder-1' } } }),
  };
  const quiet = { info() {}, debug() {}, warn() {}, error() {} };
  const api = createApi({
    getConfig: () => ({}),
    applyConfig: async () => {},
    engine,
    logger: { channel: () => quiet },
    getBootError: () => null,
    projects: {},
    toolStats: null,
    probe: null,
    modelCache: null,
    inspectModel: null,
    probeDir: null,
    runs: null,
    engineUpdate: null,
    restart: null,
    notify: null,
    guard: null,
    permissionLog: { get: () => (decided ? { decided: true } : { decided: false }), list: () => [] },
    permissionGate: { answering: () => answering },
  });
  return api;
}

test('a request the policy is answering is not shown as a card', async () => {
  const out = await harness({ answering: true }).pending(null);
  assert.deepEqual(out.permissions, []);
});

test('a request already answered is not shown again', async () => {
  const out = await harness({ decided: true }).pending(null);
  assert.deepEqual(out.permissions, []);
});

test('a request waiting for the operator is shown, once', async () => {
  const out = await harness().pending(null);
  assert.equal(out.permissions.length, 1);
  assert.equal(out.permissions[0].requestId, 'per_1');
  assert.equal(out.permissions[0].role, 'coder-1');
});
