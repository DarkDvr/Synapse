# The pipeline: roles, files, and eyes

Agreed with the operator, 19 Oct 2026. This is the implementation plan: what is
locked, in what order it gets built, and what "done" means for each stage. It
lives in the repo so it survives the session; AGENTS.md gets the durable lessons
as each stage lands.

---

## 1. Decisions (locked, do not re-litigate)

| Decision | Answer |
|---|---|
| Roles | `architect`, `inventor`, `designer`, `hacker`, `coder-1/2/3`. `auditor` and `critic` are retired. |
| Pipeline | A **menu**, not a checklist. The Architect picks the phases by project size and records them in the plan. |
| Operator gates | Two: **features** (which of these?) and **design** (open this mock, which one?). |
| `features.json` | A **linted contract**: every confirmed feature maps to a task; rejected ones are kept but never briefed downstream. |
| File ownership | **Writes** enforced by per-session permission rules. **Read**-denial on `ideas/` is tested and adopted only if the engine honours it. |
| Hack rounds | **Three**, then stop and report to the operator. A fourth hack task is refused. |
| Keep building | **ON** is the normal mode for a pipeline run — the two gates are the control. The flag remains the safety net for unattended runs. |
| Eyes | A **skill**, not a harness feature: render with the machine's own browser, read the PNG. Never claim sight we do not have. |

---

## 2. The pipeline

```
invent ──► [gate: which features?] ──► design ──► [gate: open the mock]
        ──► build the shell (no wiring) ──► wire it
        ──► hack ──► fix by id ──► re-hack  (×3, then report)
```

| # | Role | Reads | Writes |
|---|---|---|---|
| 1 | Inventor | requirement | `.synapse/ideas/ideas-1.md` — ranked `I1…In`, each with *why* and effort |
| 2 | Architect | ideas | asks the operator, then `.synapse/features.json` |
| 3 | Designer | requirement + confirmed features + pinned stack | `.synapse/design/design.md` (spec) + `mock-1.html…` |
| 4 | Architect | design folder | conformance notes, gap questions to the Designer |
| 5 | Coder | features + design spec + mocks | `bin/` — the shell, **no wiring** |
| 6 | Coder | + wiring brief | the working app |
| 7 | Hacker | requirement + features + design spec + `bin/` | `.synapse/reports/hack-1.md` — `H1…Hn`, severity, exact repro |
| 8 | Coder | *only the H-ids* | fixes |
| 9 | Hacker | the previous repro list | `hack-2.md` — fixed / still reproduces / newly broken |

The two load-bearing ideas: **"build it verbatim, no wiring"** separates *does it
look right* from *does it work*; **re-running the old repros** is the only
mechanical answer to "did the fix break something else".

The Architect is blind to pixels. `design.md` carries a **spec table** (screens,
controls, tokens, per-theme values) so the Architect checks something checkable,
and the operator is the eye at the design gate.

---

## 3. The file contract

```
<project>/
  bin/                     the app (what ships)
  .synapse/
    requirement.md         harness   · operator's words, verbatim, append-only
    plan.json              architect
    features.json          architect · F1…, confirmed + rejected
    ideas/ideas-1.md       inventor  · I1…, ranked, with why + effort
    design/design.md       designer  · spec + checklist
    design/mock-1.html     designer  · self-contained, openable
    design/shots/*.png     whoever ran visual-review
    reports/hack-1.md      hacker    · H1…, severity, exact repro
    runs.jsonl             harness
```

Owner matrix (write) — enforced by the ruleset, not just asked:

| file | writer | readers |
|---|---|---|
| `requirement.md` | harness | everyone |
| `plan.json` | architect | everyone (read-only) |
| `features.json` | architect | designer, coders, hacker |
| `ideas/**` | inventor | **architect only** |
| `design/**` | designer | architect, coders, hacker |
| `reports/**` | hacker | architect, coders |
| `bin/**` | coders | everyone |

Rules appended to every worker session:
`allow *` → `deny .synapse/**` → `allow .synapse/<own area>/**` (last match wins).

**Briefs are composed by the harness from files.** A task carries `reads: [...]`
and `ids: [...]`; the harness renders the requirement (verbatim), the confirmed
features, and the referenced files into the brief. The Architect composes
pointers, never paraphrases.

**IDs are the memory.** `I4` rejected, `F2` confirmed, `H7` still reproduces.

---

## 4. Skills

- **Install** is global (`engine.opencode.skillPaths`) — one path for all sessions.
- **Declare**: `roles.<id>.skills: [...]` in config; the brief renders
  *"Skills you may use: …"*. Advisory, but it is what the model reads.
- **Enforce**: a per-session permission rule, *if* the engine can target a skill
  by name (probe C). If it cannot, ship the declare layer and say so.
- **UI**: the ✎ button on each role card opens the picker (skills + instructions),
  closing the open "per-role instructions" item.

### `visual-review` (in `%USERPROFILE%\.agents\skills\visual-review`)

```
SKILL.md        when to use it, and the honesty rules
bin/shot.mjs    render a path or URL at 1–2 widths, temp profile, print the paths
```

- Renders with the machine's Edge/Chrome, `--headless=new`, its **own**
  `--user-data-dir` so the operator's browser is never touched.
- Screenshots land in the *project* (`.synapse/design/shots/`), so what the agent
  looked at is an artifact the operator can open.
- Two widths max: an image costs ~1k tokens; five is a budget leak.
- Honesty rules: name measurable things, say what a still cannot tell you, never
  claim a judgement the picture does not support.
