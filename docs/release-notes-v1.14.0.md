# Synapse v1.14.0

The two blunt run switches are four, each doing one job, and Settings has an
Automation tab for the waits they obey.

## Changed

- **Full Auto and Keep Running are gone.** They were two switches doing four jobs
  between them, and the pairing was the bug: an operator who wanted questions
  answered also had every permission allowed, and one who wanted the plan carried
  through had no say about permissions at all. The cog in a chat now holds four
  independent switches, per project:

  - **Keep Building** - carry the plan through to the end, or to a blocked task.
    On by default, and the same thing "Keep Running" did when it was on.
  - **Auto-Permissions** - a permission card is allowed once, by itself, after its
    wait. Off by default.
  - **Auto-Answer** - a question takes the Recommended option (or the top row)
    after its wait. Off by default.
  - **Auto-Shutdown** - the PC goes off when nothing is running, nothing is
    waiting, and nothing can start on its own. Off by default.

  The switches live in the chat's own metadata, so they travel with it and survive
  a restart. A chat saved under the old names keeps what it had: Keep Running
  becomes Keep Building, Full Auto becomes both answering switches, and the old
  global "turn the PC off when it finishes" is read as Auto-Shutdown.

- **Settings → Notices is gone; its one setting moved to General.** The
  finished-work sound is the only thing that tab held, and a tab for one field is a
  place the operator forgets to look.

- **Settings → Automation holds the four waits**, in every project, past and
  future: Keep Building 5 seconds between a report and the next task,
  Auto-Permissions 10 seconds before allowing, Auto-Answer 30 seconds before
  answering, Auto-Shutdown 5 minutes of idle before the countdown. 0 means "at
  once" for the three second-based waits.

- **Auto-Shutdown's clock is the server's**, like the timed shutdown before it: a
  hidden window throttles its timers, and the operator who needs this is asleep
  with Synapse in the tray. It waits for the whole machine to be quiet, then the
  idle minutes, then the same 20-second countdown with Cancel - and a cancel starts
  the wait again rather than re-arming immediately.

## Fixed

- The question head reads "Auto-Answer replies in 30s unless you answer first",
  and it reads the *asking* chat's switch rather than the one on screen, so a
  worker asking from another project is described by its own project.
