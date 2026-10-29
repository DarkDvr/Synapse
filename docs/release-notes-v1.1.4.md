# Synapse v1.1.4

The split in the answer rule, and the updater that can actually finish.

## The answer rule is broken for one line

The speaker's green rule used to run straight into the reply. It now has a
20-pixel gap — one line of blank background — above the final answer, then resumes
beside the prose. There is still one line, not a second rule, and only the last
text of a tool-free assistant message gets it.

## The updater

This carries the Node helper from 1.1.3:

- `update-apply.mjs`, run by `bin\node`, replaces the PowerShell script. No
  execution policy, no blocked .ps1, no antivirus rule around scripts.
- The server waits for the helper's `started` marker before it closes the app. If
  the helper cannot start, the update aborts and the app stays open.
- A failed copy restores `data\backups\<version>-<timestamp>` and starts the old
  version.

### Updating from 1.1.1/1.1.2/1.1.3

Those builds still launch the next update with the old helper. Once only:

1. Close Synapse.
2. Download `Synapse-1.1.4-win-x64.zip`.
3. Extract it **over** the Synapse folder, replacing files but keeping `data\`,
   `config\`, `logs\` and `..\Synapse.Projects`.
4. Launch. Version 1.1.4 is now running; the next update uses the Node helper.

If the previous attempt left `data\update\apply.log`, it says where the
PowerShell helper stopped; `data\update\started` is missing when it never ran.

## Tests

- Full suite: 252 tests.
- Asset: `Synapse-1.1.4-win-x64.zip` with `SHA256SUMS`.
