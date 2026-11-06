# Releases and versioning

Synapse is versioned `major.minor.patch`, and the number is not decoration: the
operator reads it in the title bar to know which build is answering, and the
tag on GitHub is what a bug report points at.

## The three numbers

- **Patch — `1.0.0` → `1.0.1`.** A fix, a wording change, a regression, a small
  improvement. Most days are a patch.
- **Minor — `1.0.0` → `1.1.0`.** A feature, a new screen, a change to how the
  harness behaves, a contract other code or the operator relies on. If the
  release notes would need a "What changed" heading, it is minor.
- **Major — `1.0.0` → `2.0.0`.** A break: an old config, project or model choice
  stops working, or the architecture changes under the operator's feet.

## Where the number lives

`package.json` `version` is the single source. `src/version.js` reads it,
`/api/status` returns it, and the rail shows `v1.0.2` as a grey note at the right
of the STATUS label — one place, and one that can be right. The boot line in
`logs/app.log` carries the same number, so a stale server is visible before any
behaviour is blamed.

The window bar used to carry it, and that was the bug: the WPF frame read
`package.json` once, at launch, so it kept showing the number the window started
with while the server ran a newer one (6 Nov: 1.29.0 running, the bar on 1.28.3).
The note is set from the server's own answer and re-read when the stream
reconnects, so a restart moves it without closing the window.

Two things mirror it and are bumped in the same commit:

- `shell/Synapse.csproj` `<Version>` — the exe's file properties.
- `README.md` — the line under the title.

`make-deliverable.ps1` stamps the travel copy's README and zip from
`package.json`, so a released folder and its source cannot disagree.

## The release checklist

1. Bump `package.json` and `shell/Synapse.csproj` to the new number.
2. Update the `README.md` version line.
3. A minor or major release gets `docs/release-notes-vX.Y.Z.md`; a patch gets
   its note in the commit message and the GitHub release page.
4. Run the suite: `bin\node\node.exe --test "tests\*.test.mjs"`.
5. Build the app and the update asset:
   ```
   .\shell\build.ps1
   .\make-release.ps1
   ```
   `dist\Synapse-<version>-win-x64.zip` carries program files only and
   `dist\SHA256SUMS` is its checksum. Attach both to the GitHub release.
6. Commit, tag, push — all three:
   ```
   git tag v1.0.2
   git push origin main --tags
   ```
7. A patch may be a tag alone; a **minor or major is a GitHub release**, with its
   notes and both assets (the zip and `SHA256SUMS`) attached — that is what the
   operator links to in a report. The tag is the release: a commit without one is a
   draft nobody can point at later.

## Reading a version before debugging

If a behaviour does not match the code in this checkout, the first question is
"which Synapse is running?" — the rail answers it. A server started before the
change is a stale build; restart it before blaming the rule. The console's boot
line says `Synapse 1.0.2 starting`, and `/api/status` reports the same string.

**The note is the server, not the exe.** It is set from `/api/status`, so it says
what is answering right now; the exe's own file properties are the version that
was built, and `tests/version.test.mjs` is what catches a bump that was forgotten
— the three places that carry the number must agree.
