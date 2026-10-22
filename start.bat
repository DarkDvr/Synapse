@echo off
REM ── Synapse launcher ──────────────────────────────────────────────────────
REM Starts the local Synapse server (which also starts the engine) and opens the
REM UI in your browser. This console window is the app: the engine's log and every
REM warning or error are mirrored into it, so leave it open while you work.
REM
REM Pass "restart" when the app relaunches itself (Settings > Restart Now). The
REM old process needs a moment to release the port before this one binds it, and
REM the old window closes itself instead of waiting at the pause below.
setlocal
cd /d "%~dp0"

REM The vendored runtime first: the copy in bin\node is what makes a folder copied
REM to another PC run without installing anything. vendor-node.ps1 puts it there.
set "NODE=%~dp0bin\node\node.exe"
if exist "%NODE%" goto :run

where node >NUL 2>&1
if errorlevel 1 (
  echo [Synapse] No Node.js found: neither bin\node\node.exe nor one on PATH.
  echo [Synapse] Run vendor-node.ps1 once, or install Node 22+ and retry.
  pause
  exit /b 1
)
set "NODE=node"

:run

if /i "%~1"=="restart" (
  echo [Synapse] restarting - waiting for the old process to let go of the port...
  ping -n 4 127.0.0.1 >NUL
)

echo [Synapse] starting... (Ctrl+C to stop)
"%NODE%" "src\index.js"

REM Exit code 2 is "asked to restart": another console is taking over, so this
REM window has nothing left to show and closes rather than waiting for a keypress.
if errorlevel 2 goto :eof

echo.
echo [Synapse] stopped.
pause
