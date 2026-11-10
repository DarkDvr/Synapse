# What we are changing, and how to put it back

A short sheet for the operator, not a lesson: the behavioural changes we are making to
the harness, why each one exists, and the tag to return to if it turns out worse in a
real run than it looked on paper. The reasoning lives in `docs/notes/`; this is the
undo list.

**How to go back**

- One change: `git revert <commit>` and rebuild — the commit is named in the table.
- Everything since a point: `git checkout v1.36.0`, `.\shell\build.ps1`, run. A tag is a
  working app, not just a label.
- Nothing here touches `config\synapse.config.json` or a project folder, so a rollback
  never costs a project its settings, its plan or its history.

## Landed

| version | what changed | why | if it is worse |
|---|---|---|---|
| 1.36.2 | **The harness writes `doing`, not the Architect.** `doing` is set when a worker starts and released to `todo` when the run ends, whatever the outcome. The brief says not to write it. | A row said "doing" while nothing ran — after a stop it read "1 running" for the rest of the day — and the model was keeping a fact it cannot see. The model keeps the judgement (`todo`/`done`/`blocked`/`failed`); the harness keeps the mechanics. | `git revert 65315b3`, or roll back to **v1.36.1**. Watch for: an Architect that no longer notices a task is in flight, or a row stuck on `todo` while a worker is on it. |
| 1.36.3 | **The page's tests ask it what it rendered**, against a small fake window (`tests/fake-page.mjs`) instead of searching its source for a phrase. | A phrase test fails when a sentence moves and passes when the behaviour is broken. Three chat behaviours are asserted this way now, and the rest will follow as they are touched. | Nothing in the app changed — only the tests. Roll back with the commit if the suite gets slower or flakier. |
| 1.36.4 | **The brief is three sections**: `What never changes`, `How we work`, `This round`. Five sentences that are rules rather than habits moved to the top, once each; the project's own state is the tail. Single mode has no sections. | The brief had become one pile, with a project's situation at the bottom of three thousand tokens and the rules that cost something buried in the middle. Order is the fix; no rule was rewritten. | `git revert` this commit or roll back to **v1.36.3**. Watch for: an Architect that ignores a rule that used to be further down (the text is identical, so this would mean the model reads position rather than content — worth knowing). |

## Being prepared now

- **Processes and ports as permission zones.** A kill by name and a listen on a port
  decided like a path is decided, so a worker cannot end the server answering its run.
  This is the one with real teeth: if it is too blunt, legitimate commands start asking
  or being refused. Rollback: **v1.36.4**, and the incident is in
  `docs/notes/protection.md`.

## Not changing

- The dependencies, the engine adapter, the single-operator design — deliberate, and
  tested where it counts.
- The plan's other fields (`result`, `note`, `origin`): removing them moves information
  into logs rather than out of the model's hands.
