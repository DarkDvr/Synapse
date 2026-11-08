# Deferred work

Things Synapse knows it does not do yet. Each one names the note that holds the
thinking, because the note is where the measurements are. Nothing here is a
promise and nothing here is a bug: a bug goes in the commit that fixes it.

| Deferred | Why it is not done | Read |
|---|---|---|
| The Russian interface | The strings are in `web/app.js` and the briefs, and a half-translated page is worse than an English one. The scope — what must never be translated, plurals, the language switch — is decided already. | `docs/notes/i18n.md` |
| A sign-in window for sites that need a login | Every cookie route was measured and one destroyed the operator's browser data; Brave is never touched. The shipped answer is a pasted Cookie header, site by site. | `docs/notes/web-reading.md` |
| A second engine | The core is engine-agnostic and the contract exists, but the second adapter has never been written, so the abstraction is unproven. | `docs/notes/runtime-scope.md`, `src/engines/base.js` |
| The coding-practice items from the audit | Six are left, each a refactor with its own risk: the rest of `web/app.js` (2,271 lines of boot, events and small behaviours), catch discipline, the wake loop out of `runs.js`, event-name constants, sync fs on the request path, one error helper. The ranked report and the step plan are in git (`audit-2026-11-06`, `refactor-plan`), staged on disk in `staged for deletion/docs/`. | `staged for deletion/docs/` (or git history) |
