// Every role's model is a project fact.
//
// A project has its own `.project/roles.json`; the chat session follows it for the
// Architect, and the delegation runner reads it for the workers. The config is only
// the template a project starts from. These cases pin the page's lookup so switching
// projects cannot show the last project's choices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { state } from '../web/state.js';
import { selectionFor, architectSelection } from '../web/run-view.js';

function withState({ sessionId = null, sessions = [], roles = {}, config = {} } = {}) {
  const before = {
    sessionId: state.sessionId,
    projects: state.projects,
    config: state.config,
    models: state.models,
  };
  state.sessionId = sessionId;
  state.projects = [{ id: 'p1', sessions, roles }];
  state.config = { roles: {}, ...config };
  state.models = [
    { ref: 'provider/model-a', name: 'Model A', variants: ['low', 'high'] },
    { ref: 'provider/model-b', name: 'Model B' },
    { ref: 'provider/model-c', name: 'Model C' },
  ];
  return () => Object.assign(state, before);
}

test('the open project keeps its own model for every role', () => {
  const restore = withState({
    sessionId: 's1',
    sessions: [{ id: 's1', model: 'provider/model-a', variant: 'high' }],
    roles: {
      architect: { ref: 'provider/model-a', variant: 'high' },
      'coder-1': { ref: 'provider/model-c', variant: '' },
    },
    config: { roles: { architect: { ref: 'provider/model-b' }, 'coder-1': { ref: 'provider/model-b' } } },
  });
  try {
    assert.deepEqual(selectionFor('architect'), { ref: 'provider/model-a', variant: 'high' });
    assert.deepEqual(architectSelection(), { ref: 'provider/model-a', variant: 'high' });
    assert.deepEqual(selectionFor('coder-1'), { ref: 'provider/model-c', variant: '' });
  } finally {
    restore();
  }
});

test('another project shows its own set, not the last one opened', () => {
  const restore = withState({
    sessionId: 's2',
    sessions: [
      { id: 's1', model: 'provider/model-a', variant: 'high' },
      { id: 's2', model: 'provider/model-b', variant: '' },
    ],
    roles: { architect: { ref: 'provider/model-b', variant: '' }, 'coder-1': { ref: 'provider/model-c', variant: '' } },
    config: { roles: { architect: { ref: 'provider/model-a', variant: 'high' }, 'coder-1': { ref: 'provider/model-a' } } },
  });
  try {
    assert.deepEqual(selectionFor('architect'), { ref: 'provider/model-b', variant: '' });
    assert.deepEqual(selectionFor('coder-1'), { ref: 'provider/model-c', variant: '' });
  } finally {
    restore();
  }
});

test('a project without a worker entry falls back to the config template', () => {
  const restore = withState({
    sessionId: 's1',
    sessions: [{ id: 's1', model: 'provider/model-a', variant: 'high' }],
    roles: { architect: { ref: 'provider/model-a', variant: 'high' } },
    config: { roles: { 'coder-1': { ref: 'provider/model-b' } } },
  });
  try {
    assert.deepEqual(selectionFor('coder-1'), { ref: 'provider/model-b', variant: '' });
  } finally {
    restore();
  }
});

test('a chat with no model falls back to the configured Architect', () => {
  const restore = withState({
    sessionId: 's1',
    sessions: [{ id: 's1', model: null, variant: null }],
    config: { roles: { architect: { ref: 'provider/model-b' } } },
  });
  try {
    assert.deepEqual(selectionFor('architect'), { ref: 'provider/model-b', variant: '' });
  } finally {
    restore();
  }
});

test('with no chat open, a new project inherits the newest project set', () => {
  const restore = withState({
    sessionId: null,
    sessions: [
      { id: 's1', model: 'provider/model-a', variant: 'low', updated: 10 },
      { id: 's2', model: 'provider/model-b', variant: '', updated: 20 },
    ],
    roles: { architect: { ref: 'provider/model-b' }, 'coder-1': { ref: 'provider/model-c' } },
    config: { roles: { architect: { ref: 'provider/model-a', variant: 'low' }, 'coder-1': { ref: 'provider/model-a' } } },
  });
  try {
    assert.deepEqual(selectionFor('architect'), { ref: 'provider/model-b', variant: '' });
    assert.deepEqual(selectionFor('coder-1'), { ref: 'provider/model-c', variant: '' });
  } finally {
    restore();
  }
});

test('the server reads the project role file before the session fallback', () => {
  const src = fs.readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
  assert.match(src, /roleModel\(readProjectRoles\(directory\), 'architect'\)/, 'the project file is the first source');
  assert.match(src, /let architectRef = sessionModel/, 'the session is the migration fallback');
});

test('changing a role writes the project, not the global config', () => {
  const src = fs.readFileSync(new URL('../web/role-models.js', import.meta.url), 'utf8');
  assert.match(src, /\/api\/projects\/\$\{encodeURIComponent\(project\.id\)\}\/roles/, 'the project endpoint is used');
  assert.match(src, /session\.model = ref/, 'the open session follows the Architect');
});

test('a pending model choice breathes until the save returns', () => {
  const src = fs.readFileSync(new URL('../web/role-models.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/synapse.css', import.meta.url), 'utf8');
  assert.match(src, /classList\.add\('is-saving'\)/);
  assert.match(src, /classList\.remove\('is-saving'\)/);
  assert.match(css, /\.model-search\.is-saving/);
  assert.match(css, /@keyframes model-saving/);
});

test('a new project is given the whole effective set, not only the Architect', () => {
  const src = fs.readFileSync(new URL('../web/mode.js', import.meta.url), 'utf8');
  assert.match(src, /for \(const role of ROLES\)/);
  assert.match(src, /body\.roles = roles/);
});
