// The analysis of a WebGPU capture that has to draw the frame differently: who owns a
// pixel, overdraw, outlines, the history of a pixel, why a draw changed nothing, what a
// vertex shader made of its vertices, GPU time by draw, and uniforms by name.
//
//   npm run build && cargo build && npm run test:webgpu
//
// fixtures/history/analysis-webgpu.html is a frame whose every answer can be worked out
// by hand; the numbers here are the ones its header gives. Its events are:
//
//   0–3  the «hdr» pass: a clear and three draws to a float texture
//   4    the scene pass's clear
//   5    A, indexed, drawn           6  B, behind A where they overlap
//   7    C, culled                   8  D, textured, discards its top half
//   9    E, outside the scissor box

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { repoRoot, serve } from '../spikes/lib/serve.mjs';

const binary = join(repoRoot, 'target', 'debug', 'scanline');
const home = mkdtempSync(join(tmpdir(), 'scanline-webgpu-'));
const env = { ...process.env, SCANLINE_HOME: home };

let server;

function scanline (...args)
{
    return new Promise((resolve) =>
    {
        execFile(binary, args.map(String), { env, timeout: 90000, maxBuffer: 16 << 20 }, (error, stdout, stderr) =>
        {
            let json = null;

            if (args.includes('--json'))
            {
                try { json = JSON.parse(stdout); } catch { /* an error message, not JSON */ }
            }

            resolve({ code: error ? error.code ?? 1 : 0, out: (stdout + stderr).trim(), json });
        });
    });
}

// Opens a fixture, runs it a few frames and captures one.
async function captured (path)
{
    const launched = await scanline('launch', server.url(path), '--headless', '--paused');
    const session = /Launched (ses_\d+)/.exec(launched.out)?.[1];

    assert.ok(session, launched.out);

    await scanline('step', 3, '--session', session);

    const taken = await scanline('capture', '--session', session);
    const capture = /^(cap_\d+):/m.exec(taken.out)?.[1];

    assert.ok(capture, taken.out);
    assert.match(taken.out, /Replay check: replaying the capture gives an image identical/);

    return { session, capture, summary: taken.out };
}

// The pixels of a PNG the host wrote: 8-bit RGBA, not interlaced.
function pixelsOf (path)
{
    const file = readFileSync(path);
    const width = file.readUInt32BE(16);
    const height = file.readUInt32BE(20);
    const chunks = [];

    for (let at = 8; at < file.length;)
    {
        const length = file.readUInt32BE(at);

        if (file.toString('latin1', at + 4, at + 8) === 'IDAT')
        {
            chunks.push(file.subarray(at + 8, at + 8 + length));
        }

        at += 12 + length;
    }

    const channels = file[25] === 6 ? 4 : 3;
    const raw = inflateSync(Buffer.concat(chunks));
    const stride = width * channels;
    const out = Buffer.alloc(width * height * channels);

    for (let y = 0; y < height; y++)
    {
        const filter = raw[y * (stride + 1)];
        const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));

        for (let x = 0; x < stride; x++)
        {
            const left = x >= channels ? out[y * stride + x - channels] : 0;
            const up = y > 0 ? out[(y - 1) * stride + x] : 0;
            const corner = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
            const guess = left + up - corner;
            const paeth = Math.abs(guess - left) <= Math.abs(guess - up) && Math.abs(guess - left) <= Math.abs(guess - corner) ? left : (Math.abs(guess - up) <= Math.abs(guess - corner) ? up : corner);

            out[y * stride + x] = (row[x] + [0, left, up, (left + up) >> 1, paeth][filter]) & 255;
        }
    }

    return { width, height, at: (x, y) => [...out.subarray((y * width + x) * channels, (y * width + x) * channels + 3)] };
}

// Positions to four places: the shader's arithmetic is in 32-bit floats.
const rounded = (positions) => positions.map((position) => position.map((part) => Math.round(part * 1e4) / 1e4 + 0));

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

afterEach(async () =>
{
    if (!existsSync(join(home, 'control.sock')))
    {
        return;
    }

    for (const [, session] of (await scanline('sessions')).out.matchAll(/\b(ses_\d+)\b/g))
    {
        await scanline('close', '--session', session);
    }
});

