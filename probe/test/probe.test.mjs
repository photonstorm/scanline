// End-to-end tests of the probe in a real browser, against the matrix fixtures.
//
//   npm run build:probe && npm run test:probe
//
// Each test launches a headless Chromium with a disposable profile. The whole file takes
// about half a minute. It needs a Chrome, Edge or Chromium (set SCANLINE_BROWSER to choose).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { captureFrame, compare, openReplay } from '../../spikes/lib/replay.mjs';
import { open, sleep } from '../../spikes/lib/session.mjs';
import { serve } from '../../spikes/lib/serve.mjs';

let server;

before(async () =>
{
    server = await serve();
});

after(async () =>
{
    await server.close();
});

// Runs `body` with a session on a fixture, and always closes the browser.
async function withPage (path, options, body)
{
    const session = await open({ url: server.url(path), ...options });

    try
    {
        await body(session);
        assert.deepEqual(session.exceptions, [], 'the page raised no uncaught errors');
        assert.deepEqual(session.events.filter((event) => event.t === 'probe-fault'), [], 'the probe reported no faults of its own');
    }
    finally
    {
        await session.close();
    }
}

const fixture = async (session) => JSON.parse(await session.evaluate('JSON.stringify(window.fixture)'));

// A page's set-up may be asynchronous (WebGPU's always is) and is not held by a paused
// start: only frames and timers are. Wait for the fixture to reach its frame loop.
async function ready (session)
{
    for (let i = 0; i < 100; i++)
    {
        if (await session.evaluate('typeof window.fixture === "object"'))
        {
            return;
        }

        await sleep(30);
    }

    throw new Error('The fixture never started its frame loop');
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];
const BACKGROUND = [32, 64, 96, 255];

