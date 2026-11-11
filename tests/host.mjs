// What every test file needs to know about the host it drives.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../spikes/lib/serve.mjs';

export const windows = process.platform === 'win32';

export const binary = join(repoRoot, 'target', 'debug', windows ? 'scanline.exe' : 'scanline');

// Whether a host is running for a home directory. A running host keeps runtime.json there
// until it stops. (On macOS and Linux its socket is beside it; on Windows the channel is a
// named pipe, which is not a file.)
export const hostRunning = (home) => existsSync(join(home, 'runtime.json'));

// On Windows, who an access rule lets in: `aces` is every entry of the rule, as its type
// ("A" allows) and who it names, and `me` is the security identifier of the user running
// the tests. "SY" is the system and "BA" its administrators. `what` is a file's path, or
// with `pipe` the name of a named pipe (which is opened, as a client, to be asked).
export function windowsRule (what, { pipe = false } = {})
{
    const script = pipe
        ? '$name = $env:SCANLINE_TEST_RULE.Split([char]92)[-1]; $client = New-Object System.IO.Pipes.NamedPipeClientStream(".", $name, [System.IO.Pipes.PipeDirection]::InOut); $client.Connect(5000); $sddl = $client.GetAccessControl().GetSecurityDescriptorSddlForm("Access"); $client.Dispose()'
        // Asked of .NET directly: Get-Acl is in a module that Windows PowerShell cannot
        // load when it is started from PowerShell 7, whose module path it inherits.
        : '$sddl = [System.IO.File]::GetAccessControl($env:SCANLINE_TEST_RULE).GetSecurityDescriptorSddlForm("Access")';

    const said = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${script}; Write-Output $sddl; Write-Output ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)`], {
        encoding: 'utf8',
        env: { ...process.env, SCANLINE_TEST_RULE: what }
    }).trim().split(/\r?\n/);

    const aces = [...said[0].matchAll(/\(([^)]*)\)/g)].map(([, ace]) => ({ type: ace.split(';')[0], who: ace.split(';')[5] }));

    return { sddl: said[0], aces, me: said[1] };
}

// Compares a pixel with what is expected of it. A flat colour is written as numbers and
// must match exactly. A channel that falls exactly between two values (a tint of 0.5 is
// 127.5), or that comes out of filtering or blending, is rounded one way through Metal
// and the other through Direct3D: such a channel is written as the values it may take,
// [127, 128], each of which was measured on a machine.
export function assertPixel (actual, expected, message = 'the pixel')
{
    const fits = actual.length === expected.length && expected.every((want, i) => (Array.isArray(want) ? want.includes(actual[i]) : want === actual[i]));

    assert.ok(fits, `${message}: got [${actual.join(', ')}], expected [${expected.map((want) => (Array.isArray(want) ? want.join(' or ') : want)).join(', ')}]`);
}
