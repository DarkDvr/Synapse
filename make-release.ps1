# make-release.ps1 - the one zip a release publishes.
#
# It is a complete folder: program files, the seed config, and bin\node +
# bin\opencode, so a new PC can run it. It contains no config\, data\, logs\ or
# projects, so extracting it over an existing Synapse folder leaves the
# operator's settings and work where they are. Synapse copies the seed into
# config\ only when that file does not exist.
#
#   .\make-release.ps1
#   .\make-release.ps1 -Out D:\releases
[CmdletBinding()]
param(
    [string]$Out = (Join-Path $PSScriptRoot 'dist')
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$pkg.version
if (-not $version) { throw 'package.json has no version' }

$required = @(
    'Synapse.exe', 'package.json', 'update-apply.ps1', 'update-apply.mjs',
    'config.default.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY.md',
    'src', 'web', 'skills', 'bin\node', 'bin\opencode', 'bin\agent-browser', 'bin\browser-host'
)
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $rel))) { throw "missing $rel - build it first (.\shell\build.ps1)" }
}

$name = "Synapse-$version-win-x64"
# The update asset keeps the version in its name so every updater finds it. The full
# install asset deliberately does NOT contain the version: old updaters pick the first
# zip whose name contains the release tag, and a 265 MB full install would hit their
# two-minute download timeout. They take the small update; new installs take the full.
$fullName = 'Synapse-full-win-x64'
$stage = Join-Path $Out "$name-stage"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host "staging $fullName..."
$files = @(
    'Synapse.exe', 'package.json', 'update-apply.ps1', 'update-apply.mjs',
    'config.default.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY.md'
)
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage }
# skills carries the shell a Windows app is copied from (skills/win-app/template);
# there is no separate templates folder any more, and the harness refuses one.
foreach ($dir in @('src', 'web', 'skills')) {
    Copy-Item -LiteralPath (Join-Path $root $dir) -Destination $stage -Recurse
}
# A template built once leaves .NET's restore output behind, and it is gitignored
# but would still travel in the zip; strip it from the stage.
$templateObj = Join-Path $stage 'skills\win-app\template\obj'
if (Test-Path -LiteralPath $templateObj) { Remove-Item -LiteralPath $templateObj -Recurse -Force }

# Node and npm travel; the npm-installed copy of the engine does not. It is
# 729 MB of duplicate runtime, and the engine itself is bin\opencode.
$nodeExclude = Join-Path $root 'bin\node\node_modules\@opencode'
robocopy (Join-Path $root 'bin\node') (Join-Path $stage 'bin\node') /E `
    /XD $nodeExclude /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying bin\node ($LASTEXITCODE)" }

# The engine, without the previous binary the update left behind.
robocopy (Join-Path $root 'bin\opencode') (Join-Path $stage 'bin\opencode') /E `
    /XF '*.bak' /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying bin\opencode ($LASTEXITCODE)" }

# The action layer. A native binary, not an npm package; it attaches to the browser the
# harness launches, and bin\ is how it travels.
robocopy (Join-Path $root 'bin\agent-browser') (Join-Path $stage 'bin\agent-browser') /E `
    /XF '*.bak' /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying bin\agent-browser ($LASTEXITCODE)" }

# The WebView2 browser host. A separate process because WebView2 cannot live inside the
# single-file Synapse.exe; it uses the runtime the app's own window already requires.
robocopy (Join-Path $root 'bin\browser-host') (Join-Path $stage 'bin\browser-host') /E `
    /XF '*.bak' /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying bin\browser-host ($LASTEXITCODE)" }

# The private Git, when this machine has one. It is optional: a fresh PC can fetch
# it on first launch, but carrying it means the zip is the whole toolchain.
$gitDir = Join-Path $root 'bin\git'
if (Test-Path -LiteralPath $gitDir) {
    robocopy $gitDir (Join-Path $stage 'bin\git') /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying bin\git ($LASTEXITCODE)" }
}

$readme = @"
Synapse $version — one folder
============================

Extract this folder anywhere writable - not under Program Files - and
double-click Synapse.exe. It starts its own server and opens at
http://127.0.0.1:8700.