describe('the frame gate', () =>
{
    for (const page of ['webgl1', 'webgl2', 'webgpu', 'timers'])
    {
        test(`${page}: pause holds, step runs exactly N frames, resume has no time jump`, async () =>
        {
            await withPage(`fixtures/matrix/${page}.html`, {}, async (session) =>
            {
                await sleep(300);

                const paused = await session.probe('pause');
                const held = await fixture(session);

                assert.equal(paused.reason, 'pause');

                await sleep(250);

                assert.deepEqual(await fixture(session), held, 'nothing moves while paused');

                const stepped = await session.probe('step', { frames: 25 });
                const later = await fixture(session);

                assert.equal(stepped.reason, 'step');
                assert.equal(stepped.remaining, 0);
                assert.equal(later.frames - held.frames, 25, 'the page ran exactly 25 frames');

                // 25 steps of 1/60 s. The first may be short or long by the part-frame the pause fell in.
                const perFrame = (later.elapsed - held.elapsed) / 25;

                assert.ok(Math.abs(perFrame - 1000 / 60) < 0.7, `each step is one sixtieth of a second (got ${perFrame.toFixed(3)} ms)`);

                await sleep(400);
                await session.probe('resume');
                await sleep(300);

                const resumed = await fixture(session);

                assert.ok(resumed.frames > later.frames, 'frames flow again');
                assert.ok(resumed.elapsed - later.elapsed < 600, 'the time spent paused is not seen by the page');
                assert.ok(resumed.lastDelta < 100, `the first frames after resume are ordinary ones (last delta ${resumed.lastDelta})`);
            });
        });
    }

    test('a page resumed soon after a pause stays running', async () =>
    {
        await withPage('fixtures/matrix/webgl1.html', {}, async (session) =>
        {
            await sleep(200);

            // Pause, step and resume inside the 300 ms that pause allows a frame to arrive in.
            await session.probe('pause');
            await session.probe('step', { frames: 2 });
            await session.probe('resume');

            const before = await fixture(session);

            await sleep(700);

            const status = await session.probe('status');

            assert.equal(status.paused, false, 'nothing paused it again');
            assert.ok((await fixture(session)).frames - before.frames > 20, 'frames kept flowing');
        });
    });

    test('a page started paused runs nothing until stepped, and a step with nothing to run says so', async () =>
    {
        await withPage('fixtures/spikes/blank.html', { startPaused: true }, async (session) =>
        {
            const idle = await session.probe('step', { frames: 5 });

            assert.equal(idle.reason, 'idle');
            assert.match(idle.detail, /no frame callbacks and no timers/);
        });

        await withPage('fixtures/matrix/webgl2.html', { startPaused: true }, async (session) =>
        {
            await sleep(300);

            assert.equal((await fixture(session)).frames, 0);

            const status = await session.probe('status');

            assert.equal(status.paused, true);
            assert.equal(status.stop.reason, 'start');

            await session.probe('step', { frames: 3 });

            assert.equal((await fixture(session)).frames, 3);
        });
    });

    test('run until a frame, an expression, and a span of page time', async () =>
    {
        await withPage('fixtures/matrix/webgl1.html', { startPaused: true }, async (session) =>
        {
            const byFrame = await session.probe('runUntil', { frame: 12 });

            assert.equal(byFrame.reason, 'until');
            assert.equal(byFrame.frame, 12);
            assert.equal((await fixture(session)).frames, 12);

            const byExpression = await session.probe('runUntil', { expr: 'window.fixture.frames >= 20' });

            assert.equal(byExpression.reason, 'until');
            assert.equal((await fixture(session)).frames, 20);

            const before = await fixture(session);

            await session.probe('runUntil', { ms: 200 });

            const elapsed = (await fixture(session)).elapsed - before.elapsed;

            assert.ok(elapsed >= 180 && elapsed < 260, `about 200 ms of page time passed (got ${elapsed.toFixed(1)})`);
        });
    });

    test('timers and Date follow the stepped clock', async () =>
    {
        await withPage('fixtures/spikes/blank.html', { startPaused: true }, async (session) =>
        {
            await session.evaluate(`
                window.fired = [];
                window.dateAtStart = Date.now();
                window.perfAtStart = performance.now();
                setTimeout(() => window.fired.push('40'), 40);
                setTimeout(() => window.fired.push('10'), 10);
                setTimeout(() => window.fired.push('90'), 90);
                window.ticks = 0;
                setInterval(() => window.ticks++, 20);
                (function loop () { requestAnimationFrame(loop); })();
            `);

            await sleep(150);

            assert.deepEqual(JSON.parse(await session.evaluate('JSON.stringify(window.fired)')), [], 'no timer fires while paused, however long really passes');

            // Three frames: 50 ms of page time.
            await session.probe('step', { frames: 3 });

            const state = JSON.parse(await session.evaluate('JSON.stringify({ fired: window.fired, ticks: window.ticks, date: Date.now() - window.dateAtStart, perf: performance.now() - window.perfAtStart })'));

            assert.deepEqual(state.fired, ['10', '40'], 'timers fire in due order once page time reaches them');
            assert.equal(state.ticks, 2, 'a 20 ms interval ticked twice in 50 ms');
            assert.ok(Math.abs(state.perf - 50) < 1, `performance.now moved 50 ms (got ${state.perf})`);
            assert.ok(Math.abs(state.date - 50) <= 1, `Date.now moved 50 ms (got ${state.date})`);
        });
    });

    test('a deterministic session replays the same numbers', async () =>
    {
        const run = async () =>
        {
            let values;

            await withPage('fixtures/spikes/blank.html', { startPaused: true, deterministic: { seed: 1234, fixedDt: 1000 / 60 } }, async (session) =>
            {
                await session.evaluate(`
                    window.log = [];
                    (function loop (time) { window.log.push([Math.random(), time]); requestAnimationFrame(loop); })(0);
                `);

                await session.probe('step', { frames: 5 });

                values = JSON.parse(await session.evaluate('JSON.stringify(window.log.slice(1))'));
            });

            return values;
        };

        const first = await run();
        const second = await run();

        assert.equal(first.length, 5);
        assert.deepEqual(first.map((row) => row[0]), second.map((row) => row[0]), 'the random sequence repeats');

        const deltas = first.slice(1).map((row, i) => row[1] - first[i][1]);

        assert.ok(deltas.every((delta) => Math.abs(delta - 1000 / 60) < 1e-6), 'frame timestamps are a fixed step apart');
    });
});

