// End-to-end tests of the built binary: the command line and the MCP server, against the
// matrix fixtures, in a real headless browser.
//
//   npm run build:probe && cargo build && npm run test:e2e
//
// The host under test keeps its files in a temporary SCANLINE_HOME, so it never touches a
// host the user is running.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { repoRoot, serve } from '../spikes/lib/serve.mjs';

const binary = join(repoRoot, 'target', 'debug', 'scanline');
const home = mkdtempSync(join(tmpdir(), 'scanline-e2e-'));
const env = { ...process.env, SCANLINE_HOME: home };

let server;

// Runs one command. Resolves with { code, out, json } whatever the exit status.
function scanline (...args)
{
    return new Promise((resolve) =>
    {
        execFile(binary, args, { env, timeout: 60000 }, (error, stdout, stderr) =>
        {
            const out = (stdout + stderr).trim();

            let json = null;

            if (args.includes('--json'))
            {
                try { json = JSON.parse(stdout); } catch { /* an error message, not JSON */ }
            }

            resolve({ code: error ? error.code ?? 1 : 0, out, json });
        });
    });
}

before(async () =>
{
    assert.ok(existsSync(binary), `${binary} is missing. Run cargo build first.`);
    server = await serve();
});

after(async () =>
{
    await scanline('stop');
    await server.close();
    rmSync(home, { recursive: true, force: true });
});

// A test that fails part-way must not leave its session open for the next one to trip over.
afterEach(async () =>
{
    if (!existsSync(join(home, 'control.sock')))
    {
        return;
    }

    const open = (await scanline('sessions', '--json')).json?.data.sessions ?? [];

    for (const { session } of open)
    {
        await scanline('close', '--session', session);
    }
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('the command line', () =>
{
    test('help and usage need no host', async () =>
    {
        const usage = await scanline('--help');

        assert.equal(usage.code, 0);
        assert.match(usage.out, /launch <url>/);

        const help = await scanline('help', 'input');

        assert.match(help.out, /"key": "ArrowRight"/);
        assert.equal(existsSync(join(home, 'control.sock')), false, 'no host was started');
    });

    test('a session: launch paused, step, look, measure, run until, close', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/matrix/webgl2.html'), '--paused', '--headless', '--json');

        assert.equal(launched.code, 0, launched.out);
        assert.equal(launched.json.data.session, 'ses_1');
        assert.equal(launched.json.data.paused, true);
        assert.equal(launched.json.data.frame, 0);
        assert.equal(launched.json.data.errors_logged, 0);
        assert.match(launched.json.summary, /ctx_1 webgl2 320×240 on ANGLE/);

        // 31 frames: the mover is 30 pixels along.
        const stepped = await scanline('step', '31', '--screenshot', '--json');

        assert.equal(stepped.json.data.frame, 31);
        assert.match(stepped.json.summary, /^Frame 31 \(stepped 31\)\. Paused\.\nNo errors\./);

        const [image] = stepped.json.images;

        assert.equal(image.width, 320);
        assert.equal(image.space, 'canvas_px');
        assert.deepEqual(readFileSync(image.view).subarray(0, 4), PNG);

        const red = await scanline('pixels', '60', '60', '--json');

        assert.deepEqual(red.json.data.rgba8, [255, 0, 0, 255]);
        assert.equal(red.json.data.provenance, 'gpu-measured');

        const edge = await scanline('pixels', '28', '208', '--w', '4', '--h', '1');

        assert.match(edge.out, /y 208: \(32, 64, 96, 255\)×2 \(255, 255, 255, 255\)×2/);

        const zoomed = await scanline('screenshot', '--region', '26,198,12,8', '--zoom', '16', '--json');

        assert.equal(zoomed.json.images[0].width, 192);
        assert.equal(zoomed.json.images[0].height, 128);
        assert.equal(zoomed.json.data.scale, 16);
        assert.notEqual(zoomed.json.images[0].view, zoomed.json.images[0].original);

        const stats = await scanline('stats', '--window-frames', '10', '--json');

        assert.equal(stats.json.data.counters.draws.last, 1);
        assert.equal(stats.json.data.counters.instances.last, 5);

        // Held keys persist across steps, and are seen by the page.
        await scanline('eval', 'window.keys = []; addEventListener("keydown", (e) => window.keys.push("down " + e.code + " " + e.isTrusted)); addEventListener("keyup", (e) => window.keys.push("up " + e.code)); 0');

        const held = await scanline('step', '5', '--hold', 'ArrowRight');

        assert.match(held.out, /Holding: ArrowRight\./);

        const released = await scanline('step', '1', '--hold', '');

        assert.doesNotMatch(released.out, /Holding/);

        const keys = await scanline('eval', 'JSON.stringify(window.keys)', '--json');

        assert.deepEqual(JSON.parse(keys.json.data.value), ['down ArrowRight true', 'up ArrowRight']);

        // A click in canvas pixels lands on that pixel of the canvas.
        await scanline('eval', 'window.clicks = []; document.getElementById("scene").addEventListener("mousedown", (e) => window.clicks.push([e.offsetX, e.offsetY, e.isTrusted])); 0');
        await scanline('input', '--events', '[{"pointer":"down","x":160,"y":60},{"pointer":"up","x":160,"y":60}]');

        const clicks = await scanline('eval', 'JSON.stringify(window.clicks)', '--json');

        assert.deepEqual(JSON.parse(clicks.json.data.value), [[160, 60, true]]);

        const met = await scanline('run_until', '--until', '{"expr":"window.fixture.frames >= 80"}', '--json');

        assert.equal(met.code, 0);
        assert.equal(met.json.data.met, true);
        assert.equal(met.json.data.frame, 80);

        const unmet = await scanline('run_until', '--until', '{"expr":"window.neverTrue"}', '--timeout-s', '0.5');

        assert.equal(unmet.code, 2, 'ran, but found nothing');
        assert.match(unmet.out, /Not met after 0\.5 s/);

        const closed = await scanline('close');

        assert.match(closed.out, /ses_1 closed/);
        assert.ok(existsSync(image.original), 'images outlive the session');
    });

    test('errors say what to do next', async () =>
    {
        const none = await scanline('pause');

        assert.equal(none.code, 1);
        assert.match(none.out, /No session named\. No sessions are open\. Call launch with a url to start one\./);

        const launched = await scanline('launch', server.url('fixtures/matrix/webgl1.html'), '--headless', '--json');
        const session = launched.json.data.session;

        const outside = await scanline('pixels', '999', '999');

        assert.equal(outside.code, 1);
        assert.match(outside.out, /outside ctx_\d+, which is 320×240 canvas pixels \(x 0–319, y 0–239\)/);

        const wrong = await scanline('pixels', '1', '1', '--session', 'ses_99');

        assert.match(wrong.out, new RegExp(`No session "ses_99"\\. Open sessions: ${session} `));

        const key = await scanline('input', '--events', '[{"key":"Bogus","press":true}]');

        assert.match(key.out, /Unknown key "Bogus"\. Use DOM names/);

        const stale = await scanline('status', '--json');
        const handle = stale.json.data.contexts[0].handle;

        await scanline('navigate', '--reload');

        const after = await scanline('pixels', '1', '1', '--context', handle);

        assert.match(after.out, new RegExp(`${handle} belongs to an earlier page load of ${session}\\. Call status`));

        await scanline('close');
    });

    test('a page error is reported with its frame', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/matrix/webgl1.html'), '--paused', '--headless', '--json');

        assert.equal(launched.code, 0, launched.out);

        await scanline('step', '3');
        await scanline('eval', 'requestAnimationFrame(() => { throw new Error("planted in a frame"); }); 0');

        const stepped = await scanline('step', '1');

        assert.match(stepped.out, /1 error raised/);
        assert.match(stepped.out, /«Error: planted in a frame/);

        const log = await scanline('console', '--level', 'error', '--json');

        assert.equal(log.json.data.lines.length, 1);
        assert.equal(log.json.data.lines[0].frame, 4);

        await scanline('close');
    });

    test('the host survives the GPU process and the browser being killed, and says what happened', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/matrix/webgl1.html'), '--headless', '--json');
        const { session, gpu_process_pid: gpu, browser_pid: browser } = launched.json.data;
        const host = JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf8')).pid;

        assert.ok(gpu > 0 && browser > 0 && host > 0, launched.out);

        // Kill the GPU process, as an unstable driver would. The browser starts another and
        // the page loses its context.
        process.kill(gpu, 'SIGKILL');

        const lost = await scanline('wait', '--kinds', '["context-lost"]', '--timeout-s', '10', '--cursor', '0', '--json');

        assert.equal(lost.code, 0, lost.out);
        assert.equal(lost.json.data.events[0].kind, 'context-lost');

        const status = await scanline('status', '--json');

        assert.equal(status.code, 0, 'the session is still usable');
        assert.match(status.out, /CONTEXT LOST|"lost": (true|false)/);
        assert.notEqual(status.json.data.gpu_process_pid, gpu, 'the browser started a new GPU process');

        // Now the whole browser.
        process.kill(browser, 'SIGKILL');

        const crashed = await scanline('wait', '--kinds', '["crashed"]', '--timeout-s', '10', '--cursor', '0', '--json');

        assert.equal(crashed.json.data.events[0].data.what, 'browser');

        const dead = await scanline('pause');

        assert.equal(dead.code, 1);
        assert.match(dead.out, new RegExp(`${session} is no longer usable: the browser exited\\. Call close, then launch again\\.`));

        process.kill(host, 0);

        assert.equal((await scanline('sessions')).code, 0, 'the host still answers');
        assert.match((await scanline('close')).out, new RegExp(`${session} closed`));
    });
});

