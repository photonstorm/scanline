// Milestone 2's exit check: after 1,000 frames, does the mirror of WebGL state still match
// the context, on every WebGL page of the matrix? (06-BUILD-PLAN.md, section 4, M2.)
//
// Stepping is paced by the display, so this takes about 17 seconds a page.

import { open, sleep } from './lib/session.mjs';
import { serve } from './lib/serve.mjs';

const frames = Number(process.argv.find((arg) => arg.startsWith('--frames='))?.slice(9) ?? 1000);
const headless = !process.argv.includes('--headed');
const server = await serve();

setTimeout(() => { console.error('timed out'); process.exit(3); }, 60000 + frames * 9 * 40).unref();

const pages = [
    ['raw WebGL 1', 'fixtures/matrix/webgl1.html'],
    ['raw WebGL 2', 'fixtures/matrix/webgl2.html'],
    ['inventory WebGL 2', 'fixtures/matrix/inventory-webgl2.html'],
    ['WebGL 2 in a worker', 'fixtures/matrix/worker.html'],
    ['three.js', 'fixtures/engines/three.html'],
    ['PixiJS', 'fixtures/engines/pixi.html'],
    ['Phaser', 'fixtures/engines/phaser.html'],
    ['Babylon.js', 'fixtures/engines/babylon.html']
];

const rows = [];

for (const [name, path] of pages)
{
    const session = await open({ url: server.url(path), headless });

    try
    {
        await sleep(800);

        // A page that renders in a worker is checked in the worker, where its context lives.
        const where = path.includes('worker') ? session.instances.find((instance) => instance.kind === 'worker') : undefined;

        await session.probe('step', { frames }, where);

        const checks = (await session.probe('registry.verify', {}, where)).filter((check) => check.checked > 0);
        const summary = await session.probe('registry.summary', {}, where);
        const stats = await session.probe('stats', { frames: 120 }, where);

        rows.push({
            page: name,
            frames: (await session.probe('status', {}, where)).frame,
            contexts: checks.length,
            'values checked': checks.reduce((sum, check) => sum + check.checked, 0),
            drift: checks.reduce((sum, check) => sum + check.drift.length, 0),
            objects: Object.values(summary.byKind).reduce((sum, kind) => sum + kind.alive, 0),
            'draws/frame': stats.counters.draws.last,
            'gpu ms': stats.gpu.frames ? stats.gpu.ms.mean.toFixed(3) : 'n/a',
            faults: session.events.filter((event) => event.t === 'probe-fault').length + session.exceptions.length
        });

        for (const check of checks)
        {
            for (const entry of check.drift.slice(0, 5))
            {
                console.log(`  ${name}: ${entry.what}: mirror ${entry.mirror}, context ${entry.real}`);
            }
        }
    }
    catch (error)
    {
        rows.push({ page: name, error: error.message.slice(0, 120) });
    }

    await session.close();
}

console.table(rows);
await server.close();

process.exit(rows.some((row) => row.error || row.drift > 0 || row.faults > 0) ? 1 : 0);