describe('looking', () =>
{
    for (const page of ['webgl1', 'webgl2', 'webgpu', 'timers'])
    {
        test(`${page}: exact pixel values of the frame the page stopped on`, async () =>
        {
            await withPage(`fixtures/matrix/${page}.html`, { startPaused: true }, async (session) =>
            {
                await ready(session);

                // Frame 1 is at elapsed 0. Frame 31 is 30 steps on: the mover has moved 30 pixels.
                await session.probe('step', { frames: 31 });

                const state = await fixture(session);
                const [context] = (await session.probe('status')).contexts.filter((entry) => entry.api.startsWith('web'));
                const at = async (x, y) => (await session.probe('image.pixels', { context: context.id, x, y })).rgba8;

                assert.deepEqual(await at(60, 60), RED);
                assert.deepEqual(await at(160, 60), GREEN);
                assert.deepEqual(await at(260, 60), BLUE);
                assert.deepEqual(await at(5, 5), BACKGROUND);

                // Edges are exact: the quad covers x 40..79, y 40..79.
                assert.deepEqual(await at(40, 40), RED);
                assert.deepEqual(await at(79, 79), RED);
                assert.deepEqual(await at(39, 40), BACKGROUND);
                assert.deepEqual(await at(80, 79), BACKGROUND);

                // The mover's left edge is where the page says it is.
                assert.deepEqual(await at(state.moverX, 210), WHITE);
                assert.deepEqual(await at(state.moverX + 19, 210), WHITE);
                assert.deepEqual(await at(state.moverX + 20, 210), BACKGROUND);

                if (page !== 'timers')
                {
                    assert.equal(state.moverX, 30);
                }
            });
        });
    }

    test('a region comes back as RGBA rows, top to bottom', async () =>
    {
        await withPage('fixtures/matrix/webgpu.html', { startPaused: true }, async (session) =>
        {
            await ready(session);
            await session.probe('step', { frames: 2 });

            const grab = await session.probe('image.grab', { context: 1, x: 38, y: 38, w: 4, h: 4 });
            const bytes = gunzipSync(Buffer.from(grab.data, 'base64'));

            assert.equal(grab.encoding, 'rgba8+gzip+base64');
            assert.deepEqual(grab.region, { x: 38, y: 38, w: 4, h: 4 });
            assert.equal(bytes.length, 4 * 4 * 4);

            const pixel = (x, y) => [...bytes.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];

            assert.deepEqual(pixel(0, 0), BACKGROUND);
            assert.deepEqual(pixel(1, 3), BACKGROUND);
            assert.deepEqual(pixel(2, 2), RED);
            assert.deepEqual(pixel(3, 3), RED);
        });
    });

    test('a running page gives the image of its next frame', async () =>
    {
        await withPage('fixtures/matrix/webgl1.html', {}, async (session) =>
        {
            await sleep(200);

            const pixels = await session.probe('image.pixels', { context: 1, x: 160, y: 60 });

            assert.deepEqual(pixels.rgba8, GREEN);
            assert.equal((await session.probe('status')).paused, false, 'looking does not pause the page');
        });
    });

    test('an unknown context is an error that lists the real ones', async () =>
    {
        await withPage('fixtures/matrix/webgl1.html', { startPaused: true }, async (session) =>
        {
            await assert.rejects(session.probe('image.pixels', { context: 9, x: 0, y: 0 }), /No rendering context 9\. Contexts on this page: ctx 1 \(webgl\)/);
        });
    });
});

