# Synapse v1.0.3

Two bugs from the first day on a second machine: a LAN door that said it was
open, and Full auto that promised to answer and did not.

## Fixed

- **Full auto now belongs to the project, not just the Architect's session.** A
  worker asking for a shell command or an edit is in the same project as the chat
  whose switch the operator turned on, but its session carried no Full auto flag —
  so the card sat there while its note said "Full auto is set to answer
  immediately". The permission gate and the question sweep now read the project's
  switch, and the runner copies it into each worker's metadata for restarts. A
  worker's card is answered at the wait, and at **0** it is answered at once with
  no card.
- **Turning Full auto off on the chat overrides a worker that was created while
  it was on**, so an old worker cannot keep answering behind the operator's back.
- **Remote Access is off at every start.** Restoring it from the config left a
  listener that showed "on" while the LAN could not reach it; toggling off and on
  was what actually opened it. The server now resets the switch to off, and the
  config with it, before it binds. Turn it on from the desktop after the server
  is up; the token is unchanged.

## Checked

- **Keep Running is live.** The switch writes the session metadata and the brief
  immediately, and the runner reads `auto` when the report arrives — so a report
  delivered after the flip is judged with the new value. No restart, no reload.
- The Full auto wait was already live (`permissionGate.retime()` re-arms open
  cards), and the Settings pane now says so: a change applies at once, including
  to a card already open.

## Tests

- New: a worker's permission ask is answered by the chat's Full auto switch; a
  worker saved with it on is overridden when the chat's switch goes off; the same
  two cases for worker questions.
- Full suite: 251 tests.

## Notes

- The Remote Access token and the LAN address are unchanged; only the switch
  resets. A laptop that was signed in stays signed in after the desktop switches
  it back on.
