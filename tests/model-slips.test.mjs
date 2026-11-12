// A tool call written into the answer, not made.
//
// The turn ends because the engine sees no tool part, and the work stops for no visible
// reason. The detector must be narrow: a run that finished, or was stopped, must never be
// woken by a guess (12 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proseToolCall } from '../src/model-slips.js';

const ASSISTANT = (text, extra = []) => ({
  type: 'assistant',
  parts: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text }, ...extra],
});

const SLIP = [
  'Reading the attachment now: <tool_call>',
  'function=read>',
  '<parameter=path>',
  'F:\\dev\\Synapse.Projects\\test_27b\\.synapse\\attachments\\pasted.txt',
  '</parameter>',
  '</function>',
  '</tool_call>',
].join('\n');

test('a call written as text is recognised', () => {
  assert.ok(proseToolCall([ASSISTANT(SLIP)]));
});

test('a message that made a real tool call is not', () => {
  assert.equal(proseToolCall([ASSISTANT('Reading it now:', [{ type: 'tool', name: 'read', status: 'completed' }])]), null);
});

test('a tag in the middle of an answer is not a slip', () => {
  assert.equal(proseToolCall([ASSISTANT('<tool_call>function=read</tool_call> and then I finished the answer.')]), null);
});

test('a closing tag with nothing that reads as a call is not', () => {
  assert.equal(proseToolCall([ASSISTANT('Here is the syntax: <tool_call>\nsome prose\n</tool_call>')]), null);
});

test('an ordinary answer is not', () => {
  assert.equal(proseToolCall([ASSISTANT('Done — the parser handles quoted commas.')]), null);
});

test('the last message has to be the assistant', () => {
  assert.equal(proseToolCall([ASSISTANT(SLIP), { type: 'user', parts: [] }]), null);
  assert.equal(proseToolCall([]), null);
  assert.equal(proseToolCall(null), null);
});
