// A tool call written as text, instead of made.
//
// Some models (a 27B on 12 Nov) end a turn by printing the call into their answer:
//
//   Reading the attachment now: <tool_call>
//   function=read>
//   <parameter=path>…</parameter>
//   </tool_call>
//
// The engine sees a finished message with **no tool part**, so there is nothing to run and
// the turn ends — the work stops for no visible reason. The check below is deliberately
// narrow, because the cure must not be worse than the disease: a run that has genuinely
// finished, or one the operator stopped, must never be woken by a guess.
//
// It is true only when **all** of these hold:
//   - the message is the last one of a turn that ended with no error;
//   - it is an assistant message;
//   - it has no tool part at all (nothing ran);
//   - its last text block *ends* with `</tool_call>`, and contains an opening tag;
//   - the block names a function (`function=` or `name=`) or a parameter.
//
// A model that quotes the syntax in the middle of an answer does not match: the block has
// to be the last thing in the message, and it has to be a call.
const OPEN = /<tool_call>/i;
const CLOSE_AT_END = /<\/tool_call>\s*$/i;
const NAMES_A_CALL = /function\s*=|name\s*=|<parameter|<\s*parameter/i;

/** The text of a part, whatever shape the engine gave it. */
const textOf = (part) => String(part?.text ?? part?.content ?? '');

/**
 * The last assistant message of a transcript, if it ends in a tool call written as text.
 * Returns the message, or null. Pure: no state, no side effects, easy to test.
 */
export function proseToolCall(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  if (!last || last.type !== 'assistant') return null;
  const parts = Array.isArray(last.parts) ? last.parts : [];
  if (parts.some((p) => p?.type === 'tool')) return null;
  const texts = parts.filter((p) => p?.type === 'text').map(textOf).filter(Boolean);
  const tail = texts[texts.length - 1] || '';
  if (!OPEN.test(tail) || !CLOSE_AT_END.test(tail)) return null;
  // The block must read as a call, not as prose about one.
  const block = tail.slice(tail.toLowerCase().lastIndexOf('<tool_call>'));
  if (!NAMES_A_CALL.test(block)) return null;
  return last;
}

/** What the model is told, once, when it writes a call instead of making one. */
export const PROSE_NUDGE =
  'That last message was text: the tool call was written into the answer, so nothing ran. ' +
  'Call the tool properly now — the same step, as a real tool call — and carry on.';

/** What the operator is told when it happens outside a run the harness drives. */
export const PROSE_NOTE =
  'The model wrote a tool call into its answer instead of making one, so nothing ran and the ' +
  'turn ended. Say continue (or send your next instruction) and it will carry on.';
