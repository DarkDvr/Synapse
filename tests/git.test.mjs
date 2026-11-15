// Git in a project: the private copy, the tree around a run, and the diff.
//
// The point of the diff is attribution: the report says what changed, and the
// change is computed from two trees rather than from the worker's sentence. The
// tests use the machine's git; the private MinGit path is a resolver and a
// download, tested only for its "already found" answer here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  findGit,
  ensureRepo,
  isRepo,
  treeOf,
  changeSince,
  diffTrees,
  ensureGit,
  createCheckpoint,
  restoreCheckpoint,
  dropCheckpoint,
  runGit,
  MINGIT,
} from '../src/git.js';
import { createRunner } from '../src/runs.js';
import { tmpdir } from './tmpdir.mjs';

const ROOT = tmpdir('synapse-git-test-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function project(name) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.synapse', 'plan.json'), '{"version":1,"tasks":[]}');
  return dir;
}

test('the private MinGit is pinned, and a machine that has git is left alone', async () => {
  assert.match(MINGIT.url, /MinGit-2\.56\.1-64-bit\.zip$/);
  assert.equal(MINGIT.sha256.length, 64);
  assert.ok(findGit(), 'this machine has a git');
  const found = await ensureGit({ log: quiet });
  assert.equal(found.ok, true);
  assert.equal(found.how, 'found');
});

test('a folder becomes a repository once', async () => {
  const dir = project('init');
  assert.equal(await isRepo(dir), false);
  const first = await ensureRepo(dir, { log: quiet });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(await isRepo(dir), true);
  const again = await ensureRepo(dir, { log: quiet });
  assert.equal(again.created, false);
});

test('the tree sees untracked files and ignores .synapse', async () => {
  const dir = project('tree');
  await ensureRepo(dir, { log: quiet });
  const before = await treeOf(dir);
  assert.ok(before);
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
  fs.writeFileSync(path.join(dir, '.synapse', 'noise.txt'), 'not the worker\'s\n');
  const after = await treeOf(dir);
  assert.notEqual(after, before);
  const diff = await diffTrees(dir, before, after);
  assert.deepEqual(diff.files, ['hello.txt']);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 0);
  assert.match(diff.patch, /\+hello/);
});

test('a project .gitignore is respected', async () => {
  const dir = project('ignored');
  await ensureRepo(dir, { log: quiet });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
  const before = await treeOf(dir);
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build', 'out.bin'), 'ignored\n');
  const diff = await changeSince(dir, 't1', before);
  assert.equal(diff, null, 'an ignored file is not a change to report');
});

test('changeSince saves the patch inside the project and returns null when nothing changed', async () => {
  const dir = project('change');
  await ensureRepo(dir, { log: quiet });
  const before = await treeOf(dir);
  assert.equal(await changeSince(dir, 't1', before), null);
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);\n');
  const change = await changeSince(dir, 't1', before);
  assert.ok(change);
  assert.equal(change.stat, '1 file, +1 −0');
  assert.ok(change.patchPath.startsWith('.synapse/reports/diffs/'));
  assert.ok(fs.existsSync(path.join(dir, ...change.patchPath.split('/'))));
  assert.match(fs.readFileSync(path.join(dir, ...change.patchPath.split('/')), 'utf8'), /\+console\.log/);
});

test('a folder with no git has no tree and no diff', async () => {
  const dir = project('no-git');
  assert.equal(await treeOf(dir), null);
  assert.equal(await changeSince(dir, 't1', null), null);
});

test('a checkpoint writes back what it had and removes what came after', async () => {
  const dir = project('checkpoint');
  await ensureRepo(dir, { log: quiet });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'before\n');
  const before = await treeOf(dir);
  const checkpoint = await createCheckpoint(dir, before, 't1-test');
  assert.ok(checkpoint?.ref.startsWith('refs/synapse/'));
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'after\n');
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'extra\n');
  const restored = await restoreCheckpoint(dir, checkpoint.ref);
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'before\n');
  assert.equal(fs.existsSync(path.join(dir, 'extra.txt')), false);
  assert.equal(await dropCheckpoint(dir, checkpoint.ref), true);
  assert.equal((await runGit(['for-each-ref', 'refs/synapse'], { cwd: dir })).out.trim(), '');
});

