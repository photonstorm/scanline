// Spike S3: does the frame gate and virtual clock hold on real engines?
// (06-BUILD-PLAN.md, section 3.)
//
// For each page: pause, check it holds; step 1 and step 100, check the engine saw exactly
// that many frames of 1/60 s each; resume, check the engine saw no time jump.

import { open, sleep } from './lib/session.mjs';
import { serve } from './lib/serve.mjs';

setTimeout(() => { console.error('S3 timed out'); process.exit(3); }, 170000).unref();

const headless = !process.argv.includes('--headed');
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const server = await serve();

const pages = [
    ['raw WebGL 1', 'fixtures/matrix/webgl1.html'],
    ['raw WebGL 2', 'fixtures/matrix/webgl2.html'],
    ['raw WebGPU', 'fixtures/matrix/webgpu.html'],
    ['timer loop (no rAF)', 'fixtures/matrix/timers.html'],
    ['worker render loop', 'fixtures/matrix/worker.html'],
    ['three.js WebGL', 'fixtures/engines/three.html'],
    ['three.js WebGPU', 'fixtures/engines/three.html?renderer=webgpu'],
    ['PixiJS WebGL', 'fixtures/engines/pixi.html'],
    ['PixiJS WebGPU', 'fixtures/engines/pixi.html?renderer=webgpu'],
    ['Phaser WebGL', 'fixtures/engines/phaser.html'],
    ['Phaser Canvas', 'fixtures/engines/phaser.html?renderer=canvas'],
    ['Babylon.js WebGL 2', 'fixtures/engines/babylon.html']
].filter(([name]) => !only || name.toLowerCase().includes(only.toLowerCase()));

const rows = [];

for (const [name, path] of pages)
{
    const row = { page: name };
    const session = await open({ url: server.url(path), headless });

    try
    {
        await sleep(900);

        const isWorker = path.includes('worker.html');

        // The worker fixture's state lives in the worker, and so does the probe that gates it.
        const where = isWorker ? session.instances.find((instance) => instance.kind === 'worker') : undefined;
        const read = async () => JSON.parse(await session.evaluate(isWorker ? 'window.readFixture().then(JSON.stringify)' : 'JSON.stringify(window.fixture)'));
        const before = await read();

        if (!before || before.frames === 0)
        {
            throw new Error(`fixture did not start: ${JSON.stringify(before)} ${session.exceptions[0] ?? ''}`);
        }

        // Pause: within one frame, and holds.
        const framesAtRequest = (await read()).frames;
        const paused = await session.probe('pause', {}, where);
        const held = await read();

        await sleep(400);

        const stillHeld = await read();

        row.pause = held.frames - framesAtRequest <= 2 && stillHeld.frames === held.frames && stillHeld.elapsed === held.elapsed
            ? 'ok'
            : `FAIL ran ${held.frames - framesAtRequest} then ${stillHeld.frames - held.frames} more`;

        // Step 1.
        await session.probe('step', { frames: 1 }, where);

        const one = await read();

        row.step1 = one.frames - stillHeld.frames === 1 ? `ok (Δt ${(one.elapsed - stillHeld.elapsed).toFixed(2)} ms)` : `FAIL +${one.frames - stillHeld.frames} frames`;

        // Step 100.
        const started = Date.now();

        await session.probe('step', { frames: 100 }, where);

        const hundred = await read();
        const perFrame = (hundred.elapsed - one.elapsed) / 100;

        row.step100 = hundred.frames - one.frames === 100
            ? `ok (${perFrame.toFixed(3)} ms/frame, ${Date.now() - started} ms real)`
            : `FAIL +${hundred.frames - one.frames} frames`;

        // Resume: the first frames after must not see the real time spent paused.
        await sleep(600);
        await session.probe('resume', {}, where);
        await sleep(500);

        const after = await read();
        const ran = after.frames - hundred.frames;
        const advance = after.elapsed - hundred.elapsed;

        // About half a second ran; a jump would show as the 600 ms pause (or more) on top.
        row.resume = ran > 5 && advance < 800 && after.lastDelta < 100
            ? `ok (${ran} frames, ${advance.toFixed(0)} ms, last Δt ${after.lastDelta.toFixed(1)})`
            : `FAIL ${ran} frames, ${advance.toFixed(0)} ms, last Δt ${after.lastDelta?.toFixed(1)}`;

        const status = await session.probe('status', {}, where);

        row.contexts = status.contexts.map((context) => context.api).join('+') || '-';
        row.notes = [...status.warnings.map((warning) => warning.id), paused.reason !== 'pause' ? paused.reason : ''].filter(Boolean).join(' ');

        if (session.exceptions.length)
        {
            row.notes += ` page errors: ${session.exceptions[0].slice(0, 80)}`;
        }
    }
    catch (error)
    {
        row.error = error.message.slice(0, 160);
    }

    rows.push(row);
    await session.close();
}

console.table(rows);
await server.close();
