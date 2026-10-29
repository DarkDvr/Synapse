# Synapse v1.1.0

One UPDATE chip for both of Synapse's moving parts, a dialog that shows what each
one changes and what it is doing, and an updater that replaces program files
without touching the operator's data.

## The chip and the dialog

- **One yellow UPDATE chip beside Settings** appears when either Synapse or the
  runtime has a newer release. It names both in its tooltip.
- The dialog has **two cards**, one per updater: current → latest, and for Synapse
  the release's own changelog (from the GitHub release body, rendered as
  Markdown). Each card has its own button.
- **One console below the cards** receives the update's own lines: download
  percentage, checksum result, unpacking, stopping/installing/starting the
  runtime, and the final result. The engine update used to be an opaque wait; it
  now says what it is doing.
- **Check Again** re-asks both feeds. **Close** is the way out.
- **A popup no longer closes when you click outside it.** Settings, Updates, the
  console, the error panel and the generic dialog all require a button — or
  **Escape**, which cancels. An update in progress keeps the dialog: neither
  click-away nor Escape can hide it.

## Updating Synapse itself

- The release zip contains **program files only**: `Synapse.exe`, `package.json`,
  `update-apply.ps1`, `src\`, `web\`, `skills\`, `templates\`. No `data\`, no
  `config\`, no `logs\`, no projects.
- Settings → About, or the chip, downloads the zip to `data\update\`, checks its
  SHA-256 against the release, unpacks it, and starts `update-apply.ps1` detached.
  The server then exits with code 3; the shell closes the whole app.
- The helper waits for both processes, backs up the current program files to
  `data\backups\<version>-<timestamp>`, overlays the new ones and starts Synapse
  again. A failed copy restores the backup.
- **Provider keys, provider definitions, chats, Full auto, Keep Running, projects
  and plans are untouched**, because they live in `data\`, `config\` and the
  projects folder, none of which are in the archive.

## The private-repository caveat

The default feed is
`https://api.github.com/repos/DarkDvr/Synapse/releases/latest`. A private
repository answers 404, so the Synapse card says so and the chip stays hidden.
Make the repository public, or set `update.synapse.feed` to a public release
feed. The runtime's update is unaffected.

## Tests

- Full suite: 251 tests.

## Releasing one

`make-release.ps1` builds `dist\Synapse-<version>-win-x64.zip` and
`dist\SHA256SUMS`; attach both to the GitHub release. `docs/notes/releases.md`
has the checklist.
