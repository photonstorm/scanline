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
import { after, before, describe, test } from 'node:test';
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
