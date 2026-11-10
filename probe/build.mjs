// Builds the probe to one self-contained script: probe/dist/probe.js.
//
// The result is a function body that expects a variable named __SCANLINE_CONFIG__ in scope.
// The host wraps it with wrapProbe() (or its Rust equivalent) to supply that per launch.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

execFileSync(process.execPath, [join(here, 'tools', 'gen-hooks.mjs'), '--check'], { stdio: 'inherit' });

mkdirSync(join(here, 'dist'), { recursive: true });

const result = await build({
    entryPoints: [join(here, 'src', 'index.ts')],
    outfile: join(here, 'dist', 'probe.js'),
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    minify: process.argv.includes('--minify'),
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning'
});

const bytes = Object.values(result.metafile.outputs)[0].bytes;

console.log(`probe/dist/probe.js ${(bytes / 1024).toFixed(1)} KB`);
