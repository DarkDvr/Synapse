# Launch Edge on a Windows desktop of its own, and stay with it until it exits.
#
# The window is a normal, headed Edge window — the fingerprint that clears a bot check —
# but it lives on a desktop that is not the operator's, so it never appears in their
# taskbar and there is nothing to flash. `CreateDesktop` + `CreateProcess` with
# `lpDesktop` is the whole trick; the desktop has no shell, so nothing is drawn on it.
#
# This process is the keeper: it holds the desktop handle and waits on Edge. If it dies,
# Edge keeps the desktop alive by itself; if Edge dies, this exits and the desktop goes.
#
# It is launched by src/browser/browser.js. Arguments are paths and sizes only; the state
# file is the only channel back (no stdout/stderr pipes, which a sandbox may refuse).

param(
  [Parameter(Mandatory = $true)][string]$EdgePath,
  [Parameter(Mandatory = $true)][string]$Profile,
  [Parameter(Mandatory = $true)][string]$StateFile,
  [int]$Width = 1280,
  [int]$Height = 800,
  # The process that asked for the browser. If it goes, the browser goes with it: a
  # killed server must not leave an Edge on a hidden desktop for the rest of the day.
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'

function Write-State([hashtable]$State) {
  try {
    $dir = Split-Path -Parent $StateFile
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json = $State | ConvertTo-Json -Compress
    # No BOM: this file is read by JSON.parse, which treats a leading U+FEFF as a syntax error.
    [System.IO.File]::WriteAllText($StateFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch { /* the state file is a courtesy; never fail the launch over it */ }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class SynaBrowseDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint ms);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);

  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr handle);
}
'@

$desktop = 'SynaBrowse-' + [guid]::NewGuid().ToString('N').Substring(0, 10)
$desk = [IntPtr]::Zero
$pi = New-Object SynaBrowseDesktop+PROCESS_INFORMATION

try {
  $desk = [SynaBrowseDesktop]::CreateDesktop($desktop, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x000F01FF, [IntPtr]::Zero)
  if ($desk -eq [IntPtr]::Zero) {
    Write-State @{ state = 'error'; desktop = $desktop; error = "CreateDesktop failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; profile = $Profile }
    exit 1
  }

  $args = @(
    "--user-data-dir=`"$Profile`"",
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate,CalculateNativeWinOcclusion',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-blink-features=AutomationControlled',
    '--test-type',
    "--window-size=$Width,$Height",
    '--window-position=0,0',
    'about:blank'
  )
  $cmd = '"' + $EdgePath + '" ' + ($args -join ' ')

  $si = New-Object SynaBrowseDesktop+STARTUPINFO
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
  $si.lpDesktop = $desktop

  $ok = [SynaBrowseDesktop]::CreateProcess($EdgePath, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0, [IntPtr]::Zero, (Split-Path -Parent $Profile), [ref]$si, [ref]$pi)
  if (-not $ok) {
    Write-State @{ state = 'error'; desktop = $desktop; error = "CreateProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; profile = $Profile }
    [void][SynaBrowseDesktop]::CloseDesktop($desk)
    exit 1
  }

  Write-State @{ state = 'running'; desktop = $desktop; edgePid = $pi.dwProcessId; profile = $Profile; startedAt = [DateTime]::UtcNow.ToString('o') }

  # The keeper. Wait two seconds at a time, so the parent can be checked without a second
  # watcher. 258 is WAIT_TIMEOUT; anything else means Edge has ended.
  $parentGone = $false
  while ($true) {
    $waited = [SynaBrowseDesktop]::WaitForSingleObject($pi.hProcess, 2000)
    if ($waited -ne 258) { break }
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
      $parentGone = $true
      try { & taskkill /PID $pi.dwProcessId /T /F 2>$null | Out-Null } catch { /* already gone */ }
      break
    }
  }

  $code = [uint32]0
  [void][SynaBrowseDesktop]::GetExitCodeProcess($pi.hProcess, [ref]$code)
  Write-State @{ state = 'exited'; desktop = $desktop; edgePid = $pi.dwProcessId; profile = $Profile; exitCode = $code; reason = $(if ($parentGone) { 'parent-exit' } else { 'edge-exit' }); exitedAt = [DateTime]::UtcNow.ToString('o') }
} catch {
  Write-State @{ state = 'error'; desktop = $desktop; error = $_.Exception.Message; profile = $Profile }
  exit 1
} finally {
  if ($pi.hThread -ne [IntPtr]::Zero) { [void][SynaBrowseDesktop]::CloseHandle($pi.hThread) }
  if ($pi.hProcess -ne [IntPtr]::Zero) { [void][SynaBrowseDesktop]::CloseHandle($pi.hProcess) }
  if ($desk -ne [IntPtr]::Zero) { [void][SynaBrowseDesktop]::CloseDesktop($desk) }
}
