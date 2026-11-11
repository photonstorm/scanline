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

        assert.match(badTarget.out, /"tex_99" is not a texture or a framebuffer in cap_\d+\. Targets the frame drew to: canvas\./);

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

        // The two against each other: the glass has moved in the order, and the picture differs where the crates are.
        const compared = await scanline('compare', bad.json.data.capture, good.json.data.capture, '--json');

        assert.equal(compared.code, 0, compared.out);
        assert.deepEqual(compared.json.data.moved, [{ a: 6, b: 9 }]);
        assert.deepEqual([compared.json.data.only_a, compared.json.data.only_b], [[], []]);
        assert.match(compared.json.summary, /MOVED: a's event 6 is b's event 9: TRIANGLE_STRIP ×4 {2}prg_1 → canvas {2}blend SRC_ALPHA\/ONE_MINUS_SRC_ALPHA/);
        assert.match(compared.json.summary, /In a it is drawn before a's events 7–9; in b it is drawn after them\./);
        assert.match(compared.json.summary, /Their final pictures differ in \d+ of 172800 pixels/);
        assert.deepEqual(readFileSync(compared.json.images[0].view).subarray(0, 4), PNG);

        const same = await scanline('compare', good.json.data.capture, good.json.data.capture);

        assert.match(same.out, /Both issue the same 25 events in the same order/);
        assert.match(same.out, /Their final pictures are identical\./);

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

describe('the control strip and the input owner', () =>
{
    const shown = async () => (await scanline('strip', '--json')).json.data.shown;

    test('the strip shows the person what was asked, and its buttons work', async () =>
    {
        await scanline('launch', server.url('fixtures/bugs/b13.html'), '--paused', '--headless');

        assert.match((await scanline('strip')).out, /The control strip is not open/);

        const asked = await scanline('request_human', 'Play until the glass flickers, then press Debug');

        assert.match(asked.out, /A control strip under the game's window shows them the instruction, with Debug, Pause and Step buttons/);

        // What the person sees.
        let strip = await shown();

        assert.equal(strip.who, 'You are driving');
        assert.equal(strip.instruction, 'Play until the glass flickers, then press Debug');
        assert.equal(strip.recording, true);
        assert.equal(strip.pause, 'Pause');
        assert.equal(strip.step_enabled, false);

        // Its frame counter follows the page.
        await new Promise((resolve) => setTimeout(resolve, 700));

        const moved = Number((await shown()).frame.replace('frame ', ''));

        assert.ok(moved > 5, `the strip shows frame ${moved}`);

        // Pause, then one frame at a time, then on again: the person's buttons, not the agent's commands.
        await scanline('strip', '--press', 'pause');

        strip = await shown();

        assert.equal(strip.pause, 'Resume');
        assert.equal(strip.step_enabled, true);

        const at = Number(strip.frame.replace('frame ', ''));

        await scanline('strip', '--press', 'step');
        assert.equal((await shown()).frame, `frame ${at + 1}`);

        await scanline('strip', '--press', 'pause');
        assert.equal((await shown()).pause, 'Pause');

        // A picture of it, for whoever wants to see what the person sees.
        const picture = await scanline('strip', '--output', '--json');

        assert.deepEqual(readFileSync(picture.json.images[0].view).subarray(0, 4), PNG);

        // Debug on the strip does what F9 does.
        await new Promise((resolve) => setTimeout(resolve, 400));
        await scanline('strip', '--press', 'debug');

        const event = await scanline('wait', '--request', 'req_1', '--timeout-s', '20', '--json');

        assert.equal(event.json.data.events[0].kind, 'debug_pressed');
        assert.equal(event.json.data.events[0].data.by, 'strip');
        assert.match(event.json.data.events[0].data.recording, /^rec_\d+$/);

        strip = await shown();

        assert.equal(strip.who, 'Nobody is driving');
        assert.match(strip.instruction, /^Frozen at frame \d+\. The agent has this frame and the \d+ before it\. Click the picture to point at something, drag to mark a box, or type a note\.$/);
        assert.equal(strip.recording, false);
    });

    test('after Debug the person marks the frozen frame: a point, a box and a note reach the agent', async () =>
    {
        await scanline('launch', server.url('fixtures/bugs/b13.html'), '--headless');
        await scanline('request_human', 'Press Debug when the glass flickers');
        await new Promise((resolve) => setTimeout(resolve, 400));
        await scanline('strip', '--press', 'debug');

        const pressed = await scanline('wait', '--request', 'req_1', '--json');
        const cursor = pressed.json.data.events.at(-1).seq;

        assert.equal(pressed.json.data.events.at(-1).kind, 'debug_pressed');

        // The page counts the clicks it sees, to show that it sees none of these.
        await scanline('eval', 'window.clicks = 0; addEventListener("mousedown", () => window.clicks++, true); 1');

        // The strip invites the marks, and has a field for a note.
        const invited = await scanline('strip', '--json');

        assert.match(invited.json.data.shown.instruction, /Frozen at frame \d+\. .*Click the picture to point at something, drag to mark a box, or type a note\./);
        assert.equal(invited.json.data.shown.note, true);

        // A click, a drag, and a typed note, as the person would make them.
        await scanline('input', '--events', '[{"pointer": "down", "x": 250, "y": 210}, {"pointer": "up", "x": 250, "y": 210}]', '--as_person', 'true');
        await scanline('input', '--events', '[{"pointer": "down", "x": 100, "y": 50}, {"pointer": "move", "x": 180, "y": 120}, {"pointer": "up", "x": 180, "y": 120}]', '--as_person', 'true');
        await scanline('strip', '--note', 'the crates show through here');

        const marks = (await scanline('events', '--since', cursor, '--json')).json.data.events.filter((event) => event.kind === 'annotation').map((event) => event.data);
        const frame = pressed.json.data.events.at(-1).data.frame;

        assert.deepEqual(marks, [
            { frame, space: 'canvas_px', x: 250, y: 210 },
            { frame, space: 'canvas_px', x: 100, y: 50, w: 81, h: 71 },
            { note: 'the crates show through here' }
        ]);

        // The page saw none of it, and the outline the person sees goes when the page moves on.
        assert.equal((await scanline('eval', '[window.clicks, document.querySelectorAll("div[aria-hidden]").length].join()', '--json')).json.data.value, '0,1');

        await scanline('step', '1');
        await new Promise((resolve) => setTimeout(resolve, 400));

        assert.equal((await scanline('eval', 'document.querySelectorAll("div[aria-hidden]").length', '--json')).json.data.value, 0);
        assert.equal((await scanline('strip', '--json')).json.data.shown.note, false, 'the note field goes with the frozen frame');
        assert.match((await scanline('strip', '--note', 'too late')).out, /The strip shows no note field just now/);

        // A click is the page's again.
        await scanline('input', '--events', '[{"pointer": "down", "x": 250, "y": 210}, {"pointer": "up", "x": 250, "y": 210}]');
        assert.equal((await scanline('eval', 'window.clicks', '--json')).json.data.value, 1);
    });

    test('while the agent has the input, the person\'s is kept out of the page', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/game.html'), '--paused', '--headless', '--deterministic', 'true', '--strip');

        const position = async () => JSON.parse((await scanline('eval', 'JSON.stringify([game.x, game.y, game.clicks])')).out.slice(1, -1));

        assert.equal((await shown()).who, 'Nobody is driving');

        // Nobody in particular has the input: the person's reaches the page.
        await scanline('input', '--as-person', '--events', '[{"key": "ArrowDown", "down": true}]');
        await scanline('step', '6');
        await scanline('input', '--as-person', '--events', '[{"key": "ArrowDown", "down": false}]');

        const [, started] = await position();

        assert.ok(started > 110, `the square moved down to ${started}`);

        const taken = await scanline('take_control');

        assert.match(taken.out, /The agent has the input: the person's keys and mouse are kept out of the page/);
        assert.match((await shown()).who, /The agent is driving/);
        assert.match((await shown()).instruction, /Your keys and mouse are kept out of the page; Debug still works/);

        // The agent's own input arrives.
        await scanline('step', '6', '--hold', 'ArrowRight');

        const [x] = await position();

        assert.ok(x > 40, `the agent moved the square right to ${x}`);

        // The person's does not: neither a key nor a click.
        await scanline('step', '1', '--hold', '');
        await scanline('input', '--as-person', '--events', '[{"key": "ArrowDown", "down": true}, {"pointer": "down", "x": 100, "y": 100}, {"pointer": "up", "x": 100, "y": 100}]');
        await scanline('step', '6');

        assert.deepEqual(await position(), [x, started, 0], 'nothing the person did reached the game');

        // And it is not in the run either, so a replay is not spoiled by it.
        const run = await scanline('save_run', '--json');

        assert.match(run.json.summary, /with 2 key presses\./);

        // Given up, the person's input arrives again.
        await scanline('input', '--as-person', '--events', '[{"key": "ArrowDown", "down": false}]');
        await scanline('take_control', '--release');
        await scanline('input', '--as-person', '--events', '[{"pointer": "down", "x": 100, "y": 100}, {"pointer": "up", "x": 100, "y": 100}]');
        await scanline('step', '2');

        assert.equal((await position())[2], 1);
        assert.equal((await shown()).who, 'Nobody is driving');
    });
});

describe('live patches', () =>
{
    const pixel = async (x, y) => (await scanline('pixels', String(x), String(y), '--json')).json.data.rgba8;

    // Handles have to have been shown before they can be named.
    const open = async (page) =>
    {
        await scanline('launch', server.url(page), '--paused', '--headless');
        await scanline('step', '4');
        await scanline('resources', 'program');
        await scanline('resources', 'texture');
    };

    test('a patch made with keep is made again after a reload, and one made without is not', async () =>
    {
        await open('fixtures/bugs/b01.html');

        const sky = [89, 153, 229, 255];
        const crate = [187, 131, 75, 255];

        // Two patches: the fix, kept; and one that would hide the ground, not kept.
        const kept = await scanline('patch_state', '--filter', '{"program": "prg_1"}', '--state', '{"cull": false}', '--keep', '--json');

        assert.equal(kept.code, 0, kept.out);
        assert.equal(kept.json.data.kept, true);
        assert.match(kept.json.summary, /It is kept: after navigate\(reload: true\) or replay_run it is made again/);

        const passing = await scanline('patch_state', '--state', '{"scissor": [0, 0, 10, 10]}', '--json');

        assert.match(passing.json.summary, /A reload removes every patch\./);

        await scanline('step', '2');
        assert.deepEqual(await pixel(100, 220), sky, 'everything is clipped to a corner');

        const listed = await scanline('patches', '--json');

        assert.deepEqual(listed.json.data.patches.map((patch) => patch.kept), [true, false]);
        assert.match(listed.json.summary, /\[kept across reloads\]/);

        // A reload: the kept one comes back under a new handle, the other is gone.
        const reloaded = await scanline('navigate', '--reload', '--json');

        assert.equal(reloaded.code, 0, reloaded.out);
        assert.match(reloaded.json.summary, /Kept patch made again in the new page: pat_1 \(draws that use prg_1: cull off\)\./);

        await scanline('pause');
        await scanline('step', '2');
        assert.deepEqual(await pixel(100, 220), crate, 'the fix is in force from the first frames of the new page');

        const after = await scanline('patches', '--json');

        assert.deepEqual(after.json.data.patches.map((patch) => [patch.kind, patch.kept]), [['state', true]]);

        // Undone, it stays undone across the next reload.
        await scanline('patches', '--revert', after.json.data.patches[0].patch);

        const again = await scanline('navigate', '--reload', '--json');

        assert.doesNotMatch(again.json.summary, /Kept patch/);

        await scanline('pause');
        await scanline('step', '2');
        assert.deepEqual(await pixel(100, 220), sky, 'the bug is back');

        // Another page is another page: what was kept for this one is dropped. (Handles from
        // before a reload are refused until they have been listed again.)
        await scanline('resources', 'program');

        const once = await scanline('patch_state', '--filter', '{"program": "prg_1"}', '--state', '{"cull": false}', '--keep');

        assert.equal(once.code, 0, once.out);

        const elsewhere = await scanline('navigate', server.url('fixtures/bugs/b00.html'), '--json');

        assert.match(elsewhere.json.summary, /1 kept patch was dropped: this is another page\./);
        assert.match((await scanline('patches')).out, /No patches are in force/);
        assert.match((await scanline('patches', '--again')).out, /No kept patch is waiting/);
    });

    test('a kept patch is in force from the first frame of a replayed run', async () =>
    {
        await scanline('launch', server.url('fixtures/bugs/b01.html'), '--paused', '--headless', '--deterministic');
        await scanline('step', '12');
        await scanline('resources', 'program');

        const crate = [187, 131, 75, 255];
        const run = /(run_\d+)/.exec((await scanline('save_run')).out)?.[1];

        assert.ok(run);

        // The fix is tried on the run that reached the bug: reload, patch, play.
        await scanline('patch_state', '--filter', '{"program": "prg_1"}', '--state', '{"cull": false}', '--keep');

        const replayed = await scanline('replay_run', run, '--json');

        assert.equal(replayed.code, 0, replayed.out);
        assert.match(replayed.json.summary, /Kept patch made again in the new page: pat_\d+ \(draws that use prg_1: cull off\)\./);
        assert.deepEqual(await pixel(100, 220), crate, 'the replayed run ends with the crate drawn');
    });

    test('state, draws, a uniform and a texture are overridden and put back', async () =>
    {
        await open('fixtures/bugs/b01.html');

        const sky = [89, 153, 229, 255];
        const crate = [187, 131, 75, 255];

        assert.deepEqual(await pixel(100, 220), sky, 'the bug: the crate is culled');

        // The fix, tried live: culling off for the draws of that program.
        const culling = await scanline('patch_state', '--filter', '{"program": "prg_1"}', '--state', '{"cull": false}', '--json');

        assert.equal(culling.code, 0, culling.out);
        assert.equal(culling.json.data.patch, 'pat_1');
        assert.equal(culling.json.data.description, 'draws that use prg_1: cull off');

        await scanline('step', '2');
        assert.deepEqual(await pixel(100, 220), crate, 'with culling off the crate is there');

        const listed = await scanline('patches', '--json');

        assert.deepEqual(listed.json.data.patches.map((patch) => [patch.patch, patch.kind, patch.draws]), [['pat_1', 'state', 11]]);
        assert.match(listed.json.summary, /Each line is the change to make in the page's source if it is the fix/);

        await scanline('patches', '--revert', 'pat_1');
        await scanline('step', '2');
        assert.deepEqual(await pixel(100, 220), sky, 'undone, the bug is back');

        // One event left out, numbered as a capture numbers it: the glass panel is event 9.
        const before = await pixel(160, 130);

        await scanline('patch_draws', '--filter', '{"draws": 9}');
        await scanline('step', '2');
        assert.deepEqual(await pixel(160, 130), sky, 'no glass: the sky shows');
        assert.notDeepEqual(before, sky);

        // Only that event, and nothing else that is drawn.
        await scanline('patches', '--revert', 'all');
        await scanline('patch_draws', '--filter', '{"draws": 9}', '--mode', 'isolate');
        await scanline('step', '2');
        assert.deepEqual(await pixel(30, 320), sky, 'the ground is not drawn');
        assert.notDeepEqual(await pixel(160, 130), sky, 'the glass is');
        await scanline('patches', '--revert', 'all');

        // A uniform held, with the texture it multiplies made white.
        const ground = [64, 128, 51, 255];

        await scanline('step', '2');
        assert.deepEqual(await pixel(30, 320), ground);

        await scanline('patch_texture', 'tex_2', '--with', 'white');

        const held = await scanline('patch_uniform', '--target', 'prg_1', '--name', 'tint', '--value', '[1, 0, 0, 1]', '--json');

        assert.equal(held.json.data.description, 'uniform tint of prg_1 held at 1, 0, 0, 1');

        await scanline('step', '3');
        assert.deepEqual(await pixel(30, 320), [255, 0, 0, 255], 'the page sets the tint every frame, and it is set straight back');

        const undone = await scanline('patches', '--revert', 'all');

        assert.match(undone.out, /2 patches undone/);

        await scanline('step', '2');
        assert.deepEqual(await pixel(30, 320), ground, 'the page draws as its own code says again');
        assert.match((await scanline('patches')).out, /No patches are in force/);

        // The frame is right after all that: the state the patches changed was put back each time.
        assert.deepEqual((await scanline('console', '--level', 'error', '--json')).json.data.lines, []);
    });

    test('a shader is edited live, and one that does not compile changes nothing', async () =>
    {
        await open('fixtures/bugs/b00.html');

        const crate = await pixel(100, 220);

        // The sprite shader made to ignore its texture and show its coordinates instead.
        const patched = await scanline('patch_shader', 'prg_1', '--edits', '[{"find": "tint * mix(vec4(1.0), texture(map, uv), textured)", "replace": "vec4(uv, 0.0, 1.0)"}]', '--json');

        assert.equal(patched.code, 0, patched.out);
        assert.match(patched.json.data.description, /^fragment shader of prg_1: «tint \* mix/);
        assert.match(patched.json.summary, /It compiled and linked/);
        assert.match(patched.json.summary, /The page's own program is untouched/);

        await scanline('step', '2');

        // The crate at x 60–140, y 180–260: its texture coordinates run 0 to 1 across it.
        const left = await pixel(64, 220);
        const right = await pixel(136, 220);

        assert.ok(left[0] < 30 && right[0] > 225, `red rises with u: ${left} → ${right}`);
        assert.equal(left[2], 0);
        assert.notDeepEqual(await pixel(100, 220), crate);

        // The sparks use another program and are untouched; the scene still animates through the patched one.
        assert.equal((await scanline('patches', '--json')).json.data.patches[0].draws, 11);

        // Whole frames replay as before once it is undone.
        await scanline('patches', '--revert', 'pat_1');
        await scanline('step', '2');
        assert.deepEqual(await pixel(100, 220), crate);

        // A #define, placed after the version line.
        const defined = await scanline('patch_shader', 'prg_1', '--defines', '{"UNUSED_SWITCH": 1}', '--json');

        assert.match(defined.json.data.description, /#define UNUSED_SWITCH 1/);
        await scanline('step', '1');
        assert.deepEqual(await pixel(100, 220), crate, 'a define nothing reads changes nothing');
        await scanline('patches', '--revert', 'all');

        // Broken source is refused, with the compiler's words, and the page is left alone.
        const broken = await scanline('patch_shader', 'prg_1', '--edits', '[{"find": "colour = ", "replace": "colour = oops + "}]');

        assert.equal(broken.code, 1);
        assert.match(broken.out, /does not compile, so nothing was changed/);
        assert.match(broken.out, /oops/);

        const missing = await scanline('patch_shader', 'prg_1', '--edits', '[{"find": "no such text", "replace": ""}]');

        assert.equal(missing.code, 1);
        assert.match(missing.out, /does not contain «no such text»/);

        await scanline('step', '1');
        assert.deepEqual(await pixel(100, 220), crate);
        assert.match((await scanline('patches')).out, /No patches are in force/);
    });

    test('an experiment measures a change and takes it away again', async () =>
    {
        await open('fixtures/bugs/b00.html');

        const before = await pixel(100, 220);
        const tried = await scanline('experiment', 'scissor_1px', '--frames', '20', '--json');

        assert.equal(tried.code, 0, tried.out);
        assert.match(tried.json.summary, /Tried for 20 frames: every draw clipped to a single pixel/);
        assert.match(tried.json.summary, /The page is back as it was/);
        assert.equal(typeof tried.json.data.cpu_ms.without, 'number');
        assert.match((await scanline('patches')).out, /No patches are in force/);

        await scanline('step', '1');
        assert.deepEqual(await pixel(100, 220), before);

        const skipped = await scanline('experiment', 'skip', '--filter', '{"program": "prg_2"}', '--frames', '20', '--json');

        assert.match(skipped.json.summary, /the matching draws left out \(draws that use prg_2 are not drawn\)/);

        const none = await scanline('experiment', 'skip');

        assert.equal(none.code, 1);
        assert.match(none.out, /needs a filter/);
    });

    test('webgpu: pipelines are rebuilt with the change, and the page\'s own are put back', async () =>
    {
        // The slow scene: a mask (pip_1, pip_2), the scene (pip_3, pip_4) and the light
        // shafts (pip_5), which sample the mask through a bind group made for pip_5 alone.
        await scanline('launch', server.url('fixtures/slow/webgpu.html'), '--paused', '--headless');
        await scanline('step', '4');
        await scanline('resources', 'pipeline');
        await scanline('resources', 'texture');

        // In the sky beside the sun, where the shafts add most; and far from it. The scene drifts a
        // little from frame to frame, so colours are compared loosely.
        const glow = () => pixel(1340, 200);
        const far = () => pixel(300, 300);
        const near = (a, b) => a.every((channel, index) => Math.abs(channel - b[index]) <= 10);
        const [glowBefore, farBefore] = [await glow(), await far()];
        const settle = async () => { await scanline('patches', '--revert', 'all'); await scanline('step', '1'); assert.ok(near(await glow(), glowBefore), 'the page draws as before'); };

        // Leaving the shafts out darkens the glow. Drawing only them loses the scene.
        const skipped = await scanline('patch_draws', '--filter', '{"pipeline": "pip_5"}');

        assert.match(skipped.out, /pat_\d+: draws that use pip_5 are not drawn/);
        await scanline('step', '1');

        const without = await glow();

        assert.ok(without[0] < glowBefore[0] - 15, `without the shafts ${without}, with them ${glowBefore}`);
        assert.match((await scanline('patches')).out, /draws that use pip_5 are not drawn {2}\(1 draw a frame\)/);
        await settle();

        await scanline('patch_draws', '--mode', 'isolate', '--filter', '{"pipeline": "pip_5"}');
        await scanline('step', '1');
        assert.ok(!near(await far(), farBefore), 'only the shafts are drawn');
        await settle();

        // State. The pipeline is rebuilt without blending, so the shafts replace the scene.
        const unblended = await scanline('patch_state', '--state', '{"blend": false}', '--filter', '{"pipeline": "pip_5"}');

        assert.match(unblended.out, /draws that use pip_5: blend off/);
        await scanline('step', '1');
        assert.ok(!near(await far(), farBefore), 'the shafts are no longer added to the scene');
        await settle();

        // A scissor box round every draw: the right half is left as it was cleared.
        await scanline('patch_state', '--state', '{"scissor": [0, 0, 960, 1080]}');
        await scanline('step', '1');
        assert.deepEqual(await glow(), [0, 0, 0, 255]);
        assert.ok(near(await far(), farBefore));
        await settle();

        // A shader module, for every pipeline that uses it: the sun turns green, in the
        // scene and (through the mask) in the shafts.
        const edited = await scanline('patch_shader', 'shd_1', '--edits', '[{"find": "in.top.rgb * glow", "replace": "vec3f(0.0, 1.0, 0.0) * glow"}]');

        assert.match(edited.out, /pat_\d+: shd_1: «in\.top\.rgb \* glow» → «vec3f\(0\.0, 1\.0, 0\.0\) \* glow»/);
        assert.match(edited.out, /It compiled, and the pipelines rebuilt with it are valid/);
        await scanline('step', '1');

        const sun = await pixel(1344, 410);

        assert.ok(sun[1] > sun[0] + 100, `the sun is green: ${sun}`);

        // Stacked on it, a stand-in for the mask the shafts sample, in a bind group
        // remade for the rebuilt pipeline.
        const stood = await scanline('patch_texture', 'tex_1', '--with', 'white');

        assert.match(stood.out, /every draw: tex_1 replaced by a white texture/);
        await scanline('step', '1');
        assert.ok((await far())[0] > farBefore[0] + 60, 'the shafts march through white');

        const listed = await scanline('patches', '--json');

        assert.equal(listed.json.data.patches.length, 2);
        assert.equal(listed.json.data.not_applied, null);
        await settle();

        // An edit that does not compile changes nothing, and says why.
        const broken = await scanline('patch_shader', 'pip_5', '--edits', '[{"find": "SAMPLES: i32 = 64", "replace": "SAMPLES: i32 = oops"}]');

        assert.equal(broken.code, 1);
        assert.match(broken.out, /The edited shader does not compile, so nothing was changed\.\nerror at line \d+: unresolved value 'oops'/);
        assert.match((await scanline('patches')).out, /No patches are in force/);

        // What WebGPU patches do not do is said plainly.
        assert.match((await scanline('patch_uniform', '--target', 'pip_5', '--name', 'sun', '--value', '1')).out, /patch_uniform is for WebGL/);
        assert.match((await scanline('patch_draws', '--filter', '{"draws": [1, 2]}')).out, /On WebGPU a filter names a pipeline/);
        assert.match((await scanline('patch_shader', 'pip_5', '--defines', '{"SAMPLES": 24}')).out, /WGSL has no #define/);
        assert.match((await scanline('patch_state', '--state', '{"cull": true}')).out, /can be switched off here, not on/);

        // No patch left the page with an error of its own making.
        assert.doesNotMatch((await scanline('console', '--level', 'error')).out, /not compatible|is invalid/);
    });
});

describe('the viewer and the activity log', () =>
{
    test('every command is logged, with who ran it, how long it took and what it said', async () =>
    {
        // The host has run every earlier test's commands: start from where the log stands.
        const from = (await scanline('activity', '--json')).json?.data.next ?? 0;

        await scanline('launch', server.url('fixtures/bugs/b00.html'), '--paused', '--headless');
        await scanline('step', '3');
        await scanline('pixels', '9999', '1');

        const log = await scanline('activity', '--since', String(from), '--json');
        const rows = log.json.data.activity;

        assert.deepEqual(rows.map((row) => [row.command, row.ok, row.by]), [['launch', true, 'agent'], ['step', true, 'agent'], ['pixels', false, 'agent']]);
        assert.equal(rows[1].arguments, '{"frames":3}');
        assert.match(rows[1].result, /^Frame 3 \(stepped 3\)\. Paused\./);
        assert.match(rows[2].result, /That point is outside ctx_1/);
        assert.ok(rows.every((row) => typeof row.ms === 'number' && row.at > 1.7e12));
        assert.match(log.json.summary, /\[\d+\] pixels \{"x":9999,"y":1\} {2}FAILED/);

        // Asking again from where it left off gives only what is new, and the log does not log itself.
        await scanline('status');

        const more = await scanline('activity', '--since', log.json.data.next, '--json');

        assert.deepEqual(more.json.data.activity.map((row) => row.command), ['status']);
    });

    test('the viewer shows the log, live figures and a capture, through the control API alone', async () =>
    {
        await scanline('launch', server.url('fixtures/adapters/three.html'), '--paused', '--headless');
        await scanline('step', '5');

        const capture = /^(cap_\d+):/m.exec((await scanline('capture')).out)?.[1];
        const opened = await scanline('viewer', '--show', 'activity', '--json');

        assert.equal(opened.code, 0, opened.out);
        assert.match(opened.json.summary, /The viewer is open in a window of this session's browser/);
        assert.equal(opened.json.data.showing.tab, 'activity');
        assert.ok(opened.json.data.showing.rows >= 3, 'launch, step and capture are listed');

        // Live: figures for the frames that ran.
        const live = await scanline('viewer', '--show', 'live', '--json');

        assert.ok(live.json.data.showing.samples >= 2);
        assert.match(live.json.data.showing.status, /^ses_\d+ · paused at frame 6$/);

        // A capture: its events, and the target as it stood after one of them.
        const looked = await scanline('viewer', '--show', 'capture', '--capture', capture, '--draw', '9', '--output', 'true', '--json');
        const showing = looked.json.data.showing;

        assert.equal(showing.capture, capture);
        assert.equal(showing.events, 15);
        assert.equal(showing.draw, 9);
        assert.equal(showing.picture, true);
        assert.deepEqual(showing.size, [480, 320]);
        assert.match(showing.state, /event 9: drawElements to canvas/);
        assert.match(showing.state, /Object: Mesh «Crate»/);
        assert.ok(showing.shaders > 0);
        assert.deepEqual(readFileSync(looked.json.images[0].view).subarray(0, 4), PNG);

        // What the person does in the viewer is in the log as theirs. Its own upkeep is not.
        const log = (await scanline('activity', '--limit', '200', '--json')).json.data.activity;
        const theirs = log.filter((row) => row.by === 'person');

        assert.ok(theirs.some((row) => row.command === 'screenshot' && row.arguments.includes('"at_draw":9')), 'choosing an event is the person looking at it');
        assert.ok(!log.some((row) => row.by === 'viewer'));
        assert.ok(!log.some((row) => row.command === 'stats' || row.command === 'memory'), 'the graphs\' polling is not logged');

        assert.match((await scanline('viewer', '--show', 'nonsense')).out, /The viewer has three tabs: activity, live and capture/);
    });
});

describe('a gamepad', () =>
{
    const game = async () => JSON.parse((await scanline('eval', 'JSON.stringify(game)', '--json')).json.data.value);

    test('a virtual pad is plugged in, held, let go and unplugged, and a run with it replays', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/game.html'), '--paused', '--headless', '--deterministic');
        await scanline('step', '5');

        const before = await game();

        assert.equal(before.pads, 0);

        // The left stick full right and half down, and the bottom face button held.
        const sent = await scanline('input', '--events', '[{"gamepad": 0, "axes": [1, 0.5], "buttons": {"0": true}}]');

        assert.equal(sent.code, 0, sent.out);
        await scanline('step', '30');

        const held = await game();

        assert.equal(held.pads, 1, 'the page was told a gamepad was connected');
        assert.equal(held.padName, 'Scanline Virtual Gamepad (STANDARD GAMEPAD)');
        assert.equal(held.padHeld, 30, 'the button is held on every frame');
        assert.ok(Math.abs(held.x - (before.x + 45)) < 1e-6, 'thirty frames at 90 pixels a second');
        assert.ok(Math.abs(held.y - (before.y + 22.5)) < 1e-6);

        // What the page is handed looks like the browser's own.
        const shape = await scanline('eval', 'JSON.stringify((() => { const pad = navigator.getGamepads()[0]; return [pad instanceof Gamepad, pad.buttons[0] instanceof GamepadButton, pad.mapping, pad.buttons.length, pad.axes.length, pad.buttons[0].value, navigator.getGamepads.name, Function.prototype.toString.call(navigator.getGamepads)]; })())', '--json');

        assert.deepEqual(JSON.parse(shape.json.data.value), [true, true, 'standard', 17, 4, 1, 'getGamepads', 'function getGamepads() { [native code] }']);

        // Letting go stops it; unplugging tells the page.
        await scanline('input', '--events', '[{"gamepad": 0, "buttons": {"0": false}, "axes": [0, 0]}]');
        await scanline('step', '10');
        await scanline('input', '--events', '[{"gamepad": 0, "connected": false}]');
        await scanline('step', '2');

        const after = await game();

        assert.equal(after.pads, 0);
        assert.equal(after.padHeld, 30);
        assert.equal(after.x, held.x);

        // The pad's states are in the run, and played again on the same frames.
        const saved = await scanline('save_run');
        const run = /^(run_\d+):/.exec(saved.out)?.[1];

        assert.match(saved.out, /with 3 gamepad changes\./);

        const replayed = await scanline('replay_run', run);

        assert.match(replayed.out, /All \d+ fingerprints along the way match the original/);

        const again = await game();

        assert.deepEqual([again.x, again.y, again.padHeld, again.pads], [after.x, after.y, after.padHeld, after.pads]);

        // It is one of the changes a page could observe, and says so.
        assert.match((await scanline('status')).out, /navigator\.getGamepads is wrapped/);
        assert.match((await scanline('input', '--events', '[{"gamepad": 9}]')).out, /A gamepad's index is 0 to 3/);
    });
});

describe('playing by rule, and by mouse-look', () =>
{
    test('a policy reads the page each frame and answers with input, until it says stop', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/game.html'), '--paused', '--headless', '--deterministic');

        // Hold Right until the square is past x = 100, then let go and stop. Log every 20th frame.
        const played = await scanline('policy', "(s, info) => ({ keys_down: game.x < 100 ? ['ArrowRight'] : [], stop: game.x >= 100, log: info.frame % 20 === 0 ? Math.round(game.x) : undefined })", '--frames', '200', '--json');

        assert.equal(played.code, 0, played.out);
        assert.match(played.json.summary, /^Ran the policy for 41 frames, to frame 41: the policy returned stop\. No events sent; no keys held at the end\./);
        assert.deepEqual(played.json.data.log, [{ frame: 0, value: 40 }, { frame: 20, value: 69 }, { frame: 40, value: 99 }]);

        const x = (await scanline('eval', 'game.x', '--json')).json.data.value;

        assert.ok(x >= 100 && x < 102, `the square stopped just past 100: ${x}`);

        // The policy's own memory lasts from frame to frame, and events are real input.
        const clicked = await scanline('policy', '(s, info) => { info.memory.n = (info.memory.n ?? 0) + 1; return { events: info.memory.n === 3 ? [{ pointer: "down", x: 50, y: 50 }, { pointer: "up", x: 50, y: 50 }] : [], stop: info.memory.n > 5 }; }', '--json');

        assert.equal(clicked.json.data.events_sent, 2);
        assert.equal((await scanline('eval', 'game.clicks', '--json')).json.data.value, 1);

        // With the page protocol, the state the page provides is the first argument.
        await scanline('navigate', server.url('fixtures/protocol/webgl2.html'));

        const read = await scanline('policy', 's => ({ log: s.season, stop: true })', '--json');

        assert.deepEqual(read.json.data.log.map((entry) => entry.value), ['summer']);
        assert.match(read.json.summary, /Page state \(its own words\)/);

        // A policy that is not a function, or that throws, says so.
        assert.match((await scanline('policy', '42')).out, /The policy is not a function/);
        assert.match((await scanline('policy', '() => { throw new Error("no"); }')).out, /The policy threw at frame .*: no\./);
        assert.match((await scanline('policy')).out, /policy needs source/);
    });

    test('with the pointer-lock shim, a page that turns by how far the mouse moves can be driven', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/mouselook.html'), '--paused', '--headless', '--pointer_lock', 'shim');
        await scanline('step', '2');

        const game = async () => JSON.parse((await scanline('eval', 'JSON.stringify(game)', '--json')).json.data.value);

        // Before the page has asked for the lock there is nothing to move.
        assert.match((await scanline('input', '--events', '[{"pointer": "move", "dx": 10, "dy": 0}]')).out, /The page does not have the pointer locked/);

        // A click: the page asks for the lock and is given it.
        await scanline('input', '--events', '[{"pointer": "down", "x": 100, "y": 100}, {"pointer": "up", "x": 100, "y": 100}]');
        await scanline('step', '1');
        assert.deepEqual(await game(), { yaw: 160, pitch: 0, locked: true, moves: 0, changes: 1 });

        // Two relative moves turn the view by their sum.
        await scanline('input', '--events', '[{"pointer": "move", "dx": 40, "dy": -5}, {"pointer": "move", "dx": 10, "dy": 0}]');
        await scanline('step', '1');
        assert.deepEqual(await game(), { yaw: 210, pitch: -5, locked: true, moves: 2, changes: 1 });
        assert.deepEqual((await scanline('pixels', '210', '100', '--json')).json.data.rgba8, [255, 255, 255, 255], 'the bar is drawn where the view now points');

        // The page gives the lock up itself.
        await scanline('input', '--events', '[{"key": "Escape", "press": true}]');
        await scanline('step', '1');
        assert.equal((await game()).locked, false);

        // It is a change the page could observe, and is listed.
        assert.match((await scanline('status')).out, /requestPointerLock is granted by the debugger without a gesture/);
    });

    test('without the shim a relative move is refused, with the reason', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/mouselook.html'), '--paused', '--headless');

        const refused = await scanline('input', '--events', '[{"pointer": "move", "dx": 10, "dy": 0}]');

        assert.equal(refused.code, 1);
        assert.match(refused.out, /A relative move \(dx, dy\) needs the pointer-lock shim: launch with pointer_lock: "shim"/);
        assert.doesNotMatch((await scanline('status')).out, /requestPointerLock is granted/);
    });
});

describe('capture triggers', () =>
{
    test('a frame is captured when the page marks an event, raises an error or runs long, with the frames before it', async () =>
    {
        await scanline('launch', server.url('fixtures/protocol/webgl2.html'), '--paused', '--headless');
        await scanline('step', '3');

        // A mark the page makes once a second of its own time.
        const marked = await scanline('capture', '--when', '{"mark": "second passed"}', '--json');

        assert.equal(marked.code, 0, marked.out);
        assert.match(marked.json.summary, /^Stopped at frame 62: the page raised "second passed"\. Paused\.\nTriggered at frame 62\. The page is frozen\. cap_\d+ is that frame; rec_\d+ holds the 59 frames up to it \(4–62\)\./);
        assert.equal(marked.json.data.met, true);
        assert.equal(marked.json.data.frames, 59);
        assert.match(marked.json.summary, /Replay check: replaying the capture gives an image identical/);

        // An error, thrown from a timer some frames from now.
        await scanline('eval', 'setTimeout(() => { throw new Error("boom"); }, 400); 1');

        const failed = await scanline('capture', '--when', '{"error": true}', '--flight_frames', '10', '--json');

        assert.match(failed.json.summary, /^Stopped at frame \d+: an error was raised\. Paused\.\nTriggered at frame \d+/);
        assert.ok(failed.json.data.frames >= 10 && failed.json.data.frames <= 40, 'the recorder keeps whole runs of 30, so between 10 and 40');

        // A frame that takes far longer than the rest.
        await scanline('eval', 'window.n = 0; const tick = () => { if (++window.n === 12) { let x = 0; for (let i = 0; i < 4e8; i++) { x += i; } } requestAnimationFrame(tick); }; requestAnimationFrame(tick); 1');

        const slow = await scanline('capture', '--when', '{"frame_ms_over": 60}', '--json');

        assert.match(slow.json.summary, /^Stopped at frame \d+: frame \d+ took [\d.]+ ms of CPU time \(over 60\)\. Paused\.\nTriggered at frame/);

        // The agent's ownership of the input is not disturbed, and each capture is announced.
        const events = await scanline('events', '--json');

        assert.equal(events.json.data.events.filter((event) => event.kind === 'capture_ready').length, 3);
        assert.equal(events.json.data.events.filter((event) => event.kind === 'debug_pressed').length, 0);

        // A condition that is never met captures nothing, and says so.
        const never = await scanline('capture', '--when', '{"mark": "never"}', '--timeout_s', '1', '--json');

        assert.equal(never.json.data.met, false);
        assert.match(never.json.summary, /^Nothing was captured: the condition was not met\./);
        assert.match((await scanline('record', 'status')).out + (await scanline('status')).out, /Paused|paused/);
        assert.match((await scanline('capture', '--when', '{"nonsense": 1}')).out, /capture\(when\) takes one of/);
    });
});

describe('a browser trace', () =>
{
    test('a window of frames is traced: the GPU process\'s time, and the whole trace on disk', async () =>
    {
        await scanline('launch', server.url('fixtures/matrix/webgl2.html'), '--paused', '--headless');
        await scanline('step', '3');

        const traced = await scanline('trace', '--frames', '12', '--json');

        assert.equal(traced.code, 0, traced.out);
        assert.match(traced.json.summary, /Browser trace over 12 frames \(frames 4–15\): \d+ events from \d+ processes/);
        assert.match(traced.json.summary, /The GPU process's main thread was busy for [\d.]+ ms, [\d.]+ ms a frame/);
        assert.match(traced.json.summary, /GPU Process \/ CrGpuMain/);
        assert.ok(traced.json.data.gpu_main_thread_ms > 0);
        assert.ok(traced.json.data.gpu_process_slices.some((slice) => /CommandBuffer|GpuChannel|WebGL/.test(slice.name)), 'the GPU process is seen running the page\'s commands');

        // The page went on by exactly the frames asked for, and is paused.
        assert.match((await scanline('status')).out, /frame 15/i);

        // The file is a trace other tools open.
        const whole = JSON.parse(readFileSync(traced.json.data.path, 'utf8'));

        assert.equal(whole.traceEvents.length, traced.json.data.events);
        assert.ok(whole.traceEvents.some((event) => event.ph === 'X' && typeof event.dur === 'number'));
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
        const run = saved.json.data.run;

        assert.match(run, /^run_\d+$/);
        assert.equal(saved.json.data.frames, 180);
        assert.equal(saved.json.data.prints, 6);
        assert.match(saved.json.summary, /run_\d+: the 180 frames since .*game\.html loaded, with 2 key presses, 2 clicks\./);

        const replayed = await scanline('replay_run', run, '--json');

        assert.equal(replayed.code, 0, replayed.out);
        assert.equal(replayed.json.data.frame, 180);
        assert.equal(replayed.json.data.diverged, null);
        assert.equal(replayed.json.data.matched, 6);
        assert.match(replayed.json.summary, /All 6 fingerprints along the way match the original/);
        assert.equal((await scanline('eval', state)).out, before, 'every number the game holds is the same, to the last bit');

        // Going back: the same run, stopped early.
        const earlier = await scanline('replay_run', run, '--to-frame', '75', '--json');

        assert.equal(earlier.json.data.frame, 75);
        assert.match(earlier.json.summary, /Replayed run_\d+ to frame 75 of 180\. Paused\./);
        assert.match((await scanline('eval', 'JSON.stringify([game.frame, game.clicks])')).out, /\[75,1\]/);

        // A replayed session can be saved again: it received the same input.
        await scanline('replay_run', run);

        const again = await scanline('save_run', '--json');

        assert.equal(again.json.data.events, saved.json.data.events);
    });

    test('what the page fetched while it ran is kept, and given again on the same frames', async () =>
    {
        // The page asks the server for a number on frames 20 and 50. The server gives a
        // different one every time, 40 ms later, and the page draws by what it was given.
        await scanline('launch', server.url('fixtures/matrix/loader.html'), '--headless', '--deterministic');

        const ran = await scanline('run_until', '--until', '{"frame": 90}');

        assert.match(ran.out, /Stopped at frame 90: reached frame 90/, 'holding the page for a response does not end a run_until');

        const game = async () => JSON.parse((await scanline('eval', 'JSON.stringify(game)', '--json')).json.data.value);
        const original = await game();

        assert.equal(original.loaded.length, 2);
        assert.equal(original.loaded[1], original.loaded[0] + 1);

        const saved = await scanline('save_run');
        const run = /^(run_\d+):/.exec(saved.out)?.[1];

        assert.match(saved.out, /[34] network responses kept with the frame each arrived on/);

        // Twice over: the server has moved on, the replay has not.
        for (let round = 0; round < 2; round++)
        {
            const replayed = await scanline('replay_run', run, '--json');

            assert.equal(replayed.json.data.diverged, null, replayed.json.summary);
            assert.equal(replayed.json.data.matched, 3);
            assert.equal(replayed.json.data.network.missed, 0);
            assert.ok(replayed.json.data.network.used >= 3, replayed.json.summary);
            assert.deepEqual(await game(), original, 'the same numbers, arriving on the same frames, and the same picture since');
        }

        // Played on, the page fetches nothing more and stays in step with itself.
        await scanline('step', '10');
        assert.equal((await game()).loaded.length, 2);

        // A session that is not deterministic keeps nothing, and its network is its own.
        await scanline('close');
        await scanline('launch', server.url('fixtures/matrix/loader.html'), '--headless', '--paused');
        await scanline('step', '60');
        assert.doesNotMatch((await scanline('save_run')).out, /network response/);
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

describe('an engine Scanline has no adapter for', () =>
{
    test('Babylon.js is launched, captured and replayed to the same picture, on WebGL 2 and WebGPU', async () =>
    {
        for (const [query, api, note] of [
            // Its shadow map's depth is a texture, which is not read back: the replay gives it storage and the frame fills it.
            ['', 'webgl2', /DEPTH_COMPONENT32F texture's contents could not be captured/],
            // It makes each frame's command encoder at the end of the frame before.
            ['?engine=webgpu', 'webgpu', /used a command encoder that was made before it began/]
        ])
        {
            const launched = await scanline('launch', server.url(`fixtures/engines/babylon-shadows.html${query}`), '--paused', '--headless', '--json');

            assert.equal(launched.code, 0, launched.out);

            const session = launched.json.data.session;

            await scanline('step', '20', '--session', session);

            const errors = await scanline('console', '--level', 'error', '--session', session);

            assert.match(errors.out, /No error console lines/, `${api}: ${errors.out}`);

            const taken = await scanline('capture', '--session', session, '--json');

            assert.equal(taken.code, 0, `${api}: ${taken.out}`);
            assert.equal(taken.json.data.api, api);
            assert.equal(taken.json.data.replay, 'identical', `${api}: ${taken.json.summary}`);
            assert.equal(taken.json.data.counts.draws, 8, `${api}: three shadow casters, then the ground, three boxes and the ball`);
            assert.match(taken.json.summary, note, api);
            assert.doesNotMatch(taken.json.summary, /raised a (GL|validation) error/, api);

            // The shadow pass and the scene are both there to be read.
            const passes = await scanline('pass_tree', taken.json.data.capture, '--session', session);

            assert.equal(passes.code, 0, passes.out);

            await scanline('close', '--session', session);
        }
    });
});

describe('the flight recorder and what the page throws away', () =>
{
    for (const [api, query] of [['WebGL 2', ''], ['WebGPU', '?api=webgpu']])
    {
        test(`${api}: frames before a texture and a buffer were deleted replay with them, and frames after with what replaced them`, async () =>
        {
            const launched = await scanline('launch', server.url(`fixtures/history/deleted.html${query}`), '--paused', '--headless', '--json');
            const session = launched.json.data.session;

            await scanline('step', '5', '--session', session);

            // The page swaps its texture and its vertex buffer at frame 20: inside the frames kept.
            const taken = await scanline('capture', '--when', '{"frames": 30}', '--flight_frames', '40', '--session', session, '--json');

            assert.equal(taken.code, 0, taken.out);
            assert.match(taken.json.summary, /Replay check: replaying the capture gives an image identical to the frame's own/);
            assert.doesNotMatch(taken.json.summary, /raised a (GL|validation) error|could not be (read|captured)/);

            const recording = /(rec_\d+)/.exec(taken.json.summary)[1];
            const at = async (frame, x, y) =>
            {
                const made = await scanline('capture', '--recording', recording, '--frame', String(frame), '--session', session, '--json');

                assert.equal(made.code, 0, made.out);
                assert.doesNotMatch(made.json.summary, /raised a (GL|validation) error|could not be (read|captured)/, `frame ${frame}`);

                const capture = /^(cap_\d+):/m.exec(made.json.summary)[1];

                return (await scanline('pixels', String(x), String(y), '--capture', capture, '--session', session, '--json')).json.data.rgba8;
            };

            const orange = [255, 128, 0, 255];
            const blue = [0, 128, 255, 255];
            const empty = [26, 26, 26, 255];

            // Before the swap: the square the page has since deleted, where it was.
            assert.deepEqual(await at(10, 40, 60), orange);
            assert.deepEqual(await at(10, 120, 60), empty);
            assert.deepEqual(await at(19, 40, 60), orange);

            // From the swap on: the one made during the recording, from the calls recorded.
            assert.deepEqual(await at(20, 120, 60), blue);
            assert.deepEqual(await at(30, 40, 60), empty);
            assert.deepEqual(await at(30, 120, 60), blue);

            // Reading the old ones before they went raised nothing the page could see.
            assert.match((await scanline('console', '--level', 'error', '--session', session)).out, /No error console lines/);

            await scanline('close', '--session', session);
        });
    }
});
