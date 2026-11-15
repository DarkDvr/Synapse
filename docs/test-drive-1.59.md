# Test drive for 1.59 — checks, the diff, rollback, and a process

A throwaway project that exercises all four on a real run. It uses only Node, no
installs and no network, and it is small enough for a local model.

**Set up:** new project, **Multi** mode, **Keep Building off** (so you move one
task at a time and can see each report). Pick any models; a cheap coder is fine.

## What to watch

| after | look for |
|---|---|
| t1 | `Changed: …` and `Checks: 1 command passed` in the report; a patch under `.project/reports/diffs/`; `git status` in the project shows `bin\` files but **not** `.project/` |
| t2 | the report opens *“finished, but its check fails”*, says *“Rollback point kept”*, and has a log under `.project/reports/checks/`; then the restore removes `bin/rolled-back.txt` |
| t3 | a tool card for `synapse-process_process` with `start`, then `logs`, then `stop`; `.project/processes/p1.log` says `serving on 8123` |
| t4 | a second diff and a passing check; the page has the new heading and footer |

## The prompt

Paste this into the project chat. It asks the Architect to write four rows and run
only the first one.

```text
This is a throwaway test of the harness itself. Work in this project in Multi mode,
one task at a time. Use only Node and the tools you have: no installs, no network,
no external assets.

Write the Project Plan as exactly these four rows, then delegate t1 and stop.

t1 — Build the page
detail: Create bin/index.html: a page whose title and h1 are "Harness Test 1.59",
a paragraph "The page works.", and a button labelled "Count" that increments a
number beside it. Keep all CSS and JS inline. Also create bin/check.mjs: it reads
bin/index.html and exits 0 only if the file contains "Harness Test 1.59", the
button text "Count", and "addEventListener"; otherwise it prints one sentence
naming what is missing and exits 1. No dependencies.
checks: ["node bin/check.mjs"]

t2 — The deliberate failure
detail: Create bin/rolled-back.txt containing "this file should disappear after
the restore". The check below is expected to fail. Do not try to make it pass,
do not change or remove the file, and do not ask a question about it: write the
file, say in your report that this is the deliberate failure, and finish.
checks: ["node -e \"process.exit(1)\""]

t3 — Serve it
detail: Create bin/serve.mjs: a Node http server that serves bin/index.html on
port 8123 and prints "serving on 8123" when it is listening. Use the process tool
to start it with the command "node bin/serve.mjs", read its log with action
"logs", then stop it with action "stop". Report the log line you saw.
checks: ["node bin/check.mjs"]

t4 — Verify the page
detail: Change the h1 to "Harness Test 1.59 — verified" and add a footer
"Built by Synapse." Update bin/check.mjs so it also requires that footer.
checks: ["node bin/check.mjs"]

When a report arrives, stop and wait for me. Do not repair t2; I will tell you
when to use the restore tool on it.
```

Then:

1. **t1** — say `continue` after its report. You should see the check pass and a
   diff with the files it created.
2. **t2** — say `continue`. It will fail its check, be sent back once, fail again,
   and the report will say so. Then say:
   `Use synapse-git_restore on t2 now. Do not fix t2. Then stop.`
   `bin/rolled-back.txt` should be gone and the tool should say what it restored.
3. **t3** — say `continue`. The worker starts the server, reads the log and stops
   it. If port 8123 is busy, tell the Architect to use 8124 in both the task and
   the tool call.
4. **t4** — say `continue`. The second diff should show the heading, the footer and
   the check script.

If a step does not look like this, that is the point: note the task id, what the
report said, and the file under `.project/reports/` that should have been there.
