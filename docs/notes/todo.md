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