describe('observing', () =>
{
    const expected = {
        webgl1: { draws: 5, instances: 5, triangles: 10 },
        webgl2: { draws: 1, instances: 5, triangles: 10 },
        webgpu: { draws: 1, instances: 5, passes: 1, submits: 1 }
    };

    for (const [page, counts] of Object.entries(expected))
    {
        test(`${page}: per-frame counters match the scene`, async () =>
        {
            await withPage(`fixtures/matrix/${page}.html`, { startPaused: true }, async (session) =>
            {
                await ready(session);
                await session.probe('step', { frames: 10 });

                const stats = await session.probe('stats', { frames: 5 });

                for (const [name, value] of Object.entries(counts))
                {
                    assert.equal(stats.counters[name].last, value, `${name} per frame`);
                    assert.equal(stats.counters[name].max, value, `${name} is steady`);
                }
            });
        });
    }

    test('status describes the context, the GPU and what the probe changed', async () =>
    {
        await withPage('fixtures/matrix/webgpu.html', {}, async (session) =>
        {
            await sleep(300);

            const status = await session.probe('status');
            const [context] = status.contexts;

            assert.equal(context.api, 'webgpu');
            assert.equal(context.width, 320);
            assert.equal(context.readable, true);
            assert.ok(context.gpu.vendor, 'the adapter is identified');

            const active = status.modifications.filter((entry) => entry.active).map((entry) => entry.id);

            assert.ok(active.includes('webgpu-canvas-copy-src'), 'the added texture usage is declared');
            assert.equal(await session.evaluate('window.fixtureFormat'), context.format);
        });
    });

    test('unmodified mode adds no texture usage, and says the canvas cannot be read', async () =>
    {
        await withPage('fixtures/matrix/webgpu.html', { unmodified: true, startPaused: true }, async (session) =>
        {
            await ready(session);
            await session.probe('step', { frames: 2 });

            const status = await session.probe('status');

            assert.equal(status.contexts[0].readable, false);
            assert.ok(!status.modifications.some((entry) => entry.id === 'webgpu-canvas-copy-src' && entry.active));
            await assert.rejects(session.probe('image.pixels', { context: 1, x: 0, y: 0 }), /no COPY_SRC usage \(unmodified mode\)/);
        });
    });

    test('at level off the hooks count nothing', async () =>
    {
        await withPage('fixtures/matrix/webgl1.html', { level: 'off', startPaused: true }, async (session) =>
        {
            await session.probe('step', { frames: 5 });

            const stats = await session.probe('stats', { frames: 5 });

            assert.equal(stats.counters.draws.max, 0);
            assert.equal((await fixture(session)).frames, 5, 'the frame gate still works');
        });
    });

    test('uncaught errors are noted with their frame, and can stop a run', async () =>
    {
        const session = await open({ url: server.url('fixtures/spikes/blank.html'), startPaused: true });

        try
        {
            await session.evaluate(`
                window.frames = 0;
                (function loop () { window.frames++; requestAnimationFrame(loop); if (window.frames === 7) { throw new Error('planted'); } })();
            `).catch(() => undefined);

            const stopped = await session.probe('runUntil', { error: true });
            const errors = await session.probe('errors', {});

            assert.equal(stopped.reason, 'until');
            assert.equal(errors.total, 1);
            assert.match(errors.errors[0].message, /planted/);
            assert.equal(errors.errors[0].frame, 6, 'the first call is direct, so the seventh is in frame 6');
            assert.equal(stopped.frame, 6, 'and the run stops on that frame');
            assert.equal(await session.evaluate('window.frames'), 7);
        }
        finally
        {
            await session.close();
        }
    });
});

describe('the state mirror', () =>
{
    const pages = [
        ['raw WebGL 1', 'fixtures/matrix/webgl1.html'],
        ['raw WebGL 2', 'fixtures/matrix/webgl2.html'],
        ['inventory WebGL 2', 'fixtures/matrix/inventory-webgl2.html'],
        ['three.js', 'fixtures/engines/three.html'],
        ['PixiJS', 'fixtures/engines/pixi.html'],
        ['Phaser', 'fixtures/engines/phaser.html'],
        ['Babylon.js', 'fixtures/engines/babylon.html']
    ];

    for (const [name, path] of pages)
    {
        test(`${name}: the mirror of WebGL state matches the context after 150 frames`, async () =>
        {
            await withPage(path, {}, async (session) =>
            {
                await sleep(600);
                await session.probe('step', { frames: 150 });

                const status = await session.probe('status');

                assert.deepEqual(status.hooks.unhandled, [], 'every tracked method has its handler');

                const checks = await session.probe('registry.verify', {});
                const live = checks.filter((check) => check.checked > 0);

                assert.ok(live.length > 0, 'at least one WebGL context was checked');

                for (const check of live)
                {
                    assert.deepEqual(check.drift, [], `context ${check.context}: ${check.checked} values`);
                }

                // Reading a frame back must leave the state as it found it.
                await session.probe('image.pixels', { context: live[live.length - 1].context, x: 1, y: 1 });

                for (const check of await session.probe('registry.verify', {}))
                {
                    assert.deepEqual(check.drift, [], 'after a canvas readback');
                }
            });
        });
    }
});

