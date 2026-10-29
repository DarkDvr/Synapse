# Synapse v1.1.3

The update helper no longer depends on PowerShell, and the answer sits one line
lower.

## Fixed: the update closed the app and did nothing

A 1.1.1 install on a second PC said it would update, closed, and never came back;
launching it manually still showed 1.1.1. The helper was a PowerShell script
started detached after the server exited. If that script did not start — execution
policy, a blocked .ps1, antivirus, or the script simply failing before its first
log line — the app was already gone and nothing recorded why.

- **The helper is now Node**, run by the `bin\node` that travels with Synapse:
  `update-apply.mjs`. No execution policy, no PowerShell, no .ps1 rules. It waits
  for the server and shell pids, backs up the program files, copies the stage,
  writes `data\update\last.json`, and starts `Synapse.exe`.
- **The server waits for the helper's `started` marker before it closes.** If the
  helper cannot start, the update is aborted, the app stays open, and the dialog
  shows the error. No more dark window.
- The PowerShell helper stays as a fallback for installs older than this one, and
  now writes the same marker.
- The update zip carries `update-apply.mjs`; the deliverable and the release
  script include it.

### If you are on 1.1.1 or 1.1.2

That build still uses the old PowerShell path for its **next** update, so the
first move has to be manual: download `Synapse-1.1.3-win-x64.zip`, extract it
over the Synapse folder (replace files; keep `data\`, `config\`, `logs\` and the
projects folder), and launch once. From 1.1.3 onward the chip updates through the
Node helper. The old `data\update\apply.log` and `last.json` are still there and
say where the PowerShell attempt stopped; `data\update\started` will be missing
if the script never ran.

## Fixed: the gap above the answer

The green rule on the final answer now starts **one line lower** (20 px instead
of 9 px), so there is a clear split between the reasoning/tool work and the
prose, as in the reference. The rule still belongs only to the last text of a
tool-free assistant message.

## Notes

- Full suite: 252 tests.
- Release asset: `Synapse-1.1.3-win-x64.zip` with `SHA256SUMS`.
