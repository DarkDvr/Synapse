# window.ps1 — the window half of app-check.
#
# Node cannot ask Windows where a window is, how big it is, or what it looks like.
# PowerShell can, through .NET, which every Windows already has. One action per
# call, one JSON object back, so the Node wrapper stays dumb and the quoting stays
# here.
#
# Every action takes a pid we started or were given. Nothing is ever found by
# process name: `opencode` is also the operator's editor (see AGENTS.md).
param(
  [Parameter(Mandatory = $true)][ValidateSet('launch', 'query', 'resize', 'shot', 'close')]
  [string]$Action,
  [string]$Exe,
  [string]$WorkDir,
  [int]$TargetPid = 0,
  [int]$Width = 0,
  [int]$Height = 0,
  [string]$Out,
  [ValidateSet('auto', 'print', 'screen')][string]$Method = 'auto',
  [int]$WaitMs = 15000
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
if (-not ('AppCheck.Win32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AppCheck {
  public static class Win32 {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int max);
  }
}
'@
}

function Get-WindowInfo {
  param([int]$ProcessId, [System.Diagnostics.Process]$Proc = $null)
  if (-not $Proc) { $Proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue }
  if (-not $Proc) { return $null }
  $Proc.Refresh()
  $hwnd = $Proc.MainWindowHandle
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  $rect = New-Object AppCheck.Win32+RECT
  [void][AppCheck.Win32]::GetWindowRect($hwnd, [ref]$rect)
  $dpi = [AppCheck.Win32]::GetDpiForWindow($hwnd)
  if ($dpi -eq 0) { $dpi = 96 }
  return [ordered]@{
    pid        = $Proc.Id
    hwnd       = [int64]$hwnd
    title      = $Proc.MainWindowTitle
    x          = $rect.Left
    y          = $rect.Top
    width      = $rect.Right - $rect.Left
    height     = $rect.Bottom - $rect.Top
    dpi        = [int]$dpi
    scale      = [math]::Round($dpi / 96.0, 2)
    alive      = -not $Proc.HasExited
    responding = $Proc.Responding
  }
}

function Wait-Window {
  param([int]$ProcessId, [int]$TimeoutMs)
  $waited = 0
  while ($waited -lt $TimeoutMs) {
    $info = Get-WindowInfo -ProcessId $ProcessId
    if ($info) { return $info }
    Start-Sleep -Milliseconds 150
    $waited += 150
  }
  return $null
}

try {
  switch ($Action) {

    'launch' {
      if (-not $Exe) { throw 'launch needs -Exe' }
      if (-not (Test-Path $Exe)) { throw "no such file: $Exe" }
      $startDir = if ($WorkDir) { $WorkDir } else { Split-Path -Parent $Exe }
      $proc = Start-Process -FilePath $Exe -WorkingDirectory $startDir -PassThru
      $info = Wait-Window -ProcessId $proc.Id -TimeoutMs $WaitMs
      if (-not $info) {
        # A single-file .NET app can hand the window to a child process, so before
        # calling it a failure, look for a window that appeared while we waited.
        $since = (Get-Date).AddSeconds(-[math]::Ceiling($WaitMs / 1000))
        $cand = Get-Process -ErrorAction SilentlyContinue | Where-Object {
          $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.StartTime -gt $since
        } | Select-Object -First 1
        if ($cand) { $info = Get-WindowInfo -ProcessId $cand.Id -Proc $cand }
      }
      if (-not $info) {
        $exited = $proc.HasExited
        [ordered]@{
          ok     = $false
          error  = if ($exited) { "the app exited with code $($proc.ExitCode) before showing a window" } else { "no window appeared within $($WaitMs)ms" }
          pid    = $proc.Id
          exited = $exited
        } | ConvertTo-Json -Compress
        exit 1
      }
      $info | ConvertTo-Json -Compress
    }

    'query' {
      $info = Get-WindowInfo -ProcessId $TargetPid
      if (-not $info) {
        [ordered]@{ ok = $false; pid = $TargetPid; error = 'that process has no window' } | ConvertTo-Json -Compress
        exit 1
      }
      $info | ConvertTo-Json -Compress
    }

    'resize' {
      if (-not $Width -or -not $Height) { throw 'resize needs -Width and -Height' }
      $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
      if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { throw "pid $TargetPid has no window" }
      $hwnd = $proc.MainWindowHandle
      # SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE = 0x2|0x4|0x10
      [void][AppCheck.Win32]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, $Width, $Height, 0x16)
      Start-Sleep -Milliseconds 250
      (Get-WindowInfo -ProcessId $TargetPid) | ConvertTo-Json -Compress
    }

    'shot' {
      if (-not $Out) { throw 'shot needs -Out' }
      $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
      if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {
        [ordered]@{ ok = $false; pid = $TargetPid; error = 'that process has no window' } | ConvertTo-Json -Compress
        exit 1
      }
      $hwnd = $proc.MainWindowHandle
      $rect = New-Object AppCheck.Win32+RECT
      [void][AppCheck.Win32]::GetWindowRect($hwnd, [ref]$rect)
      $w = [math]::Max(1, $rect.Right - $rect.Left)
      $h = [math]::Max(1, $rect.Bottom - $rect.Top)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null

      $used = 'print'
      $bmp = New-Object System.Drawing.Bitmap($w, $h)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      # PW_RENDERFULLCONTENT (2) asks for the contents rather than the frame, which
      # is what makes this work for a WebView2 window that is behind another one.
      [void][AppCheck.Win32]::PrintWindow($hwnd, $hdc, 2)
      $g.ReleaseHdc($hdc)
      $g.Dispose()
      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()

      # A window that refuses PrintWindow saves a flat, tiny image. Falling back to
      # the screen needs the window in front, which is the one intrusive thing this
      # tool does — and only when the quiet method failed.
      if ($Method -ne 'print') {
        $size = (Get-Item $Out).Length
        if ($Method -eq 'screen' -or ($Method -eq 'auto' -and $size -lt 6000)) {
          [void][AppCheck.Win32]::SetForegroundWindow($hwnd)
          Start-Sleep -Milliseconds 350
          $bmp2 = New-Object System.Drawing.Bitmap($w, $h)
          $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
          $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
          $g2.Dispose()
          $bmp2.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
          $bmp2.Dispose()
          $used = 'screen'
        }
      }

      [ordered]@{
        ok     = $true
        pid    = $TargetPid
        path   = (Resolve-Path $Out).Path
        width  = $w
        height = $h
        bytes  = (Get-Item $Out).Length
        method = $used
      } | ConvertTo-Json -Compress
    }

    'close' {
      $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
      if (-not $proc) { [ordered]@{ ok = $true; pid = $TargetPid; note = 'already gone' } | ConvertTo-Json -Compress; exit 0 }
      [void]$proc.CloseMainWindow()
      if (-not $proc.WaitForExit(3000)) { Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue }
      [ordered]@{ ok = $true; pid = $TargetPid } | ConvertTo-Json -Compress
    }
  }
}
catch {
  [ordered]@{ ok = $false; action = $Action; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
