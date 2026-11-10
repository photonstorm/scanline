// Spike S5: can replay give GPU-true answers at acceptable cost?
// (06-BUILD-PLAN.md, section 3.)
//
// Captures one frame of each WebGL page, replays it in a hidden page of the same browser,
// and compares the replay's final image with the frame's own, pixel for pixel. Then asks
// the two questions replay exists for: the picture after one draw, and which draws changed
// a pixel.

import { open, sleep } from './lib/session.mjs';
import { serve } from './lib/serve.mjs';
import { captureFrame, compare, openReplay } from './lib/replay.mjs';

setTimeout(() => { console.error('S5 timed out'); process.exit(3); }, 240000).unref();

const headless = !process.argv.includes('--headed');
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const server = await serve();

const pages = [
    ['raw WebGL 1', 'fixtures/matrix/webgl1.html'],
    ['raw WebGL 2', 'fixtures/matrix/webgl2.html'],
    ['WebGL 1 on a timer', 'fixtures/matrix/timers.html'],
    ['inventory WebGL 2', 'fixtures/matrix/inventory-webgl2.html'],
    ['three.js', 'fixtures/engines/three.html'],
    ['PixiJS', 'fixtures/engines/pixi.html'],
    ['Phaser', 'fixtures/engines/phaser.html'],
    ['Babylon.js', 'fixtures/engines/babylon.html'],
    ['2,000 draws', 'fixtures/spikes/s9.html?api=webgl2&draws=2000'],
    ['10,000 draws', 'fixtures/spikes/s9.html?api=webgl2&draws=10000']
].filter(([name]) => !only || name.toLowerCase().includes(only.toLowerCase()));

const rows = [];

for (const [name, path] of pages)
{
    const row = { page: name };
    const session = await open({ url: server.url(path), headless });

    try
    {
        await sleep(900);

        let started = Date.now();

        const capture = await captureFrame(session);

        row['capture ms'] = Date.now() - started;
        row.commands = capture.commands;
        row.draws = capture.data.draws.filter((draw) => draw.kind === 'draw').length;
        row.objects = capture.data.objects.length;
        row['blob KB'] = Math.round(capture.blobBytes / 1024);

        const replay = await openReplay(session);

        started = Date.now();
        await replay.load('cap', capture);
        row['load ms'] = Date.now() - started;

        const final = await replay.image('cap');
        const difference = compare(capture.original, final);

        row['replay ms'] = Math.round(final.ms);
        row['final image'] = difference.different === 0 ? 'identical' : (difference.sizes ?? `${difference.different} px differ, max ${difference.max}`);

        // Half way through: the picture after the middle event, and a pixel's story.
        const middle = Math.floor(capture.data.draws.length / 2);
        const part = await replay.image('cap', { draw: middle });
        const trace = await replay.call('trace', { key: 'cap', x: Math.floor(capture.original.width / 2), y: Math.floor(capture.original.height / 2) });

        row['after a draw'] = `${part.width}x${part.height}`;
        row['pixel trace'] = `${trace.changes.length} of ${trace.events} events, ${Math.round(trace.ms)} ms`;

        const notes = [...capture.data.header.notes, ...final.notes];

        if (final.error)
        {
            notes.push(`GL error 0x${final.error.toString(16)}`);
        }

        row.notes = notes.join('; ').slice(0, 110);

        const faults = session.events.filter((event) => event.t === 'probe-fault');

        if (faults.length || session.exceptions.length)
        {
            row.notes += ` FAULT ${(faults[0]?.message ?? session.exceptions[0]).slice(0, 160)}`;
        }

        await replay.close();
    }
    catch (error)
    {
        row.error = error.message.slice(0, 200);
    }

    rows.push(row);
    await session.close();
}

console.table(rows);
await server.close();
