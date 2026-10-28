# TODO — things the operator asked to leave for later

Written down on 27 Oct so they are not lost, not designed yet. Each entry says
what was asked, why it is not a small change, and what has to be decided before
anyone builds it. None of these is a rule; the rules are in `AGENTS.md` and the
other notes.

## A better "working" background effect

The operator asked for a better background "working" effect on a project and a
session. Today "working" is carried by the yellow dot and the yellow rule on a
project row; there is no motion in the background at all.

Why it is not a small change: the rail is the one part of the UI that is always
on screen, and the palette rule says amber is semantic. A background effect has
to be quiet enough to read a name through, cheap enough to run while a model
streams, and it must stop dead when the work does — a pulse that keeps going
because a stale boolean says "working" is worse than none.

Decide first: what moves (a wash behind the row, the project's rule, the dot's
glow), how slow (anything faster than about 3 s reads as an alarm), and whether
`prefers-reduced-motion` gets a still version or nothing.

## Decide what the permission timeout answers

Built 28 Oct: the composer's cog holds two switches, and "Permission timeout"
allows an unanswered permission card **once** after 60 seconds. It records
`decidedBy: 'timeout'`, and an operator answer cancels the timer. It can only
answer `ask` verdicts — a harness write or a credential store is denied before a
card exists, so it cannot widen those walls. A session that was saved with the
flag on honours it at the next ask.

Still to decide: whether the default for an **outside write** should be Allow Once
(what it does now) or Reject, and whether the timeout should also answer questions
and forms — today a worker that asks a question still stops the run overnight.
Until that is decided, the timeout covers permission cards only, with Allow Once.

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
