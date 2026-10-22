// What the cleanup may and may not stop, and how it decides a port is a project's.
//
// These are the safety parts, so they are asserted rather than trusted. The killing
// itself is not tested here — only the selection, and the proof it rests on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { servesProject, mayStop } from '../src/cleanup.js';

const node = (pid, cmd = 'node x.js') => ({ pid, exe: 'C:/Program Files/nodejs/node.exe', cmd });

/** Two folders with the *same* file names and different content — the hard case. */
const twoProjects = () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-b-'));
  for (const [dir, mark] of [
    [a, 'page A'],
    [b, 'page B'],
  ]) {
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'index.html'), `<!doctype html><title>${mark}</title>${mark}`);
  }
  return { a, b };
};

const serve = (dir) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(dir, decodeURIComponent(String(req.url || '/').split('?')[0]));
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }),
    );
  });

test('the editor is never stopped, whatever it is called', () => {
  assert.equal(
    mayStop({ pid: 999, exe: 'C:/Users/A/Programs/@opencodedesktop/OpenCode.exe', cmd: 'OpenCode.exe' }),
    false,
  );
  assert.equal(mayStop({ pid: 999, exe: 'C:/x/node.exe', cmd: 'node ai.opencode.desktop/main.js' }), false);
});

test('a pid we were told to keep is never stopped', () => {
  assert.equal(mayStop(node(4242), { keep: [4242] }), false);
  assert.equal(mayStop(node(4242), { keep: [1] }), true);
});

test('only a runtime is a candidate: a worker starts servers, not editors', () => {
  assert.equal(mayStop(node(500)), true);
  assert.equal(mayStop({ pid: 501, exe: 'C:/python311/python.exe', cmd: 'python -m http.server 8765' }), true);
  assert.equal(mayStop({ pid: 502, exe: 'C:/Windows/System32/notepad.exe', cmd: 'notepad' }), false);
  assert.equal(mayStop({ pid: 4, exe: 'C:/x/node.exe', cmd: 'node' }), false, 'system pids are out of bounds');
  assert.equal(mayStop(null), false);
});

test('a port serving this folder byte for byte is proof', async () => {
  const { a, b } = twoProjects();
  const mine = await serve(a);
  const other = await serve(b);
  try {
    assert.equal(await servesProject(mine.port, a), true);
    // The same file names, a different project: a listing proves nothing, only the
    // bytes do. This is the case that made the first version sweep a neighbour's
    // server off the machine.
    assert.equal(await servesProject(other.port, a), false);
    assert.equal(await servesProject(mine.port, b), false);
  } finally {
    await mine.close();
    await other.close();
    for (const dir of [a, b]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a port that is not answering is not proof of anything', async () => {
  const { a } = twoProjects();
  try {
    assert.equal(await servesProject(9, a), false);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
  }
});
