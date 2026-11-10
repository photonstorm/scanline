// End-to-end tests of the probe in a real browser, against the matrix fixtures.
//
//   npm run build:probe && npm run test:probe
//
// Each test launches a headless Chromium with a disposable profile. The whole file takes
// about half a minute. It needs a Chrome, Edge or Chromium (set SCANLINE_BROWSER to choose).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
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
            assert.deepEqual(seen.globals, []);
            assert.equal(seen.context, true);
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
