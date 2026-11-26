// The persona's visible contract: the card label and the yellow switch note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { state } from '../web/state.js';
import { architectLabel, loadPersona } from '../web/persona.js';
import { ICONS } from '../web/icons.js';
import { setModeNote, clearModeNote, modeNoteHtml } from '../web/mode-note.js';

test('the card is named only in Single, and keeps the role in parentheses', () => {
  state.persona = { name: 'Vekra', instructions: 'Speak.' };
  state.mode = 'single';
  assert.equal(architectLabel(), 'Vekra (Architect)');
  state.mode = 'multi';
  assert.equal(architectLabel(), 'Architect');
  state.persona = null;
  state.mode = 'single';
  assert.equal(architectLabel(), 'Architect');
});

test('a persona has a person mark, not an emoji', () => {
  assert.match(ICONS.person, /circle/);
  assert.match(ICONS.person, /path/);
  assert.doesNotMatch(ICONS.person, /👤/u);
});

test('switching off a persona leaves one yellow note with Compact', () => {
  state.messages = [{ id: 'm1', type: 'user', text: 'work', created: 1 }];
  state.modeNote = null;
  setModeNote('off', 'Vekra');
  const html = modeNoteHtml();
  assert.match(html, /msg-mode-note/);
  assert.match(html, /Synapse · persona off/);
  assert.match(html, /Vekra was the Single-mode persona/);
  assert.match(html, /data-mode-compact/);
  assert.match(html, />Compact</);
  clearModeNote();
  assert.equal(modeNoteHtml(), '');
});

test('returning to the persona recommends compaction too', () => {
  setModeNote('on', 'Vekra');
  const html = modeNoteHtml();
  assert.match(html, /persona on/);
  assert.match(html, /Vekra is back as the Single-mode persona/);
  assert.match(html, /Compaction is recommended/);
  clearModeNote();
});

test('loadPersona reads the open project and clears on a null answer', async () => {
  const oldFetch = globalThis.fetch;
  let asked = '';
  state.projects = [{ id: 'p1', directory: 'F:/p1', sessions: [{ id: 's1' }] }];
  state.sessionId = 's1';
  state.persona = null;
  state.personaFor = null;
  try {
    globalThis.fetch = async (url) => {
      asked = String(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ persona: { name: 'Vekra', instructions: 'Speak.' } }),
      };
    };
    await loadPersona({ force: true });
    assert.equal(asked, '/api/projects/p1/persona');
    assert.equal(state.persona?.name, 'Vekra');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ persona: null }),
    });
    await loadPersona({ force: true });
    assert.equal(state.persona, null);
  } finally {
    globalThis.fetch = oldFetch;
    state.projects = [];
    state.sessionId = null;
    state.persona = null;
    state.personaFor = null;
  }
});

test('the app wires the mode note and the mode-aware editor', () => {
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /setModeNote\('off'/);
  assert.match(app, /setModeNote\('on'/);
  assert.match(app, /role === 'architect' && state\.mode === 'single'\) editPersona\(\)/);
  assert.match(app, /clearModeNote\(\);/);
  const composer = fs.readFileSync(new URL('../web/composer.js', import.meta.url), 'utf8');
  assert.match(composer, /clearModeNote\(\);/);
});
