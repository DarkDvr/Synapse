# Two people, one Synapse

The app can be open on this PC and on a laptop at once. Both talk to the same server,
engine and projects. Every rule here exists to stop an **accident**, not a hostile
network: the LAN is trusted, the token is the door, and the people are the operator.

## What "busy" means

A **project** is busy when a session in it is running a turn, a delegated run is in
flight, or a card or question from it is waiting. An idle project is free. A project
waiting for a card is busy but **answerable** — that is the case the laptop exists for.

**A project is one conversation**, so a busy project locks only itself.

Busy is derived from work, never from a click. A tab that closes, crashes or sleeps
therefore cannot hold a project: nothing to expire, nothing to leak.

## The rules

1. **Any view may steer while the project is busy.** The message joins the running
   turn at its next step: guidance for the work in flight, not a second
   conversation. The composer says **Steer** with a yellow border. Cards and questions
   still block the composer — that project's, in that project's chat. Stop is
   unchanged and always available.
2. **Cards are answerable from any view.** The first answer wins and is broadcast: other
   views close the panel and repaint the chip. A second answer is a no-op.
3. **Stop is available everywhere, always, and it is two-stage.** The first press asks
   the work to finish the step it is in and end; the second cuts it off. The notice is
   broadcast, so a second press anywhere is the hard one. Stop wakes nobody and
   explains nothing: the model sees a cut, like a dropped connection. After a stop,
   change the model, type Continue, send. Your next message is also the first thing
   that can tell the Architect the run ended — the brief adds one state line, without
   saying why (30 Oct, test5).
4. **Single/Multi follows the same rule:** switchable only while the project is idle.
   The button is greyed with the reason and the server refuses a stale page.
5. **Settings are edited by one view at a time.** Opening takes a lock; closing, or
   losing the connection, releases it. Another view is told which computer holds it.
6. **Presence.** Every view is labelled with the computer's name: "busy — laptop,
   Fever Tracker" is the sentence these rules exist to produce.
7. **Changes travel.** The Remote Access switch and saved settings are broadcast. No
   rule here is implemented by refreshing the page: a reload is how a half-typed
   prompt dies.
8. **The server is the authority.** Every rule is enforced where the action is
   accepted, so a stale tab or `curl` meets the same refusal.
9. **Every broadcast says which view caused it.** A frame is written once for every
   view, so it cannot carry `yours`: the page compares the sender's id with its own.
   Without that, a view read its own action as somebody else's and said "being edited
   on ANDREWS" — the machine you are sitting at (31 Oct, twice).

## Failure modes

- **A view disappears with Settings open.** Its stream closes, the lock is released;
  a lock also carries a heartbeat, and a holder silent for fifteen minutes loses it.
- **Your own action reported back as somebody else's** is rule 9. The events carry
  `byId`; `tests/own-events.test.mjs` guards it, and a broadcast frame that gains a
  consequence without an origin is the bug that grows back.
- **A stuck turn.** Stop is the escape hatch, which is why it is not restricted.
- **Two answers at once.** The first is recorded and broadcast; the second gets
  `already answered` and the panel closes anyway.
- **A steer sent as the work ends.** The server refuses it and the composer keeps the
  text, so Send again sends it as a normal message.
- **A reload while busy.** The page rebuilds from `/api/status`, `/api/pending` and
  the stream; it does not need the previous page to have been kind.

## Deliberately not done

No separate "take over" control (Stop is the takeover). No field-level merge or
conflict dialog for Settings (the lock prevents the conflict). No read-only mode (a
view blocked from sending is already a viewer). No locking of the tray or the shell.

Where it lives: `src/presence.js` (who is connected, the name, the settings lock),
`src/busy.js` (is this project busy, and why), `src/server.js` (the routes that refuse
and the events that broadcast), `web/app.js` (the disabled Send, the greyed mode
switch, the Settings lock, the close-on-decision handler).
