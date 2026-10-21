# Copy the runtime into Synapse so it travels with the app.
#
#   .\vendor-engine.ps1                 # from the npm global install (or a path you pass)
#   .\vendor-engine.ps1 D:\engine\opencode.exe
#
# The copy lands in bin\opencode\ beside opencode.exe, with the licence it came
# with and the version it is, and Synapse prefers it over any global install —
# which is what makes "copy the folder to another PC" enough. bin\ is not in git:
# it is a 200 MB binary, and this script is how it gets there.
param([string]$From = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $root 'bin\opencode'
$destExe = Join-Path $dest 'opencode.exe'

function Find-Source {
  param([string]$Explicit)
  if ($Explicit) {
    if (-not (Test-Path $Explicit)) { throw "no file at $Explicit" }
    return (Resolve-Path $Explicit).Path
  }
  $candidates = @()
  if ($env:APPDATA) { $candidates += Join-Path $env:APPDATA 'npm\node_modules\@opencode\cli\bin\opencode.exe' }
  if ($env:USERPROFILE) { $candidates += Join-Path $env:USERPROFILE '.opencode\bin\opencode.exe' }
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\@opencode\bin\opencode.exe' }
  foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
  throw 'No engine found. Install it once with: npm install -g @opencode/cli   — or pass the path to an opencode.exe.'
}

$source = Find-Source -Explicit $From
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Write-Host "copying $source"
Write-Host "     to $destExe"
Copy-Item -Force $source $destExe

# The licence travels with the copy. MIT asks for the notice to come along, and
# this app is private — but "private" is not a licence, and the file costs nothing.
$licenseUrl = 'https://raw.githubusercontent.com/anomalyco/opencode/dev/LICENSE'
try {
  Invoke-WebRequest -Uri $licenseUrl -UseBasicParsing -TimeoutSec 15 -OutFile (Join-Path $dest 'LICENSE')
  Write-Host 'wrote LICENSE (MIT, from the project)'
} catch {
  Write-Host "could not fetch the licence ($($_.Exception.Message)). Put the project's MIT notice in $dest\LICENSE by hand."
}

# What this copy is, for whoever finds it in a year.
$versionFile = Join-Path $dest 'VERSION.txt'
$lines = @(
  "opencode.exe $((Get-Item $destExe).Length) bytes",
  "copied $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
  "source $source",
  "This copy is what Synapse runs. Delete bin\opencode and it falls back to a global install."
)
Set-Content -Path $versionFile -Value $lines -Encoding utf8

Write-Host ''
Write-Host "done: $destExe"
Write-Host 'Restart Synapse. Settings > Runtime should show this path.'
