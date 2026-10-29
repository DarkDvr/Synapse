# Synapse v1.0.4

One card bug, and the Full auto coverage from 1.0.3 restated because it is the
other half of the same screen.

## Fixed

- **A red line on a role card clears as soon as the worker does something.** The
  "Retrying at 20:53 — Nothing happened for 10 min — restarting" line stayed on
  the card through the whole next turn, so a worker running at 300 tok/s sat
  under an error that had already been dealt with. The first sign of life in a
  new turn — a message, a tool call, a streamed word — now clears it. A fresh
  failure raises a fresh line.
- The same clear happens when a retry or a stall restart begins, before the
  worker is nudged, so the card cannot claim it is retrying while it is working.
- A replaced worker session (compaction or an oversized prompt) clears its
  "starting a fresh session" line too.

## Full auto, for the record

1.0.3 made Full auto the project's switch: every role, every permission ask and
every question in the chat it was turned on in. A worker's card is answered at
the wait, and at **0** it is answered at once with no card. An explicit off on the
chat overrides a worker that was created while it was on; new workers copy the
switch into their metadata so a restart keeps it.

## Tests

- New: the stall test asserts the restart line clears on resume, not only when
  the turn ends.
- Full suite: 251 tests.

## Updating an install that is already in use

The travel-copy script is a **fresh install**: it deliberately leaves `data\`
out and ships a sanitized `config\`. Replacing the whole folder therefore takes
the provider keys (`data\provider-keys.json`), the engine sessions with the
per-chat Full auto and Keep Running flags (`data\engine\`), and the provider
definitions in `config\synapse.config.json`. Projects and plans live beside the
folder and survive.

For a patch, copy **program files only** over the existing folder — `Synapse.exe`,
`src\`, `web\`, `skills\`, `templates\` and `bin\` — and leave `data\`, `logs\`,
`config\` and the projects folder alone. The next release will ship a small
updater for this; see the release discussion.