describe('capture and replay', () =>
{
    const pages = [
        ['raw WebGL 1', 'fixtures/matrix/webgl1.html'],
        ['raw WebGL 2', 'fixtures/matrix/webgl2.html'],
        ['WebGL 1 on a timer', 'fixtures/matrix/timers.html'],
        ['inventory WebGL 2', 'fixtures/matrix/inventory-webgl2.html'],
        ['three.js', 'fixtures/engines/three.html'],
        ['PixiJS', 'fixtures/engines/pixi.html'],
        ['Phaser', 'fixtures/engines/phaser.html'],
        ['Babylon.js', 'fixtures/engines/babylon.html']
    ];

    for (const [name, path] of pages)
    {
        test(`${name}: a captured frame replays to the identical image`, async () =>
        {
            await withPage(path, {}, async (session) =>
            {
                await sleep(700);

                const capture = await captureFrame(session);
                const replay = await openReplay(session);

                await replay.load('cap', capture);

                const final = await replay.image('cap');

                assert.ok(capture.data.draws.some((event) => event.kind === 'draw'), 'the frame drew something');
                assert.deepEqual(compare(capture.original, final), { different: 0, max: 0 }, 'the replayed frame matches the page\'s own, pixel for pixel');
                assert.equal(final.error, 0, 'the replay raised no GL error');
                assert.deepEqual(final.notes, []);

                // Capturing must leave the page's own state as it found it.
                for (const check of await session.probe('registry.verify', {}))
                {
                    assert.deepEqual(check.drift, [], 'state mirror after a capture');
                }

                assert.equal(await session.evaluate(`[...document.querySelectorAll('canvas')].map((c) => c.getContext('webgl2') ?? c.getContext('webgl')).filter(Boolean).map((gl) => gl.getError()).join()`).then((errors) => /[1-9]/.test(errors)), false, 'and no GL error in the page');

                await replay.close();
            });
        });
    }

    test('the picture after one event, and the story of a pixel', async () =>
    {
        await withPage('fixtures/matrix/inventory-webgl2.html', {}, async (session) =>
        {
            await sleep(500);

            const capture = await captureFrame(session);
            const replay = await openReplay(session);

            await replay.load('cap', capture);

            // The frame: two clears of the render target, a clear of the canvas, one draw.
            assert.deepEqual(capture.data.draws.map((event) => event.kind), ['clear', 'clear', 'clear', 'draw']);

            const draw = capture.data.draws[3];

            assert.equal(draw.method, 'drawElements');
            assert.equal(draw.count, 6);
            assert.deepEqual(draw.uniforms.tint, [0.25, 0.5, 0.75, 1]);
            assert.equal(draw.blend.srcRgb, 0x0302);
            assert.equal(draw.depth, null);

            // After the first clear the render target is all magenta; after the second its lower half is cyan.
            const pixel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
            const first = await replay.image('cap', { draw: 0 });
            const second = await replay.image('cap', { draw: 1 });

            assert.equal(first.width, 32);
            assert.deepEqual(pixel(first, 0, 15), [255, 0, 255, 255]);
            assert.deepEqual(pixel(second, 0, 15), [0, 255, 255, 255]);
            assert.deepEqual(pixel(second, 0, 0), [255, 0, 255, 255]);

            // The canvas after its clear, before the draw.
            const cleared = await replay.image('cap', { draw: 2 });

            assert.deepEqual(pixel(cleared, 160, 120), [32, 64, 96, 255]);

            // A pixel inside the quad was written by the clear and then by the draw.
            const inside = await replay.call('trace', { key: 'cap', x: 160, y: 120 });

            assert.deepEqual(inside.changes.map((change) => change.draw), [2, 3]);
            assert.deepEqual(inside.changes[1].before, [32, 64, 96, 255]);
            assert.deepEqual(inside.final, inside.changes[1].after);

            // A pixel outside it, by the clear alone.
            const outside = await replay.call('trace', { key: 'cap', x: 5, y: 5 });

            assert.deepEqual(outside.changes.map((change) => change.draw), [2]);

            // A pixel of the render target.
            const target = await replay.call('trace', { key: 'cap', x: 3, y: 12, target: { texture: draw.target || capture.data.draws[0].target } });

            assert.deepEqual(target.changes.map((change) => [change.draw, change.after]), [[0, [255, 0, 255, 255]], [1, [0, 255, 255, 255]]]);

            await replay.close();
        });
    });

    test('a WebGL 1 buffer is readable from the copy kept of its uploads', async () =>
    {
        await withPage('fixtures/matrix/webgl1.html', {}, async (session) =>
        {
            await sleep(300);

            const read = await session.probe('registry.readBuffer', { id: 1 });

            assert.deepEqual([...new Float32Array(new Uint8Array(Buffer.from(read.data, 'base64')).buffer)], [0, 0, 1, 0, 0, 1, 1, 1]);
        });
    });
});

