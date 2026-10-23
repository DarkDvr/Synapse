---
name: code-craft
description: How to write code a reviewer will accept on the first pass - read the surrounding style, keep the surface small, fail loudly, and report what you actually ran. Use when building or changing code for a project.
---

# Code Craft

You are writing a small tool, script or app that a person will read, run and
judge. "It works on my one example" is the floor, not the bar. These are the
habits that separate code that gets accepted from code that comes back.

## Read before you write

- Read the task's `detail`, the design spec, and the **existing code** if there is
  any. Match its naming, formatting, error style and layout conventions. A file
  that switches style halfway is a file nobody can trust.
- If the project has no conventions yet, pick plain ones and keep them: the same
  quoting, the same spacing, the same way of reporting an error everywhere.
- Do not restructure what you were not asked to touch. A rename or a refactor
  nobody requested shows up as noise in the diff and invites a rejection.

## Keep the surface small

- One job per function. If you are writing "and" in the docstring, split it.
- **No speculative flexibility.** No config option nobody asked for, no plugin
  hook, no "base class for future backends". Build the thing the task names.
- Names say what the thing *is*, not how it is built: `parse_since_date`, not
  `util2`; `total_cost`, not `t`.
- Delete your own leftovers: no dead functions, no commented-out attempts, no
  `TODO` you are not reporting. If you leave something unfinished, say so in the
  report instead of hiding it in a comment.

## Fail loudly, at the edge

- Validate what comes from outside — argv, files, environment, user input — once,
  where it enters. Inside, trust your own data.
- An `except`/`catch` either handles the problem or re-raises with context. Never
  swallow silently: a bare `except: pass` turns a bug into a mystery.
- Error messages name the thing that failed and what the user can do:
  `cannot read input.csv: no such file` beats `error`.
- Exit codes mean something: 0 only when the job actually succeeded.

## Make the output reliable

- Deterministic ordering. If rows have ids, sort by them; do not rely on
  dict/insertion order you just happened to get.
- Align table columns for the actual data, and check the widest value — 10 and
  1000 in the same column is what breaks alignment.
- UTF-8 in, UTF-8 out. On Windows, watch line endings and paths with spaces.
- No trailing whitespace, no stray blank lines at the end, no debug prints left
  in the answer.

## Standard library first

- Prefer the standard library; do not add a dependency for something you can
  write in ten lines, and do not install anything.
- If a dependency is genuinely required, say so in the report *before* the
  Architect discovers it.

## Do not ship the platform

- A runtime, an SDK or a browser engine is a **system component**. Use the copy
  the machine has; do not bundle a second one beside the app unless the operator
  asked for a build that runs where it is missing.
- In practice: publish framework-dependent by default, and offer the
  self-contained build as the deliberate exception. A .NET window app is about
  1.5 MB that way and about 60 MB with the runtime inside — 140 MB once the
  un-bundled build output is counted too.
- Say which one you built, and what it needs on the target, in the report. "It
  runs here" is not the same sentence as "it runs on their PC".

## Prove it

- Run it. At least once with a real input, and once with the obvious bad input.
- If you claim a number, have the output that shows it. If you did not run it,
  say "not run" rather than implying you did — that is the difference between a
  report and a guess.
- A couple of real checks beat a test framework nobody asked for. If you do add
  tests, put them where the project keeps things and say where.

## Report what you did

The Architect judges the work from the disk and the output, not from your
enthusiasm. Name the files you wrote, the command you ran, and what it printed.
If something is incomplete or fragile, lead with it — a small honest caveat costs
one line, and hiding it costs a whole round.
