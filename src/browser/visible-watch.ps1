# A visible hand-off browser must not outlive the server that opened it.
#
# The window is an ordinary Edge on the operator's desktop, launched by the MCP server.
# If that server is killed mid-hand-off (a Stop can end the session under it), nothing
# runs the Node `finally` that would close the browser. This watcher is the last resort:
# it polls two ids that this app wrote — the server that asked, and the Edge it started —
# and closes the browser's tree when the first one is gone. Never by process name.
param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][int]$EdgePid
)

if ($ParentPid -le 0 -or $EdgePid -le 0) { exit 1 }

while ($true) {
  if (-not (Get-Process -Id $EdgePid -ErrorAction SilentlyContinue)) { break }
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    try { & taskkill /PID $EdgePid /T /F 2>$null | Out-Null } catch { /* already gone */ }
    break
  }
  Start-Sleep -Seconds 2
}