describe('GPU time', () =>
{
    test('webgl2: a timer query around each frame gives GPU time, and leaves no GL error', async () =>
    {
        await withPage('fixtures/matrix/webgl2.html', {}, async (session) =>
        {
            await sleep(900);

            const stats = await session.probe('stats', { frames: 60 });

            assert.ok(stats.gpu.frames > 10, `most frames were measured (${stats.gpu.frames})`);
            assert.ok(stats.gpu.ms.mean > 0 && stats.gpu.ms.mean < 50, `a plausible time (${stats.gpu.ms.mean} ms)`);
            assert.deepEqual(stats.gpu.passes, []);
            assert.equal(await session.evaluate('document.getElementById("scene").getContext("webgl2").getError()'), 0);

            const active = (await session.probe('status')).modifications.filter((entry) => entry.active).map((entry) => entry.id);

            assert.ok(active.includes('webgl-timer-query'), 'the query is declared as a change the page could notice');
        });
    });

    test('webgpu: every pass is timed, by its label', async () =>
    {
        await withPage('fixtures/matrix/inventory-webgpu.html', {}, async (session) =>
        {
            await sleep(1200);

            const stats = await session.probe('stats', { frames: 120 });

            assert.ok(stats.gpu.frames > 3, `some frames were measured (${stats.gpu.frames})`);
            assert.equal(stats.gpu.passes.length, 2, 'the offscreen pass and the canvas pass');
            assert.ok(stats.gpu.passes.every((pass) => pass.mean > 0 && pass.mean < 50));
            assert.equal(stats.counters.passes.last, 2);
        });
    });

    test('unmodified mode measures nothing and changes nothing', async () =>
    {
        await withPage('fixtures/matrix/webgpu.html', { unmodified: true }, async (session) =>
        {
            await sleep(700);

            const stats = await session.probe('stats', { frames: 60 });
            const status = await session.probe('status');

            assert.equal(stats.gpu.frames, 0);
            assert.deepEqual(status.modifications.filter((entry) => entry.active && entry.optional), []);
            assert.equal(await session.evaluate('navigator.gpu.requestAdapter().then((a) => a.requestDevice()).then((d) => d.features.has("timestamp-query"))'), false);
        });
    });

    test('a page that uses timer queries itself keeps them, and Scanline steps aside', async () =>
    {
        await withPage('fixtures/matrix/webgl2.html', {}, async (session) =>
        {
            await sleep(500);

            // The page times a clear of its own, mid-frame, as an engine's profiler would.
            const result = JSON.parse(await session.evaluate(`new Promise((resolve) =>
            {
                const gl = document.getElementById('scene').getContext('webgl2');
                const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
                const query = gl.createQuery();

                requestAnimationFrame(() =>
                {
                    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                    gl.endQuery(ext.TIME_ELAPSED_EXT);

                    const error = gl.getError();
                    const poll = () => gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)
                        ? resolve(JSON.stringify({ error, ns: gl.getQueryParameter(query, gl.QUERY_RESULT) }))
                        : requestAnimationFrame(poll);

                    poll();
                });
            })`));

            assert.equal(result.error, 0, 'the page\'s query raised no GL error');
            assert.ok(result.ns >= 0);

            await sleep(300);

            const stats = await session.probe('stats', { frames: 10 });

            assert.match(stats.gpu.notes.join(' '), /the page uses timer queries itself/);
            assert.equal(await session.evaluate('document.getElementById("scene").getContext("webgl2").getError()'), 0);
        });
    });
});

