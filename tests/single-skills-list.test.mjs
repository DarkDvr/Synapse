// The ✎ in Single is not a picker any more.
//
// Single may load every skill on the machine (a chat is not a role), so ticking a
// subset there was a promise the session does not keep and a decision nobody could
// act on. The dialog lists them instead, and saving it touches the persona only —
// the Architect's Multi list must not be rewritten by a Single-mode visit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installPage } from './fake-page.mjs';

installPage();
const { state } = await import('../web/state.js');
const { $ } = await import('../web/dom.js');
const { openDialog, closeDialog, readDialog } = await import('../web/dialog.js');
const { editRoleSettings, roleModelsWiring } = await import('../web/role-models.js');

roleModelsWiring({
  modelLabel: () => '',
  modelTitle: () => '',
  openDialog,
  renderRoleActivity: () => {},
});

const response = (obj) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify(obj),
});

const SKILLS = [
  { name: 'aesthetic-foundations', description: 'How a thing should look.', builtin: false },
  { name: 'frontend-design', description: 'A page with a point of view.', builtin: false },
  { name: 'visual-review', description: 'Render a page and read the PNG.', builtin: false },
  { name: 'OpenCode', description: 'The desktop app’s own skill.', builtin: true },
];

function seedPage({ mode }) {
  installPage();
  state.mode = mode;
  state.projects = [{ id: 'p1', directory: 'F:/p1', sessions: [{ id: 's1' }] }];
  state.sessionId = 's1';
  state.persona = null;
  state.personaFor = 'p1';
  state.skillsInfo = { skills: SKILLS, missing: [], paths: [] };
  state.config = { roles: { architect: { skills: ['visual-review'] } } };
}

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body });
    if (String(url).endsWith('/api/skills')) return response({ skills: SKILLS });
    return response({});
  };
  return calls;
}

const tick = () => new Promise((r) => setTimeout(r, 25));

test('a list field is read, not filled in', async () => {
  installPage();
  openDialog({
    title: 'List',
    fields: [
      {
        name: 'skillsHere',
        type: 'list',
        label: 'Skills it can load — all 3 of them',
        items: [{ name: 'frontend-design', hint: 'A page with a point of view.' }],
        hint: 'Nothing to tick.',
      },
    ],
  });
  const html = $('dialogBody').innerHTML;
  assert.match(html, /dlg-list/);
  assert.match(html, /title="A page with a point of view\.">frontend-design</);
  assert.doesNotMatch(html, /Nothing to tick\./, 'no prose under a list');
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /data-skill-allow/);
  assert.equal(readDialog().skillsHere, undefined, 'a list collects nothing');
  closeDialog(null);
});

test('Single lists every skill the Architect can see, and offers no boxes', async () => {
  seedPage({ mode: 'single' });
  const calls = stubFetch();
  const pending = editRoleSettings('architect');
  await tick();
  const html = $('dialogBody').innerHTML;
  assert.match(html, /Skills it can load \(3\)/, 'the count is what is on the machine');
  assert.match(html, /aesthetic-foundations/);
  assert.match(html, /frontend-design/);
  assert.match(html, /visual-review/);
  assert.doesNotMatch(html, /OpenCode/, 'the engine’s own built-in skill is not listed');
  assert.doesNotMatch(html, /data-skill-allow/, 'no allow boxes in Single');
  assert.doesNotMatch(html, /data-skill-must|>Required</, 'nothing is “required” in a chat');
  // The list is reference, not a decision: a name a line, the description on hover,
  // and no prose taking the room the persona box needs.
  assert.match(html, /<li class="dlg-list-row" title="A page with a point of view.">frontend-design<\/li>/);
  assert.doesNotMatch(html, /A page with a point of view\.<\/li>/, 'the description is not printed');
  assert.match(html, /rows="8"/, 'the persona box takes the height the list gave up');
  // This popup belongs to Single: nothing in it explains Multi.
  assert.doesNotMatch(html, /Multi/);
  closeDialog(null);
  await pending;
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0, 'closing the dialog writes nothing');
});

test('the mode switch decides which dialog is drawn', async () => {
  seedPage({ mode: 'multi' });
  stubFetch();
  const pending = editRoleSettings('architect');
  await tick();
  const html = $('dialogBody').innerHTML;
  assert.match(html, /data-skill-allow/, 'Multi still ticks what the role may load');
  assert.match(html, /data-skill-must/, 'and what it must load');
  assert.doesNotMatch(html, /dlg-list/);
  closeDialog(null);
  await pending;
});

test('a Single save writes the persona and leaves the Multi skill list alone', async () => {
  seedPage({ mode: 'single' });
  const calls = stubFetch();
  const pending = editRoleSettings('architect');
  await tick();
  closeDialog({ personaName: 'Vekra', instructions: 'Speak plainly.' });
  await pending;
  const personaPut = calls.find((c) => c.method === 'PUT' && c.url.includes('/persona'));
  assert.ok(personaPut, 'the persona is saved');
  assert.deepEqual(JSON.parse(personaPut.body), { name: 'Vekra', instructions: 'Speak plainly.' });
  assert.equal(
    calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/api/config')).length,
    0,
    'no config write, so the Multi Architect list cannot move',
  );
});
