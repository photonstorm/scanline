// Builds the replay page's script: replay/dist/replay.js. The host embeds it and evaluates
// it in a hidden page of the browser under test.

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

mkdirSync(join(here, 'dist'), { recursive: true });

const result = await build({
    entryPoints: [join(here, 'src', 'index.ts')],
    outfile: join(here, 'dist', 'replay.js'),
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    minify: process.argv.includes('--minify'),
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning'
});

console.log(`replay/dist/replay.js ${(Object.values(result.metafile.outputs)[0].bytes / 1024).toFixed(1)} KB`);
