# Git in a project, and the private Git

Git is how a run's change is known. A worker's report is a claim; the tree before
the delegation and the tree after it are the evidence, and the patch between them
is what the Architect can read.

## Who does what

- **The harness** initialises the project's repository (once per loaded project, at boot;
  and again for a folder first seen later), reads the tree, writes the diff, and keeps
  checkpoints. It never commits **the project**, never pushes, never moves HEAD, and never
  edits a project's `.git/config`. Since 20 Nov it does commit **the records**, in a
  repository of their own (see below).
- **A model** may use git to inspect its work: `git status`, `git diff`, `git log`. It
  does not commit or push unless the task or the operator asks for it. A commit is a
  judgement about what the work is; that belongs to the operator.
- **The operator** owns the history. The harness's diff is a record beside it, not
  a commit in it.

## The records repository (20 Nov)

`.project` gets its **own** repository — `git init` inside `.project`, nested, invisible
to the project's repo (the harness already excludes `.project/` there) and never pushed. It
exists because the records were the one thing with no history: the design sheet, the
mocks, the plan and the reports are outside the project's tree and outside its
`.gitignore`, so a worker that "updated" a mock destroyed the previous bytes, and the
Architect reviewed a file whose name it trusted (20 Nov: the sheet named `mock-4.html`, the
coder wired `mock-2.html`, and the newest was neither).

- **The harness commits; no model has to remember.** Before and after every worker run,
  and before an Architect turn, `commitVcs()` commits if the tree is dirty — an empty
  commit is never made. The identity is `Synapse <synapse@local>`, per command, so the
  operator's config is never read or written.
- **The label reads without a rule:** `2026-11-20 03:12 t3#2 before` — date, task, attempt
  (the redo ladder's count), event. The commit sha is what makes a commit unique; the
  message is for the reader.
- **What is versioned:** `plan.json`, `design/`, `ideas/`, `qc_findings/`, `reports/*` and
  `project.md`. What is not: `scratch/`, `shots/`, `attachments/`, `reports/diffs/`,
  `runs.jsonl`, `cache/` and `*.log` — debris, binaries and the harness's own ledger.
- **Retention:** the newest 80 commits, pruned at 100 by rewriting *this* branch
  (`commit-tree` re-creates the kept commits; the working tree is never touched). A
  rewrite is safe here because the repository is ours — the rule against rewriting the
  operator's history stands.
- **The models are told, once, in the header** every session starts with: an earlier
  version is `git -C .project log -- <file>` and `show <rev>:<file>`; update the file
  instead of keeping a copy. The policy judges the read-only subcommands (`log`, `show`,
  `diff`, …) as reads; anything that can write still asks.
- **The report warns when the sheet and the run disagree:** `designMismatch()` compares
  the run's changed design files with the names in `design.md` and adds one `Warning:`
  line. It is the review instruction the incident needed, and it is silent when the two
  agree.


## What a run records

Before the worker starts, `treeOf()` builds a tree object from the folder as it
stands: a temporary index inside `.project/cache`, `read-tree HEAD`, `add -A`,
`write-tree`. The real index and HEAD are untouched, and the temporary index is
deleted. After the run, the same call gives the new tree; `changeSince()` diffs the
two and writes:

```
<project>\.project\reports\diffs\<task>-<stamp>.diff
```

The report then carries one line — `Changed: 3 files, +42 −7 — the diff is …` — and
the run ledger keeps the same numbers. `.project` is excluded from both trees: the
harness's own state is not the worker's change. Ignored files are excluded too,
because the project's `.gitignore` is the project's answer about what is source and
what is build output.

A binary file is counted, not patched. A patch over 400 KB is cut and says so. A
folder with no repository, or a machine with no Git, simply has no diff; the report
says nothing about a change rather than guessing one.

## Checkpoints and restore

The same tree that anchors the diff is also a rollback point. Before a delegation
starts, `createCheckpoint()` writes it into a commit (no parent, no HEAD move) and
puts a ref under `refs/synapse/` inside the project. A new run replaces the older
ref: only one rollback point per project can ever be the newest.

- **A clean run drops its point.** The work was wanted; the ref and its commit go.
- **A failed, stopped or unproven run keeps it.** The report says *Rollback point
  kept*, and the Architect can call the `synapse-git_restore` tool with the task
  id. The tool refuses while a delegation is live, refuses any task that is not
  the newest result, and consumes the ref when it succeeds.
- **A restore writes the checkpoint's files back and removes files that arrived
  after it.** `.project` was never in the tree, so the plan and the evidence are
  untouched. The real index is not rewritten; the operator's `git status` shows
  the restore as a working-tree change.
- **One restore, one task.** The plan row is not edited: the Architect judges it
  again with the work back where it started.

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

- **No commit, no checkout, no reset — in the operator's repository.** A diff and a
  checkpoint need no HEAD move. (The records repository is a different thing, and the
  harness owns it; see above.)
- **No hooks.** The harness's operations do not run a project's hooks.
- **No operation outside the project.** Every command runs with the project as its
  working directory and every artefact is written inside it.
- **No history rewriting — of the operator's.** A project's commits are the operator's;
  the harness never amends, rebases or force-pushes them. Its own records history is
  pruned to 80 commits, and that is the one branch it may rewrite.
