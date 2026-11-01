// The renderer refuses what it cannot do.
//
// Timer Test 1: `shot.mjs --help` photographed a file called `--help`, wrote a
// picture of the browser's error page, and exited 0 — three runs believed it had
// looked at the page. These assertions are the cheap half (no browser launched, no
// page rendered): a wrong call must fail, and say why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SHOT = path.resolve('skills/visual-review/bin/shot.mjs');
const run = (...args) => spawnSync(process.execPath, [SHOT, ...args], { encoding: 'utf8', timeout: 60000 });

test('--help prints the usage and exits 0, without needing a page', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: shot\.mjs/);
  assert.match(r.stdout, /--widths/);
});

test('an unknown option is refused, never treated as the target', () => {
  const r = run('--help-typo', 'somewhere.html');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such option: --help-typo/);
  assert.match(r.stderr, /Usage: shot\.mjs/);
});

test('a file that is not there is refused', () => {
  const r = run('nope-does-not-exist.html');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such file/);
});

test('two targets at once are refused', () => {
  const r = run('a.html', 'b.html');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /one target at a time/);
});

test('no target at all prints the usage', () => {
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: shot\.mjs/);
});

// --expect asserts the RENDERED text of a control, because the attribute is the
// lie: a date input can carry lang="en-GB" and still draw "10/22/2026 04:00 PM".
// A malformed expectation is refused before a browser is launched.
test('a malformed --expect is refused without a page', () => {
  const r = run('somewhere.html', '--expect', 'no-pipe-here');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--expect needs "selector\|regex"/);
});

test('--expect with an empty pattern is refused', () => {
  const r = run('somewhere.html', '--expect', '#when|');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--expect needs "selector\|regex"/);
});

// 1 Nov: the operator had to point at three defects by hand — a Stop button 4px
// shorter than Pause, two labels on one line a pixel apart, and a header indented
// 12px from every row under it. Each is a number, so each is now a check.
const FIXTURE = `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; font:400 12px/16px sans-serif; background:#fff; color:#111; }
  .row { display:flex; gap:8px; align-items:flex-start; padding:8px 12px; }
  button { font:400 13px/1 sans-serif; border:1px solid #000; background:#fff; }
  .tall { height:30px; padding:0 14px; }
  .short { height:26px; padding:0 10px; }
  .leaning { height:30px; width:140px; padding:0 10px; text-align:left; }
  .line { display:flex; align-items:center; height:26px; padding:0 12px; }
  .mono { font:400 12px/16px monospace; }
  /* The "nudged by hand" case: same size, same line, 2px off the baseline. */
  .sans { font:400 12px/16px sans-serif; position:relative; top:-2px; }
  .block { padding:0 12px; }
  .head { display:flex; gap:12px; }
  .key { flex:0 0 96px; }
  .grid { display:grid; grid-template-columns:96px 1fr; }
</style>
<div class="row"><button class="tall">Pause</button><button class="short">Stop</button></div>
<div class="row"><button class="leaning">Bad</button></div>
<div class="line"><span class="mono">182.0 MB</span><span class="sans">Open page</span></div>
<div class="block">
  <div class="head"><span class="key">LIST</span><span>FUSION</span></div>
  <div class="grid"><span>STATE</span><span>Downloading</span></div>
  <div class="grid"><span>PATH</span><span>D:\\Downloads</span></div>
</div>`;

test('the layout audit names the three defects that were pointed at by hand', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-audit-'));
  try {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, FIXTURE, 'utf8');
    const r = run(page, '--widths', '700', '--no-sheet', '--audit', '--out', dir);
    // Findings fail the audit, so a role can gate on the exit code.
    assert.equal(r.status, 1, r.stderr || r.stdout);
    const line = r.stdout.split('\n').find((l) => l.includes('"layout"'));
    assert.ok(line, 'the report carries a layout section');
    const { findings } = JSON.parse(line).report.layout;
    const checks = new Set(findings.map((f) => f.check));
    assert.ok(checks.has('controls-row'), 'Pause and Stop differ in height');
    assert.ok(checks.has('control-label'), 'a label is not centred in its control');
    assert.ok(checks.has('baseline'), 'two runs on one line sit on different baselines');
    assert.ok(checks.has('column'), 'the header content is indented from the rows under it');
    for (const f of findings) assert.ok(String(f.detail || '').length > 0, 'every finding says what is wrong');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a page that is aligned reports nothing and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-audit-ok-'));
  try {
    const page = path.join(dir, 'ok.html');
    fs.writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8"><style>
        body { margin:0; font:400 12px/16px sans-serif; background:#fff; color:#111; }
        .row { display:flex; gap:8px; align-items:center; padding:8px 12px; }
        .far { display:flex; gap:220px; padding:8px 12px; }
        button { height:30px; padding:0 14px; font:400 13px/1 sans-serif; border:1px solid #000; background:#fff; }
        .short { height:26px; padding:0 10px; }
        .block { padding:0 12px; }
        .grid { display:grid; grid-template-columns:96px 1fr; }
      </style>
      <div class="row"><button>Pause</button><button>Stop</button></div>
      <div class="far"><button>Sidebar</button><button class="short">Main pane</button></div>
      <div class="block">
        <div class="grid"><span>LIST</span><span>FUSION</span></div>
        <div class="grid"><span>STATE</span><span>Downloading</span></div>
      </div>`,
      'utf8',
    );
    const r = run(page, '--widths', '700', '--no-sheet', '--audit', '--out', dir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const line = r.stdout.split('\n').find((l) => l.includes('"layout"'));
    assert.ok(line);
    assert.deepEqual(JSON.parse(line).report.layout.findings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
