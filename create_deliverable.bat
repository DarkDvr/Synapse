@echo off
setlocal EnableExtensions DisableDelayedExpansion
REM create_deliverable.bat [--build] [--no-pause]
REM
REM Builds Synapse.zip in this folder: Synapse.exe, the web UI, src, skills, the
REM Windows app template, the vendored Node runtime and the vendored engine. It
REM leaves out the runtime state (data, logs, config), the tests, docs, references,
REM shell sources, vendor caches and build output.
REM
REM The target PC is assumed to have the .NET 10 Desktop Runtime and the WebView2
REM Runtime.
REM
REM --build      rebuild Synapse.exe with shell\build.ps1 first (needs the .NET SDK)
REM --no-pause   do not wait for a key at the end on success (errors always wait)

cd /d "%~dp0"
set "ROOT=%CD%"
set "ZIP=%ROOT%\Synapse.zip"
set "STAGE=%TEMP%\SynapseDeliverable"
set "MARKER=%STAGE%\.synapse-deliverable"
set "NO_PAUSE="
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"
if /I "%~2"=="--no-pause" set "NO_PAUSE=1"

if /I "%~1"=="--build" goto build
if not exist "%ROOT%\Synapse.exe" goto build
goto guard

:build
where dotnet >nul 2>nul
if errorlevel 1 (
  echo Synapse.exe is missing and the .NET SDK is not on PATH.
  echo Build it first with: shell\build.ps1
  goto fail
)
if not exist "%ROOT%\shell\build.ps1" (
  echo Synapse.exe is missing and shell\build.ps1 is not here either.
  goto fail
)
echo Building Synapse.exe...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\shell\build.ps1"
if errorlevel 1 goto fail
if not exist "%ROOT%\Synapse.exe" (
  echo The build finished but Synapse.exe is not at the root.
  goto fail
)

:guard
REM Nothing outside the staging folder may ever be removed. The marker is written
REM after a successful create, so an edited STAGE pointing at the repo or a user
REM folder cannot be wiped by a later run.
if "%STAGE%"=="" goto fail
if /I "%STAGE%"=="%ROOT%" goto badstage
if /I "%STAGE%"=="%TEMP%" goto badstage
if /I "%STAGE%"=="%USERPROFILE%" goto badstage
if /I "%STAGE%"=="%SystemDrive%\" goto badstage
if exist "%STAGE%" if not exist "%MARKER%" goto badstage
goto check

:badstage
echo Refusing to use a staging folder that is not the deliverable temp folder:
echo   %STAGE%
echo Nothing was deleted.
goto fail

:check
for %%F in (
  "%ROOT%\Synapse.exe"
  "%ROOT%\package.json"
  "%ROOT%\src\index.js"
  "%ROOT%\web\index.html"
  "%ROOT%\bin\node\node.exe"
  "%ROOT%\bin\opencode\opencode.exe"
) do if not exist "%%~F" (
  echo Missing runtime file: %%~F
  echo Run vendor-node.ps1 and vendor-engine.ps1 if the runtime is not vendored.
  goto fail
)

if exist "%STAGE%" (
  rmdir /s /q "%STAGE%"
  if exist "%STAGE%" (
    echo Could not clear the staging folder: %STAGE%
    goto fail
  )
)
mkdir "%STAGE%"
if errorlevel 1 (
  echo Could not create the staging folder: %STAGE%
  goto fail
)
> "%MARKER" echo deliverable staging folder
mkdir "%STAGE%\Synapse"
if errorlevel 1 goto fail

if exist "%ZIP%" (
  del /q "%ZIP%"
  if exist "%ZIP%" (
    echo Could not replace the old zip: %ZIP%
    goto fail
  )
)

echo Copying the runtime...
copy /Y "%ROOT%\Synapse.exe" "%STAGE%\Synapse\Synapse.exe" >nul
if errorlevel 1 goto copyfail
copy /Y "%ROOT%\package.json" "%STAGE%\Synapse\package.json" >nul
if errorlevel 1 goto copyfail

