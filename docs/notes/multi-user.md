# Two people, one Synapse

The app can be open on this PC and on a laptop at the same time. Both talk to the
same server, the same engine and the same projects. These are the rules for that,
and every one of them exists to stop an **accident**, not to defend against a
hostile network: the LAN is trusted, the token is the door, and the people are
the operator.

## What "busy" means

A **project** is busy when any of these is true:

- a session in it is running a turn;
- a delegated run in it is in flight (a worker is working, or the run is between
  steps);
- a permission card or a question from it is waiting for an answer.

An idle project is free. A project waiting for a card is busy but **answerable** —
that is the case the laptop exists for.

**A project is one conversation.** Every project has its own folder and chat, so a
busy project locks only itself; one project's chat must never block another.

Busy is derived from work, never from a click. A tab that closes, crashes or
sleeps therefore cannot hold a project. Nothing to expire, nothing to leak.

## The rules

1. **Any view may steer while the project is busy.** The message joins the running
   turn at its next step: it is guidance for the work in flight, not a second
   conversation. The composer says **Steer** with a yellow border, whoever is
   typing. Cards and questions still block the composer — answer those first.
   Stop is unchanged, and always available.
2. **Cards are answerable from any view, busy or not.** The first answer wins and
   is broadcast: every other view closes the panel and repaints the chip. A
   second answer is a no-op, not an error.
3. **Stop is available everywhere, always, and it is two-stage.** The first press
   asks the work to finish the step it is in and end; the second cuts it off
   immediately. The notice and the red glow are broadcast, so every view knows a
   stop is in progress and a second press anywhere is the hard one. Stop wakes
   nobody: the next brief carries what happened. After a stop, change the model,
   type Continue, send. There is no separate takeover button.
4. **Single/Multi follows the same rule** as a prompt: switchable only while the
   project is idle. The button is greyed with the reason, and the server refuses
   the change even if a stale page asks.
5. **Settings are edited by one view at a time.** Opening Settings takes a lock;
   closing it, or losing the connection, releases it. Another view is told which
   computer holds it and the panel does not open. There is no merge and no
   overwrite prompt while the lock works.
6. **Presence.** Every view is labelled with the computer's name. "busy — laptop,
   Fever Tracker" is the sentence the rules are written to produce.
7. **Changes travel.** The Remote Access switch and saved settings are broadcast,
   so both views agree without a reload. No rule here may be implemented by
   refreshing the page: a reload is how a half-typed prompt dies.
8. **The server is the authority.** Every rule above is enforced where the action
   is accepted; the greyed button and the message are the honest face of it. A
   stale tab or `curl` must meet the same refusal.

## Failure modes, and what handles them

- **A view disappears with Settings open.** Its stream closes, the lock is
  released, and the next view may open it. A lock also carries a heartbeat: a
  holder that stops answering for fifteen minutes loses it.
- **A stuck turn.** Stop is the escape hatch (rule 3), which is why it is not
  restricted.
- **Two answers at once.** The first decision is recorded and broadcast; the
  second gets `already answered` and the panel closes anyway (rule 2).
- **A steer sent as the work ends.** The server refuses it and the composer keeps
  the text, so pressing Send again sends it as a normal message. The run's report
  is the record either way.
- **A reload while busy.** The page rebuilds from `/api/status`, `/api/pending`
  and the stream; it does not need the previous page to have been kind.

## Deliberately not done

- **No separate "take over" control.** Stop is the takeover.
- **No field-level merge or conflict dialog for Settings.** The lock prevents the
  conflict; a merge would only matter if two people edited the same file at once,
  which the lock forbids.
- **No read-only mode.** A view that is blocked from sending is already a viewer:
  it sees the transcript, the cards and the console live, and can answer.
- **No locking of the tray or the shell.** The desktop app is one view of the
  same server; the rules are for pages.

## Where it lives

- `src/presence.js` — who is connected, the computer's name, the settings lock.
- `src/busy.js` — is this project busy, and why.
- `src/server.js` — the routes that refuse, and the events that broadcast.
- `web/app.js` — the disabled Send, the greyed mode switch, the Settings lock and
  the close-on-decision handler.