Updating an existing install
----------------------------
Extract over the old Synapse folder and replace files. This zip does not contain
config\, data\, logs\ or the projects folder, so it cannot overwrite your
settings, provider keys, chats or work. Synapse copies config.default.json into
config\ only when config\synapse.config.json does not exist.

First run
---------
data\ and logs\ are created beside the exe, and the projects folder as
..\Synapse.Projects. Add provider keys in Settings -> Providers: the seed has
provider definitions, never keys.

Requirements
------------
Windows 10/11, x64; .NET 10 Desktop Runtime; Microsoft Edge WebView2 Runtime.
Node, the engine and agent-browser are in bin\ and need no install.

Licence
-------
AGPL-3.0-only. Copyright (C) 2026 DarkDvr. See LICENSE, NOTICE, THIRD-PARTY.md.
"@
Set-Content -LiteralPath (Join-Path $stage 'README.txt') -Value $readme -Encoding utf8

$fullZip = Join-Path $Out "$fullName.zip"
if (Test-Path -LiteralPath $fullZip) { Remove-Item -LiteralPath $fullZip -Force }
Write-Host "compressing $fullZip..."
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $fullZip -CompressionLevel Fastest

# The self-updater only replaces program files (Synapse.exe, src, web, skills and the
# small metadata files); it never copies bin\. So the update asset is those files and
# nothing else: about 7 MB, well inside every old updater's two-minute download window.
$updateStage = Join-Path $Out "$name-update-stage"
if (Test-Path -LiteralPath $updateStage) { Remove-Item -LiteralPath $updateStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $updateStage | Out-Null
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $updateStage }
foreach ($dir in @('src', 'web', 'skills')) {
    Copy-Item -LiteralPath (Join-Path $root $dir) -Destination $updateStage -Recurse
}
$updateTemplateObj = Join-Path $updateStage 'skills\win-app\template\obj'
if (Test-Path -LiteralPath $updateTemplateObj) { Remove-Item -LiteralPath $updateTemplateObj -Recurse -Force }

$updateZip = Join-Path $Out "$name.zip"
if (Test-Path -LiteralPath $updateZip) { Remove-Item -LiteralPath $updateZip -Force }
Write-Host "compressing $updateZip..."
Compress-Archive -Path (Join-Path $updateStage '*') -DestinationPath $updateZip -CompressionLevel Fastest

$fullHash = (Get-FileHash -LiteralPath $fullZip -Algorithm SHA256).Hash.ToLowerInvariant()
$updateHash = (Get-FileHash -LiteralPath $updateZip -Algorithm SHA256).Hash.ToLowerInvariant()
$sums = Join-Path $Out 'SHA256SUMS'
Set-Content -LiteralPath $sums -Encoding ascii -Value @(
    "$fullHash  $fullName.zip",
    "$updateHash  $name.zip"
)

# One release is enough: the two zips just built. Older zips are builds of code git
# and GitHub already hold, and each is ~196 MB. The boot housekeeping pass does the
# same for a folder that already has a backlog (src\housekeeping.js).
Get-ChildItem -LiteralPath $Out -Filter 'Synapse-*-win-x64*.zip' -File |
    Where-Object { $_.FullName -ne $fullZip -and $_.FullName -ne $updateZip } |
    ForEach-Object { Write-Host "removing old release $($_.Name)"; Remove-Item -LiteralPath $_.FullName -Force }
$sumsFull = Join-Path $Out 'SHA256SUMS-FULL'
if (Test-Path -LiteralPath $sumsFull) { Remove-Item -LiteralPath $sumsFull -Force }

Remove-Item -LiteralPath $stage -Recurse -Force
Remove-Item -LiteralPath $updateStage -Recurse -Force

Write-Host ''
Write-Host "full install: $fullZip"
Write-Host "update:       $updateZip"
Write-Host "checksum:     $sums"
Write-Host ("sizes:        full {0:N1} MB, update {1:N1} MB" -f `
    ((Get-Item -LiteralPath $fullZip).Length / 1MB), ((Get-Item -LiteralPath $updateZip).Length / 1MB))
Write-Host ''
Write-Host "Attach both zips and the checksum to the GitHub release for v$version."