describe('views of a WebGPU capture', () =>
{
    for (const [name, path] of [['', 'fixtures/history/analysis-webgpu.html'], [', multisampled', 'fixtures/history/analysis-webgpu.html?msaa=4']])
    {
        test(`draw_id says which draw owns each pixel${name}`, async () =>
        {
            const { session, capture } = await captured(path);
            const owners = await scanline('view', capture, 'draw_id', '--session', session, '--json');

            assert.equal(owners.code, 0, owners.out);

            // D owns only the rows its shader did not discard: the page's own fragments decide.
            assert.deepEqual(owners.json.data.owners, [
                { draw: 5, pixels: 9600, box: { x: 0, y: 0, w: 80, h: 120 } },
                { draw: 6, pixels: 4800, box: { x: 80, y: 0, w: 40, h: 120 } },
                { draw: 8, pixels: 2400, box: { x: 120, y: 60, w: 40, h: 60 } }
            ]);
            assert.equal(owners.json.data.no_draw_pixels, 2400);
            assert.deepEqual(owners.json.data.hidden, ['7', '9'], 'the culled draw and the one outside the scissor box own nothing');
        });
    }

    test('draw_id works on a float target drawn by a pipeline with layout auto', async () =>
    {
        const { session, capture } = await captured('fixtures/history/analysis-webgpu.html');
        const owners = await scanline('view', capture, 'draw_id', '--target', 'tex_2', '--session', session, '--json');

        assert.equal(owners.code, 0, owners.out);

        // H0 covers all 4,096 px; H1 then takes 256 of them and H2 another 64.
        assert.deepEqual(owners.json.data.owners.map((owner) => [owner.draw, owner.pixels]), [[1, 3776], [2, 256], [3, 64]]);
    });

    test('overdraw counts every fragment, and those that passed the depth test', async () =>
    {
        const { session, capture } = await captured('fixtures/history/analysis-webgpu.html');
        const over = await scanline('view', capture, 'overdraw', '--session', session, '--json');

        assert.equal(over.code, 0, over.out);

        // A 9,600 + B 9,600 + D 2,400 fragments over 19,200 px; A and B overlap on 4,800.
        assert.equal(over.json.data.all.mean, 1.125);
        assert.equal(over.json.data.all.max, 2);
        assert.equal(over.json.data.all.twice_or_more, 25);
        assert.deepEqual(over.json.data.all.worst, { x: 40, y: 0, w: 40, h: 120 });

        // B fails the depth test behind A, so 4,800 of its fragments are not counted.
        assert.equal(over.json.data.visible.mean, 0.875);
        assert.equal(over.json.data.visible.max, 1);
    });

    test('wireframe draws each triangle as its three edges', async () =>
    {
        const { session, capture } = await captured('fixtures/history/analysis-webgpu.html');
        const wire = await scanline('view', capture, 'wireframe', '--session', session, '--json');

        assert.equal(wire.code, 0, wire.out);

        const picture = pixelsOf(wire.json.images[0].view);

        assert.deepEqual([picture.width, picture.height], [160, 120]);

        // Inside A, away from its edges and its diagonal, the clear colour shows through;
        // on the diagonal (from the top-left of A to its bottom-right) A's own colour is drawn.
        assert.deepEqual(picture.at(20, 90), [26, 26, 26]);
        assert.deepEqual(picture.at(70, 20), [26, 26, 26]);

        const red = [0, 1, 2, 3].some((dx) => picture.at(38 + dx, 60).join() === '204,51,51');

        assert.ok(red, 'the diagonal of A crosses row 60 near x 40');

        let drawn = 0;

        for (let y = 0; y < 120; y++)
        {
            for (let x = 0; x < 160; x++)
            {
                drawn += picture.at(x, y).join() === '26,26,26' ? 0 : 1;
            }
        }

        assert.ok(drawn > 200 && drawn < 2500, `${drawn} px are drawn: lines, not filled quads (which would be 16,800)`);
    });

    test('nan finds the pixels of a float target that hold no number', async () =>
    {
        const { session, capture } = await captured('fixtures/history/analysis-webgpu.html');
        const found = await scanline('view', capture, 'nan', '--target', 'tex_2', '--session', session, '--json');

        assert.equal(found.code, 0, found.out);
        assert.equal(found.json.data.nan, 256);
        assert.equal(found.json.data.infinite, 64);
        assert.equal(found.json.data.pixels, 4096);

        // Before H1 drew, there were none.
        const early = await scanline('view', capture, 'nan', '--target', 'tex_2', '--at_draw', 1, '--session', session, '--json');

        assert.equal(early.json.data.nan, 0);

        const canvas = await scanline('view', capture, 'nan', '--session', session);

        assert.match(canvas.out, /holds 8-bit values, which cannot be NaN/);
    });

    test('mip shows which level each pixel sampled', async () =>
    {
        const { session, capture } = await captured('fixtures/history/analysis-webgpu.html');
        const mip = await scanline('view', capture, 'mip', '--session', session, '--json');

        assert.equal(mip.code, 0, mip.out);
        assert.deepEqual(mip.json.data.textures, ['tex_1']);

        // D samples level 2 for every pixel it keeps.
        assert.deepEqual(mip.json.data.levels, [{ level: 2, pixels: 2400 }]);
    });
});

