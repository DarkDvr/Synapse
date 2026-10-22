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

import { servesProject, mayStop, findScratch, sweepScratch } from '../src/cleanup.js';

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

// Fever Tracker's Designer finished with contrast.mjs and serve.mjs in
// .synapse/design/, plus a nested .synapse/design/.synapse/design/shots where a
// render doubled a relative path. The operator cleaned it by hand. This sweep is
// narrow on purpose: scripts and temp files inside .synapse only, never a plan
// file, never something the plan names, and it can be asked what it would do.
test('the scratch sweep takes scripts and the doubled .synapse, and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-scratch-'));
  try {
    const syn = path.join(dir, '.synapse');
    fs.mkdirSync(path.join(syn, 'design'), { recursive: true });
    fs.mkdirSync(path.join(syn, 'design', '.synapse', 'design', 'shots'), { recursive: true });
    const keep = [
      path.join(syn, 'plan.json'),
      path.join(syn, 'runs.jsonl'),
      path.join(syn, 'features.json'),
      path.join(syn, 'requirement.md'),
      path.join(syn, 'decisions.md'),
      path.join(syn, 'design', 'design.md'),
      path.join(syn, 'design', 'mock-1.html'),
      path.join(syn, 'qc_findings', 'qc-1.md'),
    ];
    const scratch = [
      path.join(syn, 'design', 'contrast.mjs'),
      path.join(syn, 'design', 'serve.mjs'),
      path.join(syn, 'design', 'run.ps1'),
      path.join(syn, 'tmp.log'),
    ];
    fs.mkdirSync(path.join(syn, 'qc_findings'), { recursive: true });
    for (const f of [...keep, ...scratch]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'x');
    }
    const named = ['.synapse/design/keep-this.mjs'];
    fs.writeFileSync(path.join(syn, 'design', 'keep-this.mjs'), 'x');

    const found = findScratch(dir, { named }).map((f) => path.relative(dir, f.path).replace(/\\/g, '/'));
    assert.ok(found.includes('.synapse/design/contrast.mjs'), 'contrast.mjs is scratch');
    assert.ok(found.includes('.synapse/design/serve.mjs'), 'serve.mjs is scratch');
    assert.ok(found.some((f) => f.startsWith('.synapse/design/.synapse')), 'the doubled .synapse is scratch');
    for (const f of ['plan.json', 'runs.jsonl', 'features.json', 'requirement.md', 'decisions.md']) {
      assert.ok(!found.some((g) => g.endsWith(`/${f}`)), `${f} must be kept`);
    }
    assert.ok(!found.some((g) => g.endsWith('design.md')), 'design.md is a deliverable');
    assert.ok(!found.some((g) => g.endsWith('mock-1.html')), 'the mock is a deliverable');
    assert.ok(!found.some((g) => g.endsWith('qc-1.md')), 'a findings file is a deliverable');
    assert.ok(!found.some((g) => g.endsWith('keep-this.mjs')), 'a file the plan names is kept');

    // A dry run reports and deletes nothing.
    const dry = sweepScratch(dir, { dryRun: true });
    assert.ok(dry.found > 0 && dry.removed.length === 0);
    assert.ok(fs.existsSync(path.join(syn, 'design', 'contrast.mjs')));

    const real = sweepScratch(dir);
    assert.equal(real.removed.length, dry.found);
    assert.ok(!fs.existsSync(path.join(syn, 'design', 'serve.mjs')));
    assert.ok(!fs.existsSync(path.join(syn, 'design', '.synapse')));
    assert.ok(fs.existsSync(path.join(syn, 'design', 'mock-1.html')));
    assert.ok(fs.existsSync(path.join(syn, 'plan.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
