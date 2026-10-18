@echo off
REM ── Synapse launcher ──────────────────────────────────────────────
REM Starts the local Synapse server (which also starts the engine) and
REM opens the UI in your browser. Close this window or press Ctrl+C to stop.
setlocal
cd /d "%~dp0"

where node >NUL 2>&1
if errorlevel 1 (
  echo [Synapse] Node.js was not found on PATH. Install Node 20+ and retry.
  pause
  exit /b 1
)

echo [Synapse] starting... (Ctrl+C to stop)
node "src\index.js"
echo.
echo [Synapse] stopped.
pause
