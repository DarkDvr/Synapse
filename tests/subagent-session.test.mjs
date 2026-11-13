// A session the engine spawned for a model's `subagent` call is not the operator's chat.
//
// 13 Nov, fable_calc: the Architect called the engine's own `subagent` tool, which made a
// child session in the project folder ("Build calculator HTML file"). The child carried
// no Synapse metadata, only a parent, so it was offered to the rail as a chat — and it
// was newer than the real one, which is what clicking the project opened: the engine's
// brief beginning "You are a subagent spawned by another session." as a YOU message, and
// the child's interrupted step under the Architect's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSession } from '../src/engines/base.js';
import { newestSession, pruneFolderState, chatSession } from '../web/projects.js';
import { state } from '../web/state.js';

test('a session with a parent is scaffolding, not a chat', () => {
  const child = normalizeSession({ id: 'ses_child', parentID: 'ses_parent', title: 'Build calculator HTML file' });
  assert.equal(child.internal, true, 'a child of a session is nobody’s conversation');
  // Synapse's own scaffolding is marked the same way, for the same reason.
  assert.equal(normalizeSession({ id: 's', metadata: { synapse: { internal: true } } }).internal, true);
  // The operator's own chat carries neither mark.
  assert.equal(normalizeSession({ id: 's' }).internal, false);
});

test('the project chat is never an engine subagent', () => {
  const project = {
    sessions: [
      { id: 'chat', created: 100, internal: false, raw: { id: 'chat' } },
      { id: 'child', created: 200, internal: false, raw: { id: 'child', parentID: 'chat' } },
    ],
  };
  assert.equal(newestSession(project).id, 'chat', 'the child is newer and still not the chat');
  // Among our own, the newest still wins: a compact replaces the chat with a newer one.
  assert.equal(newestSession({ sessions: [{ id: 'old', created: 1 }, { id: 'new', created: 2 }] }).id, 'new');
  // A project with nothing but scaffolding has no chat yet.
  assert.equal(newestSession({ sessions: [{ id: 'child', created: 2, raw: { parentID: 'p' } }] }), null);
});

// The other half of the same evening: fable_calc was deleted and made again at the same
// path, and the deleted project's run fold ("DESIGNER-1 · t1 · 3s") was still above the
// new conversation, because traces are page state keyed by folder.
test('a deleted project takes its runs, rates and alarms with it', () => {
  state.projects = [{ directory: 'F:\\dev\\Synapse.Projects\\keep' }];
  state.traces = new Map([
    ['run-keep', { dir: 'F:\\dev\\Synapse.Projects\\keep' }],
    ['run-gone', { dir: 'F:\\dev\\Synapse.Projects\\gone' }],
  ]);
  state.rates = new Map([
    ['f:\\dev\\synapse.projects\\keep', { role: 'coder' }],
    ['f:\\dev\\synapse.projects\\gone', { role: 'coder' }],
  ]);
  state.alarms = [
    { dir: 'F:\\dev\\Synapse.Projects\\keep' },
    { dir: 'F:\\dev\\Synapse.Projects\\gone' },
    { what: 'no folder: the Architect’s own alarm' },
  ];
  pruneFolderState();
  assert.deepEqual([...state.traces.keys()], ['run-keep'], 'the live project keeps its trace');
  assert.deepEqual([...state.rates.keys()], ['f:\\dev\\synapse.projects\\keep'], 'and its rate');
  assert.equal(state.alarms.length, 2, 'the folder-less alarm is not about a project and stays');
  state.alarms = [];
});

// A page that was already open when the child appeared keeps it in its project list, and
// the restored session ("the last one open") was the child: a reload put the operator
// back into it. Restoring asks the stricter question.
test('a scaffolding session is never restored as the chat', () => {
  state.projects = [
    {
      directory: 'F:\\p',
      sessions: [
        { id: 'chat', internal: false, raw: {} },
        { id: 'child', internal: false, raw: { parentID: 'chat' } },
        { id: 'worker', internal: true, raw: {} },
      ],
    },
  ];
  assert.equal(chatSession('chat').id, 'chat', 'the chat is openable');
  assert.equal(chatSession('child'), null, 'the engine’s subagent is not');
  assert.equal(chatSession('worker'), null, 'and neither is a run’s worker session');
});
