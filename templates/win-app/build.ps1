# build.ps1 — one command from source to a folder you can copy anywhere.
#
#   .\build.ps1                 self-contained single-file exe in dist\ (runs with no
#                               .NET installed — the runtime travels inside)
#   .\build.ps1 -Framework      small exe that needs the .NET 10 runtime present
#   .\build.ps1 -Out ..\out     somewhere else
#
# The UI is copied next to the exe as ui\, so the built app and the files that were
# reviewed are the same bytes.
param(
  [switch]$Framework,
  [string]$Out = 'dist'
)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  $selfContained = if ($Framework) { 'false' } else { 'true' }
  Write-Host "publishing (self-contained: $selfContained)..."
  dotnet publish -c Release -r win-x64 --self-contained $selfContained `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true -o $Out | Out-Host
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