describe('the live inventory', () =>
{
    const MAGENTA = [255, 0, 255, 255];
    const CYAN = [0, 255, 255, 255];

    // The row of a listing whose description contains `text`.
    const find = (listing, text) =>
    {
        const row = listing.json.data.rows.find((entry) => entry.what.includes(text));

        assert.ok(row, `a row describing "${text}" in: ${listing.json.data.rows.map((entry) => entry.what).join(' | ')}`);

        return row;
    };

    for (const api of ['webgl2', 'webgpu'])
    {
        test(`${api}: objects, their contents, and a leak`, async () =>
        {
            const launched = await scanline('launch', server.url(`fixtures/matrix/inventory-${api}.html`), '--headless', '--json');

            assert.equal(launched.code, 0, launched.out);

            await scanline('step', '5');

            // Textures: sizes are computed from dimensions, format and mip chain.
            const textures = await scanline('resources', 'texture', '--json');

            assert.equal(textures.json.data.total, 4);
            assert.equal(find(textures, '64×64').bytes, 21844, '64×64 RGBA8 with seven mip levels');
            assert.equal(find(textures, '4×4').bytes, 64);
            assert.equal(find(textures, '2×2').bytes, 64, '2×2 of sixteen bytes a texel');
            assert.match(find(textures, '64×64').site, new RegExp(`inventory-${api}\\.html:\\d+:\\d+`), 'created at a line of the page');
            assert.equal(textures.json.data.rows[0].what.startsWith('64×64'), true, 'largest first');

            if (api === 'webgpu')
            {
                assert.equal(find(textures, '4×4').label, 'checker');
            }

            // Contents, exactly.
            const checker = find(textures, '4×4').handle;
            const floaty = find(textures, '2×2').handle;
            const target = find(textures, '32×16').handle;
            const texel = async (handle, x, y) => (await scanline('pixels', String(x), String(y), '--source', handle, '--json')).json.data.values;

            assert.deepEqual(await texel(checker, 1, 2), [60, 120, 128, 255]);
            assert.deepEqual(await texel(checker, 3, 0), [180, 0, 128, 255]);
            assert.deepEqual(await texel(floaty, 0, 0), [0.25, 1.5, -2, 1], 'float values outside 0 to 1 come back as they are');
            assert.deepEqual(await texel(floaty, 1, 0), [100, 0, 0, 1]);
            assert.deepEqual(await texel(target, 0, 0), MAGENTA, 'the top of the render target as rendered');
            assert.deepEqual(await texel(target, 31, 15), CYAN, 'and the bottom');

            const stats = await scanline('region_stats', '--source', target, '--json');

            assert.equal(stats.json.data.distinct, 2);
            assert.equal(stats.json.data.pixels, 512);
            assert.deepEqual(stats.json.data.channels[0].histogram, [256, 0, 0, 0, 0, 0, 0, 256]);

            const preview = await scanline('resource', checker, '--preview', '{"zoom":16}', '--json');

            assert.equal(preview.json.images[0].width, 64);
            assert.deepEqual(readFileSync(preview.json.images[0].view).subarray(0, 4), PNG);

            // Buffers: the bytes the page uploaded.
            const buffers = await scanline('resources', 'buffer', '--json');
            const vertices = await scanline('resource', find(buffers, '48 bytes').handle, '--json');
            const floats = new Float32Array(new Uint8Array(vertices.json.data.head.bytes).buffer);

            assert.deepEqual([...floats], [-1, -1, 1, -1, -1, 1, 1, 1, 0.5, 1.5, 2.5, 3.5]);

            // The shader that does not compile says why.
            const shaders = await scanline('resources', 'shader', '--sort', 'created', '--json');
            const broken = await scanline('resource', shaders.json.data.rows[0].handle);

            assert.match(broken.out, /undefinedName/);
            assert.match(broken.out, api === 'webgl2' ? /COMPILE FAILED/ : /1 compilation message/);

            // A leak: twelve textures from one line, never destroyed.
            const before = await scanline('memory', '--snapshot', 'before', '--json');

            assert.equal(before.json.data.snapshot.objects, 6);

            await scanline('eval', 'window.leak(12)');
            await scanline('step', '2');

            const grown = await scanline('memory', '--diff', '["before","now"]', '--json');

            assert.equal(grown.json.data.created, 12);
            assert.equal(grown.json.data.created_bytes, 12 * 256 * 256 * 4);
            assert.equal(grown.json.data.destroyed, 0);
            assert.equal(grown.json.data.groups[0].count, 12);
            assert.match(grown.json.data.groups[0].site, /leakTexture/);
            assert.match(grown.json.summary, /Possible leak: one call site created 12 identical textures/);

            // Handles end at a reload, and say so.
            await scanline('navigate', '--reload');

            const stale = await scanline('pixels', '0', '0', '--source', checker);

            assert.equal(stale.code, 1);
            assert.match(stale.out, new RegExp(`${checker} belongs to an earlier page load`));

            await scanline('close');
        });
    }

    test('webgl2: uniforms as last set, and the state mirror agrees with the context', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/inventory-webgl2.html'), '--headless');
        await scanline('step', '30');

        const program = await scanline('resource', 'prg_1', '--json');
        const uniforms = Object.fromEntries(program.json.data.detail.uniforms.map((uniform) => [uniform.name, uniform]));

        assert.equal(program.json.data.detail.linked, true);
        assert.deepEqual(uniforms.tint.value, [0.25, 0.5, 0.75, 1]);
        assert.equal(uniforms.tint.type, 'vec4');
        assert.deepEqual(uniforms.scale.value, [0.5]);
        assert.deepEqual(uniforms.map.value, [0]);
        assert.equal(uniforms.bias.value, null, 'a uniform the page never set');
        assert.match(program.json.summary, /float bias = never set since linking/);
        assert.deepEqual(program.json.data.detail.attributes, [{ name: 'corner', type: 'vec2', size: 1, location: 0 }]);

        const state = await scanline('resource', 'ctx_1', '--verify', '--json');

        assert.deepEqual(state.json.data.verify.drift, []);
        assert.ok(state.json.data.verify.checked > 60);
        assert.match(state.json.summary, /program prg_1, framebuffer none/);
        assert.match(state.json.summary, /enabled: BLEND, DITHER/);
        assert.match(state.json.summary, /blend: rgb FUNC_ADD × SRC_ALPHA \+ dst × ONE_MINUS_SRC_ALPHA/);
        assert.match(state.json.summary, /unit 0: 2D tex_1/);
        assert.match(state.json.summary, /Verified: all \d+ values match/);

        await scanline('close');
    });

    test('diff finds what moved between two frames, and only that', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/webgl2.html'), '--paused', '--headless');
        const moverX = async () => JSON.parse((await scanline('eval', 'JSON.stringify(window.fixture.moverX)', '--json')).json.data.value);

        await scanline('step', '11');

        const first = await scanline('screenshot', '--json');
        const from = await moverX();

        await scanline('step', '40');

        const second = await scanline('screenshot', '--json');
        const to = await moverX();

        assert.ok(to - from >= 39, 'the mover went about 40 pixels');
        const same = await scanline('diff', first.json.images[0].original, first.json.images[0].original, '--json');

        assert.equal(same.json.data.changed, 0);
        assert.match(same.json.summary, /^No difference/);

        // The mover is 20×20: the square it left and the square it reached are what changed.
        const moved = await scanline('diff', first.json.images[0].original, second.json.images[0].original, '--json');

        assert.equal(moved.json.data.changed, 800);
        assert.deepEqual(moved.json.data.bounds, { x: from, y: 200, w: to - from + 20, h: 20 });
        assert.equal(moved.json.data.max, 223, 'white against the background blue 32');
        assert.deepEqual(readFileSync(moved.json.images[0].view).subarray(0, 4), PNG);

        // The canvas now against the second screenshot: nothing has run since.
        const now = await scanline('diff', 'canvas', second.json.images[0].original, '--json');

        assert.equal(now.json.data.changed, 0);

        await scanline('close');
    });
});

