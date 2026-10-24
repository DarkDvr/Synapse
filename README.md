# Synapse

A self-contained Windows harness for building software with agent models: choose
the models, discuss a plan, approve it, and let workers execute it while you
watch the work appear.

It is **not** a wrapper around the OpenCode desktop app. Synapse drives the
genuine **OpenCode** engine over its HTTP + SSE API and rebuilds the interface
from scratch — today that engine, tomorrow anything that implements the contract
in `src\engines\base.js`.

Everything lives in this folder. The only things reused from outside are `node`
and the engine binary.

## Requirements

- Windows — the launcher scripts are `.bat` and PowerShell.
- Node 18 or newer on `PATH`. No packages, no build step, no `node_modules`.
- An engine: `npm install -g @opencode/cli`, which puts `opencode.exe` where
  Synapse finds it. Settings → Engine can point somewhere else, and the **Update**
  chip installs a newer one from the window.

## Run it

```
start.bat        # starts Synapse: UI on 8700, engine on 8720
stop.bat         # reads data\synapse.pid
restart.ps1      # dev restart — stops by PID, never by name
```

`start.bat` reads `config\synapse.config.json`, launches the engine in an isolated
home under `data\engine\opencode` (your machine-wide `~/.config/opencode` is never
touched), and serves the UI at <http://127.0.0.1:8700>. Stop it with `stop.bat` or
Ctrl+C in the start window. The console is a first-class output: warnings, errors
and every run milestone are mirrored into it.

**Never restart by matching process names.** The desktop app also shows as process
name `opencode`, and it installs to `...\Programs\@opencodedesktop\OpenCode.exe` —
a path that contains `@opencode` — so a name filter kills the operator's editor
along with the engine. `restart.ps1` reads `data\synapse.pid` and
`data\engine.pid`, and refuses anything under `@opencodedesktop`.

`server.openBrowser` is off by default: a restart should not hijack a browser tab.

## What you see

- **Sidebar** — projects, each with its sessions, plus **Browse** (Explorer) and
  **Cmd** (a prompt in that folder). **Settings**, an engine-update chip when one
  is available, and a STATUS block naming the engine version, the event stream and
  the last event.
- **Stage** — the role cards, then the chat. The Architect is always on screen;
  **Multi** reveals the six workers.
- **Rail** — the project's plan on the left, the live tool census on the right.

A card is a control as well as a status: its model and thinking effort are chosen
there, its dot says whether that role has been used in this session, and while a
delegation runs a yellow arrow with travelling beads joins the two cards taking
part.

## Projects

A project **is** a directory — `..\Synapse.Projects\<name>`, beside the harness
rather than inside it, because a model with file tools must never be one absolute
path from editing Synapse itself. **General** is always present and cannot be
deleted.

```
<project>\
  bin\                      ← deliverables; everything else is scratch
  .synapse\plan.json        ← the plan, owned by the Architect
  .synapse\requirement.md   ← your own words, append-only
  .synapse\features.json    ← what you confirmed, and what you rejected
  .synapse\ideas\ design\ reports\    ← one folder per role
  .synapse\runs.jsonl       ← append-only record of every delegation
```

Adding a project creates the folder. Removing one only forgets it — nothing on
disk is deleted — and releases the folder so you can delete it straight after.
Re-adding a folder that already holds a plan asks first, showing what is at stake.

## The work list and the pipeline

The Architect keeps its list of work as a file, with its ordinary file tools.
Synapse only reads and renders it and **never repairs it**: a malformed file is
named, in the pane and in the Architect's own brief, so the model fixes its own
document.

The list is live. It starts with the work the Architect can see and grows while the
work happens — a defect a worker reported, a decision the build exposed — and every
row added that way is marked `found` in the pane, so a list that changed after you
looked says so. What stays fixed is the scope: `features.json` is the agreed
contract, and a new feature still comes back to you as a question.

The pipeline behind it is a **menu, not a checklist** — a clock pays for invent,
design, build and review, a one-file script pays for two tasks:

| Role | Produces |
|---|---|
| Inventor | ranked ideas, each with a one-line why and an effort |
| Architect | the plan, the decisions, the judgement after every worker |
| Designer | a design spec, and mock pages to choose from |
| Coders 1–3 | the code, in `bin\` |
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
