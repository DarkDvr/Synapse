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

where node >NUL 2>&1
if errorlevel 1 (
  echo [Synapse] Node.js was not found on PATH. Install Node 20+ and retry.
  pause
  exit /b 1
)

if /i "%~1"=="restart" (
  echo [Synapse] restarting - waiting for the old process to let go of the port...
  ping -n 4 127.0.0.1 >NUL
)

echo [Synapse] starting... (Ctrl+C to stop)
node "src\index.js"

REM Exit code 2 is "asked to restart": another console is taking over, so this
REM window has nothing left to show and closes rather than waiting for a keypress.
if errorlevel 2 goto :eof

echo.
echo [Synapse] stopped.
pause
