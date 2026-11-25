# build.ps1 — the app, from source to the folder root.
#
#   .\shell\build.ps1             lean: Synapse.exe at the root, needs the .NET 10
#                                 Desktop Runtime (about 2 MB)
#   .\shell\build.ps1 -Portable   self-contained single-file exe (about 60 MB,
#                                 runs on a PC with no .NET at all)
#
# The exe lands at the ROOT, beside src\ and web\, because Synapse.exe is the whole
# launcher: it finds its own server by looking next to itself, and nothing else is
# started by hand. It is build output and is not in git.
#
# It may run while Synapse is running. Windows locks the image file against a
# replacement but allows a rename, so the locked exe is moved aside and the new one
# takes its place; the running window keeps the old image, and the operator's next
# launch runs the new build. No process is stopped by this script.
#
# The build publishes into a scratch dist\ first and then proves the claim it makes
# — *one* file at the root. A side-by-side DLL would mean the folder is not what
# was promised, and the operator would be copying files nobody documented, so that
# fails loudly with the list instead of being tidied up later.
param([switch]$Portable)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$dist = Join-Path $here 'dist'

# The packages a Windows app needs are vendored (vendor-nuget.ps1), so a build on
# a machine with no network still works. Nothing is fetched to the user's profile.
$packs = Join-Path $root 'vendor\nuget-packages'
if (Test-Path $packs) { $env:NUGET_PACKAGES = $packs }

Push-Location $here
try {
  $selfContained = if ($Portable) { 'true' } else { 'false' }
  # Compression is only allowed in a self-contained bundle — the SDK answers
  # NETSDK1176 otherwise.
  $extra = @()
  if ($Portable) { $extra += '-p:EnableCompressionInSingleFile=true' }

  if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
  Write-Host "publishing Synapse.exe to $root (self-contained: $selfContained)..."
  dotnet publish -c Release -r win-x64 --self-contained $selfContained `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true @extra `
    -o $dist | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with $LASTEXITCODE" }

  # NuGet puts XML documentation beside assemblies and symbols belong to the build
  # machine, so neither is part of what the operator copies.
  Get-ChildItem $dist -File -Filter '*.xml' | Remove-Item -Force

  # One file, and it is named Synapse.exe.
  $built = @(Get-ChildItem $dist -File | Where-Object { $_.Extension -ne '.pdb' })
  if ($built.Count -ne 1 -or $built[0].Name -ne 'Synapse.exe') {
    throw "the publish produced more than one file, so the root would not hold one exe: $($built.Name -join ', ')"
  }

  # The app is often running while a build is made, and Windows keeps the image
  # file locked. Renaming a running exe is allowed; replacing it is not. Rename the
  # old one aside and put the new one in its place, so the build lands without
  # stopping the app, and the operator's next launch runs the new build.
  $target = Join-Path $root 'Synapse.exe'
  try {
    Copy-Item $built[0].FullName $target -Force -ErrorAction Stop
  } catch {
    $old = "$target.old-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item $target $old -Force -ErrorAction Stop
    Copy-Item $built[0].FullName $target -Force -ErrorAction Stop
    Write-Host "  Synapse was running; the old exe is $old and the new build starts on the next launch."
  }
  $size = (Get-Item $target).Length / 1MB
  Write-Host ''
  Write-Host ("{0}  {1:N1} MB" -f $target, $size)

  # The browser is its own process: a WebView2 host cannot live inside the single-file
  # Synapse.exe. It is framework-dependent like the app, one file, and lives in bin\.
  # Publish it beside the target so a running host never blocks the build.
  $hostProject = Join-Path $here 'SynaBrowseHost\SynaBrowseHost.csproj'
  $hostOut = Join-Path $root 'bin\browser-host'
  $hostTmp = Join-Path $here 'dist-host'
  if (Test-Path $hostTmp) { Remove-Item $hostTmp -Recurse -Force }
  Write-Host "publishing SynaBrowseHost.exe to $hostOut..."
  dotnet publish $hostProject -c Release -r win-x64 --self-contained false `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $hostTmp | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "the browser host publish failed with $LASTEXITCODE" }
  Get-ChildItem $hostTmp -File -Filter '*.xml' | Remove-Item -Force
  if (-not (Test-Path (Join-Path $hostTmp 'SynaBrowseHost.exe'))) { throw 'the browser host exe was not published' }
  $hostLocked = $false
  if (Test-Path $hostOut) {
    try {
      Remove-Item $hostOut -Recurse -Force -ErrorAction Stop
    } catch {
      $hostLocked = $true
    }
  }
  if ($hostLocked) {
    $oldHost = "$hostOut.old-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item $hostOut $oldHost -Force -ErrorAction Stop
    Write-Host "  the browser host is running; the old folder is $oldHost."
  }
  Move-Item $hostTmp $hostOut -Force -ErrorAction Stop
  Write-Host ''
  Write-Host ("{0}  {1:N1} MB" -f (Join-Path $hostOut 'SynaBrowseHost.exe'), ((Get-Item (Join-Path $hostOut 'SynaBrowseHost.exe')).Length / 1MB))
  Write-Host 'Launch it. Nothing else starts the app.'
  Write-Host "Check the window with: node `"$root\skills\app-check\bin\app-check.mjs`" --exe `"$root\Synapse.exe`""
}
finally {
  Pop-Location
  Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $here 'dist-host') -Recurse -Force -ErrorAction SilentlyContinue
}
