# Put agent-browser in bin\agent-browser so it travels with Synapse.
#
#   .\vendor-agent-browser.ps1
#
# agent-browser is the action layer: it turns a page into named controls with refs and
# drives them over CDP. It is a native Windows binary from Vercel Labs (Apache-2.0), not
# an npm package, and it never launches a browser of its own here — it attaches to the
# Edge Synapse owns. bin\ is not in git; this script is how the binary gets there.
param(
  [string]$Version = '0.43.0',
  [string]$Sha256 = 'ebcef5ebea93c7ccf0fe3f8c18eee908ae9174dfef8e52a3dda6f24a59f630dc'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $root 'bin\agent-browser'
$destExe = Join-Path $dest 'agent-browser.exe'
$url = "https://github.com/vercel-labs/agent-browser/releases/download/v$Version/agent-browser-win32-x64.exe"

New-Item -ItemType Directory -Force -Path $dest | Out-Null

function Get-Sha([string]$File) {
  (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLower()
}

$want = $Sha256.ToLower()
$current = $false
if (Test-Path -LiteralPath $destExe) {
  $have = Get-Sha $destExe
  if ($have -eq $want) {
    $current = $true
    Write-Host "agent-browser $Version is already in $destExe (sha256 matches)"
  } else {
    Write-Host "the existing binary does not match $Version; replacing it"
  }
}

# curl.exe ships with Windows 10/11 and does not depend on PowerShell's TLS stack, which
# failed on a machine where this was first vendored. Invoke-WebRequest is the fallback.
$curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source

if (-not $current) {
  $temp = "$destExe.download"
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  if ($curl) {
    & $curl -L --fail --silent --show-error -o $temp $url
    if ($LASTEXITCODE -ne 0) { throw "curl failed to download $url" }
  } else {
    Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 120 -OutFile $temp
  }
  $got = Get-Sha $temp
  if ($got -ne $want) {
    Remove-Item -LiteralPath $temp -Force
    throw "sha256 mismatch: expected $Sha256, got $got. Nothing was installed."
  }
  Move-Item -LiteralPath $temp -Destination $destExe -Force
}

# The Apache-2.0 notice travels with the binary, on a first run and on a repeat one. If
# the machine is offline, a short pointer is written instead; the licence is also named
# in THIRD-PARTY.md.
$license = Join-Path $dest 'LICENSE'
try {
  if ($curl) {
    & $curl -L --fail --silent --show-error -o $license 'https://www.apache.org/licenses/LICENSE-2.0.txt'
    if ($LASTEXITCODE -ne 0) { throw 'curl failed' }
  } else {
    Invoke-WebRequest -Uri 'https://www.apache.org/licenses/LICENSE-2.0.txt' -UseBasicParsing -TimeoutSec 30 -OutFile $license
  }
  Write-Host 'wrote LICENSE (Apache-2.0)'
} catch {
  Set-Content -Path $license -Encoding utf8 -Value @(
    'agent-browser is licensed under the Apache License, Version 2.0.',
    'https://www.apache.org/licenses/LICENSE-2.0.txt',
    'Copyright Vercel Labs and contributors.'
  )
  Write-Host "could not download the licence text; wrote a pointer to $license"
}

Set-Content -Path (Join-Path $dest 'VERSION.txt') -Encoding utf8 -Value @(
  "agent-browser $Version (win32-x64) $((Get-Item $destExe).Length) bytes",
  "sha256 $want",
  "source $url",
  "Apache-2.0, Copyright Vercel Labs and contributors.",
  'Attached to Synapse''s own Edge over CDP; it does not launch a browser here.'
)

Write-Host ''
Write-Host "done: $destExe"
Write-Host 'Restart Synapse; no Settings change is needed.'
