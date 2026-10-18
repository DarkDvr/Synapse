@echo off
REM ── Synapse stop ──────────────────────────────────────────────────
REM Stops a background Synapse server using its pid file.
setlocal
cd /d "%~dp0"
set PIDFILE=%~dp0data\synapse.pid

if not exist "%PIDFILE%" (
  echo [Synapse] no pid file found - is it running?
  pause
  exit /b 1
)

set /p PID=<"%PIDFILE%"
echo [Synapse] stopping pid %PID% ...
taskkill /PID %PID% /T /F >NUL 2>&1
del "%PIDFILE%" >NUL 2>&1
echo [Synapse] done.
pause
