# Synapse v1.1.7

The answer rule now looks at the turn, not at the last message.

## Fixed

`groupTurns` merges a turn's consecutive assistant messages into one, with the
reasoning, tool calls and text in `parts`. The 1.1.6 check asked whether the
merged message had a tool anywhere, so a turn that used tools never got the rule,
while a plain text-only reply did.

The check is now positional:

- **work before the last text**: reasoning or a tool in the parts before it;
- **no tool after it**: text followed by a tool is narration, not the answer.

So a plain reply with neither reasoning nor tools is one block, with no gap; a
reply after reasoning or tool work gets the 20 px break and the green rule.

## Also

- About's **Close** button (secondary, Title Case) and **Check for Updates**
  (primary) from 1.1.6 are here.

## Notes

- Full suite: 252 tests.
- One asset: `Synapse-1.1.7-win-x64.zip` with `SHA256SUMS`.
