# Synapse v1.3.9

Changing a role's model now ends the wait it is stuck in, and naming a coder in
your request now means that coder runs the task.

## Fixed

- **A model change wakes the run that is waiting on the old one.** A role asleep in
  a provider backoff — a usage cap, a rate limit, a refused model — was waiting on
  a clock that the operator had just made irrelevant; the ten-minute cap grace ran
  to the end even after the model was fixed. Saving a new model for a role now:
  - ends that wait immediately,
  - moves the role's live session to the new model (the ref **and** its variant),
  - nudges it to carry on, and
  - starts the backoff short again, because the failing model is gone.

  It is a wake, not a stop: the turn is not interrupted, and a role with no run
  waiting is untouched.
- **Your explicit coder wins over the ladder.** "Tell coder 2 to build it" used to
  be silently rewritten to coder-1, because the brief said every build task is
  written for coder-1 and the plan check warned about coder-2/3. A row the operator
  asked for carries `origin: "operator"`: the brief now tells the Architect to use
  the coder you named, mark the row and say so in its reply, and the plan check
  accepts it. The rule that the Architect picks coder-1 itself is unchanged — and
  so is the invariant that a task's role is its **first rung**, with the ladder
  only moving down (a coder-2 task falls to coder-3, never back to coder-1).

## Notes

- Full suite: 285 tests, including a run woken out of a 60-second backoff and a
  task written for coder-2 that starts there.
