// The worker's lease: a stateless MCP receipt, and the knobs the runner reads.
//
// The tool itself does nothing; the runner reads the call from the transcript and
// holds the stall clock off. This tests the receipt (a model must be told what it
// bought) and the config bounds, not the timer — that needs a live run, which is
// what the low-minute manual test is for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { normalize } from '../src/config.js';

const ROOT = process.cwd();

function ask(child, message) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          child.stdout.off('data', onData);
          resolve(parsed);
          return;
        } catch {
          // a stderr line slipped in; keep reading
        }
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

test('the lease tool is a receipt with a clock, not an action', async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp', 'lease-server.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const init = await ask(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.equal(init.result.serverInfo.name, 'synapse-lease');

    const list = await ask(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['lease']);

    const granted = await ask(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'lease', arguments: { minutes: 90, reason: 'downloading a 200 GB archive' } },
    });
    const text = granted.result.content[0].text;
    assert.match(text, /Lease noted: 90 minute/);
    assert.match(text, /downloading a 200 GB archive/);
    assert.match(text, /one extension/, 'the model is told about the one extension');
    assert.equal(granted.result.isError, false);

    const bad = await ask(child, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'lease', arguments: { minutes: 0 } },
    });
    assert.equal(bad.result.isError, true, 'a zero-minute lease is refused');

    // Fractional minutes are real: they are how the timer is tested in seconds.
    const short = await ask(child, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'lease', arguments: { minutes: 0.1 } },
    });
    assert.match(short.result.content[0].text, /6 second/);
  } finally {
    child.kill();
  }
});

test('the step cap and the lease grace are bounded settings', () => {
  const base = normalize({});
  assert.equal(base.worker.maxTurns, 80, 'a task that needs more than this is too big');
  assert.equal(base.worker.leaseGraceSec, 300);
  assert.equal(normalize({ worker: { maxTurns: 0 } }).worker.maxTurns, 0, '0 turns the cap off');
  assert.equal(normalize({ worker: { maxTurns: 5000 } }).worker.maxTurns, 1000);
  assert.equal(normalize({ worker: { leaseGraceSec: 1 } }).worker.leaseGraceSec, 5);
  assert.equal(normalize({ worker: { leaseGraceSec: 99999 } }).worker.leaseGraceSec, 3600);
});

test('the engine is handed the lease server, and the runner reads it', () => {
  const engine = fs.readFileSync(path.join(ROOT, 'src', 'engines', 'opencode.js'), 'utf8');
  assert.match(engine, /servers\['synapse-lease'\]/);
  assert.match(engine, /LEASE_SERVER/);
  const runs = fs.readFileSync(path.join(ROOT, 'src', 'runs.js'), 'utf8');
  assert.match(runs, /_lease\$\/i\.test/, 'the lease call is matched by suffix');
  assert.match(runs, /LEASE_QUESTION/);
  assert.match(runs, /overSteps/);
  const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /function noteLease/);
  assert.match(app, /chat-lease-clock/);
  assert.match(app, /data-lease-until/);
  const css = fs.readFileSync(path.join(ROOT, 'web', 'synapse.css'), 'utf8');
  assert.match(css, /\.chat-lease\b/);
});
