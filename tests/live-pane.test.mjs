// The live thinking pane belongs to the step being written (12 Nov).
//
// It used to compare its own text against the whole transcript to avoid showing a
// paragraph twice. After a tool call the next step often begins the way the last one
// did, so the comparison matched an older message and the pane disappeared — leaving
// only the folded Reasoning lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../web/state.js';
import { renderSessionStream } from '../web/traces.js';

const step = (id, text, completed = true) => ({ id, type: 'assistant', completed, parts: [{ type: 'reasoning', text }] });
const streamOf = (text, stepId) => ({ key: 'sess:test', stream: { kind: 'think', text, step: stepId, ended: false } });

test('a new step shows its pane even when it begins like the last one', () => {
  state.sessionId = 'sess_test';
  state.messages = [step('m1', 'Now I have the contract. Let me read the file again.')];
  // the next step starts with the same words; its own message is still empty
  state.messages.push({ id: 'm2', type: 'assistant', completed: false, parts: [] });
  state.sessionTrace = streamOf('Now I have the contract. Let me read the file again. Yes.', 'm2');
  assert.match(renderSessionStream(), /is-live/, 'the pane is drawn');
});

test('the pane goes once the step itself carries the words', () => {
  state.sessionId = 'sess_test';
  const text = 'Reading the file now.';
  state.messages = [{ id: 'm2', type: 'assistant', completed: false, parts: [{ type: 'reasoning', text }] }];
  state.sessionTrace = streamOf(text, 'm2');
  assert.equal(renderSessionStream(), '', 'no duplicate of the same step');
});
