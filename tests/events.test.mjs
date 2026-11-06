// The engine's event names are imported, never typed out again.
//
// A typo in an event name is the quietest bug in this codebase: the handler simply
// never runs, and the only symptom is a feature that does nothing. So the names
// live in `web/events.js` — one file, imported by the server and by the page — and
// this test fails if a bare `'session.…'` literal appears anywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EV, EXECUTION_ENDED, turnEnded } from '../web/events.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every name is a session event and no two are the same', () => {
  const values = Object.values(EV);
  assert.ok(values.length > 15, 'the list is the vocabulary, not a sample');
  for (const value of values) {
    assert.match(value, /^session\.[a-z.]+$/, `${value} looks like an engine event`);
  }
  assert.equal(new Set(values).size, values.length, 'no duplicates');
});

test('the execution endings are one list, and turnEnded answers for all of them', () => {
  assert.deepEqual(EXECUTION_ENDED, [EV.executionSucceeded, EV.executionFailed, EV.executionInterrupted]);
  assert.equal(turnEnded(EV.executionInterrupted), true);
  assert.equal(turnEnded(EV.executionStarted), false);
  assert.equal(turnEnded(EV.idle), false, 'an idle message is a message, not an event');
});

test('no file types a session event name out by hand', () => {
  const skip = new Set([
    path.join('web', 'events.js'), // the list itself
    path.join('src', 'engines'), // the adapter is where the raw names belong
  ]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'bin', 'dist', 'data', 'logs', '.git', 'vendor', 'obj'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(ROOT, full);
      if ([...skip].some((s) => rel === s || rel.startsWith(`${s}${path.sep}`))) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.m?js$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      // A quoted literal or a regex that spells a session event out. Comments are
      // allowed to name one — the prose explains the events.
      for (const line of text.split(/\r?\n/)) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/['"`]session\.[a-z.]+['"`]/.test(line) || /\/\^?session\\\./.test(line)) {
          offenders.push(`${rel}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'web'));
  assert.deepEqual(offenders, [], 'these should use a name from web/events.js');
});
