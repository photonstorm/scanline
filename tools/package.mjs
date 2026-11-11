// Builds a release of Scanline and packs it for this machine's platform:
//
//   node tools/package.mjs            dist/scanline-<version>-<platform>.tar.gz (.zip on Windows)
//   node tools/package.mjs --check    only check that the versions agree; build nothing
//
// The archive holds the one binary (the probe, the replay page and the skills are inside
// it), the skills as folders, the Claude Code plugin files, the README and an install
// script: install.sh, or install.ps1 on Windows.
//
// Signing on Windows needs the maintainer's code-signing certificate, and is not written:
// an unsigned scanline.exe runs, but Windows may ask the person before it does.
//
// Signing and notarisation need the maintainer's Apple Developer identity, which is not in
// this repository. With SCANLINE_SIGN_IDENTITY set, the binary is signed with the hardened
// runtime before it is packed. With SCANLINE_NOTARY_PROFILE also set (a notarytool keychain
// profile), the archive is submitted for notarisation. Neither path has been run: see
// docs/BY-HAND.md.

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const windows = process.platform === 'win32';

function run (command, args, options = {})
{
    return execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

// npm on Windows is a script (npm.cmd), which only the command interpreter can start.
function npmRun (script)
{
    return windows ? run('cmd.exe', ['/d', '/s', '/c', `npm run ${script}`]) : run('npm', ['run', script]);
}

// One version, said in three places. A release with them out of step is refused.
const cargo = /\[workspace\.package\][^[]*?version = "([^"]+)"/s.exec(readFileSync(join(root, 'Cargo.toml'), 'utf8'))?.[1];
const npm = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
const market = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));

const problems = [];

if (!cargo) { problems.push('Cargo.toml has no [workspace.package] version.'); }
if (npm !== cargo) { problems.push(`package.json is ${npm}; Cargo.toml is ${cargo}.`); }
if (plugin.version !== cargo) { problems.push(`.claude-plugin/plugin.json is ${plugin.version}; Cargo.toml is ${cargo}.`); }
if (market.plugins?.[0]?.name !== plugin.name) { problems.push(`marketplace.json lists "${market.plugins?.[0]?.name}"; plugin.json is "${plugin.name}".`); }

if (problems.length)
{
    console.error(`The versions do not agree:\n  ${problems.join('\n  ')}`);
    process.exit(1);
}

if (checkOnly)
{
    console.log(`Versions agree: ${cargo}.`);
    process.exit(0);
}

const platform = `${{ darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform] ?? process.platform}-${process.arch}`;
const name = `scanline-${cargo}-${platform}`;
const dist = join(root, 'dist');
const stage = join(dist, name);

// The probe and the replay page are built first: the binary holds them.
npmRun('build');
run('cargo', ['build', '--release', '--locked', '-p', 'scanline']);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const binary = join(stage, windows ? 'scanline.exe' : 'scanline');

cpSync(join(root, 'target', 'release', windows ? 'scanline.exe' : 'scanline'), binary);
chmodSync(binary, 0o755);

if (!windows)
{
    try { run('strip', process.platform === 'darwin' ? ['-x', binary] : [binary]); } catch { /* an unstripped binary still works */ }
}

if (process.env.SCANLINE_SIGN_IDENTITY && process.platform === 'darwin')
{
    run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', process.env.SCANLINE_SIGN_IDENTITY, binary]);
}

// What the binary says it is must be what is being packed.
const said = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();

if (said !== `scanline ${cargo}`)
{
    console.error(`The built binary says "${said}", not "scanline ${cargo}".`);
    process.exit(1);
}

// The skills as the binary holds them, so the folders and the binary cannot differ.
execFileSync(binary, ['skill', '--to', join(stage, 'skills')], { stdio: 'ignore' });

cpSync(join(root, '.claude-plugin'), join(stage, '.claude-plugin'), { recursive: true });
cpSync(join(root, 'README.md'), join(stage, 'README.md'));
cpSync(join(root, 'docs', 'SECURITY.md'), join(stage, 'SECURITY.md'));

