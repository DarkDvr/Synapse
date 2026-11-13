// The live thinking pane is not hidden by an older step that began the same way (12 Nov),
// and it does not outlive its turn (13 Nov).
//
// It used to compare its own text against the whole transcript to avoid showing a
// paragraph twice. After a tool call the next step often begins the way the last one
// did, so the comparison matched an older message and the pane disappeared — leaving
// only the folded Reasoning lines. And it could also be left behind: a turn that ended
// while another chat was on screen never reached the page's event flag, so coming back
// drew a one-line pane under a finished Assistant post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { state } from '../web/state.js';
import { renderSessionStream } from '../web/traces.js';
import { turnLive } from '../web/turn-live.js';

const source = (rel) => fs.readFileSync(new URL(`../web/${rel}`, import.meta.url), 'utf8');
const step = (id, text, completed = true) => ({ id, type: 'assistant', completed, parts: [{ type: 'reasoning', text }] });
const streamOf = (text, stepId) => ({ key: 'sess:test', stream: { kind: 'think', text, step: stepId, ended: false } });

test('the pane survives a step that begins like the last one', () => {
  state.sessionId = 'sess_test';
  state.messages = [step('m1', 'Now I have the contract. Let me read the file again.')];
  // one pane, appended: it holds the whole log; the step being written is still empty
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

// The operator's screenshot: "digit-count computations depend" in a one-line box under
// the Architect's delegation, with the turn long over and its reasoning already folded
// above. The pane must not outlive the turn, and hiding it is not enough — a stale
// stream would be resumed by the next turn's first delta.
test('a pane does not outlive its turn', () => {
  state.sessionId = 'sess_test';
  state.busy = false;
  state.messages = [{ id: 'm4', type: 'assistant', completed: true, parts: [{ type: 'text', text: 't4b delegated to coder-1.' }] }];
  state.sessionTrace = { key: 'sess:sess_test', stream: { kind: 'think', text: 'digit-count computations depend' } };
  assert.equal(turnLive(), false, 'the turn is over');
  assert.equal(renderSessionStream(), '', 'no pane under a finished post');
  assert.equal(state.sessionTrace.stream, null, 'the stale stream is dropped, not just hidden');
  assert.equal(state.sessionTrace.key, '', 'and its key with it');
});

test('the pane is drawn while the turn runs, whatever the last message says', () => {
  state.sessionId = 'sess_test';
  state.busy = true;
  state.messages = [{ id: 'm5', type: 'assistant', completed: true, parts: [] }];
  state.sessionTrace = { key: 'sess:sess_test', stream: { kind: 'think', text: 'thinking about the plan' } };
  assert.match(renderSessionStream(), /trace-flow/, 'the turn is live, so the pane is too');
  state.busy = false;
});

test('a late delta cannot open a pane again, and a new chat starts with none', () => {
  assert.match(source('chat-scroll.js'), /if \(!isWorker\(trace\) && !turnLive\(\)\) return;/, 'deltas for a finished turn are refused');
  assert.match(source('app.js'), /state\.sessionTrace = \{ key: '', stream: null \};/, 'opening a chat drops the last one\'s pane');
});
