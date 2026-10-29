# make-deliverable.ps1 — a copy that runs on another PC.
#
#   .\make-deliverable.ps1                       # -> E:\shared\Synapse
#   .\make-deliverable.ps1 -Destination D:\Apps\Synapse
#   .\make-deliverable.ps1 -Force                # replace a previous deliverable
#
# The target PC is assumed to have the .NET 10 Desktop Runtime and the WebView2
# Runtime. That is why the exe is the lean one: it is 1.5 MB and uses the runtime
# the machine already has.
#
# What travels: Synapse.exe, package.json, src, web, skills, templates, a
# sanitized config, bin\node and bin\opencode. What does not: data, logs, the
# provider keys, projects, git history, tests, docs, references, shell sources and
# the NuGet cache — none of them are needed to run it, and some of them are private.
#
# Safety: the copy is built in a marked staging folder beside the destination and
# only moved into place when it is complete. An existing destination is replaced
# only with -Force AND only when it carries the marker this script writes, so a
# typo cannot delete a real folder. Nothing outside the staging/destination pair
# is ever removed.

[CmdletBinding()]
param(
  [string]$Destination = 'E:\shared\Synapse',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = $null
$moving = $false

function Say([string]$line) { Write-Host $line }

function Copy-Tree {
  param(
    [Parameter(Mandatory)] [string]$From,
    [Parameter(Mandatory)] [string]$To,
    [string[]]$ExcludeDirs = @()
  )
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  $robocopyArgs = @($From, $To, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:2')
  if ($ExcludeDirs.Count -gt 0) { $robocopyArgs += '/XD'; $robocopyArgs += $ExcludeDirs }
  & robocopy @robocopyArgs | Out-Null
  # robocopy: 0-7 are success (1 means files were copied), 8+ are failures.
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with $LASTEXITCODE copying $From" }
}

try {
  # ── what this machine has ────────────────────────────────────────────────
  $required = @(
    'Synapse.exe',
    'package.json',
    'update-apply.ps1',
    'src\index.js',
    'web\index.html',
    'config\synapse.config.json',
    'bin\node\node.exe',
    'bin\opencode\opencode.exe'
  )
  foreach ($rel in $required) {
    $full = Join-Path $root $rel
    if (-not (Test-Path -LiteralPath $full)) { throw "missing $rel — is this a Synapse folder?" }
  }
  foreach ($rel in @('src', 'web', 'skills', 'templates', 'bin\node', 'bin\opencode')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $rel))) { throw "missing folder $rel" }
  }

  $nodeVersion = (& (Join-Path $root 'bin\node\node.exe') --version).Trim()
  $engineVersion = (& (Join-Path $root 'bin\opencode\opencode.exe') --version).Trim()
  $appVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
  $commit = 'unknown'
  $dirty = ''
  try {
    $commit = (& git -C $root rev-parse --short HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $commit) { $commit = 'unknown' }
    $changes = @(& git -C $root status --porcelain 2>$null)
    if ($changes.Count -gt 0) { $dirty = ' (uncommitted changes were present)' }
  } catch { $commit = 'unknown' }

  # ── the destination has to be a place we can name ────────────────────────
  $destFull = [IO.Path]::GetFullPath($Destination)
  $destParent = Split-Path -Parent $destFull
  $destLeaf = Split-Path -Leaf $destFull
  if (-not $destLeaf) { throw "destination has no folder name: $Destination" }
  if (-not (Test-Path -LiteralPath $destParent)) { throw "destination parent does not exist: $destParent" }

  $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $destTrim = $destFull.TrimEnd('\')
  if ($destTrim -ieq $rootFull) { throw 'the destination is the Synapse folder itself' }
  if ($destTrim.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'the destination is inside the Synapse folder'
  }
  # A destination that *contains* Synapse is worse than one inside it: replacing
  # it would take the source with it. F:\dev is not a deliverable.
  if ($rootFull.StartsWith($destTrim + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "the destination contains the Synapse folder: $destFull — pick a folder beside it, not above it"
  }
  # The projects root is the operator's own work. A deliverable must not contain
  # it, sit inside it, or be it; a typo there is not recoverable from this script.
  $projectsFull = [IO.Path]::GetFullPath((Join-Path $root '..\Synapse.Projects')).TrimEnd('\')
  $insideProjects =
    $destTrim -ieq $projectsFull -or
    $destTrim.StartsWith($projectsFull + '\', [StringComparison]::OrdinalIgnoreCase)
  $containsProjects = $projectsFull.StartsWith($destTrim + '\', [StringComparison]::OrdinalIgnoreCase)
  if ($insideProjects -or $containsProjects) {
    throw "the destination overlaps the projects folder ($projectsFull) — pick a separate folder"
  }
  $forbidden = @(
    [IO.Path]::GetPathRoot($destFull),
    $destParent,
    $env:USERPROFILE,
    $env:APPDATA,
    $env:LOCALAPPDATA,
    $env:ProgramData,
    $env:SystemRoot
  )
  foreach ($bad in $forbidden) {
    if (-not $bad) { continue }
    if ($destTrim -ieq ([IO.Path]::GetFullPath($bad)).TrimEnd('\')) {
      throw "refusing to use $destFull as the destination — pick a folder inside $destParent"
    }
  }

  $marker = Join-Path $destFull '.synapse-deliverable'
  if (Test-Path -LiteralPath $destFull) {
    if (-not (Test-Path -LiteralPath $destFull -PathType Container)) {
      throw "destination exists and is not a folder: $destFull"
    }
    $destItem = Get-Item -LiteralPath $destFull -Force
    if ($destItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "destination is a junction or symbolic link: $destFull — refusing to follow it"
    }
    if (-not $Force) { throw "destination already exists: $destFull (use -Force to replace a previous deliverable)" }
    if (-not (Test-Path -LiteralPath $marker)) {
      throw "refusing to replace $destFull — it has no .synapse-deliverable marker, so it is not one of ours"
    }
  }

  # ── stage beside the destination, so the move is a rename ────────────────
  $stage = Join-Path $destParent ".synapse-stage-$stamp"
  if (Test-Path -LiteralPath $stage) { throw "staging folder already exists: $stage" }
  New-Item -ItemType Directory -Path $stage | Out-Null
  Set-Content -LiteralPath (Join-Path $stage '.synapse-deliverable') `
    -Value "Synapse deliverable, staged $stamp by make-deliverable.ps1. Safe to replace with -Force." -Encoding utf8

  Say "staging in $stage"
  Say "copying Synapse.exe and package.json..."
  Copy-Item -LiteralPath (Join-Path $root 'Synapse.exe') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $root 'update-apply.ps1') -Destination $stage

  foreach ($dir in @('src', 'web', 'skills')) {
    Say "copying $dir\..."
    Copy-Tree -From (Join-Path $root $dir) -To (Join-Path $stage $dir)
  }
  Say 'copying templates\ (without obj\)...'
  Copy-Tree -From (Join-Path $root 'templates') -To (Join-Path $stage 'templates') -ExcludeDirs @('obj')

  Say 'copying bin\node\...'
  Copy-Tree -From (Join-Path $root 'bin\node') -To (Join-Path $stage 'bin\node')
  Say 'copying bin\opencode\...'
  Copy-Tree -From (Join-Path $root 'bin\opencode') -To (Join-Path $stage 'bin\opencode')

  # The source note names the machine this copy came from. A delivered folder should
  # not carry someone's profile path, and the size in the old note can be stale after
  # an in-place update, so write the facts this copy actually has.
  $engineExe = Join-Path $stage 'bin\opencode\opencode.exe'
  $engineNote = @(
    "opencode.exe $((Get-Item -LiteralPath $engineExe).Length) bytes",
    $engineVersion,
    "vendored with Synapse on $((Get-Date).ToString('yyyy-MM-dd'))",
    'This copy is what Synapse runs. Delete bin\opencode and it falls back to a global install.'
  )
  Set-Content -LiteralPath (Join-Path $stage 'bin\opencode\VERSION.txt') -Value $engineNote -Encoding utf8

  # ── config: keep the choices, drop this machine's addresses and any secret ─
  Say 'sanitizing config\synapse.config.json...'
  $cfgSource = Join-Path $root 'config\synapse.config.json'
  $cfgText = Get-Content -LiteralPath $cfgSource -Raw
  $cfg = $cfgText | ConvertFrom-Json
  $oc = $cfg.engine.opencode

  if ($oc.password -and "$($oc.password)".Trim()) { throw 'refusing to ship a config with engine.opencode.password set' }
  foreach ($provider in @($oc.providers)) {
    if ($provider -and $provider.apiKey -and "$($provider.apiKey)".Trim()) {
      throw "refusing to ship a config with an API key in provider '$($provider.id)' — keys belong in data\provider-keys.json"
    }
  }

  # Empty means "the copy that travels with the app" and "data\engine\opencode",
  # which is what every install has. Leaving the absolute paths would point the new
  # PC at F:\dev\Synapse, or create an F: folder on a machine that has no F:.
  $oc.binary = ''
  $oc.home = ''
  $cfg.server.openBrowser = $false
  $cfg.server.remote = $false

  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'config') | Out-Null
  $cfg | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $stage 'config\synapse.config.json') -Encoding utf8

  # ── the note for whoever plugs it in ─────────────────────────────────────
  $builtAt = Get-Date -Format 'yyyy-MM-dd HH:mm'
  $readme = @"
Synapse $appVersion — travel copy
=====================

Built $builtAt from commit $commit$dirty.
Node $nodeVersion     $engineVersion

Requirements (already installed on this PC):
  - Windows 10 or 11, 64-bit
  - .NET 10 Desktop Runtime
  - Microsoft Edge WebView2 Runtime

Git is optional: if it is installed, Synapse uses it for restore points and
project history; if not, those steps are skipped and everything else runs.

Run
---
Double-click Synapse.exe. The window opens, starts its own server, and shows the
interface at http://127.0.0.1:8700. Nothing is installed on the machine: Node and
the engine are in bin\, and the app writes only inside this folder and the
projects folder beside it.

First run
---------
It creates data\ and logs\ here, and ..\Synapse.Projects beside this folder. Keep
the folder somewhere writable — not under Program Files.

Models and keys
---------------
Provider definitions and the chosen role models travel in
config\synapse.config.json. API keys do NOT: they live in data\provider-keys.json
on the machine that made this copy, and data\ is deliberately absent. Add the
keys in Settings on this PC.

The "Local LLM" and "Strata" entries point at localhost ports 1235 and 8080.
Remove or edit them if those servers are not on this PC.

Ports
-----
UI 8700, engine 8720. If either is taken, change it in config\synapse.config.json
before starting.

What is in the folder
---------------------
  Synapse.exe          the app (needs the .NET 10 Desktop Runtime)
  src\ web\            the server and the interface
  skills\ templates\   what the agents use
  config\              settings, with machine-specific paths cleared
  bin\node\            Node $nodeVersion, with its licence
  bin\opencode\        $engineVersion, with its licence

Not included
------------
data\, logs\, provider keys, projects, git history, tests, docs, references,
shell sources and the vendored NuGet cache. The app recreates the first two; the
rest are for working on Synapse itself, not for running it.

Closing the window hides it to the tray; Exit Synapse in the tray stops the
server too.
"@
  Set-Content -LiteralPath (Join-Path $stage 'README.txt') -Value $readme -Encoding utf8

  # ── move it into place ───────────────────────────────────────────────────
  if (Test-Path -LiteralPath $destFull) {
    Say "replacing $destFull (marker present, -Force given)..."
    Remove-Item -LiteralPath $destFull -Recurse -Force
  }
  $moving = $true
  Move-Item -LiteralPath $stage -Destination $destFull
  $stage = $null
  $moving = $false

  $files = @(Get-ChildItem -LiteralPath $destFull -Recurse -File -Force)
  $bytes = ($files | Measure-Object -Property Length -Sum).Sum
  Say ''
  Say ("done: {0}" -f $destFull)
  Say ("      {0:N0} files, {1:N1} MB" -f $files.Count, ($bytes / 1MB))
  Say '      Double-click Synapse.exe on the target PC. Nothing else to install.'
}
finally {
  # If the move itself failed, the staging folder is the only complete copy left —
  # keep it and say where it is rather than deleting it.
  if ($stage -and -not $moving -and (Test-Path -LiteralPath $stage)) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  } elseif ($stage -and $moving -and (Test-Path -LiteralPath $stage)) {
    Write-Warning "the move failed; the complete copy is still at $stage"
  }
}
