// The SynaBrowse MCP server, over its real stdio: the protocol a model speaks.
//
// The tools are worthless if the server does not answer `initialize` and `tools/call`
// the way the engine expects, so this drives the actual process: spawn it, speak
// JSON-RPC, open a local page, click, screenshot, close. No network, no engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from './tmpdir.mjs';
import { findEdge } from '../src/browser/browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'mcp', 'browser-server.js');

/** A tiny JSON-RPC client over the server's stdio. */
function speak(child) {
  let buffer = '';
  const waiting = new Map();
  const notes = [];
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
      if (msg.id !== undefined && waiting.has(msg.id)) {
        const { resolve } = waiting.get(msg.id);
        waiting.delete(msg.id);
        resolve(msg);
      } else {
        notes.push(msg);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => notes.push(String(d).trim()));
  let seq = 0;
  return {
    notes,
    call(method, params) {
      const id = ++seq;
      let timer = null;
      const promise = new Promise((resolve, reject) => {
        waiting.set(id, { resolve });
        // A timer that is never cleared holds the process open for its whole duration,
        // which is how this file once took 34 s to finish while running in 4.
        timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 30000);
        timer.unref?.();
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return promise.finally(() => { if (timer) clearTimeout(timer); });
    },
  };
}

test('the server answers the protocol and its tools work on a local page', async (t) => {
  const edge = findEdge();
  if (!edge) {
    t.skip('no Edge on this machine');
    return;
  }
  const dir = tmpdir('synabrowse-mcp-');
  const profile = path.join(dir, 'profile');
  const page = path.join(dir, 'page.html');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(page, '<!doctype html><title>MCP page</title><h1 id="t">alpha</h1>'
    + '<button onclick="document.getElementById(\'t\').textContent=\'beta\'">Go</button>');

  // A page has to be an http(s) address — the allowlist is about hosts, and a file://
  // path is not one. So the test serves its own folder on loopback, which is also the
  // path a real page takes.
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(String(req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'page.html';
    try {
      const body = fs.readFileSync(path.join(dir, name));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(config, JSON.stringify({ browser: { enabled: true, profile, allow: ['127.0.0.1'] } }));

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SYNAPSE_BROWSER_CONFIG: config },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = speak(child);
  try {
    const init = await rpc.call('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, 'synapse-browser');

    const tools = await rpc.call('tools/list', {});
    const names = tools.result.tools.map((tool) => tool.name);
    for (const expected of ['open', 'read', 'click', 'type', 'press', 'wait', 'screenshot', 'watch', 'tabs', 'handoff', 'close']) {
      assert.ok(names.includes(expected), `the server is missing ${expected}`);
    }

    const opened = await rpc.call('tools/call', {
      name: 'open',
      arguments: { url: `${origin}/page.html`, settleMs: 300 },
    });
    assert.match(opened.result.content[0].text, /MCP page/);

    const clicked = await rpc.call('tools/call', { name: 'click', arguments: { text: 'Go' } });
    assert.equal(clicked.result.isError, false, clicked.result.content?.[0]?.text);

    const read = await rpc.call('tools/call', { name: 'read', arguments: {} });
    assert.match(read.result.content[0].text, /beta/);

    const shot = await rpc.call('tools/call', { name: 'screenshot', arguments: {} });
    const file = /Screenshot: (.*) \(/.exec(shot.result.content[0].text)?.[1];
    assert.ok(file && fs.existsSync(file), 'the screenshot was not written');

    // The fence: a host that is not on the list is refused, in words.
    const blocked = await rpc.call('tools/call', { name: 'open', arguments: { url: 'https://example.com/' } });
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0].text, /allowlist/);

    const closed = await rpc.call('tools/call', { name: 'close', arguments: {} });
    assert.match(closed.result.content[0].text, /closed/i);
  } finally {
    try { child.kill(); } catch { /* gone */ }
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* swept at exit */ }
  }
});

test('the server refuses everything when it is switched off', async (t) => {
  const edge = findEdge();
  if (!edge) {
    t.skip('no Edge on this machine');
    return;
  }
  const dir = tmpdir('synabrowse-off-');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ browser: { enabled: false, allow: ['*'] } }));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SYNAPSE_BROWSER_CONFIG: config },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = speak(child);
  try {
    await rpc.call('initialize', {});
    const call = await rpc.call('tools/call', { name: 'open', arguments: { url: 'https://example.com/' } });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /switched off/);
  } finally {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* swept at exit */ }
  }
});
