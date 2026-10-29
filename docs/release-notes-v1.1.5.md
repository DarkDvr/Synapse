# Synapse v1.1.5

One release asset again: a complete folder that is safe to extract over an
existing install.

## What changed

- **One zip, `Synapse-1.1.5-win-x64.zip`.** It contains the program files, the
  seed config, and `bin\node` + `bin\opencode`, so a new PC can run it with
  nothing installed. There is no separate “full” and “update” asset.
- **It still contains no `config\`, `data\`, `logs\` or projects.** Extracting it
  over a used folder replaces program files only; the operator’s settings,
  provider keys, chats, Full auto, Keep Running and work are not in the archive.
- **A fresh install recreates what is missing from the seed.** `config.default.json`
  travels in the zip and is copied to `config\synapse.config.json` only when that
  file does not exist. It carries provider definitions and role choices; never a
  key. `data\`, `logs\` and the projects folder are created at first run as
  before.
- **The updater downloads the same full zip.** It stages it, then the Node helper
  applies the program files; `bin\` is left alone on an existing install, because
  the bundled engine has its own update card and `bin\node` cannot be replaced
  while the helper runs from it. A fresh extract gets the whole `bin\`.
- `make-release.ps1` now builds exactly this one zip: `bin\node` without the
  729 MB npm-installed copy of the engine, `bin\opencode` without the `.bak`
  left by an engine update, plus `README.txt`.

## Updating from 1.1.4

The 1.1.4 small zip is an update package; it has no `bin\` and cannot be a fresh
install. If 1.1.4 is already running, the chip can update to 1.1.5 with the
Node helper. If the folder was deleted, use the **1.1.5 zip** and extract it into
a fresh folder; it is complete.

## Notes

- Full suite: 252 tests.
- Asset: `Synapse-1.1.5-win-x64.zip` with `SHA256SUMS`.
