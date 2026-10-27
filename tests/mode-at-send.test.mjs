// The mode is a choice about a message, applied once, at send.
//
// It used to be a PATCH on every toggle click, which is why clicking twice and
// sending could leave the engine enforcing a mode the operator had already left,
// and why the button had to be disabled while a run was live. Now the toggle is
// only the page's pending choice; the send carries it, the server applies the
// ruleset (once, and only if it differs) and then briefs with that same mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../src/api.js';
import { SINGLE_RULES } from '../src/permissions.js';

function harness({ applied = 'multi', dir = null } = {}) {
  const calls = [];
  let mode = applied;
  const briefs = [];
  const prompts = [];
  const notes = [];
  const engine = {
    status: () => ({ ready: true, kind: 'stub' }),
    getSession: async (id) => ({ id, directory: dir, single: mode === 'single', auto: false }),
    updateSessionPermissions: async (sessionId, rules) => {
      calls.push({ at: 'permissions', rules });
      mode = Array.isArray(rules) && rules.length ? 'single' : 'multi';
    },
    setInstruction: async (sessionId, key, text) => { briefs.push(text); return true; },
    prompt: async (sessionId, text) => { calls.push({ at: 'prompt' }); prompts.push(text); return {}; },
    getMessages: async () => [],
    listForms: async () => [],
    listPendingPermissions: async () => [],
    listActiveSessions: async () => [],
  };
  const api = createApi({
    getConfig: () => ({}),
    applyConfig: async () => {},
    engine,
    logger: { channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) },
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
    notify: (ev) => notes.push(ev),
    guard: null,
  });
  return { api, calls, briefs, prompts, notes, mode: () => mode };
}

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-mode-'));

test('a Single send applies the ruleset once, before the prompt', async () => {
  const dir = project();
  const h = harness({ dir });
  await h.api.sendMessage('ses_x', { text: 'Do one small thing', mode: 'single' });
  const perms = h.calls.filter((c) => c.at === 'permissions');
  assert.equal(perms.length, 1);
  assert.deepEqual(perms[0].rules, SINGLE_RULES);
  // The ruleset is applied before the turn that depends on it.
  assert.deepEqual(h.calls.map((c) => c.at), ['permissions', 'prompt']);
  assert.match(h.briefs.at(-1), /do not delegate/);
  assert.match(h.prompts.at(-1), /Do one small thing/);
  const doc = fs.readFileSync(path.join(dir, '.synapse', 'project.md'), 'utf8');
  assert.match(doc, /### chat · /, 'a Single message is a chat entry');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sending in the mode already applied does not patch the engine', async () => {
  const dir = project();
  const h = harness({ dir, applied: 'multi' });
  await h.api.sendMessage('ses_x', { text: 'Build it', mode: 'multi' });
  assert.equal(h.calls.filter((c) => c.at === 'permissions').length, 0);
  assert.match(h.briefs.at(-1), /You judge; you do not build/);
  const doc = fs.readFileSync(path.join(dir, '.synapse', 'project.md'), 'utf8');
  assert.match(doc, /### request · /, 'a Multi message is the request');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ten toggles and one send is one apply', async () => {
  // The toggle itself is a page affair; only the send reaches the server. Two
  // sends in the same mode still mean one patch.
  const dir = project();
  const h = harness({ dir, applied: 'multi' });
  await h.api.sendMessage('ses_x', { text: 'one', mode: 'single' });
  await h.api.sendMessage('ses_x', { text: 'two', mode: 'single' });
  assert.equal(h.calls.filter((c) => c.at === 'permissions').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('switching back to Multi at send clears the ruleset', async () => {
  const dir = project();
  const h = harness({ dir, applied: 'single' });
  await h.api.sendMessage('ses_x', { text: 'Use the team again', mode: 'multi' });
  const perms = h.calls.filter((c) => c.at === 'permissions');
  assert.equal(perms.length, 1);
  assert.deepEqual(perms[0].rules, []);
  assert.match(h.briefs.at(-1), /You judge; you do not build/);
  assert.doesNotMatch(h.briefs.at(-1), /do not delegate/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no mode in the body means the applied mode, and no patch', async () => {
  const dir = project();
  const h = harness({ dir, applied: 'single' });
  await h.api.sendMessage('ses_x', { text: 'Hello' });
  assert.equal(h.calls.filter((c) => c.at === 'permissions').length, 0);
  assert.match(h.briefs.at(-1), /do not delegate/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the applied mode is announced for the other window', async () => {
  const dir = project();
  const h = harness({ dir, applied: 'multi' });
  await h.api.sendMessage('ses_x', { text: 'Just this', mode: 'single' });
  const told = h.notes.filter((n) => n.type === 'session.mode');
  assert.equal(told.length, 1);
  assert.equal(told[0].mode, 'single');
  assert.equal(told[0].sessionId, 'ses_x');
  fs.rmSync(dir, { recursive: true, force: true });
});
