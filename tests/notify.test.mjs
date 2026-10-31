// The finished-work chime: four files, one name each, and the settings that pick one.
//
// The page cannot list what the server accepts (the config only carries the chosen
// name), so the two lists live where they are used: `DONE_SOUNDS` in src/config.js and
// `DONE_SOUNDS` in web/app.js. This test is what keeps them the same list — a name in
// one and not the other is either a setting that cannot be saved or a file that is
// never played.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, DONE_SOUNDS, normalize } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the config takes the four sounds and off, and refuses a name it does not have', () => {
  for (const name of DONE_SOUNDS) {
    assert.equal(normalize({ notify: { doneSound: name } }).notify.doneSound, name, name);
  }
  // A typo must not become "silence with a missing file": it is the default instead.
  assert.equal(normalize({ notify: { doneSound: 'trumpet' } }).notify.doneSound, DEFAULTS.notify.doneSound);
  assert.equal(normalize({ notify: { doneSound: '' } }).notify.doneSound, DEFAULTS.notify.doneSound);
  assert.equal(normalize({}).notify.doneSound, DEFAULTS.notify.doneSound);
});

test('the page offers exactly the sounds the server accepts', () => {
  const js = read('web/app.js');
  const block = /const DONE_SOUNDS = \[([\s\S]*?)\];/.exec(js);
  assert.ok(block, 'web/app.js declares DONE_SOUNDS');
  const page = [...block[1].matchAll(/v:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(page, DONE_SOUNDS, 'the two lists are one list');
  assert.match(js, /\{ id: 'notices', label: 'Notices'/, 'the pane is in Settings');
  assert.match(js, /notices: settingsNotices/);
});

test('every sound is a real, short, quiet WAV', () => {
  for (const name of DONE_SOUNDS.filter((n) => n !== 'off')) {
    const file = path.join(ROOT, 'web', 'sounds', `${name}.wav`);
    assert.ok(fs.existsSync(file), `${name}.wav is in the folder`);
    const buf = fs.readFileSync(file);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF', `${name}: RIFF`);
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE', `${name}: WAVE`);
    assert.equal(buf.readUInt16LE(20), 1, `${name}: PCM`);
    assert.equal(buf.readUInt16LE(22), 1, `${name}: mono`);
    assert.equal(buf.readUInt16LE(34), 16, `${name}: 16-bit`);
    const samples = (buf.length - 44) / 2;
    const seconds = samples / buf.readUInt32LE(24);
    assert.ok(seconds > 0.1 && seconds <= 1.5, `${name} lasts ${seconds.toFixed(2)}s — short`);
    let peak = 0;
    for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(buf.readInt16LE(44 + i * 2)));
    const dbfs = 20 * Math.log10(peak / 32768);
    // Quiet enough to talk over, loud enough to hear. Measured: -14 to -18 dBFS.
    assert.ok(dbfs > -26 && dbfs < -6, `${name} peaks at ${dbfs.toFixed(1)} dBFS — subtle`);
  }
});

test('a WAV is served as audio, not as an opaque file', () => {
  // Chrome will not play a URL whose type it does not recognise, and the failure is
  // silence — the one symptom that looks exactly like "the setting does nothing".
  assert.match(read('src/server.js'), /'\.wav': 'audio\/wav'/);
});
