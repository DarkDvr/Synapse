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
import { artifactDir } from '../src/browser/artifacts.js';

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

    // A long page, captured whole: the answer names a file in the project rather than
    // handing back a cut, so a model reads one artifact instead of stitching six reads
    // together (13 Nov).
    const whole = await rpc.call('tools/call', { name: 'read', arguments: { full: true } });
    const said = whole.result.content[0].text;
    assert.match(said, /The whole page is saved: /, 'the answer names the file');
    assert.match(said, /characters/, 'and says how much it held');
    const saved = /The whole page is saved: (.+)/.exec(said)[1].trim();
    assert.ok(fs.existsSync(saved), 'the file exists');
    const body = fs.readFileSync(saved, 'utf8');
    assert.match(body, /Source: http/, 'it records where it came from');
    assert.match(body, /beta/, 'and holds the page text');
    fs.rmSync(path.dirname(saved), { recursive: true, force: true });

    const shot = await rpc.call('tools/call', { name: 'screenshot', arguments: {} });
    const file = /Screenshot: (.*) \(/.exec(shot.result.content[0].text)?.[1];
    assert.ok(file && fs.existsSync(file), 'the screenshot was not written');
    assert.match(shot.result.content[0].text, /cite it exactly as !\[\]\(/, 'the answer must give a path the chat can render');
    assert.match(shot.result.content[0].text, /shot-\d/, 'the answer names the file');

    // The fence is the switch, not a host list — but a page must still be an http(s)
    // address: `file://` would be a way around the harness's own rules.
    const blocked = await rpc.call('tools/call', { name: 'open', arguments: { url: `file:///${process.execPath.replace(/\\/g, '/')}` } });
    assert.equal(blocked.result.isError, true, 'a file:// address was accepted');
    assert.match(blocked.result.content[0].text, /http/);

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

// Where a project's browsing leaves its files. The engine gives a project's server that
// project's folder as its working directory (measured 11 Nov), so the artifacts live in
// the project: deleted with it, and never shared between two projects.
test('a project server writes inside the project, anything else in the harness', () => {
  const root = 'F:\\dev\\Synapse.Projects';
  assert.equal(
    artifactDir('F:\\dev\\Synapse.Projects\\demo', root),
    'F:\\dev\\Synapse.Projects\\demo\\.synapse\\browser\\shots',
  );
  // The projects root is the "all projects" context, not a project.
  assert.match(artifactDir(root, root), /data.*browser.*shots$/);
  // The harness's own folder is not a project either.
  assert.match(artifactDir('F:\\dev\\Synapse', root), /data.*browser.*shots$/);
  // A sibling whose name starts with the root's name is not inside it.
  assert.match(artifactDir('F:\\dev\\Synapse.Projects2\\x', root), /data.*browser.*shots$/);
});

// A process whose working directory is a folder keeps that folder undeletable on Windows.
// The engine starts this server with the project as its cwd, so the server takes the path
// it needs and then steps out — otherwise deleting the project fails in the Recycle Bin
// with "The directory is not empty" (11 Nov, reproduced: EPERM).
test('the server does not keep the project folder locked', async () => {
  const dir = tmpdir('synabrowse-cwd-');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ browser: { enabled: false } }));
  const child = spawn(process.execPath, [SERVER], {
    cwd: dir,
    env: { ...process.env, SYNAPSE_BROWSER_CONFIG: config },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.doesNotThrow(() => fs.rmSync(dir, { recursive: true, force: true }), 'the folder was still held');
  } finally {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* swept at exit */ }
  }
});

// A long page is cut, and the cut says so: two models were benched on one thread and both
// believed they had all of it (13 Nov).
test('a cut read says how much is missing, and maxChars is honoured', async () => {
  const page = { title: 'A thread', url: 'https://example.test/t', text: 'x'.repeat(20000), total: 41000, links: [] };
  // Never import the server module here: importing it STARTS it, and it waits on stdin
  // for ever — that cost a hung suite on 13 Nov. The rule is checked in the source.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp', 'browser-server.js'), 'utf8');
  assert.match(src, /\[… truncated: \$\{shown\.length/, 'the cut is named');
  assert.match(src, /slice\(0, maxChars\)/, 'maxChars is the caller\'s');
  assert.match(src, /slice\(0, links\)/, 'links is the caller\'s');
});
