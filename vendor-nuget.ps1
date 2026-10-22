# Pre-fetch the .NET packages a Windows app needs, so a copied Synapse can build
# one with no network at all.
#
#   .\vendor-nuget.ps1
#
# The build itself is `dotnet publish` inside a copy of templates\win-app; that
# restores the WebView2 package and — for a self-contained, single-file exe — the
# .NET runtime packs. Normally those come from nuget.org on the first build, which
# is the one thing a fresh PC cannot do offline. So this script builds the template
# once with NUGET_PACKAGES pointed at vendor\nuget-packages, and the files that
# restore would have downloaded stay there.
#
# The engine is started with NUGET_PACKAGES set to the same folder (see
# src/engines/opencode.js), so every worker's `dotnet build` in any project finds
# them without asking the network. vendor\ is not in git: it is a cache.
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$packs = Join-Path $root 'vendor\nuget-packages'
$template = Join-Path $root 'templates\win-app'

if ((Test-Path (Join-Path $packs 'microsoft.web.webview2')) -and -not $Force) {
  Write-Host "already vendored: $packs   (use -Force to refresh)"
  exit 0
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw 'No dotnet on PATH. Install the .NET SDK once (https://dot.net) and run this again.'
}

New-Item -ItemType Directory -Force -Path $packs | Out-Null
$work = Join-Path $env:TEMP "synapse-vendor-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $work | Out-Null

try {
  Copy-Item (Join-Path $template '*') $work -Recurse
  Write-Host "restoring into $packs (this is the one download)..."

  # A publish, not a restore: the runtime packs only appear for a
  # self-contained single-file build, and those are the biggest part of the cache.
  $env:NUGET_PACKAGES = $packs
  Push-Location $work
  try {
    dotnet publish -c Release -r win-x64 --self-contained true `
      -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
      -o dist | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with $LASTEXITCODE" }
  }
  finally { Pop-Location }
}
finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

$size = (Get-ChildItem $packs -Recurse -File | Measure-Object -Property Length -Sum).Sum
$count = (Get-ChildItem $packs -Directory).Count
Write-Host ''
Write-Host ("done: {0:N0} packages, {1:N0} MB in {2}" -f $count, ($size / 1MB), $packs)
Write-Host 'Restart Synapse so the engine picks up NUGET_PACKAGES, then a build needs no network.'
