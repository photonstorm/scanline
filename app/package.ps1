# Packs the Scanline app for Windows: dist\Scanline-app-<version>-windows-x64.zip, holding the
# Scanline folder (Scanline.exe, scanline-cli.exe, CEF's files and the start page). A release
# build first. Named "app" because the command line's own release, tools/package.mjs, is
# dist\scanline-<version>-windows-x64.zip, which is the same file to Windows: names ignore case.
#
#   powershell -ExecutionPolicy Bypass -File app\package.ps1
#
# Unsigned: signing is the owner's (docs/BY-HAND.md, "Yours to decide"), and comes before
# packing: Scanline.exe, scanline-cli.exe, and CEF's DLLs if they are to carry the owner's
# signature as well as the Chromium authors'. There is no installer yet: unpacked into
# %LOCALAPPDATA%\Programs, the host finds the app there.

$here = $PSScriptRoot
$root = Split-Path $here -Parent
$version = (Select-String -Path (Join-Path $root 'Cargo.toml') -Pattern '^version\s*=\s*"(.*)"' | Select-Object -First 1).Matches[0].Groups[1].Value

$env:RELEASE = '1'
& (Join-Path $here 'bundle.ps1')

if (-not $?) { throw 'The release build failed.' }

$dist = Join-Path $root 'dist'
$archive = Join-Path $dist "Scanline-app-$version-windows-x64.zip"

New-Item -ItemType Directory -Force -Path $dist | Out-Null

if (Test-Path $archive) { Remove-Item $archive -Force }

# The tar Windows ships with writes a zip, as tools/package.mjs uses it; named in full because a
# tar from elsewhere on the PATH may not.
& (Join-Path $env:SystemRoot 'System32\tar.exe') -a -cf $archive -C (Join-Path $here 'target') Scanline

if ($LASTEXITCODE -ne 0) { throw 'Packing the zip failed.' }

$size = [math]::Round((Get-Item $archive).Length / 1MB, 1)

Write-Output "Packed $archive ($size MB)"
