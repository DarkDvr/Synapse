# show.ps1 — tell the operator SynaBrowse is waiting, without interrupting them.
#
# The window is ours (the process whose command line names the SynaBrowse profile). It is
# moved into the second monitor's working area, shown **minimized** on the taskbar, its
# button blinked, and one chime is played. Nothing is activated: the foreground window is
# the operator's, before and after, and the report proves it.
#
#   show.ps1                 ask for attention (the default)
#   show.ps1 -Restore        bring it back on screen, still without stealing focus
param(
    [string]$Marker = 'Synapse\data\browser\profile',
    [string]$Sound = 'F:\dev\Synapse\web\sounds\chime.wav',
    [switch]$Restore
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not ('W.U' -as [type])) {
    Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
'@
}

$fgBefore = [W.U]::GetForegroundWindow()

# Our browser: a process whose command line names the SynaBrowse profile and that owns a
# window. Renderer children carry the profile path too and own none.
$pids = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" |
    Where-Object { $_.CommandLine -like "*$Marker*" } |
    ForEach-Object { $_.ProcessId }
$win = $null
foreach ($id in $pids) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) { $win = $p; break }
}
if (-not $win) { '{"error":"no SynaBrowse window"}' | Write-Output; exit 1 }

$screen = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
if (-not $screen) { $screen = [System.Windows.Forms.Screen]::PrimaryScreen }
$area = $screen.WorkingArea
$w = [Math]::Min(1200, [int]($area.Width * 0.72))
$h = [Math]::Min(860, [int]($area.Height * 0.86))
$x = $area.X + [int](($area.Width - $w) / 2)
$y = $area.Y + [int](($area.Height - $h) / 2)

$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_SHOWWINDOW = 0x0040
[void][W.U]::SetWindowPos($win.MainWindowHandle, [IntPtr]::Zero, $x, $y, $w, $h, $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW)

if ($Restore) {
    # On screen, in the second monitor's place, and still not the foreground window.
    [void][W.U]::ShowWindow($win.MainWindowHandle, 9)   # SW_RESTORE
    [void][W.U]::ShowWindow($win.MainWindowHandle, 4)   # SW_SHOWNOACTIVATE
} else {
    # On the taskbar, waiting. SW_SHOWMINNOACTIVE: minimized, and not activated.
    [void][W.U]::ShowWindow($win.MainWindowHandle, 7)
}

# Blink the taskbar button so the operator notices without a sound alone.
$flash = New-Object 'W.U+FLASHWINFO'
$flash.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($flash)
$flash.hwnd = $win.MainWindowHandle
$flash.dwFlags = 0x00000002 -bor 0x0000000C   # FLASHW_TRAY | FLASHW_TIMERNOFG
$flash.uCount = 3
$flash.dwTimeout = 0
[void][W.U]::FlashWindowEx([ref]$flash)

try { $player = New-Object System.Media.SoundPlayer $Sound; $player.Play() } catch { }
Start-Sleep -Milliseconds 900

$fgAfter = [W.U]::GetForegroundWindow()
[pscustomobject]@{
    hwnd       = $win.MainWindowHandle.ToInt64()
    screen     = $screen.DeviceName
    rect       = @($x, $y, $w, $h)
    minimized  = [W.U]::IsIconic($win.MainWindowHandle)
    visible    = [W.U]::IsWindowVisible($win.MainWindowHandle)
    fgBefore   = $fgBefore.ToInt64()
    fgAfter    = $fgAfter.ToInt64()
    stoleFocus = ($fgBefore -ne $fgAfter)
} | ConvertTo-Json -Compress
