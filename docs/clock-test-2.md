# Clock Test 2 — results

The first full project Synapse built end to end. It shipped, and it is the run the
current briefs and the per-run reporting were rewritten around.

**Clock test 1 is not part of this.** It never finished: the plan stopped at `t4`
(`t1`–`t3` done, `t4` never ran), so there was no build to judge. Its results are
void and irrelevant — nothing here is derived from it, and any number in an old
note that came from it should be discarded.

## What was asked

> I want a clock I can leave open on my second monitor while I work — something I'd
> actually enjoy looking at. Surprise me with what it does.

Four features survived the operator's gate: breathing type, sky from the real solar
position, a light-left line, a minute sweep. Nine tasks: invent, design, two
builders, three hack rounds, two fix rounds, a final check.

## What it delivered

`bin/` — 0.4 MB, offline, no network at runtime, fonts bundled. It reproduces the
approved mock, and **30/30 solar + 46/46 browser tests** pass. Renders correctly at
1920×1080 from `file://`, including the live clock and the sunrise line.

## The numbers

| | |
|---|---|
| Wall clock, first worker → last | **2h 50m** (plus 59 min of planning and the feature gate) |
| Worker time / architect time between runs | 152m 27s / 18m 09s |
| Tasks / retries / resumes / failures | 9 / 0 / 0 / 0 |
| Tokens written | 727k, **70% of it thinking** |
| Time in tools | 41m (13%) — the rest was generation |

| Role | Time | Share |
|---|---:|---:|
| Hacker (3 rounds) | 76m 39s | **50.3%** |
| Coders (4 tasks) | 46m 57s | 30.8% |
| Designer | 27m 27s | 18.0% |
| Inventor | 1m 22s | 0.9% |

## What the audit found

- **The Hacker earned half its cost, not all of it.** Round 1 (38m) found nine
  issues: one major, five minor, three nice-to-have — and the major was only
  reachable above ~60° latitude, not on the operator's path. Round 2 (32m) verified
  those nine and then opened a *new* matrix for two off-path edges. Round 3 (6m)
  re-ran the repros and the suites and stamped SHIP — the same job shape as round 2
  in a fifth of the time, because it was written as a check.
- **Context, not tool work, is the cost.** Long tasks finished at 212–290k tokens.
  Throughput by prompt size: 157 tok/s under 50k, 145 at 50–100k, 117 at 100–150k,
  **68 at 150–200k**. The Hacker hit 290k and auto-compacted.
- **Most of that prompt is machinery.** Measured on the 212k coder: thinking 43%,
  tool results 30%, tool call arguments 19% (whole file bodies on every `write`),
  screenshots 4%, instructions 3%, the actual conversation ~1%.
- **84% of turns issued exactly one tool call**; the two suites were run 30 times
  across the run.
- **The designer spent 27 minutes** on a spec and four 340 KB mocks, re-reading 23
  screenshots back into its own context.
- **The plan grew from 2 tasks to 9 while the Architect worked**, so the plan the
  operator approved on the first screen was not the plan that ran.
- **Noise:** 11 watchdog alarms for the Architect running the visual-review skill,
  6 "task has a result but its status is todo" warnings inside the Architect's own
  two-step write, and 1 "harness changed during a run" — which was the operator
  saving Settings.

## What changed in Synapse because of it

- **The plan is written in full before the first task**, a declared phase with no
  task under it is named, and "finished" means every phase is covered.
- **A re-hack is a verification pass**, not a second hunt; a third round only if
  the verification changed code.
- **Build tasks are split** at ~40 turns or one subsystem, and the Hacker's default
  focus is ordinary use rather than extremes.
- **Designer: two mocks, states behind one switch.**
- **Every run reports its cost** — turns, tokens written, share of thinking, peak
  context — in the chat, the app log and `runs.jsonl`.
- **The plan pane shows the plan, not the plan's homework**; the validator's notes
  go to the Architect and the log.
- **Harness alarms judge what a shell does**: running a skill is silent, naming the
  rest of the harness still alarms, and Synapse's own config save is excused.
- **A window watchdog** compacts only when a *known* context window is about to be
  reached — never at a fixed 200k.

Commits: `2ca726c` (plan, re-hack, effort line), `c03c4bf` (two mocks), `28c4763`
(universal briefs, skills, window sizes), and the watchdog + this document.

## What we expect next time

- The same delivery, in **about 2h instead of 2h50m**: hack round 2 should take
  ~10 minutes instead of 32, the designer ~15 instead of 27.
- Every worker under ~120k context, so turns stay above ~110 tok/s and no
  compaction is needed.
- A plan the operator can read end to end before anything runs, and no unannounced
  tasks.
- A clean console: no red alarms for the tools doing their job, no yellow notes in
  the plan pane.
- One line per run telling us what it cost, so the next audit needs the chat, not
  the engine's database.

Still engine-side and not fixed here: thinking stays in the transcript, stale tool
results stay in the prompt, and a 100-turn task still slows down as it goes. The
levers Synapse has are task size and batching, and it now reports both.
