// The persona's visible contract: the card label and the yellow switch note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installPage } from './fake-page.mjs';

installPage();
const { state } = await import('../web/state.js');
const { architectLabel, loadPersona, renderPersonaCard } = await import('../web/persona.js');
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
  // A voice without a name still counts as a persona for the glyph, but the
  // card label stays the role.
  state.persona = { name: '', instructions: 'Speak softly.' };
  assert.equal(architectLabel(), 'Architect');
});

test('the card carries the persona mark in Single and never in Multi', () => {
  const h3 = { innerHTML: '', title: '', _personaKey: '' };
  const edit = { title: '', getAttribute: () => '', setAttribute() {} };
  const card = {
    querySelector: (sel) => (sel === '.role-head h3' ? h3 : sel === '.ic-edit' ? edit : null),
  };
  const oldQuery = globalThis.document.querySelector;
  globalThis.document.querySelector = () => card;
  try {
    state.persona = { name: 'Vekra', instructions: 'Speak.' };
    state.mode = 'single';
    renderPersonaCard();
    assert.match(h3.innerHTML, /set-ic/);
    assert.match(h3.innerHTML, /Vekra \(Architect\)/);
    assert.match(h3.title, /Vekra/);
    state.mode = 'multi';
    renderPersonaCard();
    assert.doesNotMatch(h3.innerHTML, /set-ic/);
    assert.equal(h3.innerHTML, 'Architect');
    assert.equal(h3.title, '');
  } finally {
    globalThis.document.querySelector = oldQuery;
    state.persona = null;
    state.mode = 'single';
  }
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

test('the app wires the mode note and the shared role dialog', () => {
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /setModeNote\('off'/);
  assert.match(app, /setModeNote\('on'/);
  assert.match(app, /if \(role\) editRoleSettings\(role\);/);
  assert.match(app, /clearModeNote\(\);/);
  const roleModels = fs.readFileSync(new URL('../web/role-models.js', import.meta.url), 'utf8');
  assert.match(roleModels, /roleId === 'architect' && state\.mode === 'single'/);
  assert.match(roleModels, /Instructions \/ Persona for this role \(Single mode only\)/);
  assert.match(roleModels, /savePersona\(project\.id/);
  const composer = fs.readFileSync(new URL('../web/composer.js', import.meta.url), 'utf8');
  assert.match(composer, /clearModeNote\(\);/);
});
