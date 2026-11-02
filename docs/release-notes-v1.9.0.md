# Synapse v1.9.0

General gains the timed shutdown and a language selector, and the layout audit stops
comparing controls across a dialog.

## Added

- **Turn the PC off when the Architect finishes.** Off by default. When on, Synapse
  waits the minutes you type (1–180), then shows a 20-second countdown with a Cancel
  button and turns the machine off. The countdown is the largest thing the interface
  draws, because it is the last thing on screen before the PC goes; the button, a
  click outside the dialog and Escape all cancel.

  The waits live in the **server**, not the page: a hidden window's timers are
  throttled by the browser — once a minute after a while — and Synapse in the tray is
  exactly when this is wanted. A 20-second countdown in a hidden page could have taken
  twenty minutes, or never come. The page arms it, draws the numbers the server
  broadcasts, and asks it to cancel.

  Nothing reaches the act by accident: the setting must be on, no run may be live,
  and the last second re-checks both — so turning the setting off mid-countdown, or a
  run that starts during it, leaves the machine on. A turn that failed or was stopped
  never arms it, because it uses the same "the Architect has finished" signal as the
  chime.

- **A Language selector** in Settings → General, with one option: English. The
  Russian translation is deferred (see `docs/notes/todo.md`), and `src/config.js`
  accepts `en` alone — so the selector is a place for the translation to land, not a
  switch that pretends to work.

## Fixed

- **The audit compared controls across a dialog.** The General pane made the Settings
  dialog taller and its footer button came within a row of the sidebar's Settings link
  behind the backdrop — a finding on a screen that is aligned. The audit now asks the
  browser what is on top at a control's centre and only groups controls in the same
  layer. Two buttons inside a dialog still compare with each other; a test asserts
  both halves. Synapse's own Settings audits clean again.

## Notes

- The countdown is tested with node's mock clock: a full minute-plus-twenty-seconds
  runs in a millisecond, and the cancel-during-wait, cancel-during-countdown and
  run-started cases are each their own test.
- `POST /api/power-off/arm` and `/cancel` are new; `/api/power-off` still exists as
  the confirmed "turn off now" path. None of them is `/api/shutdown`, which stops the
  server and leaves the machine running.
- Full suite: 336 tests.
