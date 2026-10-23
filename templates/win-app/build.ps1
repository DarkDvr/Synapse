# build.ps1 — one command from source to a folder you can copy anywhere.
#
#   .\build.ps1                lean: a small exe that uses the .NET 10 Desktop
#                              Runtime already on the PC (about 2 MB)
#   .\build.ps1 -Portable      self-contained single-file exe in dist\ (about 60 MB,
#                              runs on a PC with no .NET — the runtime travels inside)
#   .\build.ps1 -Out ..\out    somewhere else
#
# Lean is the default because the runtime is a system component: shipping a second
# copy beside every app duplicates 140 MB and freezes it at whatever version the
# build machine had, security fixes included. -Portable is the honest exception for
# a PC that has no .NET 10 Desktop Runtime, and the only thing that choice costs is
# its size.
#
# The UI is copied next to the exe as ui\, so the built app and the files that were
# reviewed are the same bytes.
param(
  [switch]$Portable,
  [string]$Out = 'dist'
)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  $selfContained = if ($Portable) { 'true' } else { 'false' }
  # Compression is only allowed in a self-contained bundle — the SDK answers
  # NETSDK1176 otherwise, which used to make -Framework fail outright.
  $extra = @()
  if ($Portable) { $extra += '-p:EnableCompressionInSingleFile=true' }
  Write-Host "publishing (self-contained: $selfContained)..."
  dotnet publish -c Release -r win-x64 --self-contained $selfContained `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true @extra `
    -o $Out | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with $LASTEXITCODE" }

  $exe = Get-ChildItem (Join-Path $Out '*.exe') | Select-Object -First 1
  if (-not $exe) { throw "no .exe in $Out" }
  $total = (Get-ChildItem $Out -Recurse -File | Measure-Object -Property Length -Sum).Sum
  "{0}  {1:N1} MB   folder {2:N1} MB" -f $exe.FullName, ($exe.Length / 1MB), ($total / 1MB)
  Write-Host "check it with: node `"$((Resolve-Path '..\..\skills\app-check\bin\app-check.mjs' -ErrorAction SilentlyContinue))`" --exe `"$($exe.FullName)`""
}
finally {
  Pop-Location
}