describe('frame capture', () =>
{
    test('capture a frame, list its draws, ask what one did and which produced a pixel', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/inventory-webgl2.html'), '--headless');
        await scanline('step', '5');

        const captured = await scanline('capture', '--json');

        assert.equal(captured.code, 0, captured.out);

        const cap = captured.json.data.capture;

        assert.match(cap, /^cap_\d+$/);
        assert.equal(captured.json.data.replay, 'identical');
        assert.equal(captured.json.data.replay_matches, true);
        assert.deepEqual([captured.json.data.counts.draws, captured.json.data.counts.clears, captured.json.data.counts.passes], [1, 3, 2]);
        assert.match(captured.json.summary, /Replay check: replaying the capture gives an image identical to the frame's own/);
        assert.deepEqual(readFileSync(captured.json.images[0].original).subarray(0, 4), PNG);

        // What the frame says.
        const list = await scanline('draw_list', cap, '--json');

        assert.deepEqual(list.json.data.events.map((event) => [event.kind, event.target]), [['clear', 'tex_4'], ['clear', 'tex_4'], ['clear', 'canvas'], ['draw', 'canvas']]);
        assert.match(list.out, /3 {2}TRIANGLES ×6 indexed {2}prg_1 → canvas {2}blend SRC_ALPHA\/ONE_MINUS_SRC_ALPHA {2}textures tex_1/);

        const filtered = await scanline('draw_list', cap, '--filter', 'blend = 1 and depth_test = 0', '--json');

        assert.deepEqual(filtered.json.data.events.map((event) => event.draw), [3]);

        const draw = await scanline('draw', cap, '3', '--json');

        assert.deepEqual(draw.json.data.state.uniforms, { map: [0], scale: [0.5], tint: [0.25, 0.5, 0.75, 1] });
        assert.match(draw.json.summary, /TRIANGLES × 6, indexed \(UNSIGNED_SHORT from buf_2 at byte 0\)/);
        assert.match(draw.json.summary, /unit 0: 2D tex_1/);
        assert.match(draw.json.summary, /attribute 0: 2 × FLOAT from buf_1/);

        // What it did: the quad is half the canvas each way, centred.
        assert.deepEqual(draw.json.data.effect, { changed: 160 * 120, bounds: { x: 80, y: 60, w: 160, h: 120 } });

        const difference = await scanline('draw_diff', cap, '0', '1');

        assert.match(difference.out, /clearColor: \[1,0,1,1\] → \[0,1,1,1\]/);
        assert.match(difference.out, /scissor: null → \[0,0,32,8\]/);
        assert.match(difference.out, /enabled: \[BLEND, DITHER\] → \[BLEND, DITHER, SCISSOR_TEST\]/);

        const sql = await scanline('query', cap, "select name, value from uniforms where draw = 3 order by name", '--json');

        assert.deepEqual(sql.json.data.rows, [['map', '0'], ['scale', '0.5'], ['tint', '0.25, 0.5, 0.75, 1']]);

        const refused = await scanline('query', cap, 'delete from draws');

        assert.equal(refused.code, 1);
        assert.match(refused.out, /SQL error/);

        // What the frame did, by replay.
        const source = await scanline('pixel_source', cap, '160', '120', '--json');

        assert.deepEqual(source.json.data.changes.map((change) => change.draw), [2, 3]);
        assert.deepEqual(source.json.data.changes[0].after, [32, 64, 96, 255]);
        assert.match(source.json.summary, /was produced by event 3\. gpu-measured\./);

        const corner = await scanline('pixel_source', cap, '5', '5', '--json');

        assert.deepEqual(corner.json.data.changes.map((change) => change.draw), [2], 'outside the quad, only the clear');

        const target = await scanline('pixel_source', cap, '3', '12', '--target', 'tex_4', '--json');

        assert.deepEqual(target.json.data.changes.map((change) => [change.draw, change.after]), [[0, [255, 0, 255, 255]], [1, [0, 255, 255, 255]]]);

        // The render target part-way through the frame.
        const before = await scanline('pixels', '0', '15', '--capture', cap, '--at-draw', '0', '--target', 'tex_4', '--json');
        const after = await scanline('pixels', '0', '15', '--capture', cap, '--at-draw', '1', '--target', 'tex_4', '--json');

        assert.deepEqual(before.json.data.rgba8, [255, 0, 255, 255]);
        assert.deepEqual(after.json.data.rgba8, [0, 255, 255, 255]);

        const shot = await scanline('screenshot', '--capture', cap, '--at-draw', '2', '--json');

        assert.equal(shot.json.images[0].width, 320);

        // The capture outlives its session. What it says is still readable; what it did needs a browser.
        await scanline('close');

        const later = await scanline('draw_list', cap, '--filter', "kind = 'draw'", '--json');

        assert.equal(later.json.data.total, 1);

        const noBrowser = await scanline('pixel_source', cap, '160', '120');

        assert.equal(noBrowser.code, 1);
        assert.match(noBrowser.out, /needs a browser to run it in, and no session is open\. Call launch/);

        // Any session's browser will do.
        await scanline('launch', server.url('fixtures/spikes/blank.html'), '--headless');

        const elsewhere = await scanline('pixel_source', cap, '160', '120', '--json');

        assert.deepEqual(elsewhere.json.data.changes.map((change) => change.draw), [2, 3]);
        assert.match((await scanline('captures')).out, new RegExp(`${cap} {2}frame \\d+ of webgl2 320×240, 1 draws, replay identical`));
    });

    test('webgpu: capture a frame, replay it, and ask the same questions', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/inventory-webgpu.html'), '--paused', '--headless');
        await scanline('step', '3');

        const taken = await scanline('capture', '--json');

        assert.equal(taken.code, 0, taken.out);

        const cap = taken.json.data.capture;

        assert.equal(taken.json.data.api, 'webgpu');
        assert.equal(taken.json.data.replay, 'identical', taken.json.summary);
        assert.deepEqual(taken.json.data.findings, [], 'nothing about a correct frame is worth a look');
        assert.match(taken.json.summary, /2 draws, 2 clears in 2 passes/);
        assert.match(taken.json.summary, /pass 0: 1 draw, 1 clear to tex_\d+\n {2}pass 1: 1 draw, 1 clear to canvas/);

        // A pass that clears as it begins is an event, like a draw. Each has its effect measured:
        // the frame is split after it, submitted and read.
        const list = await scanline('draw_list', cap, '--json');
        const events = list.json.data.events;

        assert.deepEqual(events.map((event) => event.kind), ['clear', 'draw', 'clear', 'draw']);
        assert.equal(events[3].target, 'canvas');
        assert.equal(events[3].mode, 'triangle-strip');
        assert.match(events[3].program, /^pip_\d+$/);
        assert.equal(events[2].pixels_changed, 320 * 240);
        assert.deepEqual([events[3].pixels_changed, events[3].changed_box], [160 * 120, '80, 60, 160, 120']);
        assert.match(list.out, /viewport 0, 8, 32, 8 \(target is 32×16\)/);
        assert.doesNotMatch(list.out, /bottom-left/);

        // One draw: its pipeline, and what its bind groups hold.
        const draw = await scanline('draw', cap, '3');

        assert.match(draw.out, /event 3: draw to canvas/);
        assert.match(draw.out, /triangle-strip × 4, from vertex 0/);
        assert.match(draw.out, /pipeline pip_\d+ {2}\(render pipeline/);
        assert.match(draw.out, /bind group 0: bgr_\d+/);
        assert.match(draw.out, /binding \d+: a view of tex_\d+ {2}\(/);
        assert.match(draw.out, /binding \d+: smp_\d+/);
        assert.match(draw.out, /Effect: it changed 19200 pixels/);

        const clear = await scanline('draw', cap, '2');

        assert.match(clear.out, /the pass begins by clearing colour to /);

        // Which event produced a pixel, on the canvas and on the texture the frame drew to first.
        const source = await scanline('pixel_source', cap, '160', '120', '--json');

        assert.deepEqual(source.json.data.changes.map((change) => change.draw), [2, 3]);

        const target = events[0].target;
        const inner = await scanline('pixel_source', cap, '3', '12', '--target', target, '--json');

        assert.deepEqual(inner.json.data.changes.map((change) => change.draw), [0, 1]);

        // The canvas part-way through the frame: cleared, not yet drawn on.
        const before = await scanline('pixels', '160', '120', '--capture', cap, '--at-draw', '2', '--json');
        const after = await scanline('pixels', '160', '120', '--capture', cap, '--at-draw', '3', '--json');

        assert.notDeepEqual(before.json.data.rgba8, after.json.data.rgba8);
        assert.deepEqual(after.json.data.rgba8, source.json.data.changes[1].after);

        // The stream reads as WebGPU calls, each with what it was made on.
        const calls = await scanline('query', cap, "select method, receiver from commands where method like '%.draw' or method like '%submit'", '--json');

        assert.deepEqual(calls.json.data.rows.map((row) => row[0]), ['GPURenderPassEncoder.draw', 'GPURenderPassEncoder.draw', 'GPUQueue.submit']);
        assert.match(calls.json.data.rows[0][1], /^#\d+$/);
        assert.equal(calls.json.data.rows[2][1], 'queue');

        const objects = await scanline('query', cap, 'select kind, count(*) from objects group by kind order by kind', '--json');

        assert.ok(objects.json.data.rows.some((row) => row[0] === 'pipeline' && row[1] === 2), JSON.stringify(objects.json.data.rows));
        assert.ok(objects.json.data.rows.some((row) => row[0] === 'bind_group'));
    });

    test('webgpu: a frame the browser rejects is reported as one that did not run', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/webgpu-invalid.html'), '--paused', '--headless');

        // The page catches nothing, so the browser logs the error: a step reports it.
        const stepped = await scanline('step', '2');

        assert.match(stepped.out, /errors? raised/);
        assert.match(stepped.out, /Vertex range \(first: 0, count: 3\) requires a larger buffer/);

        const taken = await scanline('capture', '--json');

        assert.equal(taken.code, 0, taken.out);
        assert.equal(taken.json.data.replay, 'identical');
        assert.equal(taken.json.data.counts.gl_errors, 2);
        assert.match(taken.json.summary, /2 calls raised a validation error when replayed/);
        assert.match(taken.json.summary, /call \d+ GPUCommandEncoder\.finish: Vertex range \(first: 0, count: 3\) requires a larger buffer \(24\) than the bound buffer size \(8\)/);
        assert.match(taken.json.summary, /So events 0–1 did not run in the page/);
        assert.doesNotMatch(taken.json.summary, /changed no pixels/);

        const list = await scanline('draw_list', taken.json.data.capture);

        assert.equal(list.out.match(/DID NOT RUN: dropped with its command buffer/g).length, 2);

        const draw = await scanline('draw', taken.json.data.capture, '1');

        assert.match(draw.out, /THIS EVENT DID NOT RUN in the page/);
    });

    test('webgpu: frames of three.js and PixiJS replay to identical images', async () =>
    {
        for (const page of ['fixtures/engines/three.html?renderer=webgpu', 'fixtures/engines/pixi.html?renderer=webgpu'])
        {
            const launched = await scanline('launch', server.url(page), '--paused', '--headless', '--json');
            const session = launched.json.data.session;

            await scanline('step', '5', '--session', session);

            const taken = await scanline('capture', '--session', session, '--json');

            assert.equal(taken.code, 0, `${page}: ${taken.out}`);
            assert.equal(taken.json.data.api, 'webgpu', page);
            assert.equal(taken.json.data.replay, 'identical', `${page}: ${taken.json.summary}`);
            assert.ok(taken.json.data.counts.draws >= 1, page);

            // Every event's effect could be measured: none came back unreadable.
            const list = await scanline('draw_list', taken.json.data.capture, '--session', session, '--json');

            assert.ok(list.json.data.events.every((event) => typeof event.pixels_changed === 'number'), `${page}: ${list.out}`);

            await scanline('close', '--session', session);
        }
    });

    test('mistakes with captures are explained', async () =>
    {
        const missing = await scanline('draw_list', 'cap_999');

        assert.match(missing.out, /No capture "cap_999"\./);

        await scanline('launch', server.url('fixtures/matrix/webgl2.html'), '--headless');

        const cap = (await scanline('capture', '--json')).json.data.capture;
        const badDraw = await scanline('draw', cap, '77');

        assert.match(badDraw.out, new RegExp(`${cap} has \\d+ events, numbered from 0; there is no draw 77\\.`));

        const badFilter = await scanline('draw_list', cap, '--filter', 'colour = 1');

        assert.match(badFilter.out, /no such column: colour/);
        assert.match(badFilter.out, /filter is a SQL condition on the draws table/);

        const badTarget = await scanline('pixel_source', cap, '1', '1', '--target', 'tex_99');

        assert.match(badTarget.out, /"tex_99" is not a texture in cap_\d+\. Targets the frame drew to: canvas\./);

        await scanline('close');
        await scanline('launch', server.url('fixtures/spikes/blank.html'), '--headless');

        // A page with nothing to capture.
        const nothing = await scanline('capture');

        assert.equal(nothing.code, 1);
        assert.match(nothing.out, /context/i);
    });
});

describe('working with the person', () =>
{
    test('ask, play, Debug: the frames before the press are kept and the flicker is found', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/bugs/b13.html'), '--paused', '--headless', '--json');
        const session = launched.json.data.session;

        const asked = await scanline('request_human', 'Play until the glass flickers, then press Debug', '--flight-frames', '90', '--json');

        assert.equal(asked.code, 0, asked.out);
        assert.equal(asked.json.data.request, 'req_1');
        assert.equal(asked.json.data.recording, true);
        assert.match(asked.json.summary, /req_1: the person has been asked: «Play until the glass flickers, then press Debug»\. They have the input and the page is running\./);

        // The person has the game. The agent may look, but not move time or send input.
        const refused = await scanline('step', '1');

        assert.equal(refused.code, 1);
        assert.match(refused.out, /The person has the input \(req_1: «Play until the glass flickers, then press Debug»\), so step is not available/);
        assert.match((await scanline('status')).out, /The person has the input, asked \(req_1\).*The flight recorder is on/);

        // Nothing has been pressed yet.
        const early = await scanline('wait', '--request', 'req_1', '--timeout-s', '0.3', '--json');

        assert.equal(early.code, 2);
        assert.equal(early.json.data.still_waiting, true);

        // Play for long enough that the flicker (one frame in forty) has happened at least twice.
        await scanline('eval', 'new Promise((done) => { const tick = () => (game.frame >= 150 ? done(game.frame) : requestAnimationFrame(tick)); tick(); })', '--await');

        // The press. It carries where the person pointed.
        const pressed = await scanline('debug', '--x', '250', '--y', '210', '--note', 'here', '--json');

        assert.equal(pressed.code, 0, pressed.out);

        const { frame, capture, recording, frames, first_frame: first } = pressed.json.data;

        assert.equal(recording, 'rec_1');
        assert.ok(frames >= 90 && frames <= 120, `kept ${frames} frames`);
        assert.equal(first + frames - 1, frame, 'the frames kept run up to the frozen one');
        assert.deepEqual(pressed.json.data.annotation, { x: 250, y: 210, note: 'here' });
        assert.match(pressed.json.summary, /The page is frozen/);
        assert.match(pressed.json.summary, /Replay check: replaying the capture gives an image identical to the frame's own/);

        // The page is frozen at that frame and belongs to nobody, so the agent can carry on.
        assert.match((await scanline('status')).out, new RegExp(`Paused at frame ${frame}\\b`));

        // The press is in the queue whenever the agent comes for it, however late.
        const event = await scanline('wait', '--request', 'req_1', '--json');

        assert.equal(event.json.data.events.length, 1);
        assert.equal(event.json.data.events[0].kind, 'debug_pressed');
        assert.deepEqual(
            [event.json.data.events[0].data.capture, event.json.data.events[0].data.recording, event.json.data.events[0].data.request],
            [capture, 'rec_1', 'req_1']
        );

        // The recording says which frames are not like the others: the ones that flicker.
        const record = await scanline('recording', 'rec_1', '--json');
        const odd = record.json.data.frames.filter((entry) => entry.unusual).map((entry) => entry.frame);

        assert.ok(odd.length >= 2, record.json.summary);
        assert.ok(odd.every((number) => number % 40 === 0), `the flicker frames are the fortieth ones: ${odd}`);
        assert.match(record.json.summary, new RegExp(`${odd.length} of the ${frames} frames differ from the rest in what they draw`));
        assert.match(record.json.summary, /Every frame issued 25 events/);
        assert.match(record.json.summary, /Contact sheet: 12 across/);
        assert.deepEqual(readFileSync(record.json.images[0].view).subarray(0, 4), PNG);

        // A flicker frame and its neighbour as captures: one has the glass before the crates.
        const bad = await scanline('capture', '--recording', 'rec_1', '--frame', String(odd[0]), '--json');
        const good = await scanline('capture', '--recording', 'rec_1', '--frame', String(odd[0] - 1), '--json');

        assert.equal(bad.code, 0, bad.out);
        assert.equal(bad.json.data.frame, odd[0]);
        assert.equal(bad.json.data.replay, 'not compared');
        assert.equal(bad.json.data.replay_matches, true);
        assert.match(bad.json.summary, /Event 6 blends, but opaque depth-written events 8–9 are drawn after it on the same pixels/);
        assert.match(bad.json.summary, /taken from recording rec_1, which kept no image of it/);
        assert.deepEqual(good.json.data.findings, []);
        assert.match(bad.json.data.url, /b13\.html$/);

        // Its tables hold that frame's calls only, numbered as they are in the recording.
        const calls = await scanline('query', bad.json.data.capture, 'select count(*), min(command) from commands', '--json');

        assert.equal(calls.json.data.rows[0][0], 153);
        assert.ok(calls.json.data.rows[0][1] > 153, 'earlier frames come before it in the stream');

        // The frozen frame is the capture made at the press, not a second one.
        const again = await scanline('capture', '--recording', 'rec_1', '--frame', String(frame), '--json');

        assert.equal(again.json.data.capture, capture);
    });

    test('webgpu: the flight recorder keeps frames that replay', async () =>
    {
        await scanline('launch', server.url('fixtures/engines/three.html?renderer=webgpu'), '--paused', '--headless');
        await scanline('step', '3');

        const asked = await scanline('request_human', 'Watch the cubes, then press Debug', '--flight-frames', '45', '--json');

        assert.equal(asked.json.data.recording, true, asked.out);

        await scanline('eval', 'new Promise((done) => { let left = 80; const tick = () => (--left ? requestAnimationFrame(tick) : done(1)); tick(); })', '--await');

        const pressed = await scanline('debug', '--json');

        assert.equal(pressed.code, 0, pressed.out);
        assert.ok(pressed.json.data.frames >= 45, `kept ${pressed.json.data.frames} frames`);
        assert.match(pressed.json.summary, /Replay check: replaying the capture gives an image identical to the frame's own/);

        const record = await scanline('recording', pressed.json.data.recording, '--json');

        assert.match(record.json.summary, /Every frame draws the same things in the same order with the same state/);
        assert.equal(record.json.data.frames.length, pressed.json.data.frames);
        assert.ok(record.json.data.frames.every((entry) => /^[0-9a-f]{8}$/.test(entry.picture)), 'every frame was replayed to a picture');

        // A frame from the middle, as a capture: its events were measured, so it replayed.
        const middle = await scanline('capture', '--recording', pressed.json.data.recording, '--frame', String(pressed.json.data.first_frame + 20), '--json');

        assert.equal(middle.code, 0, middle.out);
        assert.equal(middle.json.data.api, 'webgpu');
        assert.equal(middle.json.data.replay_matches, true);

        const list = await scanline('draw_list', middle.json.data.capture, '--json');

        assert.ok(list.json.data.events.length >= 2);
        assert.ok(list.json.data.events.every((event) => typeof event.pixels_changed === 'number'), list.out);
    });

    test('the Debug key in the page freezes and captures, and the page never sees the key', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/webgl2.html'), '--headless');
        await scanline('eval', 'window.seen = []; addEventListener("keydown", (event) => seen.push(event.code)); addEventListener("keyup", (event) => seen.push(event.code)); 0');

        // An ordinary key reaches the page; F9 does not.
        await scanline('input', '--events', '[{"key": "KeyA", "press": true}, {"key": "F9", "press": true}]');

        const event = await scanline('wait', '--kinds', '["debug_pressed"]', '--cursor', '0', '--timeout-s', '20', '--json');

        assert.equal(event.json.data.events.length, 1, event.out);
        assert.equal(event.json.data.events[0].data.by, 'key');
        assert.match(event.json.data.events[0].data.capture, /^cap_\d+$/);
        assert.match((await scanline('status')).out, /Paused at frame \d+/);
        assert.equal((await scanline('eval', 'JSON.stringify(seen)')).out.includes('F9'), false);
        assert.match((await scanline('eval', 'JSON.stringify(seen)')).out, /KeyA/);
    });
});

describe('runs: play it again', () =>
{
    const state = 'JSON.stringify([game.frame, game.time, game.x, game.y, game.clicks, game.sparks, Date.now(), performance.now()])';

    test('a deterministic session replays to the same state and the same fingerprints', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/matrix/game.html'), '--paused', '--headless', '--deterministic', 'true', '--json');

        assert.match(launched.json.summary, /Deterministic session: random numbers are seeded \(1\), every frame is 16\.667 ms of page time, page time starts at 0/);

        // Play: steer right, then down, clicking twice. Each click throws sparks in random directions.
        await scanline('step', '40', '--hold', 'ArrowRight');
        await scanline('step', '50', '--hold', 'ArrowDown', '--events', '[{"at": 5, "pointer": "down", "x": 200, "y": 100}, {"at": 6, "pointer": "up", "x": 200, "y": 100}]');
        await scanline('step', '90', '--hold', '', '--events', '[{"at": 60, "pointer": "down", "x": 100, "y": 60}, {"at": 61, "pointer": "up", "x": 100, "y": 60}]');

        const before = (await scanline('eval', state)).out;

        // Time is a function of the frame number and nothing else: 180 frames of 1/60 s,
        // from zero, give or take the rounding of adding one step at a time.
        const [frames, time, , , clicks, , date] = JSON.parse(before.slice(1, -1));

        assert.equal(frames, 180);
        assert.ok(Math.abs(time - 3000) < 1e-6, `page time is ${time}`);
        assert.equal(date, Date.UTC(2026, 0, 1) + 3000, 'and the date started at the first instant of 2026');
        assert.equal(clicks, 2);

        const saved = await scanline('save_run', '--json');

        assert.equal(saved.code, 0, saved.out);
        assert.equal(saved.json.data.run, 'run_1');
        assert.equal(saved.json.data.frames, 180);
        assert.equal(saved.json.data.prints, 6);
        assert.match(saved.json.summary, /run_1: the 180 frames since .*game\.html loaded, with 2 key presses, 2 clicks\./);

        const replayed = await scanline('replay_run', 'run_1', '--json');

        assert.equal(replayed.code, 0, replayed.out);
        assert.equal(replayed.json.data.frame, 180);
        assert.equal(replayed.json.data.diverged, null);
        assert.equal(replayed.json.data.matched, 6);
        assert.match(replayed.json.summary, /All 6 fingerprints along the way match the original/);
        assert.equal((await scanline('eval', state)).out, before, 'every number the game holds is the same, to the last bit');

        // Going back: the same run, stopped early.
        const earlier = await scanline('replay_run', 'run_1', '--to-frame', '75', '--json');

        assert.equal(earlier.json.data.frame, 75);
        assert.match(earlier.json.summary, /Replayed run_1 to frame 75 of 180\. Paused\./);
        assert.match((await scanline('eval', 'JSON.stringify([game.frame, game.clicks])')).out, /\[75,1\]/);

        // A replayed session can be saved again: it received the same input.
        await scanline('replay_run', 'run_1');

        const again = await scanline('save_run', '--json');

        assert.equal(again.json.data.events, saved.json.data.events);
    });

    test('a replay that parts from the original says where', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/game.html'), '--paused', '--headless', '--deterministic', 'true');
        await scanline('step', '100', '--events', '[{"at": 20, "pointer": "down", "x": 160, "y": 120}, {"at": 21, "pointer": "up", "x": 160, "y": 120}]');

        const run = (await scanline('save_run', '--json')).json.data.run;

        await scanline('close');

        // The same input with other random numbers: the sparks fly elsewhere.
        await scanline('launch', server.url('fixtures/matrix/game.html'), '--paused', '--headless', '--deterministic', '{"seed": 7}');

        const replayed = await scanline('replay_run', run, '--json');

        assert.equal(replayed.code, 0, replayed.out);
        assert.match(replayed.json.data.diverged, /at frame 30, its picture differs from the original's/);
        assert.equal(replayed.json.data.frame, 30, 'it stops there, paused, to be looked at');
        assert.match(replayed.json.summary, /DIVERGED: the replay of run_\d+ parted from the original/);
        assert.match(replayed.json.summary, /recorded with deterministic .*"seed":1.*this session has .*"seed":7/);

        const missing = await scanline('replay_run', 'run_999');

        assert.equal(missing.code, 1);
        assert.match(missing.out, /No run "run_999"\. The most recent of \d+ is run_\d+\./);
    });
});

