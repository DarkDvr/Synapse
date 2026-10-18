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

Write-Host 'stopping Synapse...'
Stop-ByPidFile -File (Join-Path $root 'data\synapse.pid') -Label 'synapse'
Stop-ByPidFile -File (Join-Path $root 'data\engine.pid') -Label 'engine'
Start-Sleep -Seconds 2

Write-Host 'starting Synapse...'
Start-Process -FilePath node -ArgumentList 'src/index.js' -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput "$env:TEMP\synapse.out" -RedirectStandardError "$env:TEMP\synapse.err"
Start-Sleep -Seconds 14

try {
  $st = Invoke-RestMethod 'http://127.0.0.1:8700/api/status'
  Write-Host "  engine ready: $($st.engine.ready) ($($st.engine.kind) $($st.engine.version)) pid=$($st.engine.pid)"
} catch {
  Write-Host "  Synapse is not responding: $($_.Exception.Message)"
  if (Test-Path "$env:TEMP\synapse.err") { Get-Content "$env:TEMP\synapse.err" -Tail 10 }
}
