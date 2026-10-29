# Synapse v1.1.6

A small transcript fix and a proper Close button on About.

## The answer rule only appears after work

The 20 px break and the green answer rule are now used only when the turn
actually did something to separate from: reasoning or a tool call, in the same
message or earlier in the turn. A plain reply with no reasoning and no tools is
one block again, with no gap.

The check is per turn: user, synthetic and system messages start it; an assistant
message with reasoning or a tool marks it; idle ends it. A tool-free answer after
tool work keeps the rule, which is the case it was for.

## About

About now has a proper **Close** button next to **Check for Updates**:

- Check for Updates is `btn-primary` (the action).
- Close is `btn-secondary`, Title Case, and closes Settings.
- Save and Revert stay hidden there; there is nothing to save.

## Notes

- Full suite: 252 tests.
- One asset: `Synapse-1.1.6-win-x64.zip` with `SHA256SUMS`, still the complete
  folder that is safe over an existing install.
