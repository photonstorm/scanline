# Builds the Scanline app for Windows: app\target\Scanline\ holding Scanline.exe, its command
# line as scanline-cli.exe, CEF's files and the start page. Chromium's helpers are
# Scanline.exe itself on Windows.
#
#   npm run app                                                        a debug build
#   powershell -ExecutionPolicy Bypass -File app\bundle.ps1            the same
#   $env:RELEASE = '1'; powershell -ExecutionPolicy Bypass -File app\bundle.ps1
#
# Needs Visual Studio 2022 (or its Build Tools) with the C++ tools: they bring cmake and ninja,
# which compile CEF's C++ wrapper, and this script finds them. The first build downloads CEF
# for Windows (175 MB) into app\target\cef.

$here = $PSScriptRoot
$root = Split-Path $here -Parent

if ($env:RELEASE) { $kind = 'release'; $flag = @('--release') } else { $kind = 'debug'; $flag = @() }

# The command line first, in the environment it is always built in: what follows would make
# cargo build its C dependencies again, here and in the next plain cargo build.
Push-Location $root
cargo build @flag -p scanline
$built = $LASTEXITCODE
Pop-Location

if ($built -ne 0) { throw 'cargo build of scanline failed' }

# The MSVC tools, cmake and ninja, from Visual Studio's developer shell when they are not on
# the PATH already.
if (-not ((Get-Command cl.exe -ErrorAction SilentlyContinue) -and (Get-Command cmake.exe -ErrorAction SilentlyContinue) -and (Get-Command ninja.exe -ErrorAction SilentlyContinue))) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }

    if (-not $vs) {
        throw 'Building the app needs Visual Studio 2022, or its Build Tools, with the C++ tools.'
    }

    # The shell's own search for vswhere complains that it is not on the PATH, and then finds it.
    & (Join-Path $vs 'Common7\Tools\Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation *> $null
}

# CEF targets Windows 10 21H2 (NTDDI_WIN10_FE), which the Windows 10 SDK, 10.0.19041, does not
# know: its own headers then fail to compile. With that SDK the constant is given to the
# compiler; a newer SDK has it already.
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Include'
$newest = Get-ChildItem $kits -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+(\.\d+)+$' } | Sort-Object { [version]$_.Name } | Select-Object -Last 1

if ($newest -and -not (Select-String -Path (Join-Path $newest.FullName 'shared\sdkddkver.h') -Pattern 'NTDDI_WIN10_FE' -Quiet)) {
    $env:CL = ('/DNTDDI_WIN10_FE=0x0A00000A ' + $env:CL).Trim()
}

$env:CEF_PATH = Join-Path $here 'target\cef'

Push-Location $here
cargo build @flag
$built = $LASTEXITCODE
Pop-Location

if ($built -ne 0) { throw 'cargo build of the app failed' }

$from = Join-Path $here "target\$kind"
$out = Join-Path $here 'target\Scanline'

New-Item -ItemType Directory -Force -Path $out | Out-Null

# The app and its command line. Not scanline.exe: file names on Windows ignore case.
Copy-Item (Join-Path $from 'Scanline.exe') (Join-Path $out 'Scanline.exe') -Force -ErrorAction Stop
Copy-Item (Join-Path $root "target\$kind\scanline.exe") (Join-Path $out 'scanline-cli.exe') -Force -ErrorAction Stop
Copy-Item (Join-Path $here 'resources\start.html') (Join-Path $out 'start.html') -Force -ErrorAction Stop
# The icons are compiled in; their licence (CC BY 4.0, with attribution) travels with them.
Copy-Item (Join-Path $here 'resources\icons\LICENSE.md') (Join-Path $out 'Icons LICENSE.md') -Force -ErrorAction Stop

# CEF's runtime, from the distribution itself: its DLLs, resources, V8's snapshot, ICU's data
# and SwiftShader's description (the build copies the same beside the executable, with
# libcef.lib and the rest of the distribution's top level).
$cef = Get-ChildItem $env:CEF_PATH -Directory | ForEach-Object { Join-Path $_.FullName 'cef_windows_x86_64' } | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $cef) { throw "CEF for Windows is not in $env:CEF_PATH" }

Get-ChildItem $cef -File | Where-Object { $_.Extension -in '.dll', '.pak', '.bin', '.dat' -or $_.Name -eq 'vk_swiftshader_icd.json' } | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $out $_.Name) -Force -ErrorAction Stop
}

$locales = Join-Path $out 'locales'

if (Test-Path $locales) { Remove-Item $locales -Recurse -Force }

Copy-Item (Join-Path $cef 'locales') $locales -Recurse -Force -ErrorAction Stop

Write-Output "Built $out"
