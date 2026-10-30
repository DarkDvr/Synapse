# Synapse v1.4.1

Two more housekeeping steps: a project's spent render profiles and the engine's
own undo store, which is emptied every time the engine starts.

## Added

- **Spent render profiles** — every render starts Chrome with a throwaway profile
  (`visual-review-<pid>-<width>-<time>`, ~12 MB) under the shared scratch root.
  The renderer deletes its own, but Windows often keeps a file locked, so 108 of
  them (180 MB) had piled up. The boot pass removes the ones older than a day.
  A **project's** own scratch folder (`<project>-<hash>`) is never touched,
  however old — a project can be resumed days later, and its brief says it may
  keep work there.
- **The engine's snapshot store** — `data\engine\opencode\data\opencode\snapshot\global`
  (347 MB, the largest single thing under `data`) is the engine's undo history: its
  copy of every file a model edited. Synapse never uses the engine's revert, so it
  is emptied **just before every engine start**, in the OpenCode adapter. Only
  `global`'s children go; the folder stays for the engine to rebuild in, and the
  chats, the database and the project files are untouched. The cost is the
  engine's undo across restarts, which nothing here depends on. It is best-effort:
  a failed reclaim never blocks a start.

## Notes

- The clean that prompted this freed 3.03 GB by hand; these two steps keep the
  two streams that were still growing from needing a person.
- Full suite: 293 tests.
