// The finished-work chime: four files, one name each, and the rule that decides when
// a silence in the chat is a *finish* and when it is just the gap between two pieces of
// work.
//
// The gap was the bug (31 Oct): a coder's run ended at 14:11:35, the Architect read its
// report, marked the task done and started the next one at 14:12:09 — and the chime
// fired in between, telling the operator the job was done when the plan still had two
// tasks to do. The rule lives in `web/notify.js` so it can be tested like this, without
// a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, DONE_SOUNDS, normalize } from '../src/config.js';
import { DONE_SOUNDS as PAGE_SOUNDS, doneSoundName, workWillContinue } from '../web/notify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tasks = (...statuses) => statuses.map((status, i) => ({ id: `t${i + 1}`, status }));

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
  assert.deepEqual(PAGE_SOUNDS.map((s) => s.v), DONE_SOUNDS, 'the two lists are one list');
  assert.equal(PAGE_SOUNDS[0].v, 'off', 'Off is first, so the default answer is silence');
  assert.equal(doneSoundName('nonsense'), DEFAULTS.notify.doneSound, 'an unknown name falls back');
  assert.equal(doneSoundName('off'), 'off');
  const js = read('web/app.js');
  assert.match(js, /from '\.\/notify\.js'/, 'the page imports the rule instead of repeating it');
  assert.match(js, /\{ id: 'notices', label: 'Notices'/, 'the pane is in Settings');
  assert.match(js, /notices: settingsNotices/);
});

test('a gap between two pieces of work is not a finish', () => {
  // The bug: a coder's run ends, the Architect is between turns, the plan is unfinished.
  assert.equal(workWillContinue({ mode: 'multi', auto: true, tasks: tasks('done', 'todo', 'todo') }), true);
  assert.equal(workWillContinue({ mode: 'multi', auto: true, tasks: tasks('done', 'doing') }), true);

  // The job really is over, or it stopped for the operator: the chime is due.
  assert.equal(workWillContinue({ mode: 'multi', auto: true, tasks: tasks('done', 'done', 'done') }), false);
  assert.equal(workWillContinue({ mode: 'multi', auto: true, tasks: tasks('done', 'blocked') }), false);
  assert.equal(workWillContinue({ mode: 'multi', auto: true, tasks: [] }), false);

  // Keep running off: the Architect stops after each task and waits, so every end is
  // the operator's move and it is worth a sound.
  assert.equal(workWillContinue({ mode: 'multi', auto: false, tasks: tasks('todo') }), false);

  // Single mode has no delegation and no plan to continue: the turn ending is the end.
  assert.equal(workWillContinue({ mode: 'single', auto: true, tasks: tasks('todo') }), false);

  // Defensive: no plan loaded, or a malformed entry, must not throw or suppress.
  assert.equal(workWillContinue({ mode: 'multi', auto: true, tasks: null }), false);
  assert.equal(workWillContinue({ mode: 'multi', auto: true, tasks: [null, { status: 'done' }] }), false);
  assert.equal(workWillContinue(), false);
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
