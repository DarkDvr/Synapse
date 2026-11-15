# Git in a project, and the private Git

Git is how a run's change is known. A worker's report is a claim; the tree before
the delegation and the tree after it are the evidence, and the patch between them
is what the Architect can read.

## Who does what

- **The harness** initialises the repository (once, after a project's first
  successful turn), reads the tree, writes the diff, and keeps checkpoints. It
  never commits a project, never pushes, never moves HEAD, and never edits a
  project's `.git/config`.
- **A model** may use git to inspect its work: `git status`, `git diff`, `git log`.
  It does not commit or push unless the task or the operator asks for it. A commit
  is a judgement about what the work is; that belongs to the operator.
- **The operator** owns the history. The harness's diff is a record beside it, not
  a commit in it.

## What a run records

Before the worker starts, `treeOf()` builds a tree object from the folder as it
stands: a temporary index inside `.synapse/cache`, `read-tree HEAD`, `add -A`,
`write-tree`. The real index and HEAD are untouched, and the temporary index is
deleted. After the run, the same call gives the new tree; `changeSince()` diffs the
two and writes:

```
<project>\.synapse\reports\diffs\<task>-<stamp>.diff
```

The report then carries one line — `Changed: 3 files, +42 −7 — the diff is …` — and
the run ledger keeps the same numbers. `.synapse` is excluded from both trees: the
harness's own state is not the worker's change. Ignored files are excluded too,
because the project's `.gitignore` is the project's answer about what is source and
what is build output.

A binary file is counted, not patched. A patch over 400 KB is cut and says so. A
folder with no repository, or a machine with no Git, simply has no diff; the report
says nothing about a change rather than guessing one.

## The private Git

A new PC may have no Git. On first launch `ensureGit()` looks for one (the vendored
copy, `SYNAPSE_GIT`, then `git.exe` on PATH). If there is none it downloads
**MinGit 2.56.1** from the official Git for Windows release, verifies the pinned
SHA-256, and unpacks it into `bin\git` — about 40 MB, inside this folder, with
nothing installed machine-wide, no PATH edit outside the app, and no registry
write. Deleting `bin\git` undoes it.

The engine's shells get `bin\git\cmd` on their PATH, so a worker's `git status`
works on a machine that never installed Git. The harness's own calls use the
executable directly and their own config (`GIT_CONFIG_NOSYSTEM`, an empty global
config under `data\git`), so the operator's `~/.gitconfig` is never read for a
harness decision and never written.

If the download fails (offline, proxy, a changed upstream), the app still starts:
one warning, diffs and checkpoints off until the next launch. It is a runtime like
Node and the engine, not a prerequisite.

## What it deliberately does not do

- **No commit, no checkout, no reset.** A diff and a checkpoint need no HEAD move.
- **No hooks.** The harness's operations do not run a project's hooks.
- **No operation outside the project.** Every command runs with the project as its
  working directory and every artefact is written inside it.
- **No history rewriting.** A project's commits are the operator's; the harness
  never amends, rebases or force-pushes.