describe('the history of a pixel of a WebGPU capture', () =>
{
    for (const [name, path] of [['', 'fixtures/history/analysis-webgpu.html'], [', multisampled', 'fixtures/history/analysis-webgpu.html?msaa=4']])
    {
        test(`says which test turned each draw away${name}`, async () =>
        {
            const { session, capture } = await captured(path);
            const history = async (x, y) => (await scanline('pixel_history', capture, x, y, '--session', session, '--json')).json;

            // Under A, with B behind it.
            const middle = await history(60, 60);

            assert.deepEqual(middle.data.history.map((row) => [row.draw, row.changed]), [[4, true], [5, true], [6, false]]);
            assert.deepEqual(middle.data.history[1].after, [204, 51, 51, 255]);
            assert.deepEqual(middle.data.history[2].passes, { scissor: true, cull: true, depth: false, stencil: null });
            assert.match(middle.summary, /event {4}6 {2}REJECTED: it fails the depth test \(less\)/);
            assert.equal(middle.data.not_reaching, 3);

            // Where C is culled and D's shader discards.
            const corner = await history(140, 30);

            assert.match(corner.summary, /event {4}7 {2}REJECTED: its triangle is culled \(cull back, front face ccw\)/);
            assert.match(corner.summary, /event {4}8 {2}REJECTED: its fragment shader discarded it/);
            assert.equal(corner.data.discarded, 1);
            assert.match(corner.summary, /Its final value \(26, 26, 26, 255\) was produced by event 4/);

            // Where E would draw, were it not for the scissor box.
            const top = await history(20, 10);

            assert.match(top.summary, /event {4}9 {2}REJECTED: it is outside the scissor box \(100, 0, 20, 20\)/);
        });
    }

    test('follows a float target, and refuses a pixel outside it', async () =>
    {
        const { session, capture } = await captured('fixtures/history/analysis-webgpu.html');
        const history = await scanline('pixel_history', capture, 4, 4, '--target', 'tex_2', '--session', session, '--json');

        assert.equal(history.code, 0, history.out);
        // H2 covers the pixel too (it is one triangle over everything) and its scissor box keeps it out.
        assert.deepEqual(history.json.data.history.map((row) => [row.draw, row.changed]), [[0, true], [1, true], [2, true], [3, false]]);
        assert.deepEqual(history.json.data.history[1].after, [0.5, 0.25, 0, 1]);
        assert.ok(history.json.data.history[2].after.every((channel) => channel === null), 'NaN has no JSON: it arrives as null');
        assert.equal(history.json.data.history[3].passes.scissor, false);

        const outside = await scanline('pixel_history', capture, 70, 4, '--target', 'tex_2', '--session', session);

        assert.equal(outside.code, 1);
        assert.match(outside.out, /is outside the target, which is 64×64/);
    });
});