test('restore refuses a ref that is not a checkpoint', async () => {
  const dir = project('checkpoint-bad');
  await ensureRepo(dir, { log: quiet });
  const result = await restoreCheckpoint(dir, 'refs/heads/main');
  assert.equal(result.ok, false);
  assert.match(result.error, /checkpoint/i);
});

// ── through the runner: the report names the change ──────────────────

function makeEngine({ dir, writes = [] }) {
  const sessions = new Map();
  const arch = [];
  let seq = 0;
  const engine = {
    async getSession(id) {
      if (id === 'ses_arch') return { id, directory: dir, internal: false, single: false, auto: false };
      return { id, directory: dir, internal: true };
    },
    async createSession({ metadata }) {
      const id = `ses_w${(seq += 1)}`;
      sessions.set(id, { role: metadata?.synapse?.role || null, messages: [], writes });
      return { id };
    },
    async setInstruction() {},
    async prompt(id) {
      const s = sessions.get(id);
      s.messages.push({ id: `${id}-u`, type: 'user', parts: [{ type: 'text', text: 'go' }] });
      for (const w of s.writes.splice(0)) fs.writeFileSync(path.join(dir, w.file), w.text);
      const n = (s.turn = (s.turn || 0) + 1);
      setTimeout(() => {
        s.messages.push({ id: `${id}-a${n}`, type: 'assistant', parts: [{ type: 'text', text: 'done' }] });
        s.messages.push({ id: `${id}-i${n}`, type: 'idle', parts: [] });
      }, 10);
    },
    async synthetic(id, text) {
      if (id === 'ses_arch') {
        arch.push({ id: `a-s${arch.length}`, type: 'synthetic', parts: [{ type: 'text', text }] });
        setTimeout(() => {
          arch.push({ id: `a-r${arch.length}`, type: 'assistant', parts: [{ type: 'text', text: 'noted' }] });
          arch.push({ id: `a-i${arch.length}`, type: 'idle', parts: [] });
        }, 10);
        return;
      }
      // A repair turn from the runner (a failed check): answer it, so the run can
      // finish and the rollback point is kept.
      const s = sessions.get(id);
      s.messages.push({ id: `${id}-s${s.messages.length}`, type: 'synthetic', parts: [{ type: 'text', text }] });
      const n = (s.turn = (s.turn || 0) + 1);
      setTimeout(() => {
        s.messages.push({ id: `${id}-a${n}`, type: 'assistant', parts: [{ type: 'text', text: 'done' }] });
        s.messages.push({ id: `${id}-i${n}`, type: 'idle', parts: [] });
      }, 10);
    },
    async getMessages(id) {
      return id === 'ses_arch' ? [...arch] : [...(sessions.get(id)?.messages || [])];
    },
    async interrupt() {},
    async switchModel() {},
    async updateSessionPermissions() {},
    async deleteSession(id) { sessions.delete(id); },
  };
  return { engine, arch };
}

function runnerFor(engine) {
  return createRunner({
    engine,
    logger: { channel: () => quiet },
    getConfig: () => ({
      roles: { 'coder-1': { ref: 'opencode/one' } },
      worker: { ladder: ['coder-1'], stallSec: 30, resumeMax: 0, retryBaseSec: 1, retryCapSec: 2 },
    }),
    modelCache: { get: () => null, noteIssue: () => true },
    notify: () => {},
  });
}

