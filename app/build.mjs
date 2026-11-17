// The app's build and packing for this machine (app/README.md):
//
//   node app/build.mjs            npm run app:          app/bundle.sh on a Mac, app\bundle.ps1 on Windows
//   node app/build.mjs package    npm run package:app:  app/package.sh on a Mac, app\package.ps1 on Windows

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] === 'package' ? 'package' : 'bundle';
const [command, args] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, `${name}.ps1`)]]
    : ['sh', [join(here, `${name}.sh`)]];

const { status, error } = spawnSync(command, args, { stdio: 'inherit' });

if (error)
{
    console.error(`${command} could not be started: ${error.message}`);
}

process.exit(status ?? 1);