describe('one draw of a WebGPU capture', () =>
{
    test('draw names what the bind groups hold and says which test rejected it', async () =>
    {
        const { session, capture } = await captured('fixtures/history/analysis-webgpu.html');

        // C: every triangle is culled.
        const culled = await scanline('draw', capture, 7, '--session', session, '--json');

        assert.equal(culled.code, 0, culled.out);
        assert.match(culled.json.summary, /Why: With face culling off it changes 2400 pixels: every triangle is culled \(cull back, front face ccw\)/);
        assert.match(culled.json.summary, /group 0 binding 0: «tint» Tint \(uniform buffer\), in buf_\d+/);
        assert.match(culled.json.summary, /tint\.colour \(vec4f\) = 0\.2, 0\.8, 0\.2, 1/);
        assert.match(culled.json.summary, /tint\.rect \(vec4f\) = 120, 0, 160, 60/);
        assert.match(culled.json.summary, /tint\.depth \(f32\) = 0\.5/);
        assert.deepEqual(culled.json.data.bindings.buffers[0].values.map((value) => value.name), ['tint.colour', 'tint.rect', 'tint.depth']);

        // E: outside the scissor box.
        const clipped = await scanline('draw', capture, 9, '--session', session);

        assert.match(clipped.out, /Why: With the scissor test off it changes 1200 pixels: it falls outside the scissor box \(100, 0, 20, 20\)/);

        // D: a pipeline with layout auto, with a texture and a sampler beside its buffer.
        const textured = await scanline('draw', capture, 8, '--session', session);

        assert.match(textured.out, /group 0 binding 1: «checks» texture_2d<f32>/);
        assert.match(textured.out, /group 0 binding 2: «nearest» sampler/);
        assert.match(textured.out, /tint\.rect \(vec4f\) = 120, 0, 160, 120/);
    });

    test('geometry reads what the vertex shader made of the vertices', async () =>
    {
        const { session, capture } = await captured('fixtures/history/analysis-webgpu.html');

        // A: indexed, wound counter-clockwise.
        const drawn = await scanline('geometry', capture, 5, '--session', session, '--json');

        assert.equal(drawn.code, 0, drawn.out);

        const a = drawn.json.data.geometry;

        assert.deepEqual(a.indices, { first: [0, 3, 2, 0, 2, 1], lowest: 0, highest: 3 });
        assert.equal(a.attributes[0].name, 'corner');
        assert.deepEqual(a.attributes[0].values, [[0, 0], [0, 1], [1, 1], [0, 0], [1, 1], [1, 0]]);
        assert.deepEqual(rounded(a.output.first.slice(0, 3)), [[-1, 1, 0.25, 1], [-1, -1, 0.25, 1], [0, -1, 0.25, 1]]);
        assert.deepEqual([a.output.total, a.output.reach, a.output.front, a.output.back], [2, 2, 2, 0]);
        assert.match(drawn.json.summary, /In the viewport \(0, 0, 160, 120\) that is about 80×120 pixels, from x 0, y 0 up from the bottom/);

        // C: six vertices from the fourth on, wound clockwise, so both triangles face away.
        const culled = await scanline('geometry', capture, 7, '--session', session, '--json');
        const c = culled.json.data.geometry;

        assert.equal(c.first, 4);
        assert.deepEqual([c.output.front, c.output.back], [0, 2]);
        assert.match(culled.json.summary, /Culling is BACK, so 2 of them are culled: NOTHING IS LEFT TO DRAW/);
        assert.match(culled.json.summary, /about 40×60 pixels, from x 120, y 60 up from the bottom/);

        // H0: a draw with no vertex buffers, whose shader reads the vertex's number itself.
        const whole = await scanline('geometry', capture, 1, '--session', session, '--json');

        assert.deepEqual(rounded(whole.json.data.geometry.output.first), [[-1, -1, 0, 1], [3, -1, 0, 1], [-1, 3, 0, 1]]);

        const clear = await scanline('geometry', capture, 4, '--session', session);

        assert.equal(clear.code, 1);
        assert.match(clear.out, /Event 4 is a clear, which has no geometry/);
    });
});

describe('GPU time by draw of a WebGPU capture', () =>
{
    test('profile ranks the costly draw first, blended or opaque', async () =>
    {
        const timed = async (path) =>
        {
            const { session, capture } = await captured(path);
            const profile = await scanline('profile', capture, '--session', session, '--json');

            assert.equal(profile.code, 0, profile.out);
            assert.equal(profile.json.data.rows[0].draw, 7, `the shafts are the costly draw: ${JSON.stringify(profile.json.data.rows)}`);
            assert.ok(profile.json.data.rows[0].ns > 5 * profile.json.data.rows[1].ns);
            assert.match(profile.json.summary, /WebGPU times passes, not draws/);

            await scanline('close', '--session', session);

            return profile.json.data.rows[0].ns;
        };

        const blended = await timed('fixtures/slow/webgpu.html');
        const opaque = await timed('fixtures/slow/webgpu.html?opaque');

        // A tile-based GPU shades only the last of several opaque draws to a pixel. If the
        // repeats were let hide each other, the opaque draw would read as a fraction of this.
        assert.ok(opaque > blended * 0.4, `the same shader costs about the same drawn opaque (${opaque} ns) as blended (${blended} ns)`);

        const by = await captured('fixtures/slow/webgpu.html');
        const passes = await scanline('profile', by.capture, '--by', 'pass', '--session', by.session, '--json');

        assert.equal(passes.json.data.rows[0].pass, '1');
    });
});

