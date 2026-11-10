# The suite, and the run on GitHub

`node --test "tests/*.test.mjs"` from the project root. 580 tests, one skipped by
design: `engine-contract.test.mjs` needs `SYNAPSE_E2E=1` and a live engine, so the
suite stays offline.

`.github/workflows/tests.yml` runs the same command on `windows-latest` for every
push to `main`, and by hand from the Actions tab. Windows because the app is: the
tests read Windows paths, drive Edge through `skills/visual-review` and read the
WPF project file. Node 24, and one step checks Edge is on the runner so a missing
browser is a sentence at the top instead of a failure fifteen minutes in.

## The one rule: a test may read only a file that travels in git

`config/synapse.config.json`, `data/`, `logs/` and `bin/` are gitignored — they are
this machine's answers, not the program. A test that opens one of them passes here
and fails on every runner, and it fails the ugliest way: an `ENOENT` at import time,
so the whole file reports as one broken test and the other 579 pass around it.

This has now happened three times:

- 6 Nov, one hour after CI existed: two tests that only passed on this machine
  (`1de459d` fixed them).
- 8 Nov, `548a6da` "the config stays home" took `config/synapse.config.json` out of
  git and added it to `.gitignore` — a good decision — while
  `provider-config.test.mjs` still read it to check the shipped DeepSeek provider.
  The file was on this machine, so the suite stayed green here, and **37 consecutive
  runs failed** over 32 hours on that one `ENOENT`, each sending the operator an
  email.
- 9 Nov, fixed: the test reads `config.default.json`, the seed every fresh install is
  made from. That is the file that ships, so it is the file "what we ship" may read.

The rule generalises: **removing a file from git is a two-place change**, and the
test that read it is the other place. When a commit un-tracks something, grep
`tests/` for its name in the same commit.

## Reading a red run

```
gh run list --limit 5
gh run view <id> --log-failed | Select-String 'ENOENT|not ok|✖ tests|ℹ fail'
```

Then reproduce it the way the runner sees it, which is faster than reading the log:

```
git worktree add $env:TEMP\synapse-ci HEAD
cd $env:TEMP\synapse-ci ; node --test "tests/*.test.mjs"
git worktree remove $env:TEMP\synapse-ci --force
```

A worktree is the CI checkout exactly: no `config/`, no `data/`, no `bin/`, no
`Synapse.exe`. Green here and red there has only ever meant one thing — a test is
reading something this machine happens to have.

Copy the **whole** change into it, not the file you were editing. A worktree
holding half a commit answers a question nobody asked: on 9 Nov it went green
because the new note was absent in both trees, and CI failed on the note the
commit actually added. Run `git status` first, and mirror every path it names.

## Emails

The operator is the repository owner, so GitHub mails every failed run of a watched
workflow. The setting is per user, not per repository: GitHub → Settings →
Notifications → Actions, or Watch → "Participate and @mentions" on the repository.
A red run is not made quieter by that; it is made quieter by being green.

## The suite leaves its temp folders behind (10 Nov)

`node --test "tests/*.test.mjs"` runs each file in its own process, and the files that build
a fixture with `fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-…'))` clean up in a `finally`
— unless the test throws before it, or the file never reaches the cleanup at all. Counted on
10 Nov: **15,638 folders, 61 MB** under `%TEMP%`, about 145 more per full run, with names
like `synapse-doc-*`, `synapse-perm-*`, `synapse-round-*`. That is clutter, not a fault in
the app, and it was cleared.

It is not fixed: the durable fix is one shared helper — `tmpdir(prefix)` that registers its
folder on a process-exit hook — and every test file using it instead of `mkdtempSync`. Worth
doing the next time this suite is touched; until then, a full run adds ~145 folders.
