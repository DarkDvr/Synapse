# Synapse

A self-contained Windows harness for building software with agent models: choose
the models, discuss a plan, approve it, and let workers execute it while you
watch the work appear.

It is **not** a wrapper around the OpenCode desktop app. Synapse drives the
genuine **OpenCode** engine over its HTTP + SSE API and rebuilds the interface
from scratch — today that engine, tomorrow anything that implements the contract
in `src\engines\base.js`.

**Version 1.2.3** — Windows 10/11, x64. The zip carries Node, the engine and the fonts.

**Licence:** AGPL-3.0-only, Copyright (C) 2026 DarkDvr — see `LICENSE`, `NOTICE`, `THIRD-PARTY.md`.

## Requirements

- Windows 10 or 11, with the **WebView2** runtime. Windows 11 has it; on Windows 10
  it arrives with Microsoft Edge.
- The **.NET 10 Desktop Runtime** for `Synapse.exe`. `shell\build.ps1 -Portable`
  produces a copy that carries its own, for a PC without one.
- Nothing else. Node and the engine are in `bin\`, and `vendor-node.ps1` and
  `vendor-engine.ps1` restore them if they are missing.

## Run it

```
Synapse.exe       # the app: the window, the tray icon, and the server it starts
```

Double-click it. The window opens on the boot panel, which shows the console while
the server starts, then becomes the interface at <http://127.0.0.1:8700>. The app
reads `config\synapse.config.json`, launches the engine in an isolated home under
`data\engine\opencode` (your machine-wide `~/.config/opencode` is never touched),
and runs its own Node from `bin\node`.

Closing the window hides it to the tray and the server keeps running. The tray icon
is where the server is stopped and started — **Stop Server** asks first — and
**Exit Synapse** is the only thing that stops both.

To work on the server itself, without the window:

```
bin\node\node.exe src\index.js
```

**Never restart by matching process names.** The desktop app also shows as process
name `opencode`, and it installs to `...\Programs\@opencodedesktop\OpenCode.exe` —
a path that contains `@opencode` — so a name filter kills the operator's editor
along with the engine. Nothing here matches on a name: the app stops the process it
holds a handle to.

`build.ps1` in `shell\` produces `Synapse.exe` — one lean file at the root, about
1.5 MB. It is build output and is not in git.

## What you see

- **Sidebar** — projects, each with its sessions, plus **Browse** (Explorer) and
  **Cmd** (a prompt in that folder). **Settings**, an engine-update chip when one
  is available, and a STATUS block naming the engine version, the event stream and
  the last event.
- **Stage** — the role cards, then the chat. The Architect is always on screen;
  **Multi** reveals the six workers.
- **Rail** — the Project Plan on the left, the live tool census on the right.

A card is a control as well as a status: its model and thinking effort are chosen
there, its dot says whether that role has been used in this session, and while a
delegation runs a yellow arrow with travelling beads joins the two cards taking
part.

## Projects

A project **is** a directory — `..\Synapse.Projects\<name>`, beside the harness
rather than inside it, because a model with file tools must never be one absolute
path from editing Synapse itself. There is no built-in project: an empty registry
is an empty rail, and adding one creates its folder.

At every start, any folder in the projects folder that the registry does not name is
adopted; its plan and scratch folder are created if missing. Folders starting with
`_` are the harness's own, and an empty folder is still a project.

```
<project>\
  bin\                      ← deliverables; everything else is scratch
  .synapse\plan.json        ← the plan, owned by the Architect
  .synapse\features.json    ← what you confirmed, and what you rejected
  .synapse\ideas\ design\ reports\    ← one folder per role
  .synapse\runs.jsonl       ← append-only record of every delegation
```

Deleting a project sends its folder to the Recycle Bin; re-adding a folder that already holds a plan asks first.

## The Project Plan and the pipeline

The Architect keeps the Project Plan as a file, with its ordinary file tools.
Synapse only reads and renders it and **never repairs it**: a malformed file is
named, in the pane and in the Architect's own brief, so the model fixes its own
document.

The Project Plan is live. It starts with the work the Architect can see and grows
while the work happens — a defect a worker reported, a decision the build exposed —
and every row added that way is marked `found` in the pane, so a Project Plan that
changed after you looked says so. What stays fixed is the scope: `features.json`
is the agreed contract, and a new feature still comes back to you as a question.

The pipeline behind the plan is a **menu, not a checklist** — a clock pays for
invent, design, build and review, a one-file script pays for two tasks:

| Role | Produces |
|---|---|
| Inventor | ranked ideas, each with a one-line why and an effort |
| Architect | the plan, the decisions, the judgement after every worker |
| Designer | a design spec, and mock pages to choose from |
| Coders 1–3 | the code |
| QC | what a real person would break or misread, then a fix round |

Two decisions are yours, and the Architect asks for them with a form: **which of
the proposed features to build** (one multiselect, one option per feature) and
**which mock to build to**. QC has a volume dial — ordinary user mistakes and
confusing wording by default, hostile testing when you turn it up — and the
QC/fix loop is capped at three rounds. **Keep building**, between Stop and Send,
decides whether the Architect delegates the next task by itself or stops after
judging each one.

## Models

Every role owns its model and its thinking effort; there is deliberately no
default model. Pickers are searchable, and each row carries a source chip so two
entries with the same display name can never be confused.

**The catalog ships inside the engine binary.** A stale model list is a stale
*engine*, never a stale cache — the console prints `catalog: N model(s) from
engine X` at every boot, and the **Update** chip beside Settings is how a newer
engine arrives.

## Configuration

`config\synapse.config.json` is the single source of truth, and Settings is a GUI
over it. The keys most worth knowing:

| Key | Meaning |
|---|---|
| `server.port` | where the UI is served (8700) |
| `server.openBrowser` | open a tab on start |
| `engine.opencode.binary` | the engine program (`""` = find it) |
| `engine.opencode.port` | engine port (8720) |
| `engine.opencode.home` | the engine's isolated home (`""` = `data\engine\opencode`) |
| `roles.<id>` | `{ "ref", "variant" }` for one role, the Architect included |
| `worker.stallSec` | silence before a worker is told to carry on (minutes) |
| `worker.resumeMax` | how many nudges one task gets before it is reported stuck |
| `logging.retentionDays` | how long logs are kept |

## Logs

One file per channel in `logs\`: `app` (lifecycle, config, run milestones),
`engine` (process output and stream health), `session` (prompts and events) and
`tools` (tool calls and permission requests). Rotated at `logging.maxFileMb`,
deleted past `logging.retentionDays`.

## Changing engines

1. add `src\engines\<name>.js` implementing the contract in `base.js`,
2. register it in `src\engines\index.js`,
3. set `engine.type` in the config.

Nothing engine-specific leaks outside its adapter.

## Where the detail is

This file is the front door. The reasoning, the measurements and the traps live
next to it:

| File | Holds |
|---|---|
| `AGENTS.md` | the rules, how to run and restart it, the engine trap table |
| `docs\notes\engine-notes.md` | the engine API, briefs, the plan contract, delegation, permissions |
| `docs\notes\models-and-tools.md` | the catalog, effort variants, marks, the probe, engine updates |
| `docs\notes\ui-lessons.md` | layout invariants and the measurements that prove them |
| `docs\notes\runbook.md` | protecting the harness, browsers, destructive commands |
