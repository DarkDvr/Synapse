# screen.ps1 — the screen state a launch needs, and the way back to the operator's window.
#
#   screen.ps1 -Mode state            the foreground window and every monitor's rectangle
#   screen.ps1 -Mode restore -Hwnd N  put window N back in front
#
# Why this exists: Edge's launch takes the foreground even with `--start-minimized`, so the
# operator loses focus on whatever they were typing in before any hand-off is asked for
# (measured 11 Nov). The launch captures the foreground first and puts it back afterwards,
# and the window is positioned on the second monitor rather than off-screen, so its taskbar
# button appears there.
param(
    [string]$Mode = 'state',
    [long]$Hwnd = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not ('W.F' -as [type])) {
    Add-Type -Namespace W -Name F -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool on);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
'@
}

if ($Mode -eq 'state') {
    $foreground = [W.F]::GetForegroundWindow()
    $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        [pscustomobject]@{
            device  = $_.DeviceName
            primary = $_.Primary
            x       = $_.Bounds.X
            y       = $_.Bounds.Y
            w       = $_.Bounds.Width
            h       = $_.Bounds.Height
            workX   = $_.WorkingArea.X
            workY   = $_.WorkingArea.Y
            workW   = $_.WorkingArea.Width
            workH   = $_.WorkingArea.Height
        }
    })
    [pscustomobject]@{
        foreground = $foreground.ToInt64()
        screens    = $screens
    } | ConvertTo-Json -Compress -Depth 4
    exit 0
}

# Restore: a process that does not own the foreground may not take it by itself, so this
# attaches to the current foreground thread for the length of the call. That is the
# documented trick, and it is what makes "give the focus back" actually work.
$target = [IntPtr]$Hwnd
if ($Hwnd -eq 0 -or -not [W.F]::IsWindow($target)) { '{"ok":false,"why":"no such window"}'; exit 0 }
$current = [W.F]::GetCurrentThreadId()
$foreground = [W.F]::GetForegroundWindow()
$pidIgnored = [uint32]0
$foregroundThread = [W.F]::GetWindowThreadProcessId($foreground, [ref]$pidIgnored)
$attached = $false
if ($foregroundThread -ne 0 -and $foregroundThread -ne $current) {
    $attached = [W.F]::AttachThreadInput($current, $foregroundThread, $true)
}
$ok = [W.F]::SetForegroundWindow($target)
[void][W.F]::BringWindowToTop($target)
if ($attached) { [void][W.F]::AttachThreadInput($current, $foregroundThread, $false) }
[pscustomobject]@{
    ok     = $ok
    now    = ([W.F]::GetForegroundWindow()).ToInt64()
    wanted = $Hwnd
} | ConvertTo-Json -Compress