describe('render bundles', () =>
{
    // fixtures/history/bundles-webgpu.html: «early» (red, then blue with a pipeline of layout
    // auto) is built before the first frame, «late» (green) every frame, and a yellow quad
    // is drawn straight on the pass. Event 1 is executeBundles([early, late]).
    const pixel = async (x, y) => (await scanline('pixels', x, y, '--json')).json.data.rgba8;

    test('a capture holds a bundle built before its frame, and says what it draws', async () =>
    {
        const { session, capture } = await captured('fixtures/history/bundles-webgpu.html');
        const list = await scanline('draw_list', capture, '--session', session);

        assert.match(list.out, /1 {2}3 draws in render bundles → canvas {2}⇒ 14400 px at 0, 0, 120, 120/);

        const event = await scanline('draw', capture, 1, '--session', session);

        assert.match(event.out, /runs 2 render bundles: what they draw was recorded when they were built/);
        assert.match(event.out, /bnd_1: drawIndexed × 6 with pip_1\n {4}bnd_1: drawIndexed × 6 with pip_2\n {4}bnd_\d+: drawIndexed × 6 with pip_1/);
        assert.doesNotMatch(event.out, /pipeline none/);

        assert.match((await scanline('resources', 'bundle', '--session', session)).out, /bnd_1 «early» {2}render bundle of 2 draws/);
        assert.match((await scanline('stats', '--session', session)).out, /Per frame: 4 draws, 4 instances, 8 triangles/);
    });

    test('the views take a bundle apart, and its draws belong to its event', async () =>
    {
        const { session, capture } = await captured('fixtures/history/bundles-webgpu.html');
        const owners = await scanline('view', capture, 'draw_id', '--session', session, '--json');

        assert.equal(owners.code, 0, owners.out);
        assert.deepEqual(owners.json.data.owners.map((owner) => [owner.draw, owner.pixels]), [[1, 14400], [2, 4800]]);
        assert.doesNotMatch(owners.json.summary, /left out/);

        const over = await scanline('view', capture, 'overdraw', '--session', session, '--json');

        assert.equal(over.json.data.all.mean, 1);
        assert.equal(over.json.data.all.max, 1);

        const history = await scanline('pixel_history', capture, 60, 60, '--session', session, '--json');

        assert.deepEqual(history.json.data.history.map((row) => [row.draw, row.changed]), [[0, true], [1, true]]);
        assert.match(history.json.summary, /\[3 draws in render bundles\]/);

        const profile = await scanline('profile', capture, '--session', session, '--json');

        assert.deepEqual(profile.json.data.rows.map((row) => row.draw).sort(), [1, 2], 'the bundle is timed whole');
    });

    test('a live patch reaches the draws inside a bundle', async () =>
    {
        await scanline('launch', server.url('fixtures/history/bundles-webgpu.html'), '--headless', '--paused');
        await scanline('step', 3);
        await scanline('resources', 'pipeline');

        const plain = [await pixel(20, 60), await pixel(60, 60), await pixel(100, 60), await pixel(140, 60)];

        assert.deepEqual(plain, [[204, 51, 51, 255], [51, 51, 204, 255], [51, 204, 51, 255], [204, 204, 51, 255]]);

        // pip_2 draws only the blue quad, inside «early».
        await scanline('patch_draws', '--mode', 'solid', '--filter', '{"pipeline": "pip_2"}');
        await scanline('step', 2);
        assert.deepEqual([await pixel(20, 60), await pixel(60, 60), await pixel(100, 60)], [plain[0], [255, 0, 255, 255], plain[2]]);
        await scanline('patches', '--revert', 'all');

        // Event 1 is the bundles, as a capture numbers them: all three of their quads go.
        await scanline('patch_draws', '--filter', '{"draws": 1}');
        await scanline('step', 2);
        assert.deepEqual([await pixel(20, 60), await pixel(60, 60), await pixel(100, 60), await pixel(140, 60)], [[26, 26, 26, 255], [26, 26, 26, 255], [26, 26, 26, 255], plain[3]]);
        await scanline('patches', '--revert', 'all');
        await scanline('step', 2);
        assert.deepEqual([await pixel(20, 60), await pixel(60, 60), await pixel(100, 60), await pixel(140, 60)], plain);
        assert.doesNotMatch((await scanline('console', '--level', 'error')).out, /not compatible|is invalid|Invalid/);
    });
});