describe('the page cannot tell', () =>
{
    test('wrapped functions look native and nothing is added to the global', async () =>
    {
        await withPage('fixtures/matrix/webgl2.html', {}, async (session) =>
        {
            const seen = JSON.parse(await session.evaluate(`JSON.stringify({
                sources: [performance.now, requestAnimationFrame, setTimeout, Date, Date.now, HTMLCanvasElement.prototype.getContext,
                    WebGL2RenderingContext.prototype.drawArrays, GPUDevice.prototype.createTexture, Function.prototype.toString]
                    .map((fn) => Function.prototype.toString.call(fn)),
                names: [requestAnimationFrame.name, WebGL2RenderingContext.prototype.drawArrays.name, Date.name],
                lengths: [requestAnimationFrame.length, WebGL2RenderingContext.prototype.drawArrays.length, WebGL2RenderingContext.prototype.texImage2D.length, Date.length],
                date: [new Date(0).getTime(), new Date() instanceof Date, Date.prototype.constructor === Date, typeof Date(), Date.UTC(2020, 0, 1), Date.parse('2020-01-01T00:00:00Z')],
                globals: Object.getOwnPropertyNames(window).filter((name) => /scanline/i.test(name)),
                context: document.getElementById('scene').getContext('webgl2') instanceof WebGL2RenderingContext
            })`));

            for (const source of seen.sources)
            {
                assert.match(source, /^function \w* ?\(\) \{ \[native code\] \}$/);
            }

            assert.deepEqual(seen.names, ['requestAnimationFrame', 'drawArrays', 'Date']);
            assert.deepEqual(seen.lengths, [1, 3, 6, 7]);
            assert.deepEqual(seen.date, [0, true, true, 'string', 1577836800000, 1577836800000]);
            // The one global the probe adds is the page protocol's.
            assert.deepEqual(seen.globals, ['__scanline']);
            assert.equal(seen.context, true);
        });

        await withPage('fixtures/matrix/webgl2.html', { unmodified: true }, async (session) =>
        {
            assert.equal(await session.evaluate(`Object.getOwnPropertyNames(window).filter((name) => /scanline|THREE_DEVTOOLS|PIXI/i.test(name)).join()`), '', 'unmodified mode adds none');
        });
    });

    test('before the clock is first used, the page reads real time', async () =>
    {
        await withPage('fixtures/matrix/webgl1.html', {}, async (session) =>
        {
            await sleep(200);

            const status = await session.probe('status');

            assert.equal(status.clockEngaged, false);
            assert.ok(status.frame > 0);
        });
    });
});

