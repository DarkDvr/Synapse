@echo off
setlocal EnableExtensions
title Synapse - create travel copy
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Create a Synapse travel copy that runs on another PC with the .NET 10
rem  Desktop Runtime and the WebView2 Runtime already installed.
rem
rem  Usage:
rem    create_deliverable.bat                 prompts for a destination
rem    create_deliverable.bat "E:\shared\Synapse"
rem
rem  Safety: this file deletes nothing. It refuses the Synapse folder, anything
rem  inside or above it, and the projects folder. The PowerShell script it calls
rem  stages the copy beside the destination and only replaces a folder that
rem  carries its own .synapse-deliverable marker (and then only after you say yes).
rem ---------------------------------------------------------------------------

set "HERE=%~dp0"
set "DEST=%~1"

if /I "%~1"=="/?" goto help
if /I "%~1"=="--help" goto help
if /I "%~1"=="-h" goto help

if not defined DEST (
  echo.
  echo Synapse - create travel copy
  echo =============================
  echo.
  echo The target PC needs the .NET 10 Desktop Runtime and the WebView2 Runtime.
  echo The copy will include Synapse.exe, src, web, skills, templates, config and
  echo bin\node and bin\opencode. It will not include data, logs, projects, keys,
  echo tests, docs, references, shell sources, git history or the NuGet cache.
  echo.
  echo Choose an EMPTY folder, or a previous Synapse deliverable to replace.
  echo Do not choose the Synapse folder itself, anything inside it, or a folder
  echo that contains it.
  echo.
  set /p "DEST=Destination folder: "
)

if not defined DEST goto no_dest

rem A pasted path can arrive wrapped in quotes. Quotes are not legal in a Windows
rem file name, so removing them cannot damage a real path. `%%~fI` then makes it
rem absolute and drops a trailing slash, which would otherwise escape the closing
rem quote on the PowerShell command line.
set "DEST=%DEST:"=%"
for %%I in ("%DEST%") do set "DEST=%%~fI"

rem The same overlap test the PowerShell script performs, asked before anything is
rem staged: this is what rejects "F:\dev\Synapse" (and F:\dev above it) outright.
set "SYN_SRC=%HERE%"
set "SYN_DEST=%DEST%"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=[IO.Path]::GetFullPath($env:SYN_SRC).TrimEnd('\');" ^
  "$d=[IO.Path]::GetFullPath($env:SYN_DEST).TrimEnd('\');" ^
  "if($d -ieq $s -or $d.StartsWith($s+'\',[StringComparison]::OrdinalIgnoreCase) -or $s.StartsWith($d+'\',[StringComparison]::OrdinalIgnoreCase)){exit 3}"
if errorlevel 3 goto overlap

if not exist "%HERE%make-deliverable.ps1" (
  echo.
  echo ERROR: make-deliverable.ps1 is missing beside this file.
  goto fail
)

set "FORCE="
if exist "%DEST%\.synapse-deliverable" (
  echo.
  echo A Synapse deliverable already exists at:
  echo   %DEST%
  echo.
  choice /C YN /N /M "Replace it? [Y/N] "
  if errorlevel 2 goto cancelled
  set "FORCE=-Force"
)

echo.
echo Building the travel copy in a staging folder beside:
echo   %DEST%
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%HERE%make-deliverable.ps1" -Destination "%DEST%" %FORCE%
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo The copy was not completed. Nothing in this Synapse folder was changed.
  goto fail
)

echo.
echo Done. Copy that folder to the other PC and double-click Synapse.exe.
echo Nothing else needs installing there.
echo.
pause
exit /b 0

:overlap
echo.
echo REFUSED: that path is the Synapse folder, inside it, or a folder that
echo contains it.
echo.
echo Choose a separate folder, for example E:\shared\Synapse.
echo Nothing was copied or deleted.
echo.
pause
exit /b 3

:no_dest
echo.
echo No destination given. Nothing was copied or deleted.
echo.
pause
exit /b 2

:cancelled
echo.
echo Cancelled. Nothing was copied or deleted.
echo.
pause
exit /b 1

:fail
echo.
pause
exit /b 1

:help
echo.
echo Usage:
echo   create_deliverable.bat                 prompts for a destination
echo   create_deliverable.bat "E:\shared\Synapse"
echo.
echo The target PC needs the .NET 10 Desktop Runtime and the WebView2 Runtime.
echo The Synapse folder, anything inside or above it, and the projects folder
echo are refused. An existing deliverable is replaced only after you confirm.
echo.
pause
exit /b 0
