# Synapse

A self-contained Windows harness for building software with agent models: choose the
models, discuss a plan, approve it, and let workers execute it while you watch the work
appear.

It is **not** a wrapper around the OpenCode desktop app. Synapse drives the genuine
**OpenCode** engine over its HTTP + SSE API and rebuilds the interface from scratch —
today that engine, tomorrow anything that implements the contract in
`src\engines\base.js`.

**Version 1.86.3** - Windows 10/11, x64. The zip carries Node, Git, the engine, agent-browser and the fonts.

**Licence:** AGPL-3.0-only, Copyright (C) 2026 DarkDvr — see `LICENSE`, `NOTICE`, `THIRD-PARTY.md`.

## Requirements

- Windows 10 or 11 with the **WebView2** runtime (Windows 11 has it; on 10 it arrives with
  Edge).
- The **.NET 10 Desktop Runtime** for `Synapse.exe`; `shell\build.ps1 -Portable` produces a
  copy that carries its own.
- **Git** — if the machine has none, Synapse installs a private MinGit into `bin\git` on
  first launch.
- Nothing else: Node and the engine are in `bin\`, and `vendor-node.ps1` and
  `vendor-engine.ps1` restore them.

## Run it

```
Synapse.exe       # the app: the window, the tray icon, and the server it starts
```

Double-click it. The boot panel shows the console while the server starts, then becomes the
interface at <http://127.0.0.1:8700>. The app reads `config\synapse.config.json`, launches
the engine in an isolated home under `data\engine\opencode` (your machine-wide
`~/.config/opencode` is never touched), and runs its own Node from `bin\node`.

Closing the window hides it to the tray and the server keeps running. The tray stops and
starts the server — **Stop Server** asks first — and **Exit Synapse** is the only thing that
stops both. The server alone: `bin\node\node.exe src\index.js`.

**Never restart by matching process names.** The desktop app also shows as `opencode` and
installs to `...\Programs\@opencodedesktop\OpenCode.exe` — a path containing `@opencode` —
so a name filter kills the operator's editor with the engine. The app stops the process it
holds a handle to.

`build.ps1` in `shell\` produces `Synapse.exe`: one lean file at the root, about 1.5 MB,
build output and not in git.

## What you see

- **Sidebar** — projects, Browse, Cmd, Settings, and a STATUS block: Remote Access, the
  Engine, the Last Event, the Local LLM.
- **Stage** — the role cards, then the chat. The Architect is always on screen; **Multi**
  reveals the five workers. A card is a control as well as a status: its model and thinking
  effort are chosen there, and its dot says whether that role has been used in this chat,
  is working now, or is blocked. A delegation draws a yellow arrow with travelling beads
  between the two cards taking part.
- **Rail** — the Project Plan on the left, the live tool census on the right.

The chat can chime when the Architect finishes — four sounds, or off, in
**Settings → General**.

## Projects

A project **is** a directory — `..\Synapse.Projects\<name>`, beside the harness rather than
inside it, because a model with file tools must never be one absolute path from editing
Synapse itself. There is no built-in project: an empty registry is an empty rail.

At every start, any folder the registry does not name is adopted; its plan and scratch are
created if missing. Folders starting with `_` are the harness's own, and an empty folder is
still a project.

```
<project>\
  bin\                      ← deliverables; everything else is scratch
  .project\plan.json        ← the plan, owned by the Architect
  .project\features.json    ← what you confirmed, and what you rejected
  .project\ideas\ design\ reports\    ← one folder per role
  .project\runs.jsonl       ← append-only record of every delegation
```

Deleting a project sends its folder to the Recycle Bin; re-adding a folder that already
holds a plan asks first. The `⋯` menu can make a project **Private**: Synapse then keeps no
log, census, trace or scratch record of it outside its own folder.

## The Project Plan and the pipeline

The Architect keeps the Project Plan as a file with its ordinary tools. It is a **work
list**, not a fixed contract: it grows while the work happens. Synapse only reads and
renders it and **never repairs it** — a malformed file is named in the pane and in the
Architect's own brief, so the model fixes its own document. A row added mid-work is marked
`found`, so a plan that changed after you looked says so. What stays fixed is the scope:
`features.json` is the agreed contract, and a new feature still comes back as a question.

A row may carry **`checks`** — up to three short commands that prove it. The harness runs
them when the worker reports done, sends a failure back once, and puts a still-failing check
in the report.

The pipeline is a **menu, not a checklist** — a small job spends a task or two, a full build
spends invent, design, build and review:

| Role | Produces |
|---|---|
| Inventor | ranked ideas, each with a one-line why and an effort |
| Architect | the plan, the decisions, the judgement after every worker |
| Designer | a design spec, and mock pages to choose from |
| Coders 1–2 | the code |
| QC | what a real person would break or misread, then a fix round |

Two decisions are yours, asked with a form: **which features to build** and **which mock to
build to**. QC has a volume dial, and the QC/fix loop is capped at three rounds. **Keep
building**, between Stop and Send, decides whether the Architect delegates the next task by
itself or stops after judging each one.

## Models

Every role owns its model and its thinking effort; there is deliberately no default model.
Pickers are searchable, and each row carries a source chip so two entries with the same
display name cannot be confused.

**The catalog ships inside the engine binary.** A stale model list is a stale *engine*,
never a stale cache — the console prints `catalog: N model(s) from engine X` at every boot,
and the **Update** chip beside Settings is how a newer engine arrives.

## Configuration

`config\synapse.config.json` is the single source of truth, and Settings is a GUI over it.

| Key | Meaning |
|---|---|
| `server.port` | where the UI is served (8700) |
| `server.openBrowser` | open a tab on start |
| `engine.opencode.binary`, `.port`, `.home` | the engine program, its port (8720), its isolated home |
| `roles.<id>` | `{ "ref", "variant", "skills", "mustLoad" }` for one role, the Architect included |
| `worker.stallSec`, `.resumeMax` | silence before a worker is nudged (600), and how many nudges |
| `logging.retentionDays` | how long logs are kept |

## Changing engines

1. add `src\engines\<name>.js` implementing the contract in `base.js`,
2. register it in `src\engines\index.js`,
3. set `engine.type` in the config.

Nothing engine-specific leaks outside its adapter.

## Where the detail is

This file is the front door. `AGENTS.md` is the map of the rules and the traps, and its
table names the `docs\notes\` file for whatever you are about to touch.
