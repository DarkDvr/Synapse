# Prohibited: the paths a model may read and never change

This is the one tier that does not ask. A write, an edit or a destructive shell command
aimed at a protected path is refused before a permission card exists, so there is no
countdown to outlast, no "Always Allow" clicked months ago, and no auto-permission that
fires while the operator is away.

A wrong answer here is not a bad file in a project. It is the Windows folder, `Program
Files`, `ProgramData`, the Synapse install, or a browser profile whose loss resets
everything the operator has.

## Specificity: a narrow entry beats a broad one

The list is not "any match refuses". The **most specific** covering entry decides, by path
length: `…\Synapse\data\browser\shots` beats `…\Synapse\data` and `…\Synapse`. That is how
the operator says "this folder is protected, except this subfolder".

One exception is built in, because the harness writes the file itself: **reads** under
`data\browser\shots\` are allowed, so the model can look at a screenshot the browser just
took. Nothing else under `data\` opened, and the exception is read-only.

## What is on the list

Two independent permissions per path:

| column | means |
|---|---|
| Path | the file or folder; built-ins are marked **Built-in** |
| **Write** | ticked: changes are allowed and the normal rules apply. cleared: every write, edit or destructive command aimed inside it is refused before a card exists |
| **Read** | ticked: reading is allowed. cleared: reads are refused too |
| delete | removes an added path. A built-in's ✕ is permanently disabled |

- **Built-ins**, from the machine's own variables: `%SystemRoot%`, `%ProgramFiles%`,
  `%ProgramFiles(x86)%`, `%ProgramData%`, and the folder Synapse runs from. They start
  **Write cleared, Read ticked**, can be changed but never deleted: a half-ticked list
  must not be able to lose Windows.
- **Added entries** start the same way and can be deleted. Deleting one records its path
  in `protection.removed`, which is what stops a seeded entry coming back at boot.

A refusal names the path it actually resolved, not only the spelling the model used. If a
relative path leaves the project, the sentence says it was resolved from the command's
working directory — the `app/build.ps1 -Out ../bin` trap, where the script would write
inside the project but the policy judges the literal `../bin` from the project root.

The config keeps `protection: { builtinsOff, builtinsSealed, paths, removed }`. The older
one-box form (`enabled`/`sealed`) is folded into it on load.

## Brave

Brave is an **added** entry, seeded at boot from `%LOCALAPPDATA%\BraveSoftware` and
`%APPDATA%\BraveSoftware` when those folders exist. Both boxes are cleared: Brave treats a
read as a touch, and touching it resets extensions, cookies and settings
(`web-reading.md`). The seed is why a fresh install gets the protection without a
machine-specific path in the shipped config, and deleting the row is a deliberate act that
lasts.

## How it is enforced

- Every engine tool call is judged by `decide()` in `src/permissions.js`; the gate
  (`src/permission-gate.js`) passes the list in, read per request, so a tick applies to
  the next call without a restart.
- A write or edit inside an entry whose **Write is cleared** is `deny`, `scope:
  'prohibited'`.
- A shell command is judged per statement: a statement that is not read-only may not name
  such a path, a redirect may not land in one, and a write with no path (`cd C:\Windows`
  then `del x`) is judged by the directory it runs in.
- An entry whose **Read is cleared** refuses reads too, for a file tool and a read-only
  command alike.
- Deleting a project whose folder sits inside an entry is refused, as is wiping one.
- The model is told what happened with the strongest refusal note there is, and the chat
  shows a bright-red `Synapse · PROHIBITED` line. Workers and the Architect both get it:
  "something tried to change Windows" is news.

## Copying a skill's assets

A shipped skill carries files a project is meant to receive, and `Copy-Item` is not a read
verb, so the source under `skills/` counted as a write into the harness and the built-in
entry refused the copy (8 Nov). The carve-out is a **copy** (`Copy-Item`, `cp`, `copy`,
`cpi`) whose sources all resolve inside `skills/` and whose destination is outside
Synapse. That statement's source is a read. It is narrow on purpose:

- **a move is not a copy.** `Move-Item` would delete the skill, so it is refused;
- **the source must really be a skill.** A `..` that climbs back into `src/` is refused;
- **a destination inside Synapse is still a change to Synapse**, and is refused;
- **the destination is still judged as the write it is** — into the project or scratch is
  allowed, to the Desktop asks, into Windows is refused;
- **the exemption is per statement.** `Copy-Item …; Remove-Item skills\…` still deletes a
  skill;
- **a sealed entry still seals**: a cleared Read refuses the source like any other read.

## The limit, said plainly

The gate sees the paths the command names. A shell one-liner that builds a path at runtime
(`$p = 'C:' + '\Windows'; Remove-Item $p`) is not understood — nothing at this layer can
execute PowerShell to find out what it will touch. The protection is a strong fence
against the model that reaches for `C:\Windows` by name, not a kernel. The OS's own
permissions are the last line, and Synapse does not change them.

## The screen is not a file

A worker that launches an app or photographs a window takes the operator's mouse, keyboard
and focus. That is the one thing on this machine that is theirs *while they are using it*,
so the policy does not decide it: it asks, and the answer is a lease (`src/desk.js`)
rather than a rule.

- `screenTaking()` names the shapes: `SetForegroundWindow`, `SendInput`/`SendKeys`/
  `mouse_event`/`SetCursorPos`, and the shipped window tool
  (`skills/app-check/bin/window.ps1`) with any action but `query`.
- With no lease, the gate leaves the card to the operator with `scope: 'desk'` — "wants to
  use your screen", **Allow Screen** and **Reject**. No "Always Allow", because the lease
  already covers the run.
- With Auto-Permissions **off** the card waits however long they take. With it **on** it is
  allowed after the same wait as any other card — that is what makes an overnight run
  possible — and the card is still drawn, so an operator who is awake can take it back.
- Allowing takes the lease (one project at a time, machine-wide). The badge says who has it
  and offers **Take Back**, which ends it at once; the work keeps running and cannot take
  the screen again without asking.
- **The lease is about the call, not the run.** It ends when the tool call that took it
  finishes, and every ending is announced — the badge clears, the chat says so, and a
  chime plays when it was the work that let go rather than the operator.
- Headless work is untouched: `skills/visual-review` renders in `--headless=new`.
- **A program is run, not written.** A shipped tool that launches Windows software
  (`-Exe C:\Windows\System32\cmd.exe`) names a program, and judging that as a change to
  Windows refused the operator's own skill. Writing into a protected folder is still
  refused, and a cmd-style switch (`/c`) is a switch, not a path.
  **A launcher's target counts too**: `Start-Process …\powershell.exe` puts the program in
  an argument where the head-of-statement rule cannot see it, so the launcher's own target
  is the exemption; a second path in the arguments is judged as what it is.
- **Elevation is refused, and says so.** `Start-Process -Verb RunAs` asks Windows for
  administrator rights, and UAC is a thing only the operator can answer — an unattended run
  would sit on it. It is a plain refusal with the real reason, not the prohibited line.
- **A script is read, because the mouse can hide inside one.** On 8 Nov a coder wrote
  `capture.ps1` (`SetCursorPos` + `SendInput` + `Start-Process`) and ran it; the command
  named nothing the gate knew and the cursor moved. A statement that *runs* a script (the
  script is the head, or follows `pwsh -File`, `node`, `cmd /c`) is now read, bounded to
  256 KB and only from the project or scratch, and its text goes through `screenTaking()`.
  `Get-Content capture.ps1` is still just a read.
- **The project's own program asks too.** A GUI program takes the screen from the inside,
  where no command text can be read. Running an `.exe`/`.com` inside the project therefore
  asks for the screen; `Get-Item` on the same file does not.

Not covered: a program from *outside* the project that takes the screen itself, and a
runtime that builds a path to `SetCursorPos` before calling it.

## Processes: one id you started

The path fence cannot see a kill. `Get-Process python | ForEach-Object { Stop-Process -Id
$_.Id -Force }` names no file, so every path rule passes it, and on 10 Nov a worker tidying
up stopped the local model server answering its own run — eight minutes of retries against
a closed port.

So the shell refuses three shapes, in the same tier as PROHIBITED — no card, no countdown,
a sentence the model can act on:

- **a sweep** — processes from a list piped into a stop with no name of its own;
- **a family** — `Stop-Process -Name python`, `taskkill /IM python.exe`, a wildcard,
  `pkill`: a runtime's name is shared by every other program written in that language;
- **an id it found** — `-Id (Get-NetTCPConnection …)`, `-Id $pid`.

Stopping a **specific id** stays allowed, and so does stopping a project's own app **by
name** (`Stop-Process -Name SysMonitor`): measured over a day, 121 of 122 kill commands
were exactly that. The list of names treated as shared runtimes is the same
`INTERPRETERS` set the shell analysis already uses.

**A POSIX `kill` names its id the other way round.** `kill 17863` and `kill $pid` are the
same "one id it was given"; a second id (`kill 1 2`), a group (`kill -9 -1`), a job
(`kill %1`) and a subexpression (`kill $(pgrep …)`) are still refused.

A refusal rather than a question is deliberate: an unattended night run must not stop and
wait, and the refusal names the fix — "stop the one process you started, by its id" — so
the model can carry on.

**Every refusal is explained, whoever asked.** The engine ends the model's turn when a
tool call is declined — the transcript says "Step interrupted" — so the synthetic note is
the only channel left. `refusalNote({ policy: true })` keeps the harness's own voice: it
never says the operator declined anything, and for a refusal the model can fix it passes
the policy's sentence on whole.

**What it still cannot see:** a command that builds the name or the id at runtime, a
script that does it inside, and an interpreter not in `INTERPRETERS`.

**A tool's arguments are not shell syntax.** A Designer ran the visual-review renderer
with `--do "click:[data-state=\"long\"]"` and `--eval "(()=>{...})()"`; the analyzer read
the `=>` as a redirect and the escaped quote as the end of the argument, invented a path
outside the project, and asked on every render. A `>` after `=`, `<` or `&` is not a
redirect, and `\"` inside a quoted argument is a quote. A real `>` redirect is still a
write, judged where it lands.

