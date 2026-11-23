// The Architect's model is a project fact, not a global role.
//
// A project has one chat, and that chat's session carries the model the operator
// chose for it. The config's `roles.architect` is only the fallback for a chat
// that has no model yet; worker role models remain config-wide. These cases pin
// the lookup so switching projects cannot show the last project's choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { state } from '../web/state.js';
import { selectionFor, architectSelection } from '../web/run-view.js';

function withState({ sessionId = null, sessions = [], config = {} } = {}) {
  const before = {
    sessionId: state.sessionId,
    projects: state.projects,
    config: state.config,
    models: state.models,
  };
  state.sessionId = sessionId;
  state.projects = [{ id: 'p1', sessions }];
  state.config = { roles: {}, ...config };
  state.models = [
    { ref: 'provider/model-a', name: 'Model A', variants: ['low', 'high'] },
    { ref: 'provider/model-b', name: 'Model B' },
  ];
  return () => Object.assign(state, before);
}

test('the open project keeps its own Architect model', () => {
  const restore = withState({
    sessionId: 's1',
    sessions: [{ id: 's1', model: 'provider/model-a', variant: 'high' }],
    config: { roles: { architect: { ref: 'provider/model-b' }, 'coder-1': { ref: 'provider/model-b' } } },
  });
  try {
    assert.deepEqual(selectionFor('architect'), { ref: 'provider/model-a', variant: 'high' });
    assert.deepEqual(architectSelection(), { ref: 'provider/model-a', variant: 'high' });
    // Worker roles are still the config's choice.
    assert.deepEqual(selectionFor('coder-1'), { ref: 'provider/model-b', variant: '' });
  } finally {
    restore();
  }
});

test('another project shows its own model, not the last one opened', () => {
  const restore = withState({
    sessionId: 's2',
    sessions: [
      { id: 's1', model: 'provider/model-a', variant: 'high' },
      { id: 's2', model: 'provider/model-b', variant: '' },
    ],
    config: { roles: { architect: { ref: 'provider/model-a', variant: 'high' } } },
  });
  try {
    assert.deepEqual(selectionFor('architect'), { ref: 'provider/model-b', variant: '' });
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

test('with no chat open, a new project inherits the newest project Architect', () => {
  const restore = withState({
    sessionId: null,
    sessions: [
      { id: 's1', model: 'provider/model-a', variant: 'low', updated: 10 },
      { id: 's2', model: 'provider/model-b', variant: '', updated: 20 },
    ],
    config: { roles: { architect: { ref: 'provider/model-a', variant: 'low' } } },
  });
  try {
    assert.deepEqual(selectionFor('architect'), { ref: 'provider/model-b', variant: '' });
  } finally {
    restore();
  }
});

test('the server leaves an existing project model alone', () => {
  const src = fs.readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /sessionModel !== architectRef/, 'the global role still repairs the session every turn');
  assert.match(src, /let architectRef = sessionModel/, 'the session model is the first source');
});

test('changing the open project Architect is not saved as the global role', () => {
  const src = fs.readFileSync(new URL('../web/role-models.js', import.meta.url), 'utf8');
  assert.match(src, /if \(roleId === 'architect' && state\.sessionId\) return;/, 'the global role would move every other project');
  assert.match(src, /session\.model = model\.ref/, 'the open session is updated in place');
});
