// What asks for the operator's screen, and what must not.
//
// 9 Nov 2026, live: every `curl.exe …` download raised "AI wants to use your
// keyboard and mouse". A bare program name resolves against the working directory,
// so `curl.exe` looked exactly like a program the project had built — the one shape
// that is allowed to ask, because a GUI takes the screen from inside its own binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide } from '../src/permissions.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-screen-'));
const project = path.join(root, 'proj');
fs.mkdirSync(project, { recursive: true });

const call = (command) => decide({
  action: 'shell',
  resources: [command],
  cwd: project,
  projectRoot: project,
  harnessRoot: path.join(root, 'harness'),
  scratchRoot: path.join(root, 'scratch'),
  home: root,
  protection: [],
  deskHeld: false,
});

test('a download asks nothing of the screen', () => {
  assert.equal(call(`curl.exe -L --ssl-no-revoke --max-time 120 -A 'Mozilla/5.0' -o "$s\\t.zip" $u`).effect, 'allow');
  assert.equal(call(`curl.exe -sL -o "$s\\nsis.zip" 'https://downloads.sourceforge.net/x.zip'`).effect, 'allow');
});

test('a bare program name that is not in the project is not the project program', () => {
  assert.equal(call('curl.exe --version').effect, 'allow');
});

test('a program the project actually built does still ask', () => {
  fs.writeFileSync(path.join(project, 'Widget.exe'), 'MZ');
  assert.equal(call('.\\Widget.exe').effect, 'ask');
  assert.equal(call('Start-Process .\\Widget.exe').effect, 'ask');
});
