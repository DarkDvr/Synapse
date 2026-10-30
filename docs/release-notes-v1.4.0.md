# Synapse v1.4.0

Disk housekeeping: an applied update no longer leaves a gigabyte behind, and
`dist` keeps one release zip instead of every one ever built.

## Added

- **`src/housekeeping.js`** — one small pass, run once at boot after the page is
  up, and by hand with `bin\node\node.exe src\housekeeping.js --dry-run`:
  - **an applied update's staging** is deleted (the zip, the extracted tree, the
    helper copies — about 1.1 GB per update), and older `data\backups` folders go,
    keeping the newest. It only acts when `last.json` says the update succeeded
    and is more than a minute old: the helper starts Synapse *before* it writes
    that record. A failed update is left alone — its staging is the diagnosis.
  - **`dist` keeps the newest release zip** and rewrites `SHA256SUMS` for it.
    Older zips are builds of code git and GitHub already hold, 196 MB each.
- `make-release.ps1` prunes older zips as it builds, so the backlog cannot
  re-form; the boot pass exists for folders that already have one.

## Notes

- Deliberately not swept: the projects' `_scratch` (a model may leave work there
  and a project can resume days later) and the engine's own `snapshot` store
  (347 MB of undo history — it needs the engine stopped, so it is a separate
  action, not a boot pass).
- The manual cleanup that proved the rules freed 3.03 GB: 16 release zips, two
  updates' staging, a pre-migration WebView2 profile, five build/test folders and
  probe screenshots.
- Full suite: 291 tests.
