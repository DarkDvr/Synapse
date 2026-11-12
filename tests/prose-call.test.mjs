// The page's copy of the slip rule. It only shows a notice — no message is sent — so it
// has to agree with the harness's rule about what counts (12 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsInProseToolCall } from '../web/transcript.js';

const ASSISTANT = (text, extra = []) => ({ type: 'assistant', parts: [{ type: 'text', text }, ...extra] });
const SLIP = 'Reading it now: <tool_call>\nfunction=read>\n<parameter=path>\nF:\\x.txt\n</parameter>\n</function>\n</tool_call>';

test('the page agrees that a written call is a slip', () => {
  assert.equal(endsInProseToolCall([ASSISTANT(SLIP)]), true);
  assert.equal(endsInProseToolCall([ASSISTANT('Reading it now:', [{ type: 'tool', name: 'read' }])]), false);
  assert.equal(endsInProseToolCall([ASSISTANT('<tool_call>function=read</tool_call> then more answer')]), false);
  assert.equal(endsInProseToolCall([ASSISTANT('Done.')]), false);
  assert.equal(endsInProseToolCall([]), false);
});