## A project cannot look into another

Two entries, not a new policy:

- the **projects root** (`F:\dev\Synapse.Projects`) is a protected entry with **both boxes
  refused** — writes and reads;
- the **project in use** is a more specific permitted subfolder of it, appended per
  request (`withProjectFence`), because "the project in use" is not a property of the
  machine.

Since 20 Nov there is no second exception: scratch is `.project/scratch` inside the
project. The operator's own entries come first, so a path they added inside their project
still wins by being more specific.

The root entry is **mandatory**: `src/protection.js` refuses both boxes whatever the
config says, and Settings shows them disabled with a "Mandatory" tag. One unticked box
would let any model wander into every project.

The refusal says what it is, not "PROHIBITED": *"Another project is not yours to read.
Work only inside your own project folder."* It covers file tools and shell commands alike.

**Not covered:** a project registered outside the projects root (Add Project accepts any
folder).

**The fence is about models, not the operator.** Delete Project and the add-project wipe
also consult the list, and both call `entryBlockingWrite(..., { operator: true })`, which
skips the mandatory projects entry and nothing else — otherwise the fence refused *every*
delete (15 Nov). Audited at the same time: rename, the Private toggle, Browse/Cmd, the
shipped skills and the project's own `.project` writes never went through the protected
list at all; the two delete paths were its only callers.

