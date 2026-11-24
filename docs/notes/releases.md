# Releases and versioning

The operator reads the number in the rail to know which build is answering, and the
tag is what a bug report points at.

## The three numbers

- **Patch — `1.0.0` → `1.0.1`.** A fix, a wording change, a regression.
- **Minor — `1.0.0` → `1.1.0`.** A feature, a new screen, a change to how the harness
  behaves, a contract other code relies on.
- **Major — `1.0.0` → `2.0.0`.** An old config, project or model choice stops working.

## Where the number lives

`package.json` `version` is the single source. `src/version.js` reads it, `/api/status`
returns it, and the rail shows `v1.75.1` under STATUS. The boot line in `logs/app.log`
carries it too, so a stale server is visible before any behaviour is blamed.

**The note is the server, not the exe.** It is set from `/api/status` and re-read when
the stream reconnects, so a restart moves it without closing the window. The window
bar used to carry it and drifted (6 Nov: 1.29.0 running, the bar on 1.28.3).

Two things mirror it and are bumped in the same commit: `shell/Synapse.csproj`
`<Version>` and the line under the README title. `tests/version.test.mjs` fails when
the three disagree. **Stage those three by name**, not the whole tree: on 17 Nov an
unrelated commit carried a version backwards and the suite went red on a commit whose
message said nothing about it.

## The release checklist

1. Bump `package.json`, `shell/Synapse.csproj`, `README.md`.
2. Run the suite through `bin\node\node.exe scripts\checks.mjs`.
3. **Read `/api/runs` and `/api/pending` immediately before you stop anything** — a
   run can begin between two checks (8 Nov: a t5 started four minutes after one and
   died at the next restart).
4. `.\shell\build.ps1` then `.\make-release.ps1`; `dist\` gets **two zips** and
   `SHA256SUMS`.
5. Commit, tag `vX.Y.Z`, push `main` and the tag. The push is the delivery and does
   not wait.
6. **A GitHub release is the operator's call.** When they ask: write
   `docs/release-notes-vX.Y.Z.md`, attach both zips and `SHA256SUMS`, publish — then
   **delete the local note**. The release page is the record.

## Two zips, because old updaters cannot be changed

The updater travels inside each installed copy. A 1.47.2 copy will still use its
two-minute download timeout and its own extraction code, whatever we ship later. The
release therefore publishes two assets:

- `Synapse-X.Y.Z-win-x64.zip` — the **update** asset. It contains only what the
  self-updater replaces: `Synapse.exe`, `src\`, `web\`, `skills\` and the small
  metadata files. About 5–8 MB, which fits inside every old updater's window.
- `Synapse-full-win-x64.zip` — the **new install** asset. It has the same contents
  plus `bin\` (Node, the engine, the browser host) and is about 265 MB.

The full install's name deliberately has **no version in it**. Old updaters pick the
first zip whose name contains the release tag; only the small update carries the tag,
so they take the small one. The release notes must link a new install to the full
asset. The two names are not interchangeable.


A docs-only change is a commit, not a release: it moves no behaviour, so the version
does not move and the exe is not rebuilt.
