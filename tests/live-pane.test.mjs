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
import { alarmBreaks, panePostIndex } from '../web/transcript.js';
import { groupTurns } from '../web/run-view.js';
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

// The operator's rule, twice over (14 Nov, and again at 20:03 on 19 Nov when they photographed
// the pane vanishing and coming back mid-turn): the pane stays for the whole turn. The step's
// own words reaching the message is not a reason to hide it — the message's copy is a closed
// fold, and a step boundary is not the operator's idea of "the turn is over".
test('the pane stays while the step itself carries the same words', () => {
  state.sessionId = 'sess_test';
  state.busy = true;
  const text = 'Reading the file now.';
  state.messages = [{ id: 'm2', type: 'assistant', completed: false, parts: [{ type: 'reasoning', text }] }];
  state.sessionTrace = streamOf(text, 'm2');
  assert.match(renderSessionStream(), /is-live/, 'the pane hid itself mid-turn');
  state.busy = false;
  state.sessionTrace = null;
});

// The operator's rule (14 Nov): once the pane has built to its full height it stays
// until the turn ends. Hiding it when a finished step's words reached the message, and
// bringing it back for the next step, moved the whole chat by eleven lines twice a step.
test('a full pane stays for the rest of the turn', () => {
  state.sessionId = 'sess_test';
  state.busy = true;
  const text = 'Reading the file now.';
  state.messages = [{ id: 'm2', type: 'assistant', completed: false, parts: [{ type: 'reasoning', text }] }];
  state.sessionTrace = { key: 'sess:sess_test', reserved: true, stream: { kind: 'think', text } };
  const html = renderSessionStream();
  assert.match(html, /is-reserved/, 'the pane is still there, at its full height');
  state.busy = false;
  state.sessionTrace = null;
});

// The operator's screenshot the day before: "digit-count computations depend" in a
// one-line box under the Architect's delegation, with the turn long over. A pane must not
// outlive the turn — and hiding it is not enough: the stale stream would be resumed.
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

// The pane used to be drawn only when the assistant post happened to be the *last*
// message, so a compaction line arriving mid-turn took it away for a render and the next
// one put it back (14 Nov).
test('the live pane sits in the newest Assistant post, whatever follows it', () => {
  assert.equal(panePostIndex([{ type: 'user' }, { type: 'assistant' }, { type: 'assistant' }, { type: 'synthetic' }]), 2);
  assert.equal(panePostIndex([{ type: 'user' }, { type: 'assistant' }]), 1);
  assert.equal(panePostIndex([{ type: 'user' }]), -1, 'no assistant yet: nothing to attach it to');
  assert.equal(panePostIndex([]), -1);
});

// A PROHIBITED line is a refusal that happened at one step. The transcript merges a
// turn's steps into one block, so a line that arrived between two steps used to be
// rendered after the whole turn — and as the turn grew it slid down and sat at the
// bottom of the chat (15 Nov).
test('an alarm between two steps splits the turn instead of sinking to its bottom', () => {
  const messages = [
    { id: 'm1', type: 'assistant', created: 100, parts: [] },
    { id: 'm2', type: 'assistant', created: 200, parts: [] },
    { id: 'm3', type: 'assistant', created: 300, parts: [] },
  ];
  const breaks = alarmBreaks(messages, [150]);
  assert.deepEqual([...breaks], ['m2'], 'the first step after the alarm is where the merge stops');
  assert.equal(groupTurns(messages).length, 1, 'without a break the turn is one block');
  assert.equal(groupTurns(messages, { breakBefore: breaks }).length, 2, 'with it, the line can sit between the steps');
  assert.equal(alarmBreaks(messages, []).size, 0, 'no alarm, no break');
  assert.equal(alarmBreaks(messages, [999]).size, 0, 'an alarm after the last step breaks nothing');
});

