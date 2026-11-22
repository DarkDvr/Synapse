# Git in a project, and the private Git

A worker's report is a claim; the tree before the delegation and the tree after it
are the evidence, and the patch between them is what the Architect can read.

## Who does what

- **The harness** initialises the project's repository (once per loaded project at
  boot, and for a folder first seen later), reads the tree, writes the diff, and
  keeps checkpoints. It never commits **the project**, never pushes, never moves
  HEAD, and never edits a project's `.git/config`. It does commit **the records**, in
  a repository of their own (below).
- **A model** may use git to inspect its work: `status`, `diff`, `log`. It does not
  commit or push unless the task or the operator asks.
- **The operator** owns the history. The harness's diff is a record beside it.

## The records repository

`.project` gets its **own** repository — nested, invisible to the project's repo (the
harness excludes `.project/`) and never pushed. It exists because the records had no
history: a worker that "updated" a mock destroyed the previous bytes, and the
Architect reviewed a file whose name it trusted (20 Nov: the sheet named `mock-4.html`,
the coder wired `mock-2.html`, and the newest was neither).

- **The harness commits; no model has to remember.** Before and after every worker
  run, and before an Architect turn, `commitVcs()` commits if the tree is dirty — an
  empty commit is never made. The identity is `Synapse <synapse@local>`, per command,
  so the operator's config is never read or written.
- **The label reads without a rule:** `2026-11-20 03:12 t3#2 before` — date, task,
  attempt (the ladder's count), event.
- **What is versioned:** `plan.json`, `design/`, `ideas/`, `qc_findings/`, `reports/*`,
  `project.md`. What is not: `scratch/`, `shots/`, `attachments/`, `reports/diffs/`,
  `runs.jsonl`, `cache/`, `*.log`.
- **Retention:** the newest 80 commits, pruned at 100 by rewriting *this* branch. Safe
  here because the repository is ours; the rule against rewriting the operator's
  history stands.
- **The models are told where history is,** once, in the header every session starts
  with: `git -C .project log -- <file>` and `show <rev>:<file>`. The policy judges the
  read-only subcommands as reads; anything that can write still asks.

## What a run records

Before the worker starts, `treeOf()` builds a tree object from the folder as it
stands: a temporary index inside `.project/cache`, `read-tree HEAD`, `add -A`,
`write-tree`. The real index and HEAD are untouched. After the run the same call
gives the new tree; `changeSince()` writes the diff to
`.project\reports\diffs\<task>-<stamp>.diff`, and the report says `Changed: 3 files,
+42 −7`. `.project` is excluded from both trees, and so are ignored files: the
project's `.gitignore` is its answer about what is source.

A binary file is counted, not patched. A patch over 400 KB is cut and says so. With
no repository, or no Git, there is simply no diff — the report says nothing rather
than guessing.

## Checkpoints and restore

The same tree that anchors the diff is a rollback point. Before a delegation,
`createCheckpoint()` writes it into a commit (no parent, no HEAD move) and puts a ref
under `refs/synapse/`. A new run replaces the older ref: one rollback point per
project is the newest.

- **A clean run drops its point.** A failed, stopped or unproven run keeps it, and
  the report says *Rollback point kept*.
- **`synapse-git_restore`** takes the task id. It refuses while a delegation is live,
  refuses any task that is not the newest result, and consumes the ref when it
  succeeds.
- **A restore writes the checkpoint's files back and removes files that arrived
  after it.** The real index is not rewritten, so the operator's `git status` shows
  the restore as a working-tree change.
- **One restore, one task.** The plan row is not edited; the Architect judges it
  again with the work back where it started.

## The private Git

A new PC may have no Git. `ensureGit()` looks for one (the vendored copy,
`SYNAPSE_GIT`, then `git.exe` on PATH). If there is none it downloads **MinGit
2.56.1**, verifies the pinned SHA-256 and unpacks it into `bin\git` — about 40 MB,
inside this folder, nothing installed machine-wide, no PATH edit outside the app, no
registry write. Deleting `bin\git` undoes it.

The engine's shells get `bin\git\cmd` on their PATH. The harness's own calls use the
executable directly and their own config (`GIT_CONFIG_NOSYSTEM`, an empty global
config under `data\git`), so the operator's `~/.gitconfig` is never read or written.

A failed download is one warning; diffs and checkpoints are off until the next
launch. It is a runtime like Node and the engine, not a prerequisite.

## What it deliberately does not do

- **No commit, checkout or reset in the operator's repository.** A diff and a
  checkpoint need no HEAD move.
- **No hooks.**
- **No operation outside the project.**
- **No history rewriting — of the operator's.** Its own records history is pruned to
  80 commits, and that is the one branch it may rewrite.
