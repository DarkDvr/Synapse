# Prohibited: the paths a model may read and never change

This is the one tier that does not ask. A write, an edit or a destructive shell
command aimed at a protected path is refused before a permission card exists, so
there is no countdown to outlast, no "Always Allow" to have clicked months ago,
and no auto-permission that fires while the operator is away.

It exists because a wrong answer here is not a bad file in a project. It is the
Windows folder, `Program Files`, `ProgramData`, the Synapse install, or a browser
profile whose loss resets everything the operator has.

## What is on the list

- **Built-ins**, defined in `src/protection.js`, from the machine's own variables:
  `%SystemRoot%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramData%`, and the
  folder Synapse runs from. They can be switched **off** in Settings → Prohibited
  but never deleted: a half-ticked list must not be able to lose Windows.
- **Added entries**, chosen in that pane with the native folder or file picker.
  They can be switched off and deleted. Deleting one records its path in
  `protection.removed`, which is what stops a seeded entry coming back at boot.

The entry list lives in `config/synapse.config.json` as
`protection: { builtinsOff, paths, removed }`. Built-ins are *code plus an off
switch*, so editing the config cannot invent or erase one; added paths are data.

## Brave

Brave is an **added** entry, seeded at boot from
`%LOCALAPPDATA%\BraveSoftware` and `%APPDATA%\BraveSoftware` when those folders
exist. Its row is marked **No reads** as well: Brave treats a read as a touch, and
touching it resets extensions, cookies and settings — see `web-reading.md`. The
seed is why a fresh install gets the protection without a machine-specific path in
the shipped config, and deleting the row is a deliberate act that lasts.

## How it is enforced

- Every engine tool call is judged by `decide()` in `src/permissions.js`; the gate
  in `src/permission-gate.js` passes the enabled list in, read per request, so a
  tick applies to the next tool call without a restart.
- A write or edit that resolves inside an entry is `deny`, `scope: 'prohibited'`.
- A shell command is judged per statement: a statement that is not read-only may
  not name a protected path, a redirect may not land in one, and a write with no
  path (`cd C:\Windows` then `del x`) is judged by the directory it runs in. A
  read-only command may read one, unless the entry is sealed.
- A sealed entry (Brave) refuses reads too.
- Deleting a project whose folder sits inside an entry is refused, as is wiping
  one.
- The model is told what happened with the strongest refusal note there is, and
  the chat shows a bright-red `Synapse · PROHIBITED` line. Workers and the
  Architect both get it: "something tried to change Windows" is news.

## The limit, said plainly

The gate sees the paths the command names. A shell one-liner that builds a path at
runtime (`$p = 'C:' + '\Windows'; Remove-Item $p`) is not understood — nothing at
this layer can execute PowerShell to find out what it will touch. The protection is
a strong fence against the model that reaches for `C:\Windows` by name, not a
kernel. The OS's own permissions are the last line, and Synapse does not change
them.