if (windows)
{
    // CRLF, as PowerShell scripts on Windows are, whatever this file's own line endings.
    writeFileSync(join(stage, 'install.ps1'), `# Puts scanline.exe on your PATH. Run from the unpacked folder:
#     powershell -ExecutionPolicy Bypass -File install.ps1
# It copies one file, and adds the folder it copies it to (which is yours alone) to your
# own PATH if it is not there. It changes nothing else and needs no administrator. To
# remove Scanline, delete that folder and the directory \`scanline browser\` names.
$ErrorActionPreference = 'Stop'
$to = if ($env:SCANLINE_BIN_DIR) { $env:SCANLINE_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\\Scanline' }
New-Item -ItemType Directory -Force -Path $to | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'scanline.exe') (Join-Path $to 'scanline.exe')
Write-Output "Installed $(& (Join-Path $to 'scanline.exe') --version) to $(Join-Path $to 'scanline.exe')"
$mine = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($mine -split ';') -notcontains $to) {
    [Environment]::SetEnvironmentVariable('Path', (@($mine, $to) | Where-Object { $_ }) -join ';', 'User')
    Write-Output "Added $to to your PATH. Open a new terminal for it to take effect."
}
Write-Output 'Next: scanline browser            which browser it will use'
Write-Output '      scanline launch <url>       open a page'
Write-Output '      scanline skill --to <dir>   write the skills where your agent loads them'
`.replaceAll('\n', '\r\n'));
}
else
{
    writeFileSync(join(stage, 'install.sh'), `#!/bin/sh
# Puts the scanline binary on your PATH. Run from the unpacked folder:  sh install.sh
# It copies one file and changes nothing else. To remove Scanline, delete that file and
# the directory \`scanline browser\` names.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
to="\${SCANLINE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$to"
cp "$here/scanline" "$to/scanline"
chmod 755 "$to/scanline"
echo "Installed $("$to/scanline" --version) to $to/scanline"
case ":$PATH:" in
    *":$to:"*) ;;
    *) echo "$to is not on your PATH. Add this line to your shell profile:"; echo "    export PATH=\\"$to:\\$PATH\\"" ;;
esac
echo "Next: scanline browser            which browser it will use"
echo "      scanline launch <url>       open a page"
echo "      scanline skill --to <dir>   write the skills where your agent loads them"
`);
    chmodSync(join(stage, 'install.sh'), 0o755);
}

// A zip is what a Windows user expects, and what Explorer opens. The tar Windows ships
// with writes one; it is named in full because a tar from elsewhere on the PATH may not.
const suffix = windows ? 'zip' : 'tar.gz';
const archive = join(dist, `${name}.${suffix}`);

rmSync(archive, { force: true });

if (windows)
{
    run(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['-a', '-cf', archive, '-C', dist, name]);
}
else
{
    run('tar', ['-czf', archive, '-C', dist, name]);
}

const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');

writeFileSync(`${archive}.sha256`, `${hash}  ${name}.${suffix}\n`);

if (process.env.SCANLINE_SIGN_IDENTITY && process.env.SCANLINE_NOTARY_PROFILE && process.platform === 'darwin')
{
    // notarytool takes a zip, a disk image or a package, not a tarball.
    const zip = join(dist, `${name}.zip`);

    run('ditto', ['-c', '-k', '--keepParent', stage, zip]);
    run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', process.env.SCANLINE_NOTARY_PROFILE, '--wait']);
}

console.log(`\n${archive}\n  ${(statSync(archive).size / 1e6).toFixed(1)} MB, sha256 ${hash}\n  signed: ${windows ? 'no (signing on Windows is not written)' : (process.env.SCANLINE_SIGN_IDENTITY ? 'yes' : 'no (set SCANLINE_SIGN_IDENTITY)')}`);
