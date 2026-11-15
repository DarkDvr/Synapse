// The Architect's restore tool, end to end: a live run blocks it, and the newest
// failed run is put back exactly once.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ensureRepo, treeOf, createCheckpoint } from '../src/git.js';
import { tmpdir } from './tmpdir.mjs';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const SERVER = path.resolve('src/mcp/git-server.js');

function rpc(child) {
  let buffer = '';
  let next = 1;
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = waiting.get(msg.id);
      if (resolve) {
        waiting.delete(msg.id);
        resolve(msg);
      }
    }
  });
  return (method, params) => {
    const id = next++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  };
}

test('restore refuses while a run is live, then puts the newest failed run back once', async () => {
  const dir = tmpdir('synapse-restore-test-');
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  await ensureRepo(dir, { log: quiet });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'before\n');
  const before = await treeOf(dir);
  const checkpoint = await createCheckpoint(dir, before, 't1-test');
  assert.ok(checkpoint);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'after\n');
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'extra\n');

  const ledger = path.join(dir, '.synapse', 'runs.jsonl');
  fs.writeFileSync(
    ledger,
    [
      JSON.stringify({ kind: 'delegate', callId: 'c1', task: 't1', role: 'coder-1' }),
      JSON.stringify({
        kind: 'result',
        callId: 'c1',
        task: 't1',
        role: 'coder-1',
        outcome: 'failed',
        checkpoint,
      }),
    ].join('\n') + '\n',
  );

  // A live delegation (no result yet) makes the tool refuse. This is what stops a
  // worker from restoring its own project mid-run.
  const liveLedger = fs.readFileSync(ledger, 'utf8');
  fs.writeFileSync(ledger, `${liveLedger}${JSON.stringify({ kind: 'delegate', callId: 'c2', task: 't2' })}\n`);

  const child = spawn(process.execPath, [SERVER], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  try {
    const call = rpc(child);
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    const busy = await call('tools/call', { name: 'restore', arguments: { task: 't1' } });
    assert.equal(busy.result?.isError, true, stderr);
    assert.match(busy.result.content[0].text, /still live/);
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'after\n');

    // The run finished: now the restore is allowed, once.
    fs.writeFileSync(ledger, `${liveLedger}${JSON.stringify({ kind: 'result', callId: 'c2', task: 't2', outcome: 'completed' })}\n`);
    const older = await call('tools/call', { name: 'restore', arguments: { task: 't1' } });
    assert.equal(older.result?.isError, true);
    assert.match(older.result.content[0].text, /newest run/i);

    fs.writeFileSync(ledger, liveLedger);
    const ok = await call('tools/call', { name: 'restore', arguments: { task: 't1' } });
    assert.notEqual(ok.result?.isError, true, stderr);
    assert.match(ok.result.content[0].text, /Restored the project to before t1/);
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'before\n');
    assert.equal(fs.existsSync(path.join(dir, 'extra.txt')), false);
    assert.match(fs.readFileSync(ledger, 'utf8'), /"kind":"restore"/);
  } finally {
    child.kill();
  }
});
