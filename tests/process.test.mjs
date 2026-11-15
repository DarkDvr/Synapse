// The process tool: start a long-lived command, read its log, stop it by the id
// Synapse issued — and refuse a command the project is not allowed to start.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { tmpdir } from './tmpdir.mjs';

const SERVER = path.resolve('src/mcp/process-server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitFor(fn, ms = 8000) {
  for (let i = 0; i < ms / 50; i += 1) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

test('start, logs and stop by id; a protected command is refused', async () => {
  const dir = tmpdir('synapse-process-test-');
  fs.mkdirSync(path.join(dir, '.project'), { recursive: true });
  const child = spawn(process.execPath, [SERVER], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let pid = 0;
  try {
    const call = rpc(child);
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });

    const refused = await call('tools/call', {
      name: 'process',
      arguments: { action: 'start', command: 'Remove-Item -Recurse C:\\Windows\\System32\\x -Force' },
    });
    assert.equal(refused.result?.isError, true, stderr);
    assert.match(refused.result.content[0].text, /not a process this project may start/);

    const started = await call('tools/call', {
      name: 'process',
      arguments: {
        action: 'start',
        command: 'node -e "console.log(\'listening\'); setInterval(() => {}, 1000)"',
      },
    });
    assert.notEqual(started.result?.isError, true, stderr);
    const text = started.result.content[0].text;
    assert.match(text, /Started p1 \(pid \d+\)/);
    pid = Number(/pid (\d+)/.exec(text)?.[1] || 0);
    assert.ok(pid > 0);
    assert.ok(fs.existsSync(path.join(dir, '.project', 'processes.json')));
    assert.ok(fs.existsSync(path.join(dir, '.project', 'processes', 'p1.log')));

    const logged = await waitFor(async () => {
      const res = await call('tools/call', { name: 'process', arguments: { action: 'logs', id: 'p1' } });
      return /listening/.test(res.result?.content?.[0]?.text || '') ? res : null;
    });
    assert.ok(logged, `the log never showed the line; stderr: ${stderr}`);

    const stopped = await call('tools/call', { name: 'process', arguments: { action: 'stop', id: 'p1' } });
    assert.notEqual(stopped.result?.isError, true, stderr);
    assert.match(stopped.result.content[0].text, /Stopped p1/);
    const gone = await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 5000);
    assert.equal(gone, true, 'the process is still running after stop');

    const unknown = await call('tools/call', { name: 'process', arguments: { action: 'stop', id: 'p9' } });
    assert.equal(unknown.result?.isError, true);
  } finally {
    child.kill();
    if (pid) {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {
        // already stopped
      }
    }
  }
});
