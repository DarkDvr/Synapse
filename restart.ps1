# Restart Synapse — and only Synapse's own engine.
#
# ============================ READ THIS ============================
# NEVER kill these processes by name.
#
# The desktop app installs to `...\Programs\@opencodedesktop\OpenCode.exe`,
# whose path CONTAINS `@opencode`. So this, which looks obviously correct:
#
#     Get-Process -Name opencode | Where-Object { $_.Path -like '*@opencode*' }
#
# matches the operator's editor as well as the engine, and force-kills the
# editor every time. That mistake caused a string of "the desktop app keeps
# crashing" reports: it was never crashing, it was being killed, which is also
# why it left no crash dump behind.
#
# Both pids are recorded by the app itself:
#   data\synapse.pid   written by src/index.js
#   data\engine.pid    written by src/engines/opencode.js
# Read those, and never match on a process name.
# ===================================================================
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Stop-ByPidFile {
  param([string]$File, [string]$Label)

  if (-not (Test-Path $File)) { Write-Host "  no $Label pid file"; return }
  $raw = (Get-Content $File -Raw).Trim()
  if (-not $raw) { return }

  $target = 0
  if (-not [int]::TryParse($raw, [ref]$target)) { Write-Host "  bad $Label pid: '$raw'"; return }

  $proc = Get-Process -Id $target -ErrorAction SilentlyContinue
  if (-not $proc) { Write-Host "  $Label pid $target is not running"; return }

  # Hard guard: whatever the pid file says, these are off limits.
  if ($proc.Path -like '*@opencodedesktop*' -or $proc.Path -like '*ai.opencode.desktop*') {
    Write-Host "  REFUSING to stop $Label pid $target - that is the desktop app"
    Write-Host "    $($proc.Path)"
    return
  }

  Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
  Write-Host "  stopped $Label pid $target ($($proc.ProcessName))"
}

# The pid file is not always the truth. A console started by hand writes one, but a
# second copy that died on EADDRINUSE leaves its own pid behind — and then this
# script reports "not running" while the real server keeps serving the OLD code.
# So: find the process by the socket it holds, and prove it is this Synapse before
# touching it. Proof, not a name: the port answers /api/status with an engine home
# under THIS folder, or the engine's own binary sits under this folder.
function Stop-ByPort {
  param([int]$Port, [string]$Label)

  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.Path -and ($proc.Path -like '*@opencodedesktop*' -or $proc.Path -like '*ai.opencode.desktop*')) {
      Write-Host "  REFUSING: port $Port is held by the desktop app ($($proc.Path))"
      continue
    }
    if ($Label -eq 'synapse') {
      $expected = Join-Path $root 'data\engine\opencode'
      try {
        $st = Invoke-RestMethod "http://127.0.0.1:$Port/api/status" -TimeoutSec 3
      } catch {
        Write-Host "  port $Port is held by pid $($proc.Id) and does not answer /api/status - leaving it alone"
        continue
      }
      if ($st.engine.home -ne $expected) {
        Write-Host "  port $Port answers as '$($st.engine.home)', not '$expected' - leaving it alone"
        continue
      }
    } else {
      if (-not $proc.Path -or -not $proc.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Host "  port $Port is held by $($proc.Path) - not this install, leaving it alone"
        continue
      }
    }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Host "  stopped $Label pid $($proc.Id) (found by listening on $Port)"
  }
}

Write-Host 'stopping Synapse...'
Stop-ByPidFile -File (Join-Path $root 'data\synapse.pid') -Label 'synapse'
Stop-ByPidFile -File (Join-Path $root 'data\engine.pid') -Label 'engine'
# and whatever is still holding the ports, if it proves to be ours
Stop-ByPort -Port 8700 -Label 'synapse'
Stop-ByPort -Port 8720 -Label 'engine'
Start-Sleep -Seconds 2

Write-Host 'starting Synapse...'
# The vendored runtime first (vendor-node.ps1), so a copied folder needs nothing
# installed; the machine's own node is only a fallback for a dev checkout.
$nodeExe = Join-Path $root 'bin\node\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }
Start-Process -FilePath $nodeExe -ArgumentList 'src/index.js' -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput "$env:TEMP\synapse.out" -RedirectStandardError "$env:TEMP\synapse.err"
Start-Sleep -Seconds 14

try {
  $st = Invoke-RestMethod 'http://127.0.0.1:8700/api/status'
  Write-Host "  engine ready: $($st.engine.ready) ($($st.engine.kind) $($st.engine.version)) pid=$($st.engine.pid)"
} catch {
  Write-Host "  Synapse is not responding: $($_.Exception.Message)"
  if (Test-Path "$env:TEMP\synapse.err") { Get-Content "$env:TEMP\synapse.err" -Tail 10 }
}
