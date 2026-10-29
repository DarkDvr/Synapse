# make-release.ps1 - the update zip for an existing Synapse install.
#
# This is NOT the travel copy: it carries program files only, no data\, no
# config\, no logs\ and no bin\. The in-app updater stages it, the helper waits
# for Synapse to close and overlays these paths. Settings, provider keys, chats
# and projects stay where they are.
#
#   .\make-release.ps1
#   .\make-release.ps1 -Out D:\releases
#
# Attach the zip and SHA256SUMS to the GitHub release for this version. The
# updater downloads the zip named in the release, so the tag and the file must
# agree.
[CmdletBinding()]
param(
    [string]$Out = (Join-Path $PSScriptRoot 'dist')
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$pkg.version
if (-not $version) { throw 'package.json has no version' }

$exe = Join-Path $root 'Synapse.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Synapse.exe is missing - build it first (.\shell\build.ps1)' }
foreach ($rel in @('src', 'web', 'skills', 'templates', 'update-apply.ps1', 'package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $rel))) { throw "missing $rel" }
}

$name = "Synapse-$version-win-x64"
$stage = Join-Path $Out "$name-stage"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host "staging $name..."
foreach ($file in @('Synapse.exe', 'package.json', 'update-apply.ps1')) {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage
}
foreach ($dir in @('src', 'web', 'skills', 'templates')) {
    Copy-Item -LiteralPath (Join-Path $root $dir) -Destination $stage -Recurse
}

$zip = Join-Path $Out "$name.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Write-Host "compressing $zip..."
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$sums = Join-Path $Out 'SHA256SUMS'
Set-Content -LiteralPath $sums -Value "$hash  $name.zip" -Encoding ascii

Remove-Item -LiteralPath $stage -Recurse -Force
Write-Host ''
Write-Host "release asset: $zip"
Write-Host "checksum:     $sums"
Write-Host ("size:         {0:N1} MB" -f ((Get-Item -LiteralPath $zip).Length / 1MB))
Write-Host ''
Write-Host "Attach both to the GitHub release for v$version."
