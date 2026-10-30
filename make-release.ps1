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
    'src', 'web', 'skills', 'templates', 'bin\node', 'bin\opencode'
)
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $rel))) { throw "missing $rel - build it first (.\shell\build.ps1)" }
}

$name = "Synapse-$version-win-x64"
$stage = Join-Path $Out "$name-stage"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host "staging $name..."
$files = @(
    'Synapse.exe', 'package.json', 'update-apply.ps1', 'update-apply.mjs',
    'config.default.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY.md'
)
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage }
foreach ($dir in @('src', 'web', 'skills', 'templates')) {
    Copy-Item -LiteralPath (Join-Path $root $dir) -Destination $stage -Recurse
}

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
Node and the engine are in bin\ and need no install.

Licence
-------
AGPL-3.0-only. Copyright (C) 2026 DarkDvr. See LICENSE, NOTICE, THIRD-PARTY.md.
"@
Set-Content -LiteralPath (Join-Path $stage 'README.txt') -Value $readme -Encoding utf8

$zip = Join-Path $Out "$name.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Write-Host "compressing $zip..."
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Fastest

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$sums = Join-Path $Out 'SHA256SUMS'
Set-Content -LiteralPath $sums -Value "$hash  $name.zip" -Encoding ascii

# One release is enough: the zip just built. Older zips are builds of code git
# and GitHub already hold, and each is ~196 MB. The boot housekeeping pass does
# the same for a folder that already has a backlog (src\housekeeping.js).
Get-ChildItem -LiteralPath $Out -Filter 'Synapse-*-win-x64*.zip' -File |
    Where-Object { $_.FullName -ne $zip } |
    ForEach-Object { Write-Host "removing old release $($_.Name)"; Remove-Item -LiteralPath $_.FullName -Force }
$sumsFull = Join-Path $Out 'SHA256SUMS-FULL'
if (Test-Path -LiteralPath $sumsFull) { Remove-Item -LiteralPath $sumsFull -Force }

Remove-Item -LiteralPath $stage -Recurse -Force

Write-Host ''
Write-Host "release asset: $zip"
Write-Host "checksum:     $sums"
Write-Host ("size:         {0:N1} MB" -f ((Get-Item -LiteralPath $zip).Length / 1MB))
Write-Host ''
Write-Host "Attach both to the GitHub release for v$version."
