# Synapse v1.30.0

The page is modules now, the providers are the operator's own rows, and the harness
can be read without being written. A Windows app ships as a skill instead of a
folder in Synapse, an attachment looks the same wherever it appears, and a fast
model no longer makes the chat stutter.

## Changed

- **`app.js` is no longer one file.** The 6,000-line spine was split into about
  forty modules over a series of stages, each reviewed before the next: the
  transcript, the traces, the composer, the rail, the plan pane, the Settings
  panes, the role cards, the run bookkeeping, the dialogs, the console. What is
  left is the boot sequence, the event stream and the wiring between modules. A
  module is handed the app's own functions at boot and throws if one is missing,
  so a forgotten wire shows up on the page rather than as a silent no-op.
  `scripts/check-imports.mjs` is the checker this needed: it reads exports and
  imports, and it found eight dead pages that a human read had missed.

- **OC Zen and OC Go are ordinary providers.** They were built into the page as
  two rows with their own handling; they are now added, renamed and removed like
  any other OpenAI-compatible provider, and the provider list is whatever the
  operator's config holds. A provider's model prefix is a field you can type,
  with the derived prefix shown as a hint and a duplicate refused — two providers
  sharing a prefix would offer the same model twice under two names.

- **The harness can be read; it cannot be changed.** The old allow-list refused
  `templates/` and every other folder it did not name, which killed a run whose
  worker was told to copy a scaffold. The rule is a denylist now: `data/`,
  `config/`, `bin/`, `.git/`, `vendor/`, `node_modules/` and `templates/` are
  closed, everything else inside Synapse may be read, and a write still asks.
  A refusal is no longer silent: it is broadcast to the chat with the call and
  the reason, because a refused call ends the turn.

- **A Windows app is a skill, not a folder in Synapse.** `templates/win-app`
  became `skills/win-app/template` with a `SKILL.md` carrying the build steps,
  and the brief names the skill rather than a path in the harness. A role that
  was not granted the skill cannot load it.

- **One chip for every attachment.** The chat's attachment chip is one function
  now, and everything that can show a file calls it: a message, a model's answer,
  and a steer's picture. A steer to a worker saves its file in the project
  (`.synapse/attachments/`), so the chip on the run's STEER line survives a
  reload and shows the picture on hover.

- **The streamed slide keeps up with a fast model.** The panel used to snap to
  "newest line minus 8px" every frame, so at speed the text moved in line-sized
  jumps. The writing's speed is fed forward into the slide now, eased over a
  third of a second, and the readable-line cap is closed over frames. Measured at
  60fps: 4px per frame at a line every 150ms, 6px at a line every 50ms, and a
  burst of ten lines spreads over 0.2s instead of landing in one frame.

- **A provider that states its window is believed.** OpenRouter and OpenCode Zen
  put it in `limit: { context, output }`, and that shape was not read — so
  `deepseek-v4.1-flash` on OC Go was budgeted from the engine's shipped catalog
  (200k) while the provider serves 1M. Settings → Providers → Ask The Provider now
  records the real number, and 24 models were re-measured on this machine.

- **The engine's store is cleaned up.** A dead-conversation sweep runs at boot and
  daily, and the store is vacuumed before the engine starts: 207 forgotten
  conversations gave back 176 MB.

## Fixed

- **A finished run told the Architect it had finished.** `report.js` lost its
  `tokens` and `QC_ROUNDS` helpers in the split, so every completed delegation
  threw and the Architect was never woken. It is the failure the split existed to
  make visible, and the suite caught it.

- **The write tool asked nobody.** `edit` had an ask rule and `write` did not, so
  any model could create any file anywhere. Both ask now.

- **A mode switch replaced the permission policy.** Switching Single → Multi sent
  the single-mode ruleset instead of adding to it, which disabled the protections
  the multi rules had installed.

- **The app-check launcher did not ask for the screen.** Only `window.ps1`
  matched the screen rule, so `app-check.mjs` could take the mouse and keyboard
  without a card.

- **The chime meant two things.** It played when a worker gave the screen back,
  so it was heard mid-run and read as the job ending. The sound is the finish and
  nothing else; the toast still says the screen is free.

- **A page that dies while it loads now says so**, instead of a blank window: a
  ten-second fallback box, and the boot error is reported to the server.
