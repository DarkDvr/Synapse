# Synapse 1.85.0

This release gathers the browser, chat and restart work since 1.82.10.

## Steer is immediate, and says when it lands

- A steer is painted the moment Steer is pressed — before the request returns.
  The `STEER:` tag breathes while the model has not read it, and stops at the
  engine's next step. A steer that is only an attachment now works too: the tag
  and its chip are the whole line.
- A finished run clears a pending steer instead of leaving it breathing on a
  trace nobody will read.

## SynaBrowse

- `nxm://` links are handed to the registered handler, so Nexus "Mod manager
  download" / "Slow download" can reach ModOrganizer2. Only `nxm` leaves the
  browser; other custom schemes stay inside it.
- The hand-off catches an anchor click, `window.open`, a navigation and the
  resource request, because WebView2 does not raise every one of those for a
  custom scheme.
- A rebuilt browser host is not adopted while an older host is still running:
  close SynaBrowse before testing a new host build.

## Chat

- A compaction is a small tool-shaped row above the thinking pane, not a banner
  at the bottom, with tighter margins.
- A compact keeps the unsent draft and its attachments.
- A question accepts attachments the same way the chat does.
- File actions, copy-into-chat and file drops are in the conversation.

## Safe restarts and builds

- The window adopts a server left by a previous shell, and a restart or
  shutdown is refused while work is live.
- The build no longer swaps files under a running app; old build files are
  removed on the next start.

## Downloads

- **New install:** [Synapse-full-win-x64.zip](https://github.com/DarkDvr/Synapse/releases/download/v1.85.0/Synapse-full-win-x64.zip)
- **Update an existing install:** [Synapse-1.85.0-win-x64.zip](https://github.com/DarkDvr/Synapse/releases/download/v1.85.0/Synapse-1.85.0-win-x64.zip)
- Checksums: `SHA256SUMS`

The update asset contains only the program files the self-updater replaces. The
full install contains `bin\` (Node, the engine, agent-browser and the browser
host) for a new machine.
