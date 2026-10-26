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

  Copy-Item $built[0].FullName (Join-Path $root 'Synapse.exe') -Force
  $size = (Get-Item (Join-Path $root 'Synapse.exe')).Length / 1MB
  Write-Host ''
  Write-Host ("{0}  {1:N1} MB" -f (Join-Path $root 'Synapse.exe'), $size)
  Write-Host 'Launch it. Nothing else starts the app.'
  Write-Host "Check the window with: node `"$root\skills\app-check\bin\app-check.mjs`" --exe `"$root\Synapse.exe`""
}
finally {
  Pop-Location
  Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
}
