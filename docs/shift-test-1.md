# Shift Test 1 — findings so far

The second test project, built to answer one question: **is a small, clearly
scoped project cheap?** Clock Test 3 cost 56.4M prompt tokens for a clock; this is
a one-screen shift calculator where each role has one task. The run is **not
finished** — t1–t3 are done, t4 (node tests) was interrupted by a restart and the
provider's rate limits. The cost numbers below are for the three finished tasks.

## What it is

One page, offline, no dependencies. Log a shift (date optional, start, end, unpaid
break, rounding rule), see the paid hours, a running week total, export CSV.
Overnight shifts must work. Plan: 7 tasks, one per role.

## The numbers

| task | role | wall | turns | peak ctx | prompt tokens | thinking |
|---|---|---:|---:|---:|---:|---:|
| t1 | designer | 17m (6 retries) | 42 | 75k | **2.08M** | 61% |
| t2 | coder-1 static shell | **59s** | **5** | 27k | **0.11M** | 28% |
| t3 | coder-2 wiring + CSV | 20m (7 retries) | 27 | 61k | **1.13M** | 55% |
| | **total, 3 tasks** | | 74 | ≤75k | **3.32M** | |

Clock Test 3, for comparison: 50.3M prompt tokens across eight tasks, contexts
130–276k. **Per task: 6.3M → 1.1M**, and no context above 75k.

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

- **Wall clock is the provider, not the harness.** 6 and 7 retries on t1/t3, all
  `429 Rate limit exceeded`; the work itself was minutes. t4 was mid-retry when the
  run was stopped.
- The Architect's turn after t3 died on a 429 *after* it had already called
  `delegate t4` — and Synapse started t4 anyway, because requests are read from the
  transcript rather than from a live turn. That part worked as designed.
- The plan still grew during the build (t5b/t6b/t6c in Clock Test 3); here it has
  held at seven tasks so far.

## Next

t4 tests → t5 hack → t6 fix → t7 verify. With the local model wired in
(`bionic/qwen3.8-27b-ud`), the 429s should be gone and the wall clock should finally
reflect the work.
