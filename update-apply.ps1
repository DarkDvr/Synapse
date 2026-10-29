# update-apply.ps1 - finish a Synapse update after the app has closed.
#
# The server downloads and unpacks the release, then starts this script detached
# and exits with code 3. The shell sees that code, closes the window, and this
# script waits for both processes to be gone before it touches a file.
#
# Only program files are replaced. data\, logs\, config\ and the projects folder
# are never in the stage and are never copied over; the previous program files are
# kept in data\backups\ so a failed copy can be put back.
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Stage,
    [int]$ServerPid = 0,
    [int]$ShellPid = 0,
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$updateDir = Join-Path $Root 'data\update'
New-Item -ItemType Directory -Force -Path $updateDir | Out-Null
$logFile = Join-Path $updateDir 'apply.log'

function Say([string]$line) {
    $stamp = Get-Date -Format 'HH:mm:ss'
    Add-Content -LiteralPath $logFile -Value "[$stamp] $line" -Encoding utf8
}

function Wait-Gone([int]$id, [int]$milliseconds, [string]$what) {
    if ($id -le 0) { return $true }
    $until = (Get-Date).AddMilliseconds($milliseconds)
    while ((Get-Date) -lt $until) {
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        if (-not $p) { return $true }
        Start-Sleep -Milliseconds 400
    }
    Say "$what (pid $id) did not exit in time"
    return $false
}

function Backup-Programs([string]$to) {
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    foreach ($rel in @('Synapse.exe', 'package.json', 'update-apply.ps1', 'src', 'web', 'skills', 'templates')) {
        $from = Join-Path $Root $rel
        if (-not (Test-Path -LiteralPath $from)) { continue }
        Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
    }
}

function Restore-Programs([string]$from) {
    if (-not (Test-Path -LiteralPath $from)) { return }
    foreach ($rel in @('Synapse.exe', 'package.json', 'update-apply.ps1', 'src', 'web', 'skills', 'templates')) {
        $src = Join-Path $from $rel
        if (-not (Test-Path -LiteralPath $src)) { continue }
        Copy-Item -LiteralPath $src -Destination $Root -Recurse -Force
    }
}

Say "update to $Version requested; waiting for the app to close"
if (-not (Wait-Gone $ServerPid 60000 'the server')) {
    Say 'aborted: the server is still running'
    exit 1
}
if (-not (Wait-Gone $ShellPid 60000 'the app window')) {
    $p = Get-Process -Id $ShellPid -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'Synapse') {
        Say 'the app did not close; stopping this window so the update can finish'
        Stop-Process -Id $ShellPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $Root "data\backups\$Version-$stamp"
$ok = $false
try {
    Say "backing up the current program files to $backup"
    Backup-Programs $backup
    Say 'copying the new program files'
    $rc = Start-Process -FilePath 'robocopy.exe' -ArgumentList @(
        $Stage, $Root, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1',
        '/XD', (Join-Path $Stage 'data'), (Join-Path $Stage 'logs'), (Join-Path $Stage 'config')
    ) -Wait -PassThru -WindowStyle Hidden
    if ($rc.ExitCode -ge 8) { throw "robocopy failed with $($rc.ExitCode)" }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'Synapse.exe'))) { throw 'Synapse.exe is missing after the copy' }
    $ok = $true
    Say 'update applied'
}
catch {
    Say "update failed: $($_.Exception.Message)"
    try {
        Say 'restoring the previous program files'
        Restore-Programs $backup
    }
    catch {
        Say "restore failed: $($_.Exception.Message)"
    }
}

$result = [ordered]@{
    version = $Version
    ok = $ok
    at = (Get-Date).ToString('o')
    backup = $backup
    log = $logFile
}
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $updateDir 'last.json') -Encoding utf8

Say 'starting Synapse'
Start-Process -FilePath (Join-Path $Root 'Synapse.exe') -WorkingDirectory $Root