call :copy_tree "%ROOT%\src" "%STAGE%\Synapse\src"
if errorlevel 1 goto copyfail
call :copy_tree "%ROOT%\web" "%STAGE%\Synapse\web"
if errorlevel 1 goto copyfail
call :copy_tree "%ROOT%\skills" "%STAGE%\Synapse\skills"
if errorlevel 1 goto copyfail
call :copy_tree "%ROOT%\templates" "%STAGE%\Synapse\templates" obj
if errorlevel 1 goto copyfail
call :copy_tree "%ROOT%\bin\node" "%STAGE%\Synapse\bin\node"
if errorlevel 1 goto copyfail
call :copy_tree "%ROOT%\bin\opencode" "%STAGE%\Synapse\bin\opencode"
if errorlevel 1 goto copyfail

REM A short note for the person unzipping it. This is the only thing they need to
REM know that the UI does not tell them.
> "%STAGE%\Synapse\README.txt" echo Synapse
>> "%STAGE%\Synapse\README.txt" echo =======
>> "%STAGE%\Synapse\README.txt" echo.
>> "%STAGE%\Synapse\README.txt" echo Requirements:
>> "%STAGE%\Synapse\README.txt" echo   Windows 10 or 11, 64-bit.
>> "%STAGE%\Synapse\README.txt" echo   .NET 10 Desktop Runtime.
>> "%STAGE%\Synapse\README.txt" echo   Microsoft Edge WebView2 Runtime.
>> "%STAGE%\Synapse\README.txt" echo.
>> "%STAGE%\Synapse\README.txt" echo Run:
>> "%STAGE%\Synapse\README.txt" echo   Double-click Synapse.exe. Nothing needs installing.
>> "%STAGE%\Synapse\README.txt" echo.
>> "%STAGE%\Synapse\README.txt" echo First run:
>> "%STAGE%\Synapse\README.txt" echo   Creates config, data and logs next to Synapse.exe.
>> "%STAGE%\Synapse\README.txt" echo   Creates the projects folder next to this folder,
>> "%STAGE%\Synapse\README.txt" echo   as ..\Synapse.Projects. Keep this folder somewhere
>> "%STAGE%\Synapse\README.txt" echo   writable, not under Program Files.
>> "%STAGE%\Synapse\README.txt" echo.
>> "%STAGE%\Synapse\README.txt" echo The engine and its licence are in bin\opencode. The Node
>> "%STAGE%\Synapse\README.txt" echo runtime and its licence are in bin\node.

echo Packing Synapse.zip...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%STAGE%\Synapse' -DestinationPath '%ZIP%' -Force -CompressionLevel Optimal"
if errorlevel 1 goto fail
if not exist "%ZIP%" (
  echo The packer returned no zip: %ZIP%
  goto fail
)
for %%A in ("%ZIP%") do set "SIZE=%%~zA"
if not defined SIZE goto fail
if "%SIZE%"=="0" goto fail
set /a MB=%SIZE%/1048576
echo.
echo Created "%ZIP%"  ^(%MB% MB^)
echo Contents: Synapse.exe, package.json, src, web, skills, templates, bin\node,
echo bin\opencode, README.txt.
rmdir /s /q "%STAGE%"
if not defined NO_PAUSE pause
exit /b 0

:copyfail
echo Could not copy a runtime folder into the staging area.
goto fail

:copy_tree
if "%~3"=="" (
  robocopy "%~1" "%~2" /E /NFL /NDL /NJH /NJS /NP >nul
) else (
  robocopy "%~1" "%~2" /E /NFL /NDL /NJH /NJS /NP /XD "%~3" >nul
)
if errorlevel 8 exit /b 1
exit /b 0

:fail
echo.
echo DELIVERABLE FAILED - nothing else was attempted.
echo.
pause
exit /b 1
