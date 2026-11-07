# Deferred work

Things Synapse knows it does not do yet. Each one names the note that holds the
thinking, because the note is where the measurements are. Nothing here is a
promise and nothing here is a bug: a bug goes in the commit that fixes it.

| Deferred | Why it is not done | Read |
|---|---|---|
| The Russian interface | The strings are in `web/app.js` and the briefs, and a half-translated page is worse than an English one. The scope — what must never be translated, plurals, the language switch — is decided already. | `docs/notes/i18n.md` |
| A sign-in window for sites that need a login | Every cookie route was measured and one destroyed the operator's browser data; Brave is never touched. The shipped answer is a pasted Cookie header, site by site. | `docs/notes/web-reading.md` |
| A second engine | The core is engine-agnostic and the contract exists, but the second adapter has never been written, so the abstraction is unproven. | `docs/notes/runtime-scope.md`, `src/engines/base.js` |
| The coding-practice items from the audit | Deliberately not all at once: each one is a refactor with its own risk, and the report ranks them. | `docs/audit-2026-11-06.md` |
| A skill may copy its assets into a project | The protection rule refuses any shell statement naming Synapse unless it only reads, so `Copy-Item` from `skills/win-app/template` is refused and a coder has to read each file and write it again. The fix is a carve-out: a copy whose source is under `skills/` and whose destination is outside Synapse is a read. It changes the fence, so it waits for a run to end and for the permission tests. | `docs/notes/protection.md` |
