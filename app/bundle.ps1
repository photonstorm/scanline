# Builds the Scanline app for Windows: app\target\Scanline\ holding Scanline.exe, its command
# line as scanline-cli.exe, CEF's files and the start page. Chromium's helpers are
# Scanline.exe itself on Windows.
#
#   powershell -ExecutionPolicy Bypass -File app\bundle.ps1            a debug build
#   $env:RELEASE = '1'; powershell -ExecutionPolicy Bypass -File app\bundle.ps1
#
# Written on the Mac on 12 November 2026 and never run: docs/HANDOVER.md, section 2a. Needs
# cmake and ninja on the PATH (for CEF's C++ wrapper) and the MSVC tools the host builds with.
# The first build downloads CEF for Windows (175 MB) into app\target\cef.

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$root = Split-Path $here -Parent

$env:CEF_PATH = Join-Path $here 'target\cef'

if ($env:RELEASE) { $profile = 'release'; $flag = @('--release') } else { $profile = 'debug'; $flag = @() }

Push-Location $here
cargo build @flag
if ($LASTEXITCODE -ne 0) { throw 'cargo build of the app failed' }
Pop-Location

Push-Location $root
cargo build @flag -p scanline
if ($LASTEXITCODE -ne 0) { throw 'cargo build of scanline failed' }
Pop-Location

$built = Join-Path $here "target\$profile"
$out = Join-Path $here 'target\Scanline'

New-Item -ItemType Directory -Force -Path $out | Out-Null

# The app and its command line. Not scanline.exe: file names on Windows ignore case.
Copy-Item (Join-Path $built 'Scanline.exe') (Join-Path $out 'Scanline.exe') -Force
Copy-Item (Join-Path $root "target\$profile\scanline.exe") (Join-Path $out 'scanline-cli.exe') -Force
Copy-Item (Join-Path $here 'resources\start.html') (Join-Path $out 'start.html') -Force
# The icons are compiled in; their licence (CC BY 4.0, with attribution) travels with them.
Copy-Item (Join-Path $here 'resources\icons\LICENSE.md') (Join-Path $out 'Icons LICENSE.md') -Force

# CEF's runtime: the build copies it beside the executable (cef-dll-sys, copy_cef_runtime_files).
Get-ChildItem $built -File | Where-Object { $_.Extension -in '.dll', '.pak', '.bin', '.dat', '.json' } | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $out $_.Name) -Force
}

$locales = Join-Path $built 'locales'

if (Test-Path $locales) {
    Copy-Item $locales (Join-Path $out 'locales') -Recurse -Force
}

Write-Output "Built $out"
