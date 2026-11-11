# show.ps1 — tell the operator SynaBrowse is waiting, without interrupting them.
#
# The window is ours: a top-level Chromium window belonging to the process whose command
# line names the SynaBrowse profile. It is placed in the **second monitor's** working area
# — the primary only if there is no other — shown minimized on the taskbar for a hand-off,
# restored for a sign-in, its button blinked, and one chime played. Nothing is activated:
# the foreground window is the operator's before and after, and the report proves it.
#
# Two things that had to be learned (11 Nov):
#   - the placement is done with **SetWindowPlacement**, not SetWindowPos: a minimized
#     window restores to its `rcNormalPosition`, and SetWindowPos does not move that. That
#     is why the hand-off kept appearing on the main monitor;
#   - the window is found by **enumerating top-level windows** of our process, not through
#     `Process.MainWindowHandle`, which for Edge reported a handle that was not the window.
#
#   show.ps1                 ask for attention (the window stays minimized)
#   show.ps1 -Restore        bring it up for a sign-in, still on the second monitor
param(
    [string]$Marker = 'Synapse\data\browser\profile',
    [string]$Sound = 'F:\dev\Synapse\web\sounds\hollow.wav',
    [switch]$Restore,
    [switch]$Focus,
    [switch]$Hide,
    [int]$WaitMs = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not ('W.U' -as [type])) {
    Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int index, int value);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool on);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
[DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
[DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int count);
public delegate bool EnumProc(IntPtr hWnd, IntPtr param);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
  public int length; public int flags; public int showCmd;
  public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
}
public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
'@
}

$fgBefore = [W.U]::GetForegroundWindow()

# Our browser: the processes whose command line names the SynaBrowse profile, skipping
# `--type=` children. The comparison normalises separators, because the same profile
# arrives as `F:\dev\...` from the app and `F:/dev/...` from a script.
$markerKey = ($Marker -replace '\\', '/').ToLower()
$pids = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -notmatch '--type=' -and
        (($_.CommandLine -replace '\\', '/').ToLower().Contains($markerKey))
    } | ForEach-Object { [uint32]$_.ProcessId })

# The window: a top-level Chromium window of one of those processes, with a page title.
$found = New-Object System.Collections.ArrayList
$callback = [W.U+EnumProc]{
    param($hWnd, $param)
    $owner = [uint32]0
    [void][W.U]::GetWindowThreadProcessId($hWnd, [ref]$owner)
    if ($pids -notcontains $owner) { return $true }
    $class = New-Object System.Text.StringBuilder 256
    [void][W.U]::GetClassNameW($hWnd, $class, 256)
    if ($class.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
    $title = New-Object System.Text.StringBuilder 512
    [void][W.U]::GetWindowTextW($hWnd, $title, 512)
    if (-not $title.ToString()) { return $true }
    # Edge shows a "Restore pages" bubble as its own window, and it is not ours to touch.
    if ($title.ToString() -match 'Restore pages') { return $true }
    $box = New-Object 'W.U+RECT'
    [void][W.U]::GetWindowRect($hWnd, [ref]$box)
    if (($box.Right - $box.Left) -lt 300) { return $true }
    [void]$found.Add($hWnd)
    return $true
}
# The window appears a moment after the process does, and until it is a tool window it
# has a taskbar button. -WaitMs lets the caller start this before the browser is ready and
# have it grab the window the instant it exists (12 Nov).
if ($WaitMs -gt 0) {
    $deadline = (Get-Date).AddMilliseconds($WaitMs)
    while ($found.Count -eq 0 -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 40
        [void]$found.Clear()
        [void][W.U]::EnumWindows($callback, [IntPtr]::Zero)
    }
}
[void][W.U]::EnumWindows($callback, [IntPtr]::Zero)
if ($found.Count -eq 0) { '{"error":"no SynaBrowse window"}' | Write-Output; exit 1 }
$hwnd = $found[0]

# How the window behaves.
#
# -Hide: no taskbar button and no Alt-Tab entry (WS_EX_TOOLWINDOW), parked off-screen but
# left *normal* — a minimized window stops compositing, and every screenshot then waits out
# its timeout (measured 12 Nov). Invisible, unlisted, still rendering.
#
# -Focus: the operator allowed a sign-in, so the window is an ordinary one again: no tool
# window, placed on the monitor they are looking at, and brought forward with the
# attach-to-foreground-thread trick Windows requires.
$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x80
$WS_EX_APPWINDOW = 0x40000
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020

$screens = [System.Windows.Forms.Screen]::AllScreens
$screen = $null
if ($Focus) {
    $fg = New-Object 'W.U+RECT'
    if ($fgBefore -ne [IntPtr]::Zero -and [W.U]::GetWindowRect($fgBefore, [ref]$fg)) {
        $cx = [int](($fg.Left + $fg.Right) / 2)
        $cy = [int](($fg.Top + $fg.Bottom) / 2)
        $screen = $screens | Where-Object { $cx -ge $_.Bounds.X -and $cx -le ($_.Bounds.X + $_.Bounds.Width) -and $cy -ge $_.Bounds.Y -and $cy -le ($_.Bounds.Y + $_.Bounds.Height) } | Select-Object -First 1
    }
}
if (-not $screen) { $screen = $screens | Where-Object { -not $_.Primary } | Select-Object -First 1 }
if (-not $screen) { $screen = [System.Windows.Forms.Screen]::PrimaryScreen }
$area = $screen.WorkingArea
$w = [Math]::Min(1200, [int]($area.Width * 0.72))
$h = [Math]::Min(860, [int]($area.Height * 0.86))
$x = $area.X + [int](($area.Width - $w) / 2)
$y = $area.Y + [int](($area.Height - $h) / 2)

$ex = [W.U]::GetWindowLong($hwnd, $GWL_EXSTYLE)
if ($Hide) {
    [void][W.U]::SetWindowLong($hwnd, $GWL_EXSTYLE, (($ex -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)))
    [void][W.U]::ShowWindow($hwnd, 4)   # SW_SHOWNOACTIVATE: normal, so it keeps rendering
    [void][W.U]::SetWindowPos($hwnd, [IntPtr]::Zero, -32000, -32000, $w, $h, $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED)
    $state = 'hidden'
} else {
    [void][W.U]::SetWindowLong($hwnd, $GWL_EXSTYLE, (($ex -bor $WS_EX_APPWINDOW) -band (-bnot $WS_EX_TOOLWINDOW)))
    [void][W.U]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $w, $h, $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED)
    [void][W.U]::ShowWindow($hwnd, 9)   # SW_RESTORE
    [void][W.U]::ShowWindow($hwnd, 4)   # SW_SHOWNOACTIVATE
    if ($Focus) {
        $current = [W.U]::GetCurrentThreadId()
        $fgThread = 0
        $fgWin = [W.U]::GetForegroundWindow()
        if ($fgWin -ne [IntPtr]::Zero) {
            $ignored = [uint32]0
            $fgThread = [W.U]::GetWindowThreadProcessId($fgWin, [ref]$ignored)
        }
        $attached = $false
        if ($fgThread -ne 0 -and $fgThread -ne $current) { $attached = [W.U]::AttachThreadInput($current, $fgThread, $true) }
        [void][W.U]::SetForegroundWindow($hwnd)
        [void][W.U]::BringWindowToTop($hwnd)
        if ($attached) { [void][W.U]::AttachThreadInput($current, $fgThread, $false) }
    }
    $state = 'shown'
}

