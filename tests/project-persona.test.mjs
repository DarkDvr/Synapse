// A project's persona stays inside the project.
//
// The file is `.project/persona.json`, so the records repository must not version
// it, and the API must be local-only. The brief rule is in brief-persona.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPersona, writePersona, personaPath, PERSONA_MAX_TEXT } from '../src/project-persona.js';
import { vcsIgnore } from '../src/project-vcs.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-persona-'));
const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('a persona round-trips from the project folder', () => {
  const dir = temp();
  try {
    assert.equal(readPersona(dir), null);
    const saved = writePersona(dir, { name: 'Vekra', instructions: 'Speak plainly.' });
    assert.deepEqual(saved, { name: 'Vekra', instructions: 'Speak plainly.' });
    assert.equal(fs.existsSync(personaPath(dir)), true);
    assert.deepEqual(readPersona(dir), { name: 'Vekra', instructions: 'Speak plainly.' });
    writePersona(dir, {});
    assert.equal(readPersona(dir), null);
    assert.equal(fs.existsSync(personaPath(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the file is capped and a name stays on one line', () => {
  const dir = temp();
  try {
    const saved = writePersona(dir, {
      name: '  Vekra\nArchitect  ',
      instructions: 'x'.repeat(PERSONA_MAX_TEXT + 500),
    });
    assert.equal(saved.name, 'Vekra Architect');
    assert.equal(saved.instructions.length, PERSONA_MAX_TEXT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed persona is no persona, not a crash', () => {
  const dir = temp();
  try {
    fs.mkdirSync(path.join(dir, '.project'), { recursive: true });
    fs.writeFileSync(personaPath(dir), '{ nope', 'utf8');
    assert.equal(readPersona(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the records repository does not version the persona', () => {
  assert.match(vcsIgnore(), /persona\.json/);
});

test('the persona route is local only and writes through the project', () => {
  const server = read('src/server.js');
  const api = read('src/api.js');
  assert.match(server, /seg\[2\] === 'persona' && method === 'GET'/);
  assert.match(server, /seg\[2\] === 'persona' && method === 'PUT'/);
  assert.match(server, /if \(fromLan\) return sendJson\(res, 404, \{ error: 'not found' \}\);/);
  assert.match(api, /projectPersona: \(id, \{ remote = false \} = \{\}\)/);
  assert.match(api, /setProjectPersona: \(id, body, \{ remote = false \} = \{\}\)/);
  assert.match(api, /if \(remote\) throw fail\(404, 'not found'\)/);
  assert.match(api, /readPersona\(project\.directory\)/);
  assert.match(api, /writePersona\(project\.directory, body\)/);
  // The brief must not use a persona for a LAN send either, even if the file exists.
  assert.match(api, /!remote && role === 'architect' \? readPersona\(directory\) : null/);
  assert.match(server, /api\.sendMessage\(sessionId, .*remote: fromLan/);
});
