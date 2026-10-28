# TODO — things the operator asked to leave for later

Written down on 27 Oct so they are not lost, not designed yet. Each entry says
what was asked, why it is not a small change, and what has to be decided before
anyone builds it. None of these is a rule; the rules are in `AGENTS.md` and the
other notes.

## Replace a worker's session when its compaction no longer fits

The engine's compaction prompt is the whole message log, not the model's current
prompt. On 28 Oct a worker's 111k turn prompted a **225k summarise call on a 131k
model**, which failed ("Compaction produced no summary"); the turn retried and the
next compaction (at 112k) succeeded. A worker that compacts several times can
reach this again, and it is expensive rather than fatal.

Why it is not small: Synapse already knows how to discard a conversation and keep
a handover — that is what the project compact does. Doing it for a worker means a
new worker session, a brief, the handover and the task, and deciding what "enough
state to carry on" is when the engine's own summary is the thing that failed.

Decide first: whether the handover is the engine's compaction summary (when it has
one) or one Synapse writes; whether the worker keeps its tool/time budget; and
whether this fires after N compactions, when a compaction fails, or only when the
compaction prompt exceeds the window.
