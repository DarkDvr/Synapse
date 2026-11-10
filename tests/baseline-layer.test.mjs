// The baseline is a cascade layer, not a sibling stylesheet.
//
// On 2 Nov the shutdown warning's subtitle was off-centre because Summit's
// `.modal p` (0,1,1) outranked Synapse's `.shutdown-lead` (0,1,0): the library's
// margin and font-size silently won. Scoping the rule fixed that one rule; this
// fixes the class of bug. Summit is imported with `layer(summit)`, and layered
// rules always lose to unlayered ones — so a Synapse component rule cannot be
// outranked by accident, and the locked library is not edited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './tmpdir.mjs';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const SHOT = path.resolve('skills/visual-review/bin/shot.mjs');

test('the shell loads the baseline through a layer, and Synapse is unlayered', () => {
  const html = read('web/index.html');
  assert.match(html, /href="\/baseline\.css"/, 'the baseline is loaded by our own stylesheet');
  assert.doesNotMatch(html, /href="\/vendor\/summit\.css"/, 'Summit is not linked as a sibling any more');
  const baseline = read('web/baseline.css');
  assert.match(baseline, /@import url\('vendor\/summit\.css'\) layer\(summit\)/, 'imported into a lower layer');
  const ours = read('web/synapse.css');
  assert.doesNotMatch(ours, /@layer/, 'Synapse stays unlayered, which is what makes it win');
});

// The behaviour, not the markup: a (0,1,0) rule of ours must beat the library's
// (0,1,1) rule, which is exactly what the cascade does not do without layers.
test('an unlayered rule of ours beats the baseline even when the baseline is more specific', () => {
  const dir = tmpdir('synapse-layer-');
  try {
    // The library and the layer wrapper, exactly as the app serves them.
    fs.copyFileSync(path.resolve('web/vendor/summit.css'), path.join(dir, 'summit.css'));
    fs.writeFileSync(
      path.join(dir, 'baseline.css'),
      "@import url('summit.css') layer(summit);\n",
      'utf8',
    );
    // A single-class rule — lower specificity than the library's `.modal p`.
    fs.writeFileSync(
      path.join(dir, 'ours.css'),
      '.subtitle { color: rgb(1, 2, 3); font-size: 13px; text-decoration-line: underline; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'page.html'),
      `<!doctype html><meta charset="utf-8">
       <link rel="stylesheet" href="baseline.css">
       <link rel="stylesheet" href="ours.css">
       <div class="modal"><p class="subtitle" id="x">Subtitle</p></div>`,
      'utf8',
    );
    const r = spawnSync(
      process.execPath,
      [SHOT, path.join(dir, 'page.html'), '--widths', '600', '--no-sheet', '--eval',
        `(() => { const s = getComputedStyle(document.getElementById('x')); return JSON.stringify({ color: s.color, fontSize: s.fontSize }); })()`],
      { encoding: 'utf8', timeout: 60000 },
    );
    const line = r.stdout.split('\n').find((l) => l.includes('color'));
    assert.ok(line, r.stderr || r.stdout);
    // The value is a JSON string inside the JSON line, so it arrives escaped.
    const answer = JSON.parse(JSON.parse(line).value);
    assert.equal(answer.color, 'rgb(1, 2, 3)', 'our (0,1,0) rule wins over the library\'s (0,1,1)');
    assert.equal(answer.fontSize, '13px', 'the size too, not just the colour');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
