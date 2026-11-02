# TODO — things the operator asked to leave for later

Written down on 27 Oct so they are not lost, not designed yet. Each entry says
what was asked, why it is not a small change, and what has to be decided before
anyone builds it. None of these is a rule; the rules are in `AGENTS.md` and the
other notes.

## Russian interface

Asked for on 2 Nov, deferred by the operator on 2 Nov ("moves to a TODO list until
further notice"). The selector is already in Settings → General, holding English
alone, and `src/config.js` accepts `en` only (`UI_LANGUAGES`), so a hand-edited
`"language": "ru"` falls back instead of asking the page for strings that do not
exist. The selector is a place for the translation to land, not a switch that
pretends to work.

What it needs, in the order it has to be decided:

- **Scope.** Every user-facing string in `web/app.js` is written inline — several
  thousand literals, plus composed sentences. Translation means a string table and a
  `t()` call around each one, which is a mechanical pass over a 9,000-line file, and
  this project has no build step by rule (AGENTS #1). The decision is whether the
  whole interface is in scope, or Settings and the shell first.
- **Plurals.** The interface is full of counts ("3 file(s) read, 2 waiting"). Russian
  has three plural forms, so a naive `${n} files` breaks the moment it is translated
  properly. The string table needs a plural form, not just a map.
- **What must never be translated:** model output (it answers in the language it is
  written to), project names, log and console lines, and the briefs in
  `src/plans.js` — those are sent to the engine, and a rule in Russian is a rule the
  next model may not read as well.
- **One word per concept.** The briefs and the UI share vocabulary — `plan`, `run`,
  `task`, `role`, `report`. A translation has to pick one Russian word for each and
  keep it, or the interface and the briefs describe the same thing differently.
- **A test that proves it.** The guard should be the shape of
  `tests/chat-text.test.mjs`: in Russian mode, no English literal may reach the
  screen. That needs the string table to be the only source, which is another reason
  the mechanical pass comes first.

Nothing else is outstanding as of 2 Nov. The last two — the working wash/border light
and the worker-session replacement — are built and recorded in
`docs/notes/ui-lessons.md` and `docs/notes/engine-notes.md`.