describe('the page protocol', () =>
{
    test('a page names its draws, offers its state, and takes settings', async () =>
    {
        await withPage('fixtures/protocol/webgl2.html', { startPaused: true }, async (session) =>
        {
            await session.probe('step', { frames: 3 });

            const said = await session.probe('protocol.describe', {});

            assert.equal(said.version, 1);
            assert.equal(said.present, true);

            // The frame as the page grouped it: five trees of two draws each, inside "trees".
            const rows = said.groups.rows.map((row) => [row.depth, row.name, row.draws]);

            assert.deepEqual(rows.slice(0, 4), [[0, 'sky', 0], [0, 'ground', 1], [0, 'trees', 10], [1, 'tree-1', 2]]);
            assert.equal(rows.length, 8);
            assert.equal(said.groups.loose, 0, 'no draw is outside a group');
            assert.deepEqual(said.groups.rows[3].entity, { type: 'Tree', name: 'tree-1', id: 1, path: 'orchard/tree-1', height: said.groups.rows[3].entity.height });

            // State, as text.
            const state = JSON.parse(said.state.text);

            assert.equal(state.scene, 'orchard');
            assert.equal(state.trees, 5);
            assert.equal(said.stateSchema.sunHeight, '0 (dusk) to 1 (noon)');

            // Controls carry their current values; a set is checked against what the control takes.
            assert.deepEqual(said.controls.map((control) => [control.id, control.type, control.value]), [['sun.height', 'number', 0.8], ['wind', 'boolean', true], ['season', 'enum', 'summer']]);

            const set = await session.probe('protocol.set', { id: 'season', value: 'autumn' });

            assert.equal(set.before, 'summer');
            assert.equal(set.control.value, 'autumn');
            assert.match((await session.probe('protocol.set', { id: 'season', value: 'winter' })).refused, /one of/);
            assert.match((await session.probe('protocol.set', { id: 'sun.height', value: 3 })).refused, /maximum is 1/);
            assert.equal((await session.probe('protocol.set', { id: 'nope', value: 1 })).unknown, true);

            // A registered view is the page's own drawing, switched on.
            assert.deepEqual(said.views, [{ id: 'bounds', label: 'Tree bounds', description: 'A red box round each tree, trunk and crown together.', on: false }]);
            await session.probe('protocol.view', { id: 'bounds', on: true });
            await session.probe('step', { frames: 1 });

            const withView = await session.probe('protocol.describe', {});

            assert.deepEqual(withView.groups.rows.filter((row) => row.name === 'debug').map((row) => row.draws), [20]);
            assert.equal(withView.views[0].on, true);

            // Marks are events, and the page can be run until one.
            assert.deepEqual(said.marks.map((mark) => mark.name), ['assets loaded', 'first frame']);
            assert.ok(session.events.some((event) => event.t === 'mark' && event.name === 'first frame'));

            const stopped = await session.probe('runUntil', { event: 'second passed' });

            assert.equal(stopped.frame, 62, 'one second of page time at sixty frames a second, from the second frame');

            // The engine's own time control and checkpoints, called when asked.
            assert.deepEqual(said.time, ['pause', 'resume', 'step', 'setScale']);
            assert.deepEqual(said.checkpoint, { save: true, restore: true });

            const saved = await session.probe('protocol.save', {});

            await session.probe('protocol.set', { id: 'season', value: 'spring' });
            await session.probe('protocol.restore', { state: saved.state });
            assert.equal(JSON.parse((await session.probe('protocol.state', {})).text).season, 'autumn');

            // Names given through the protocol reach the inventory, and what was exposed is kept.
            const programs = await session.probe('registry.list', { kind: 'program' });

            assert.deepEqual(programs.rows.map((row) => row.label), ['flat']);
            assert.deepEqual(said.exposed.map((entry) => entry.names), [{ light: { min: 0, max: 2 } }]);
        });
    });

    test('a capture carries the groups and the game objects', async () =>
    {
        await withPage('fixtures/protocol/webgl2.html', { startPaused: true }, async (session) =>
        {
            await session.probe('step', { frames: 2 });

            const capture = await captureFrame(session);
            const groups = capture.data.header.groups;

            assert.equal(groups.filter((entry) => entry[1] === 'push').length, 8);
            assert.equal(groups.filter((entry) => entry[1] === 'pop').length, 8);
            assert.equal(groups.filter((entry) => entry[1] === 'entity').length, 6);
            assert.deepEqual(groups[0].slice(1), ['push', 'sky']);

            // Each entry says how many commands had been recorded: the trees group holds the ten tree draws.
            const draws = capture.data.draws.filter((row) => row.kind === 'draw').map((row) => row.command);
            const trees = groups.findIndex((entry) => entry[2] === 'trees');
            const closes = groups.findLast((entry) => entry[1] === 'pop');

            assert.equal(draws.filter((command) => command >= groups[trees][0] && command < closes[0]).length, 10);
        });
    });

    test('calls a later protocol might add are ignored, and nothing the page passes can throw', async () =>
    {
        await withPage('fixtures/matrix/webgl2.html', {}, async (session) =>
        {
            const result = await session.evaluate(`(() =>
            {
                const dbg = __scanline;

                dbg.somethingNew(1, 2);
                dbg.future.deeper.call({ a: 1 }).more;
                dbg.views.somethingElse();
                dbg.label(null, 'x');
                dbg.label({}, { toString () { throw new Error('no'); } });
                dbg.entity(null, { get bad () { throw new Error('no'); }, fine: 1 });
                dbg.pop();
                dbg.controls.register({ id: 'broken' });
                dbg.state.provide(() => { throw new Error('page fault'); });

                return [dbg.version, dbg.group('g', () => 7), dbg.time.deterministic()];
            })()`);

            assert.deepEqual(result, [1, 7, null]);
            assert.match((await session.probe('protocol.state', {})).error, /page fault/);
        });
    });

    test('a deterministic session tells the page its seed and step', async () =>
    {
        await withPage('fixtures/protocol/webgl2.html', { deterministic: { seed: 99, fixedDt: 16 } }, async (session) =>
        {
            assert.deepEqual(await session.evaluate(`(() => { let got = null; const back = __scanline.time.deterministic((facts) => { got = facts; }); return [got, back]; })()`), [{ seed: 99, fixedDt: 16 }, { seed: 99, fixedDt: 16 }]);
        });
    });
});