test('the report names the diff, and the patch is inside the project', async () => {
  const dir = project('runner');
  fs.writeFileSync(
    path.join(dir, '.synapse', 'plan.json'),
    JSON.stringify({
      version: 1,
      goal: 'test',
      summary: '',
      tasks: [{ id: 't1', title: 'Change it', role: 'coder-1', status: 'todo', detail: 'd' }],
    }),
  );
  await ensureRepo(dir, { log: quiet });
  const stub = makeEngine({ dir, writes: [{ file: 'hello.txt', text: 'hello\n' }] });
  const runner = runnerFor(stub.engine);
  stub.arch.push({ id: 'u1', type: 'user', created: Date.now(), parts: [{ type: 'text', text: 'go' }] });
  stub.arch.push({
    id: 'a1',
    type: 'assistant',
    created: Date.now() + 1,
    parts: [{ type: 'tool', name: 'synapse-delegate_delegate', id: 'call_diff', input: { task: 't1' } }],
  });
  await runner.handleTurn('ses_arch', [...stub.arch]);
  const result = await (async () => {
    for (let i = 0; i < 200; i += 1) {
      const file = path.join(dir, '.synapse', 'runs.jsonl');
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const r = lines.find((x) => x.kind === 'result');
        if (r) return r;
      }
      await sleep(25);
    }
    return null;
  })();
  assert.ok(result, 'a result was recorded');
  assert.ok(result.change, 'the run carries a change');
  assert.equal(result.change.stat, '1 file, +1 −0');
  const report = stub.arch
    .filter((m) => m.type === 'synthetic')
    .map((m) => String(m.parts?.[0]?.text || ''))
    .find((t) => t.startsWith('t1 (coder-1)')) || '';
  assert.match(report, /Changed: 1 file, \+1 −0/);
  assert.match(report, /\.synapse\/reports\/diffs\/t1-/);
  assert.ok(fs.existsSync(path.join(dir, ...result.change.patch.split('/'))));
  assert.equal(result.checkpoint, null, 'a clean run drops its rollback point');
  assert.equal((await runGit(['for-each-ref', 'refs/synapse'], { cwd: dir })).out.trim(), '');
});

test('a run whose check fails keeps its rollback point', async () => {
  const dir = project('runner-check');
  fs.writeFileSync(
    path.join(dir, '.synapse', 'plan.json'),
    JSON.stringify({
      version: 1,
      goal: 'test',
      summary: '',
      tasks: [
        {
          id: 't1',
          title: 'Prove it',
          role: 'coder-1',
          status: 'todo',
          detail: 'd',
          checks: ['node -e "process.exit(1)"'],
        },
      ],
    }),
  );
  await ensureRepo(dir, { log: quiet });
  const stub = makeEngine({ dir, writes: [{ file: 'hello.txt', text: 'hello\n' }] });
  const runner = runnerFor(stub.engine);
  stub.arch.push({ id: 'u1', type: 'user', created: Date.now(), parts: [{ type: 'text', text: 'go' }] });
  stub.arch.push({
    id: 'a1',
    type: 'assistant',
    created: Date.now() + 1,
    parts: [{ type: 'tool', name: 'synapse-delegate_delegate', id: 'call_cp', input: { task: 't1' } }],
  });
  await runner.handleTurn('ses_arch', [...stub.arch]);
  const result = await (async () => {
    for (let i = 0; i < 300; i += 1) {
      const file = path.join(dir, '.synapse', 'runs.jsonl');
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const r = lines.find((x) => x.kind === 'result');
        if (r) return r;
      }
      await sleep(25);
    }
    return null;
  })();
  assert.ok(result, 'a result was recorded');
  assert.ok(result.checkpoint?.ref?.startsWith('refs/synapse/'), 'the failed check keeps a rollback point');
  const refs = (await runGit(['for-each-ref', '--format=%(refname)', 'refs/synapse'], { cwd: dir })).out.trim();
  assert.equal(refs, result.checkpoint.ref);
  const report = stub.arch
    .filter((m) => m.type === 'synthetic')
    .map((m) => String(m.parts?.[0]?.text || ''))
    .find((t) => t.startsWith('t1 (coder-1)')) || '';
  assert.match(report, /Rollback point kept/);
  assert.match(report, /finished, but its check fails/);
});