describe('the MCP server', () =>
{
    test('initialize, list tools, and run a session with an inline image', async () =>
    {
        const child = spawn(binary, ['mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
        const waiting = new Map();

        let buffer = '';
        let nextId = 1;

        child.stdout.on('data', (chunk) =>
        {
            buffer += chunk;

            let newline;

            while ((newline = buffer.indexOf('\n')) >= 0)
            {
                const message = JSON.parse(buffer.slice(0, newline));

                buffer = buffer.slice(newline + 1);
                waiting.get(message.id)?.(message);
            }
        });

        const request = (method, params) => new Promise((resolve) =>
        {
            const id = nextId++;

            waiting.set(id, resolve);
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });

        const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;

        try
        {
            const hello = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } });

            assert.equal(hello.result.protocolVersion, '2025-11-25');
            assert.match(hello.result.instructions, /^Scanline debugs WebGL and WebGPU rendering/);

            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

            const tools = (await request('tools/list', {})).result.tools;

            assert.ok(tools.length >= 15);
            assert.ok(tools.every((tool) => tool.name.startsWith('gfx_') && tool.inputSchema.type === 'object'));

            const launched = await call('gfx_launch', { url: server.url('fixtures/matrix/webgpu.html'), start: 'paused', headless: true });

            assert.equal(launched.isError, false, launched.content[0].text);
            assert.match(launched.content[0].text, /ctx_\d+ webgpu 320×240/);
            assert.match(launched.content[0].text, /COPY_SRC is added/);

            const session = launched.structuredContent.session;
            const stepped = await call('gfx_step', { session, frames: 2, observe: { screenshot: { max_edge: 160 } } });

            assert.equal(stepped.isError, false, stepped.content[0].text);
            assert.equal(stepped.content.length, 2, 'text, then one image');
            assert.equal(stepped.content[1].type, 'image');
            assert.equal(stepped.content[1].mimeType, 'image/png');
            assert.deepEqual(Buffer.from(stepped.content[1].data, 'base64').subarray(0, 4), PNG);
            assert.match(stepped.content[0].text, /shown at 1\/2 scale\. Image is 160×120/);

            const pixel = await call('gfx_pixels', { session, x: 160, y: 60 });

            assert.match(pixel.content[0].text, /rgba8 \(0, 255, 0, 255\)\. Target format (bgra8unorm|rgba8unorm)\. gpu-measured\./);

            const failed = await call('gfx_pixels', { session: 'ses_404', x: 0, y: 0 });

            assert.equal(failed.isError, true);
            assert.match(failed.content[0].text, /No session "ses_404"/);

            await call('gfx_close', { session });
        }
        finally
        {
            child.stdin.end();
        }
    });
});
