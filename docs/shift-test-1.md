# Shift Test 1 — findings

The second test project, built to answer one question: **is a small, clearly
scoped project cheap?** Clock Test 3 cost 56.4M prompt tokens for a clock; this is
a one-screen shift calculator where each role has one task. **It is finished** —
seven tasks, all done, the plan summarised.

## What it is

One page, offline, no dependencies. Log a shift (date optional, start, end, unpaid
break, rounding rule), see the paid hours, a running week total, export CSV.
Overnight shifts must work. Plan: 7 tasks, one per role.

## The numbers

| task | role | model | wall | turns | prompt tokens | compactions | peak ctx |
|---|---|---|---:|---:|---:|---:|---:|
| t1 | designer | hosted | 17m | 48 | 2.08M | 0 | 75k |
| t2 | coder-1 static shell | hosted | **59s** | 5 | 0.11M | 0 | 27k |
| t3 | coder-2 wiring + CSV | hosted | 20m | 34 | 1.13M | 0 | 61k |
| t4 | coder-3 node tests | **local** | 13m | 32 | 0.54M | 3 | 25k |
| t5 | hacker | **local** | 22m | 38 | 0.60M | 7 | 25k |
| t6 | coder-2 fix | **local** | **79s** | 6 | 0.08M | 0 | 16k |
| t7 | coder-3 verify | **local** | 12m | 21 | 0.30M | 4 | 27k |
| | architect (79 turns) | both | | | 1.0M | 2 | |
| | **project** | | **86m of work** | 184 | **6M** | | |

Clock Test 3, for comparison: **56.4M** prompt tokens for a clock, contexts
130–276k, and 50.3M of it in the workers. This project: **6M**, contexts ≤75k.

The artefacts are smaller in the same proportion: `design.md` is **93 lines / 9 KB**
(the clock's was 602 lines / 57 KB), one mock instead of four, and the whole tool is
33 KB of HTML/CSS/JS.

## What moved the number

- The brief now says what a turn costs ("every turn re-sends this conversation,
  your reasoning included") and asks for a sentence of thinking, not a page.
- Read a file once, search it after; edit rather than rewrite (a `write` carries
  the whole file body).
- The designer has a spec size: under ~200 lines.
- The Architect writes tasks with a named file and a proving command, and at most
  two reads. The static-shell task took **59 seconds and 5 turns** because the
  spec, the mock and the file names left nothing to explore.

## What the local model did (qwen3.8-27b-ud, 39k window, IQ3_S)

- **41 node tests** for the shift maths, all passing: parsing and validation,
  overnight, rounding half-up, break-before-rounding, CSV escaping, empty week.
- **A hack pass** that ran 21 jsdom probes against the real page, found **one
  nice-to-have** (the error message does not say that "9:00" needs a leading
  zero), wrote a one-line coverage note for every area, cited the design line it
  was judging, and listed its own limitations. It traced the wording back to
  design.md line 93 and called it a spec choice rather than a build defect.
- **A fix that changed nothing** — correctly: the finding was spec-level, so the
  coder verified the behaviour matched the spec and said so instead of editing
  files to look busy.
- **A verification pass** with a pass/fail table and evidence, and the suite green.
- The Architect role, too: it recovered from a failed edit by re-reading the file
  and retrying, judged each report, and wrote the closing summary.

## Does the tool work?

Tested by hand in a browser:

| input | result |
|---|---|
| 09:00–17:30, 30 min break | **8.00 h**, and it shows the arithmetic |
| 22:00–06:00 | **8.00 h** — overnight correct |
| 09:00–17:32, round to 5 | **8.50 h** — "512 min; nearest 5 = 510 min" |
| 8 h shift, 600 min break | refused: "Break must be shorter than the shift" |

"Clear week" calls `window.confirm`, which blocks a headless page — correct
behaviour, but it looks like a hang to an automated test.

## What is still wrong

- **The wall clock was the provider, not the harness.** t1 and t3 spent most of
  their time on `429 Rate limit exceeded` retries; the work itself was minutes.
  The local model has no rate limit at all, which is the whole difference.
- **A 39k window churns.** The engine compacts at ~60% of it, so the hacker took
  **7 compactions in 38 turns** and the verifier 4. Each one is a summary and a
  moment of re-orientation. Small tasks are fine; bigger ones would churn.
- **The Architect told a coder to write in the Hacker's folder**
  (`.synapse/reports/verify-1.md`), which the file rules refuse and the harness
  reported as a stray write. The brief now says a worker's report goes in its own
  folder or in the task's result.
- The Architect's turn after t3 died on a 429 *after* it had already called
  `delegate t4` — and Synapse started t4 anyway, because requests are read from the
  transcript rather than from a live turn. That part worked as designed.
- The plan held at seven tasks this time. (Clock Test 3's grew 10 → 13.)
