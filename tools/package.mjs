// Builds a release of Scanline and packs it for this machine's platform:
//
//   node tools/package.mjs            dist/scanline-<version>-<platform>.tar.gz
//   node tools/package.mjs --check    only check that the versions agree; build nothing
//
// The archive holds the one binary (the probe, the replay page and the skills are inside
// it), the skills as folders, the Claude Code plugin files, the README and an install script.
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

function run (command, args, options = {})
{
    return execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
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
run('npm', ['run', 'build']);
run('cargo', ['build', '--release', '--locked', '-p', 'scanline']);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const binary = join(stage, process.platform === 'win32' ? 'scanline.exe' : 'scanline');

cpSync(join(root, 'target', 'release', process.platform === 'win32' ? 'scanline.exe' : 'scanline'), binary);
chmodSync(binary, 0o755);

if (process.platform !== 'win32')
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

const archive = join(dist, `${name}.tar.gz`);

rmSync(archive, { force: true });
run('tar', ['-czf', archive, '-C', dist, name]);

const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');

writeFileSync(`${archive}.sha256`, `${hash}  ${name}.tar.gz\n`);

if (process.env.SCANLINE_SIGN_IDENTITY && process.env.SCANLINE_NOTARY_PROFILE && process.platform === 'darwin')
{
    // notarytool takes a zip, a disk image or a package, not a tarball.
    const zip = join(dist, `${name}.zip`);

    run('ditto', ['-c', '-k', '--keepParent', stage, zip]);
    run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', process.env.SCANLINE_NOTARY_PROFILE, '--wait']);
}

console.log(`\n${archive}\n  ${(statSync(archive).size / 1e6).toFixed(1)} MB, sha256 ${hash}\n  signed: ${process.env.SCANLINE_SIGN_IDENTITY ? 'yes' : 'no (set SCANLINE_SIGN_IDENTITY)'}`);
