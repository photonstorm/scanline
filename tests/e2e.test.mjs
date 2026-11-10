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