## Synapse's own temp is not a folder to work in

`data\temp` is the engine's plumbing — a compiler's intermediates, a render's throwaway
browser profile — so it is not an answer to "where did my build's temp files go". A read,
write or command that names it is refused **as temp**, with the folder to use instead:

> That is Synapse's own temp folder, not yours — nothing of a model's belongs there and
> nothing in it is kept. A command that needs a temp directory writes into your project:
> set it for that command, e.g. `$env:TEMP = "$PWD\.project\scratch\temp"` in PowerShell
> or `set TEMP=%CD%\.project\scratch\temp` in cmd, then run it again and look there.

The refusal is checked before the protected list in all three deciders, because its
sentence is the useful one.

## One wording for every folder refusal

A worker wrote `..\p3-browser-output.txt`, was refused, and then asked the operator "which
path was protected?" Three wordings failed: "the projects root" read as *this project's*
root; "the shared folder that holds every project" explained a concept it does not need.

What it says now, and the whole of it:

> PROHIBITED: `F:\dev\Synapse.Projects` and `SYNAPSE_PROJECTS_ROOT` are outside your
> project folder and are not permitted for you to browse. You should work only inside your
> project folder (`$PWD`, or `%CD%` in cmd); scratch is `.project/scratch` inside it, and
> there is nowhere else to write.

The harness uses the same shape for its own folder:

> PROHIBITED: that path is inside `SYNAPSE_HARNESS` (`F:\dev\Synapse`), Synapse's own
> folder, and is not permitted for you to read. You should work only inside your project
> folder (`$PWD`, or `%CD%` in cmd); scratch is `.project/scratch` inside it.

Four facts, no concept: the folder and its constant, that it is not for browsing, the
project folder's own name (`$PWD`), and where scratch is. The constants are the ones the
core instruction gives every role, so the sentence and the instructions share one
vocabulary, and the brief's coder line says the same thing in the same words.
