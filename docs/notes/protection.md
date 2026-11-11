# Prohibited: the paths a model may read and never change

This is the one tier that does not ask. A write, an edit or a destructive shell
command aimed at a protected path is refused before a permission card exists, so
there is no countdown to outlast, no "Always Allow" to have clicked months ago,
and no auto-permission that fires while the operator is away.

It exists because a wrong answer here is not a bad file in a project. It is the
Windows folder, `Program Files`, `ProgramData`, the Synapse install, or a browser
profile whose loss resets everything the operator has.

## Specificity: a narrow entry beats a broad one

The list is not "any match refuses". The **most specific** covering entry decides, by path
length: `…\Synapse\data\browser\shots` beats `…\Synapse\data` and `…\Synapse`. That is
how the operator says "this folder is protected, except this subfolder" — the broad entry
carries the refusal, a narrower added entry carries the permission (11 Nov).

One exception is built in, because the harness writes the file itself: **reads** under
`data\browser\shots\` are allowed. The browser takes a screenshot, answers the model with
its path, and the model has to be able to look at it; before this, every screenshot was a
refused read ("These are Synapse's private files") and the tool was pointless. Nothing
else under `data\` opened, and the exception is read-only.

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
  **A launcher's target counts too** (11 Nov): `Start-Process …\powershell.exe` puts
  the program in an argument, where the head-of-statement rule could not see it, so a
  worker reading a CPU temperature sensor was refused as a write into Windows. The
  launcher's own target is the exemption; a second path in the arguments is judged
  as what it is.
- **Elevation is refused, and says so** (11 Nov). `Start-Process … -Verb RunAs` asks
  Windows for administrator rights, and the UAC prompt is a thing only the operator
  can answer — an unattended run would sit on it. That refusal used to be
  "PROHIBITED: Windows is on the protected list", which was untrue: nothing was
  going to be written there. It is now a plain refusal with the real reason, telling
  the model to do the work without elevation or ask the operator for that one step.
  The chat shows it as an ordinary refused call, not as the red prohibited line.

- **A script is read, because the mouse can hide inside one.** On 8 Nov the coder
  wrote `capture.ps1` — `SetCursorPos` + `SendInput` + `Start-Process` — and ran
  `.\capture.ps1 -Exe …`. The command named nothing the gate knew, and the cursor
  moved. A statement that *runs* a script (the script is the head, or follows an
  interpreter: `pwsh -File x.ps1`, `node x.mjs`, `cmd /c x.bat`) is now read,
  bounded to 256 KB and only from the project or the scratch root, and the script's
  text goes through the same `screenTaking()` test. Reading a script is still a
  read: `Get-Content capture.ps1` does not ask.
- **The project's own program asks too.** A GUI program takes the screen from the
  inside, where no command text can be read — the SysMonitor widget calls
  `SetForegroundWindow` itself when its menu opens. Running an `.exe`/`.com` that
  lives in the project (`& .\bin\App.exe`, `Start-Process …`, `cmd /c …`) therefore
  asks for the screen; `Get-Item` on the same file does not.
- The managed cursor is the same API: `[System.Windows.Forms.Cursor]::Position`.

What this still does not cover: a program from *outside* the project that takes the
screen itself, and a runtime that builds a path to `SetCursorPos` before calling it.
It is a fence around the shipped tools, the obvious API names, the scripts a command
runs and the programs a project builds — not a desktop sandbox.

## Processes: one id you started (10 Nov)

The path fence cannot see a kill. `Get-Process python | ForEach-Object { Stop-Process -Id
$_.Id -Force }` names no file, so every path rule passes it, and on 10 Nov a worker tidying
up after its task stopped the local model server that was answering its own run — eight
minutes of retries against a closed port.

So the shell gets one more shape it refuses, in the same tier as PROHIBITED: no card, no
countdown, a sentence the model can act on. Three shapes are refused, and nothing else:

- **a sweep** — processes from a list piped into a stop with no name of its own: it stops
  whatever the list happens to hold;
- **a family** — `Stop-Process -Name python`, `taskkill /IM python.exe`, a wildcard,
  `pkill`: a runtime's name is shared by every other program written in that language;
- **an id it found** — `-Id (Get-NetTCPConnection …)`, `-Id $pid`: an id the command
  looked up is no safer than a name.

Stopping a **specific id** stays allowed, and so does stopping a project's own app **by
name** (`Stop-Process -Name SysMonitor`): measured over a day of logs, 121 of the 122 kill
commands were exactly that, and refusing them would break how a project tests itself. The
list of names treated as shared runtimes is the same `INTERPRETERS` set the shell analysis
already uses for "a program that hosts other work" — no new list to maintain.

A refusal rather than a question is deliberate: an unattended night run must not stop and
wait (the operator's rule, 10 Nov), and the refusal names the fix — "stop the one process
you started, by its id: Stop-Process -Id <pid>" — so the model can carry on.

**What it still cannot see:** a command that builds the name or the id at runtime
(`$n = 'py'+'thon'; Get-Process $n | Stop-Process`), a script that does it inside, and an
interpreter that is not in `INTERPRETERS`. This is a fence on the shapes that reach beyond
the project, not a kernel.
