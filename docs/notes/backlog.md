# Backlog — worth discussing, not built

Ideas that survived a first look but were not taken in 1.59. Each says what it
would change and why it is not already done; nothing here is a promise.

## Project facts in the brief

Workers spend their first turns discovering what a project is: the language, the
package manager, the test command, the entry point. A small scanner could cache
that once per project (a `package.json`, a `pyproject.toml`, a `*.csproj`, the
first lines of a README) and put three lines at the top of every brief.

Not done because the Architect already writes the task detail, and a wrong guess
about the stack is worse than no line. It needs a detection pass that is honest
about "not sure", and a way for the operator to correct it.

## Batch reads

A policy-checked `read_files` (up to eight paths, line numbers, per-file cap) in
place of eight `read` calls. It would save turns on a worker reading a design
spec, a feature list and two reports.

Not done because it does not save context, only round trips, and the engine's
`read` already takes an offset and limit. It also bypasses the engine's gate, so
the tool would have to call `decide()` itself for every path.

## A fallback model for every role

The coder ladder exists; the other roles do not have one. If the Architect's
provider dies at 2am the run ends, even when another configured model could take
the same conversation. A per-role `fallback` would let the harness switch on a
terminal provider failure and tell the model what happened.

Not done because "the role's model" is the operator's choice, and switching it
changes which model is judged. It needs a rule for when to switch (a dead
provider, not a bad answer), what the Architect is told, and whether the
conversation carries.

## A verifier for the Architect's own edits

The checks/diff work covers a delegation. The Architect's own turn can still
edit a file with no second pair of eyes; QC is the next task, not the same one.
A read-only "what changed since your last message" line in the brief would make
its own changes visible.

Not done because the Architect is told not to build, and a line that reports its
edits could read as permission to make them.
