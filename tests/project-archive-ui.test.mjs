// The archived shelf: active rows stay where they were, archived rows wait below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPage } from './fake-page.mjs';

installPage();
const { state } = await import('../web/state.js');
const { renderTree, toggleArchiveSection } = await import('../web/projects.js');

function reset() {
  const page = installPage();
  state.projects = [
    { id: 'a', name: 'Alpha', directory: 'C:/alpha', exists: true, archived: false, sessions: [] },
    { id: 'b', name: 'Beta', directory: 'C:/beta', exists: true, archived: true, archivedAt: 10, sessions: [] },
    { id: 'c', name: 'Gamma', directory: 'C:/gamma', exists: true, archived: false, sessions: [] },
  ];
  state.sessionId = null;
  state.view = 'none';
  state.traces = new Map();
  state.runs = new Map();
  state.alarms = [];
  return page;
}

test('archived projects are below a closed Archived section', () => {
  const page = reset();
  renderTree();
  const html = page.el('projectTree').innerHTML;
  assert.match(html, /data-project-row="a"/);
  assert.match(html, /data-project-row="c"/);
  assert.match(html, /data-archive-section/);
  assert.match(html, /Archived/);
  assert.match(html, /tree-archive-count">1/);
  assert.match(html, /data-archive-toggle aria-expanded="false"/);
  assert.match(html, /id="archivedProjects" hidden/);
  assert.match(html, /data-project-row="b"/);
});

test('the Archived section opens and closes without moving the active rows', () => {
  const page = reset();
  renderTree();
  toggleArchiveSection();
  let html = page.el('projectTree').innerHTML;
  assert.match(html, /data-archive-toggle aria-expanded="true"/);
  assert.match(html, /id="archivedProjects">/);
  assert.doesNotMatch(html, /id="archivedProjects" hidden/);
  toggleArchiveSection();
  html = page.el('projectTree').innerHTML;
  assert.match(html, /data-archive-toggle aria-expanded="false"/);
  assert.match(html, /id="archivedProjects" hidden/);
  assert.ok(html.indexOf('data-project-row="a"') < html.indexOf('data-project-row="c"'));
});