- Degrades explicitly: no browser → structural review of HTML/CSS, and its output
  says so.

Serves the Designer (own mocks), the Architect (before the gate), the Hacker
(regressions between rounds).

---

## 5. Stages

### Stage 1 — rename and mandates
- `src/plans.js`: `ROLES` → the seven new ids. Role mandates in `briefSession()`
  (what an inventor/designer/hacker is for).
- `web/index.html`: Critic card → **Inventor** (row 1, pipeline first); Auditor
  card → **Hacker** (row 3, pipeline last). `data-role` attributes move with them.
- `web/app.js`: `ROLES` array.
- `src/config.js`: fold legacy `roles.auditor` → `roles.inventor` and
  `roles.critic` → `roles.hacker` once, so the operator keeps the model picks;
  accept `skills: []` on a role entry.
- `config/synapse.config.json`: migrate the live file.
- **Done when:** the cards read Inventor and Hacker, both keep the Auditor's and
  Critic's models, an old plan naming `auditor` is reported as an unknown role,
  and nothing else changed.

### Stage 2 — skills and eyes
- Probe A/B/C first (see §6), results reported as facts.
- Write `visual-review` (SKILL.md + `bin/shot.mjs`).
- `roles.<id>.skills` in config + normalize + brief line.
- ✎ picker on the role card: skill checkboxes, saved to the role entry.
- Ruleset gating if probe C passes; otherwise declare-only.
- **Done when:** the Architect can be given `visual-review`, render a mock, and
  describe it accurately — verified by asking it something only the image knows.

### Stage 3 — file contract
- `requirement.md` written by the harness (first operator message, append-only
  follow-ups); owner matrix rules in `src/harness.js`; `.synapse` subfolders
  created with the project.
- `features.json` read + lint (`src/plans.js` or a new `src/features.js`):
  confirmed → must map to a task; rejected → never briefed.
- Brief assembly: requirement + confirmed features + `reads`/`ids` from the task.
- **Done when:** a worker cannot write outside its own area, and a brief shows the
  operator's own words without the Architect restating them.

### Stage 4 — pipeline
- Architect brief: the menu, the two gates, design-verbatim-then-wire, the stack
  question before design.
- `phases` recorded in the plan (`"phases": ["invent","design","build","hack"]`).
- Plan pane: show the chosen phases (quietly).
- **Done when:** the clock example reaches a mock for operator approval.

### Stage 5 — hack loop
- Hacker report format, fix-by-id, re-check replays the previous list, cap at 3.
- Refusal of a 4th hack task, recorded in `runs.jsonl` as `outcome: 'hack-cap'`.
- **Done when:** a run reaches three hack rounds and stops with a report.

---

## 6. Probes and their fallbacks

| Probe | Question | If it fails |
|---|---|---|
| A | Does headless Edge screenshot a local HTML file without touching the operator's profile? | Kill the eyes idea now; a skill that cannot look must not pretend. |
| B | Does the engine's `read` return image content to the model? | Attach the PNG via `POST /prompt {files}` (synthetic message) as the second route; if that fails too, structural review only. |
| C | Does a permission rule deny the `skill` tool by name or path? | Declare-only; the brief lists allowed skills and we say the gate is advice. |
| D | Does a write rule deny a path under `.synapse/**` for a worker? | (Expected to pass — same mechanism as the harness guard, already measured.) |

---

## 7. Risks

- **Role ids are load-bearing** in `plans.js`, `web/index.html`, `web/app.js` and
  `config/synapse.config.json`. All four move together or a card silently loses
  its model.
- **Brief size**: requirement + features + files can get long. Start by inlining;
  measure; fall back to paths if the transcript suffers.
- **Blind Architect**: the design gate is the operator's, and `design.md`'s spec
  table is what the Architect actually checks.
- **Cost**: a full pipeline is ~8–10 worker turns (10–15 min on free models).
  That is why the pipeline is a menu.
- **Screenshots can be hallucinated.** The skill asks for measurable specifics and
  states uncertainty; the operator still owns the design verdict.

---

## 8. Acceptance test

The clock: *"Bro, build me a digital clock, run it in Windows like an app."*

It should ask for the stack, ask which features from the Inventor's list, render a
mock for approval, build the shell, wire it, then a Hacker report and up to three
rounds. If it gets through that, the pipeline is real.

---

## 9. What the build changed (19 Oct, measured)

Landed: stages 1–3 in full, stage 4's Architect brief and `phases`, and stage 5's
hack cap. Notes that differ from the plan above, all from live measurement:

- **The rules match the path as the model wrote it**, so they are emitted
  relative (`.synapse/**`) *and* absolute. `edit` is the action covering both
  `write` and `edit`; `write` is not an action name; `read` is.
- **Path rules cannot stop `shell` or `execute`**, so the runner fingerprints
  `.synapse` around every worker turn and alarms on anything written outside the
  role's folder. Prevention plus detection, like the harness watchdog.
- **Hack rounds: three.** The third report says the loop is closed, and a fourth
  hacker delegation is refused with `outcome: 'hack-cap'` plus a toast.
- **Skills are enforced fail-closed**: deny every skill, allow the listed ones.
  The ✎ picker is the UI; no list means no restriction.
- **`visual-review` lives in the operator's skills folder**, not in the repo
  (`%USERPROFILE%\.agents\skills\visual-review`), consistent with the other
  nine skills. It needs no restart: the engine rescans the folder per request.

Not done yet, and deliberately:

- **`phases` is shown in the pane** as one muted line above the tasks
  (`Phases: build · hack`), so the menu choice is visible without opening the
  file.