describe('frame statistics', () =>
{
    test('triangles are counted on WebGPU, from each pipeline\'s topology', async () =>
    {
        await scanline('launch', server.url('fixtures/history/analysis-webgpu.html'), '--headless', '--paused');
        await scanline('step', 10);

        // Three single triangles to the float texture, and five quads of two to the canvas.
        assert.match((await scanline('stats')).out, /Per frame: 8 draws, 8 instances, 13 triangles/);
    });

    test('a WebGL frame is timed pass by pass', async () =>
    {
        await scanline('launch', server.url('fixtures/slow/webgl2.html'), '--headless', '--paused');
        await scanline('step', 30);

        const stats = await scanline('stats', '--json');
        const passes = Object.fromEntries(stats.json.data.gpu.passes.map((pass) => [pass.label, pass.mean]));

        // The mask is drawn to a framebuffer, then the scene and the costly shafts to the canvas.
        assert.deepEqual(Object.keys(passes).sort(), ['pass 0 → fbo_1', 'pass 1 → canvas']);
        assert.ok(passes['pass 1 → canvas'] > passes['pass 0 → fbo_1'] * 3, JSON.stringify(passes));
        assert.match(stats.json.summary, /ms {2}pass 1 → canvas\n/);
        assert.doesNotMatch(stats.json.summary, /coarsens WebGPU timestamps/);
    });
});