# Blink the taskbar button so the operator notices without a sound alone.
$flash = New-Object 'W.U+FLASHWINFO'
$flash.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($flash)
$flash.hwnd = $hwnd
$flash.dwFlags = 0x00000002 -bor 0x0000000C   # FLASHW_TRAY | FLASHW_TIMERNOFG
$flash.uCount = 3
$flash.dwTimeout = 0
[void][W.U]::FlashWindowEx([ref]$flash)

try { if ($Sound) { $player = New-Object System.Media.SoundPlayer $Sound; $player.Play() } } catch { }
Start-Sleep -Milliseconds 900

# Where it really is: the rectangle Windows reports, and whether that lands in the monitor
# we asked for.
$rect = New-Object 'W.U+RECT'
[void][W.U]::GetWindowRect($hwnd, [ref]$rect)
$placeNow = New-Object 'W.U+WINDOWPLACEMENT'
$placeNow.length = [Runtime.InteropServices.Marshal]::SizeOf($placeNow)
[void][W.U]::GetWindowPlacement($hwnd, [ref]$placeNow)
$fgAfter = [W.U]::GetForegroundWindow()
[pscustomobject]@{
    hwnd       = $hwnd.ToInt64()
    screen     = $screen.DeviceName
    screens    = ($screens | ForEach-Object { $_.DeviceName }) -join ','
    asked      = @($x, $y, $w, $h)
    rect       = @($rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
    state      = $state
    toolWindow = ((([W.U]::GetWindowLong($hwnd, $GWL_EXSTYLE)) -band $WS_EX_TOOLWINDOW) -ne 0)
    normal     = @($placeNow.rcNormalPosition.Left, $placeNow.rcNormalPosition.Top, ($placeNow.rcNormalPosition.Right - $placeNow.rcNormalPosition.Left), ($placeNow.rcNormalPosition.Bottom - $placeNow.rcNormalPosition.Top))
    onScreen   = ($rect.Left -ge $area.X -and $rect.Top -ge $area.Y -and $rect.Right -le ($area.X + $area.Width))
    minimized  = [W.U]::IsIconic($hwnd)
    visible    = [W.U]::IsWindowVisible($hwnd)
    fgBefore   = $fgBefore.ToInt64()
    fgAfter    = $fgAfter.ToInt64()
    stoleFocus = ($fgBefore -ne $fgAfter)
} | ConvertTo-Json -Compress
