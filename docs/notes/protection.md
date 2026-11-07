# Prohibited: the paths a model may read and never change

This is the one tier that does not ask. A write, an edit or a destructive shell
command aimed at a protected path is refused before a permission card exists, so
there is no countdown to outlast, no "Always Allow" to have clicked months ago,
and no auto-permission that fires while the operator is away.

It exists because a wrong answer here is not a bad file in a project. It is the
Windows folder, `Program Files`, `ProgramData`, the Synapse install, or a browser
profile whose loss resets everything the operator has.

## What is on the list

The list is a table of **two permissions per path**, because they are independent:

| column | means |
|---|---|
| Path | the file or folder; the built-ins are marked **Built-in** |
| **Write** | ticked: changes are allowed and the normal rules apply. cleared: every write, edit or destructive command aimed inside it is refused before a card exists |
| **Read** | ticked: reading is allowed. cleared: reads are refused too |
| delete | removes an added path. A built-in's ✕ is permanently disabled |

- **Built-ins**, defined in `src/protection.js` from the machine's own variables:
  `%SystemRoot%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramData%`, and the
  folder Synapse runs from. They start **Write cleared, Read ticked**. They can be
  changed but never deleted: a half-ticked list must not be able to lose Windows.
- **Added entries**, chosen in that pane with the native folder or file picker.
  They start the same way — Write cleared, Read ticked — and can be deleted.
  Deleting one records its path in `protection.removed`, which is what stops a
  seeded entry coming back at boot.

The config keeps `protection: { builtinsOff, builtinsSealed, paths, removed }`:
`builtinsOff` lists the built-in ids whose Write was switched back on,
`builtinsSealed` the ids whose Read was cleared, and each added path carries
`{ path, label, write, read }`. The older one-box form (`enabled` / `sealed`) is
folded into it on load, so an existing file opens with the answers it showed.

## Brave

Brave is an **added** entry, seeded at boot from
`%LOCALAPPDATA%\BraveSoftware` and `%APPDATA%\BraveSoftware` when those folders
exist. Both boxes are cleared: Brave treats a read as a touch, and touching it
resets extensions, cookies and settings — see `web-reading.md`. The seed is why a
fresh install gets the protection without a machine-specific path in the shipped
config, and deleting the row is a deliberate act that lasts.

## How it is enforced

- Every engine tool call is judged by `decide()` in `src/permissions.js`; the gate
  in `src/permission-gate.js` passes the list in, read per request, so a tick
  applies to the next tool call without a restart.
- A write or edit that resolves inside an entry whose **Write is cleared** is
  `deny`, `scope: 'prohibited'`.
- A shell command is judged per statement: a statement that is not read-only may
  not name such a path, a redirect may not land in one, and a write with no path
  (`cd C:\Windows` then `del x`) is judged by the directory it runs in.
- An entry whose **Read is cleared** refuses reads too, for a file tool and for a
  read-only command alike.
- Deleting a project whose folder sits inside an entry is refused, as is wiping
  one.
- The model is told what happened with the strongest refusal note there is, and
  the chat shows a bright-red `Synapse · PROHIBITED` line. Workers and the
  Architect both get it: "something tried to change Windows" is news.

## Copying a skill's assets

A shipped skill carries files a project is meant to receive — the Windows app
scaffold is the one that surfaced it. `Copy-Item` is not a read verb, so the source
under `skills/` counted as a write into the harness and the built-in entry refused
the copy: a coder had to read every file of the scaffold and write it again (8 Nov).

The carve-out is a **copy** (`Copy-Item`, `cp`, `copy`, `cpi`) whose sources all
resolve inside `skills/` and whose destination is outside Synapse. That statement's
source is a read. It is narrow on purpose:

- **a move is not a copy.** `Move-Item` would delete the skill, so it is refused as
  the harness write it is;
- **the source must really be a skill.** A `..` that climbs back into `src/`, or a
  file elsewhere in the harness, is not under `skills/` and is refused as before;
- **a destination inside Synapse is still a change to Synapse**, and is refused;
- **the destination keeps being judged as the write it is.** Copying into the
  project or the scratch folder is allowed; copying to the Desktop asks; copying
  into Windows is refused;
- **the exemption is per statement.** `Copy-Item …; Remove-Item skills\…` still
  deletes a skill, and the second statement is refused;
- **a sealed entry still seals.** A prohibited entry whose Read is unticked refuses
  the source like any other read.

## The limit, said plainly

The gate sees the paths the command names. A shell one-liner that builds a path at
runtime (`$p = 'C:' + '\Windows'; Remove-Item $p`) is not understood — nothing at
this layer can execute PowerShell to find out what it will touch. The protection is
a strong fence against the model that reaches for `C:\Windows` by name, not a
kernel. The OS's own permissions are the last line, and Synapse does not change
them.

## The screen is not a file

A worker that launches an app or photographs a window takes the operator's mouse,
keyboard and focus. That is the one thing on this machine that is theirs *while
they are using it*, so the policy does not decide it: it asks, and the answer is a
lease (`src/desk.js`) rather than a rule.

- `screenTaking()` in `src/permissions.js` names the shapes: `SetForegroundWindow`,
  `SendInput`/`SendKeys`/`mouse_event`/`SetCursorPos`, and the shipped window tool
  (`skills/app-check/bin/window.ps1`) with any action but `query` — its screenshot
  falls back to `SetForegroundWindow` + `CopyFromScreen` when `PrintWindow` is
  refused, which is exactly the window that jumps in front of the operator.
- With no lease, the gate leaves the card to the operator with `scope: 'desk'`, and
  the card says "wants to use your screen" with **Allow Screen** and **Reject** —
  no "Always Allow", because the lease already covers the run.
- With Auto-Permissions **off** the card waits for the operator however long they
  take: no timeout answers it. With the switch **on** for that project it is allowed
  after the same wait as any other card — that is what makes an overnight run
  possible — and the card is still drawn, so an operator who is awake sees it and
  can take the screen back or reject it.
- Allowing it takes the lease (one project at a time, machine-wide). The badge in
  the bar says who has it and offers **Take Back**, which ends it at once; the work
  keeps running and simply cannot take the screen again without asking.
- **The lease is about the call, not the run.** It ends when the tool call that took
  it finishes — the runner watches the worker's transcript for that call id — so a
  worker that clicks one button and carries on hands the machine back at once and
  keeps working. It also ends with the run, with Take Back, or with a stop, and
  every ending is announced: the badge clears, the chat says so, and a chime plays
  when it was the work that let go rather than the operator.
- Headless work is untouched: `skills/visual-review` renders in `--headless=new`,
  so it never asks and never takes anything.
- **A program is run, not written.** A shipped tool that launches Windows software
  (`-Exe C:\Windows\System32\cmd.exe`) names a program, and judging that as a
  change to Windows refused the operator's own skill (6 Nov). Writing into a
  protected folder (`-Out C:\Windows\…`) and deleting a binary there are still
  refused, and a cmd-style switch (`/c`) is a switch, not a path — it used to
  resolve to `F:/c` and make `cmd /c dir` look like an outside write.

What this does not cover: a project's own test that launches a GUI app directly
(`& .\bin\app.exe`) names no window call, so the gate cannot see it. It is a fence
around the shipped tools and the obvious API names, not a desktop sandbox.
