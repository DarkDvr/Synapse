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

// Brave resets the operator's profile when anything touches it, so the renderer
// names Edge and no other browser — and an override cannot point it back at Brave.
test('the renderer uses Edge and never Brave', () => {
  const source = fs.readFileSync(SHOT, 'utf8');
  assert.match(source, /Microsoft\/Edge\/Application\/msedge\.exe/);
  assert.doesNotMatch(source, /Brave-Browser|brave\.exe/i);
});

test('an override pointing at Brave is refused before a page is touched', () => {
  const r = spawnSync(process.execPath, [SHOT, 'page.html'], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      VISUAL_REVIEW_BROWSER: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Brave is never launched/);
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
        .acct { display:flex; justify-content:space-between; padding:8px 12px; }
        .tier { font:400 12px/16px sans-serif; }
        .out { font:400 12px/16px sans-serif; display:flex; align-items:center; }
        button { height:30px; padding:0 14px; font:400 13px/1 sans-serif; border:1px solid #000; background:#fff; }
        .short { height:26px; padding:0 10px; }
        .block { padding:0 12px; }
        .grid { display:grid; grid-template-columns:96px 1fr; }
      </style>
      <div class="row"><button>Pause</button><button>Stop</button></div>
      <div class="far"><button>Sidebar</button><button class="short">Main pane</button></div>
      <div class="acct"><span class="tier">· Free tier</span><a class="out">Sign out</a></div>
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

// A dialog covers the page, so what is behind it is not on screen: a control there
// and one inside the dialog can share a y without being a row. Synapse's own Settings
// hit exactly this once the General pane made the dialog taller — its footer button
// lined up with the sidebar's behind the backdrop. The layer comes from the browser's
// hit test, so no page has to name its overlay. Two buttons *inside* the dialog still
// compare with each other, which is the half that must not be lost.
test('controls either side of a dialog are not a row, but controls inside it are', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-audit-modal-'));
  try {
    const page = path.join(dir, 'modal.html');
    fs.writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8"><style>
        body { margin:0; width:700px; height:800px; font:400 12px/16px sans-serif; background:#fff; }
        button { font:400 13px/1 sans-serif; border:1px solid #000; background:#fff; }
        /* behind the dialog, and at the same y as the button in it */
        .page-btn { position:absolute; left:40px; top:400px; height:30px; padding:0 14px; }
        .backdrop { position:fixed; inset:0; background:rgba(0,0,0,.6); }
        .panel { position:absolute; left:20px; top:300px; width:360px; height:260px; background:#fff; }
        /* same row, same layer as .page-btn's y — must not be compared across the backdrop */
        .dialog-btn { position:absolute; left:20px; top:400px; height:34px; padding:0 16px; }
        /* a genuine pair inside the dialog: one is 4px shorter, and that is a finding */
        .tall { position:absolute; left:20px; top:470px; height:30px; padding:0 14px; }
        .short { position:absolute; left:96px; top:470px; height:26px; padding:0 10px; }
      </style>
      <button class="page-btn">Behind</button>
      <div class="backdrop">
        <div class="panel">
          <button class="dialog-btn">Inside</button>
          <button class="tall">Pause</button><button class="short">Stop</button>
        </div>
      </div>`,
      'utf8',
    );
    const r = run(page, '--widths', '700', '--height', '800', '--no-sheet', '--audit', '--out', dir);
    assert.equal(r.status, 1, r.stderr || r.stdout);
    const { findings } = JSON.parse(r.stdout.split('\n').find((l) => l.includes('"layout"'))).report.layout;
    const rows = findings.filter((f) => f.check === 'controls-row');
    assert.equal(rows.length, 1, 'only the pair inside the dialog is a row');
    const names = [rows[0].el, rows[0].vs].join(' ');
    assert.match(names, /tall|short/, 'the pair inside the dialog is named');
    assert.doesNotMatch(names, /page-btn|dialog-btn/, 'nothing is compared across the backdrop');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --diff compares a build against an approved mock at the mock's own size. The
// first attempt at this was wrong in a way only a test would catch: the build's
// render was written to `<base>-<width>.png`, the same name a mock shot by this
// tool has, so it overwrote the reference and compared the page with itself —
// 0% every time, on any change. The name is now `-build.png`, and the mock's
// bytes are asserted unchanged below.
const DIFF_PAGE = (css = '', words = 'Two of five files are on disk.') => `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; width:400px; height:300px; background:#fff; color:#111; font:400 14px/20px sans-serif; }
  .card { margin:20px; padding:16px; border:1px solid #ccc; border-radius:6px; }
  h1 { margin:0 0 8px; font:700 16px/20px sans-serif; }
  button { margin-top:8px; height:30px; padding:0 14px; ${css} }
</style><div class="card"><h1>Download</h1><p>${words}</p><button>Start</button></div>`;

test('--diff on an unchanged build reports nothing and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-diff-same-'));
  try {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, DIFF_PAGE(), 'utf8');
    const shot = run(page, '--widths', '400', '--height', '300', '--no-sheet', '--out', dir);
    assert.equal(shot.status, 0, shot.stderr || shot.stdout);
    fs.copyFileSync(path.join(dir, 'page-400.png'), path.join(dir, 'mock.png'));

    const r = run(page, '--diff', path.join(dir, 'mock.png'), '--out', dir);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const line = r.stdout.split('\n').find((l) => l.includes('"diff"'));
    const { diff } = JSON.parse(line);
    assert.equal(diff.different, 0, 'the same page must not differ from itself');
    assert.equal(diff.percent, 0);
    assert.deepEqual(diff.boxes, []);
    assert.ok(fs.statSync(diff.path).size > 0, 'a diff picture is still written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--diff finds a moved control, keeps the mock intact, and can gate on it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-diff-moved-'));
  try {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, DIFF_PAGE(), 'utf8');
    assert.equal(run(page, '--widths', '400', '--height', '300', '--no-sheet', '--out', dir).status, 0);
    const mock = path.join(dir, 'mock.png');
    fs.copyFileSync(path.join(dir, 'page-400.png'), mock);
    const mockBytes = fs.readFileSync(mock);

    // The build: the button nudged 10px and a word changed. One run both measures
    // it and gates on it, so QC can block on drift without paying for two renders.
    fs.writeFileSync(page, DIFF_PAGE('margin-left:10px;', 'Two of six files are on disk.'), 'utf8');
    const r = run(page, '--diff', mock, '--fail-over', '0', '--out', dir);
    assert.equal(r.status, 1, 'any difference over 0% is a failed gate');
    assert.match(r.stderr, /is over the 0% limit/);
    const { diff } = JSON.parse(r.stdout.split('\n').find((l) => l.includes('"diff"')));
    assert.ok(diff.percent > 0, 'a changed page differs from the mock');
    assert.ok(diff.regions >= 1, 'the change has to be somewhere, and the region names it');
    for (const b of diff.boxes) {
      assert.ok(b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0, 'a region is a positive rectangle');
      assert.ok(b.x + b.w <= 400 && b.y + b.h <= 320, 'a region stays inside the picture');
    }
    assert.deepEqual(fs.readFileSync(mock), mockBytes, 'the mock is the reference and is never rewritten');
    assert.ok(fs.existsSync(path.join(dir, 'page-400-build.png')), 'the build render has its own name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--diff refuses a bad argument before any browser starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-diff-bad-'));
  try {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, DIFF_PAGE(), 'utf8');
    const missing = run(page, '--diff', path.join(dir, 'nope.png'));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no such file/);

    const notPng = run(page, '--diff', page);
    assert.equal(notPng.status, 1);
    assert.match(notPng.stderr, /--diff needs a PNG/);

    // A mock is a size, so asking for another width is a measurement of two
    // layouts rather than one: refused, not silently overridden. The size is read
    // from the header alone, which is all this check needs — no browser, no decode.
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'ascii');
    header.writeUInt32BE(400, 16);
    header.writeUInt32BE(800, 20);
    const png = path.join(dir, 'header.png');
    fs.writeFileSync(png, header);
    const wrongSize = run(page, '--diff', png, '--widths', '800');
    assert.equal(wrongSize.status, 1);
    assert.match(wrongSize.stderr, /compares at the mock's size \(400px\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
