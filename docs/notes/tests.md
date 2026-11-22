# The suite, and the run on GitHub

`node --test "tests/*.test.mjs"` from the project root. Every test runs offline
except `engine-contract.test.mjs`, which needs `SYNAPSE_E2E=1` and a live engine.

On this machine, run it through `bin\node\node.exe scripts\checks.mjs`. The script
turns Auto-Shutdown off for every project first and **leaves it off**: an idle app
plus a test run is exactly what the auto-shutdown tick waits for, and it powered the
PC off under the suite on 11 and 15 Nov. Only the Synapse window may turn it back on.

`.github/workflows/tests.yml` runs the same command on `windows-latest` for every
push to `main`, and by hand from the Actions tab. Windows because the app is: the
tests read Windows paths, drive Edge through `skills/visual-review` and read the WPF
project file. Node 24, and one step checks Edge is on the runner so a missing browser
is a sentence at the top instead of a failure fifteen minutes in.

## The one rule: a test may read only a file that travels in git

`config/synapse.config.json`, `data/`, `logs/` and `bin/` are gitignored — this
machine's answers, not the program. A test that opens one passes here and fails on
every runner, and it fails the ugliest way: an `ENOENT` at import time, so the whole
file reports as one broken test while the rest pass around it.

This has happened three times, twice on the same file: a config test reading
`config/synapse.config.json` failed 37 consecutive runs over 32 hours after the file
left git (8–9 Nov). The fix was to read `config.default.json`, the seed every fresh
install is made from — the file that ships is the file "what we ship" may read.

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

Copy the **whole** change into it, not the file you were editing. A worktree holding
half a commit answers a question nobody asked: on 9 Nov it went green because the new
note was absent in both trees, while CI failed on the note the commit actually added.
Run `git status` first, and mirror every path it names.

GitHub mails the owner every failed run of a watched workflow. A red run is not made
quieter by a setting; it is made quieter by being green.

## Fixtures

Every fixture folder goes through **`tmpdir(prefix)`** in `tests/tmpdir.mjs`: it makes
the folder, remembers it, and a `process.on('exit')` hook empties it. Before that a
full run left about 145 folders in `%TEMP%` (15,638 by 10 Nov), because a file that
throws never reaches its own `finally`.

Measured after the change: a full run adds **0** folders. Two honest limits: a
process killed outright never reaches the hook, and the hook must be synchronous —
Node runs no async work on `exit`. `tests/tmpdir.test.mjs` proves the case that
matters.