describe('live patches on a WebGPU page', () =>
{
    const pixel = async (x, y) => (await scanline('pixels', x, y, '--json')).json.data.rgba8;

    // A under B, B alone, D's kept half, D's discarded half.
    const look = async () =>
    {
        await scanline('step', 2);

        return { a: await pixel(20, 60), both: await pixel(60, 60), b: await pixel(100, 60), d: await pixel(140, 90), none: await pixel(140, 30) };
    };

    const open = async () =>
    {
        await scanline('launch', server.url('fixtures/history/analysis-webgpu.html'), '--headless', '--paused');
        await scanline('step', 3);
        await scanline('resources', 'pipeline');
        await scanline('resources', 'texture');

        return look();
    };

    test('the running page is drawn as overdraw and as a colour for each draw', async () =>
    {
        const plain = await open();
        const over = await scanline('live_view', 'overdraw');

        assert.match(over.out, /^pat_\d+: overdraw: a pass that clears a colour clears it to black/);

        // One layer adds (32, 11, 4). A and B overlap; D's shader discards its top half,
        // which is therefore not counted: the page's own fragments decide.
        let seen = await look();

        assert.deepEqual(seen.a, [32, 11, 4, 255]);
        assert.deepEqual(seen.both, [64, 22, 8, 255]);
        assert.deepEqual(seen.d, [32, 11, 4, 255]);
        assert.deepEqual(seen.none, [0, 0, 0, 255]);

        await scanline('live_view', 'draw_id');
        seen = await look();
        assert.deepEqual(seen.none, plain.none, 'the clear colour is the page\'s again');
        assert.notDeepEqual(seen.a, plain.a);
        assert.notDeepEqual(seen.a, seen.b, 'each draw has a colour of its own');
        assert.notDeepEqual(seen.b, seen.d);
        assert.match((await scanline('patches')).out, /^1 patch in force/);

        assert.match((await scanline('live_view', 'off')).out, /Switched off: 1 of Scanline's own/);
        assert.deepEqual(await look(), plain);
        assert.match((await scanline('live_view', 'wireframe')).out, /The live wireframe view is for WebGL\. On a WebGPU page: overdraw and draw_id live/);
        assert.doesNotMatch((await scanline('console', '--level', 'error')).out, /not compatible|is invalid|Invalid/);
    });

    test('draws are named by event number or by a texture, and drawn in one flat colour', async () =>
    {
        const plain = await open();

        // B is event 6 of the frame, as draw_list numbers it.
        const solid = await scanline('patch_draws', '--mode', 'solid', '--filter', '{"draws": 6}', '--colour', '[0, 1, 0]');

        assert.match(solid.out, /^pat_\d+: draws at event 6 of the frame are drawn in one flat colour \(0, 1, 0, 1\)/);

        let seen = await look();

        assert.deepEqual(seen.b, [0, 255, 0, 255]);
        assert.deepEqual([seen.a, seen.both, seen.d], [plain.a, plain.both, plain.d], 'B is still behind A, and nothing else changed');
        await scanline('patches', '--revert', 'all');

        // D is the one draw with «checks» in a bind group. A flat colour keeps its discard.
        await scanline('patch_draws', '--mode', 'solid', '--filter', '{"texture": "tex_1"}');
        seen = await look();
        assert.deepEqual(seen.d, [255, 0, 255, 255]);
        assert.deepEqual(seen.none, plain.none, 'the half its shader discards is still discarded');
        await scanline('patches', '--revert', 'all');

        const skipped = await scanline('patch_draws', '--filter', '{"texture": "tex_1"}');

        assert.match(skipped.out, /draws with tex_1 in a bind group are not drawn/);
        seen = await look();
        assert.deepEqual(seen.d, plain.none);
        assert.match((await scanline('patches')).out, /are not drawn {2}\(1 draw a frame\)/);
        await scanline('patches', '--revert', 'all');
        assert.deepEqual(await look(), plain);
    });

    test('a uniform is held by the name its shader gives it, and put back', async () =>
    {
        const plain = await open();
        const held = await scanline('patch_uniform', '--target', 'pip_1', '--name', 'colour', '--value', '[0, 1, 1, 1]', '--json');

        assert.equal(held.code, 0, held.out);
        assert.equal(held.json.data.description, 'uniform tint.colour (vec4f) held at 0, 1, 1, 1 for draws that use pip_1');

        // A and B are drawn with pip_1, each from a buffer of its own; D with another pipeline.
        let seen = await look();

        assert.deepEqual([seen.a, seen.b], [[0, 255, 255, 255], [0, 255, 255, 255]]);
        assert.deepEqual(seen.d, plain.d);

        // This page never writes those buffers again: undone, they get back what they held.
        await scanline('patches', '--revert', 'all');
        assert.deepEqual(await look(), plain);

        assert.match((await scanline('patch_uniform', '--target', 'pip_1', '--name', 'nope', '--value', 1)).out, /declare no uniform named "nope"\. They have: tint\.colour, tint\.rect, tint\.depth/);
        assert.match((await scanline('patch_uniform', '--target', 'pip_1', '--name', 'tint.depth', '--value', '[1, 2]')).out, /tint\.depth is a f32, which takes 1 number, and 2 were given/);
    });

    test('a texture is stood in for from a file', async () =>
    {
        const plain = await open();

        // 2×2, plain red.
        const row = Buffer.from([0, 255, 0, 0, 255, 255, 0, 0, 255]);
        const chunk = (type, data) =>
        {
            const body = Buffer.concat([Buffer.from(type), data]);
            const out = Buffer.alloc(body.length + 8);

            out.writeUInt32BE(data.length, 0);
            body.copy(out, 4);
            out.writeUInt32BE(crc32(body), body.length + 4);

            return out;
        };
        const header = Buffer.alloc(13);

        header.writeUInt32BE(2, 0);
        header.writeUInt32BE(2, 4);
        header.set([8, 6, 0, 0, 0], 8);

        const file = join(home, 'red.png');

        writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]));

        const stood = await scanline('patch_texture', 'tex_1', '--with', file);

        assert.match(stood.out, /every draw: tex_1 replaced by the 2×2 image given/);

        const seen = await look();

        assert.deepEqual(seen.d, [255, 0, 0, 255]);
        assert.deepEqual(seen.a, plain.a);
        await scanline('patches', '--revert', 'all');
        assert.deepEqual(await look(), plain);
    });
});

