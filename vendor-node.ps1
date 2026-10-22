# Copy Node into Synapse so the app travels with its own runtime.
#
#   .\vendor-node.ps1                 # fetch the version this app was tested on
#   .\vendor-node.ps1 -Version 24.21.0
#
# The copy lands in bin\node\ with node.exe and its licence. start.bat, stop.bat and
# restart.ps1 prefer it over whatever is installed on the machine, which is what
# makes "copy the folder to another PC" enough — the same bargain as
# vendor-engine.ps1. bin\ is not in git: 80 MB of runtime is not something to carry
# in history, and this script is how it gets there.
param(
  [string]$Version = '24.21.0',
  [string]$From = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $root 'bin\node'
$destExe = Join-Path $dest 'node.exe'

# What this app was actually run on. The version is a floor, not a hope: Synapse
# needs 22+ for the built-in WebSocket, and is tested on the one below.
if (-not $Version -and (Get-Command node -ErrorAction SilentlyContinue)) {
  $Version = (& node --version).TrimStart('v')
}

if ($From) {
  if (-not (Test-Path $From)) { throw "no file at $From" }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Force $From (Join-Path $dest 'node.exe')
} else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $zipName = "node-v$Version-win-$arch"
  $url = "https://nodejs.org/dist/v$Version/$zipName.zip"
  $tmp = Join-Path $env:TEMP "$zipName.zip"
  Write-Host "downloading $url"
  Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 300 -OutFile $tmp

  $expand = Join-Path $env:TEMP "synapse-node-$([guid]::NewGuid().ToString('N'))"
  Expand-Archive -Path $tmp -DestinationPath $expand -Force
  $inner = Join-Path $expand $zipName
  if (-not (Test-Path (Join-Path $inner 'node.exe'))) { throw "the archive did not contain $zipName\node.exe" }

  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Force (Join-Path $inner 'node.exe') $destExe
  # npm is not used by Synapse, but it costs little and makes the copy useful by hand.
  foreach ($extra in @('npm.cmd', 'npx.cmd')) {
    if (Test-Path (Join-Path $inner $extra)) { Copy-Item -Force (Join-Path $inner $extra) $dest }
  }
  if (Test-Path (Join-Path $inner 'LICENSE')) { Copy-Item -Force (Join-Path $inner 'LICENSE') $dest }
  Remove-Item $expand -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

$got = (& $destExe --version).Trim()
$lines = @(
  "node $got",
  "copied $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
  "This copy is what Synapse runs: start.bat, stop.bat and restart.ps1 prefer it.",
  "Delete bin\node and they fall back to the machine's own node."
)
Set-Content -Path (Join-Path $dest 'VERSION.txt') -Value $lines -Encoding utf8

Write-Host ''
Write-Host "done: $destExe ($got)"
Write-Host 'Restart Synapse. It now runs on this copy, not the machine'"'"'s.'
