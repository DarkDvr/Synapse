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

## Hide role cards that are not in use

On a full plan the role cards take a large share of the top of the session
view, and most of them are not doing anything. The operator asked for a way to
hide the cards of roles this session has not used.

Why it is not a small change: a card's presence is how the operator picks a
model for a role *before* the role has ever run, and `is-dim` already says "this
role has not taken part". Hiding is a stronger statement than dimming, and a
hidden card must not be the only way back to the picker.

Decide first: who hides them (an automatic rule from `planState.used`, or a
control the operator flips), where the hidden ones go (a count and a "show all"
line, or a fold), and whether the Architect can ever be hidden (it should not).

## A server-requested restart should reload the page

Found during the 27 Oct QC, not asked for. `/api/restart` (what Settings' save and
the console's Restart use) exits with code 2 and the shell starts the replacement
directly, without reporting Stopped; the window therefore keeps the page and the
JavaScript it loaded. The tray's Stop then Start does reload, because it passes
through Stopped (`MainWindow._needsReload`). A client change made in `web/` is
consequently not live after a server restart — the operator has to press Ctrl+R,
which is exactly the thing you forget after fixing a UI bug.

The fix is one line in `ServerHost.OnExited`, in the `ExitRestart` branch: report
Stopped before `Start()`, the way `RestartAsync` already does. It was not made in
the QC pass because it needs a rebuilt `Synapse.exe` to test and the running app
holds the current one; the doc (desktop-app.md §4) now states the limit instead.

## Overnight mode

The operator asked for an overnight mode built on Keep Building: work continues
without them, and either the Architect decides on its own what it would
otherwise ask, or a "Full Trust" override answers every permission request.

Why it is not a small change: this is the one feature that deliberately widens
`src/permissions.js`, and that file is the boundary between a model and the
machine. "Allow everything" for eight hours is a different product from "allow
everything for one request". The walls that must not move are in `AGENTS.md`
hard rule 8: writes inside the harness and credential stores stay refused, and a
policy change is where a zone changes, never a brief or a config flag.

Decide first: what the override covers (only `ask` verdicts in the project, or
the harness zone too — it must not), who can turn it on (the operator, never a
model), whether it lapses on time or on a run end, and what the UI says while it
is on. A button labelled "Full Trust" that quietly answers a credential read
would be the worst possible version of this.

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
