// What Scanline says, unasked, about each planted bug (fixtures/bugs, evals/bugs.json).
//
//   npm run build && cargo build && npm run test:findings
//
// The agent evaluation in evals/ measures whether an agent finds each bug. These tests pin
// down what the tool hands it: for each bug, the capture's summary or one further command
// has to state the fact that is the cause. The correct page has to raise nothing.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { repoRoot, serve } from '../spikes/lib/serve.mjs';

const binary = join(repoRoot, 'target', 'debug', 'scanline');
const home = mkdtempSync(join(tmpdir(), 'scanline-findings-'));
const env = { ...process.env, SCANLINE_HOME: home };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let server;

function scanline (...args)
{
    return new Promise((resolve) =>
    {
        execFile(binary, args.map(String), { env, timeout: 60000 }, (error, stdout, stderr) =>
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

// Opens a bug's page, runs it a few frames and captures one. Returns the handles and the summary.
async function captured (bug, frames = 6)
{
    const launched = await scanline('launch', server.url(`fixtures/bugs/${bug}.html`), '--headless', '--paused');
    const session = /Launched (ses_\d+)/.exec(launched.out)?.[1];

    assert.ok(session, launched.out);

    await scanline('step', frames, '--session', session);

    const taken = await scanline('capture', '--session', session);
    const capture = /^(cap_\d+):/m.exec(taken.out)?.[1];

    assert.ok(capture, taken.out);
    assert.match(taken.out, /Replay check: replaying the capture gives an image identical/);

    return { session, capture, summary: taken.out };
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

describe('what a capture says about each planted bug', () =>
{
    test('b00, the correct scene, raises nothing', async () =>
    {
        const { summary, capture, session } = await captured('b00');

        assert.doesNotMatch(summary, /Worth a look/);
        assert.doesNotMatch(summary, /raised a GL error/);

        // Every event's effect is measured, and none did nothing.
        const list = await scanline('draw_list', capture, '--limit', 40, '--session', session);

        assert.match(list.out, /25 events/);
        assert.equal(list.out.match(/⇒ \d+ px at/g).length, 25);
        assert.match(list.out, / 5 {2}TRIANGLE_STRIP ×4 {2}prg_1 → canvas .*⇒ 48000 px at 0, 260, 480, 100/);
        assert.match(list.out, /scissor ON 12, 336, 150, 12 {2}⇒ 1800 px at 12, 12, 150, 12/);

        // The correct scene binds the crate texture for the first crate.
        const crate = await scanline('draw', capture, 6, '--session', session);

        assert.match(crate.out, /unit 0: 2D tex_1 {2}\(64×64 [^)]*\) {3}← bound for this draw, at call \d+/);
    });

    test('b01: the crates are culled, and draw says so', async () =>
    {
        const { summary, capture, session } = await captured('b01');

        assert.match(summary, /3 draws changed no pixels: events 6–8\. draw\(draw: 6\) says which test rejected it/);

        const draw = await scanline('draw', capture, 6, '--session', session);

        assert.match(draw.out, /rect = 140, 180, -80, 80 {3}← set for this draw, at call \d+/);
        assert.match(draw.out, /Why: With face culling off it changes 6400 pixels: every triangle is culled \(cull BACK, front face CW\)/);
    });

    test('b02: the crate texture is incomplete', async () =>
    {
        const { summary } = await captured('b02');

        assert.match(summary, /tex_1 is bound for events [\d–, ]+ but is incomplete: it has one mip level and its MIN_FILTER \(never set, so NEAREST_MIPMAP_LINEAR\) needs mipmaps/);
    });

    test('b03: the glass is drawn with blending off', async () =>
    {
        const { summary } = await captured('b03');

        assert.match(summary, /Event 9 is drawn with blending off, but its uniform tint has an alpha of 0\.4/);
    });

    test('b04: the ground inherits a tint it never set', async () =>
    {
        const { capture, session } = await captured('b04');
        const draw = await scanline('draw', capture, 5, '--session', session);

        assert.match(draw.out, /tint = 1, 0\.8, 0\.2, 1 {3}← last set at call \d+, for event 3; not set again for this draw/);
        assert.match(draw.out, /rect = 0, 260, 480, 100 {3}← set for this draw/);

        // The calls that set the draw up can be asked for by the draw.
        const calls = await scanline('query', capture, 'select method from commands where for_draw = 5 and method like \'gl.uniform%\'', '--session', session);

        assert.match(calls.out, /gl\.uniform4f/);
        assert.doesNotMatch(calls.out, /gl\.uniform4fv/);
    });

    test('b05: the depth clear makes every depth test fail', async () =>
    {
        const { summary, capture, session } = await captured('b05');

        assert.match(summary, /17 draws changed no pixels: events 5–21/);

        const draw = await scanline('draw', capture, 5, '--session', session);

        assert.match(draw.out, /Why: With the depth test off it changes 48000 pixels: every fragment fails the depth test \(LESS\)\. The depth buffer was last cleared to 0 by event 4, and nothing can pass/);
    });

    test('b06: the glass is drawn before the crates', async () =>
    {
        const { summary } = await captured('b06');

        assert.match(summary, /Event 6 blends, but opaque depth-written events 8–9 are drawn after it on the same pixels/);
    });

    test('b07: the scissor test is left on', async () =>
    {
        const { summary, capture, session } = await captured('b07');

        assert.match(summary, /Events 0, 4 clear with the scissor test on \(box 12, 336, 150, 12\), so only that box is cleared\. The frame began with the scissor test already on: an earlier frame left it on\. This frame does the same: call \d+ switches it on and nothing after it switches it off/);

        const enabled = await scanline('query', capture, "select method from commands where args like '%SCISSOR_TEST%'", '--session', session);

        assert.match(enabled.out, /1 row\b[^\n]*\n\s+gl\.enable/);

        const draw = await scanline('draw', capture, 5, '--session', session);

        assert.match(draw.out, /scissor test ON, box 12, 336, 150, 12/);
        assert.match(draw.out, /Why: With the scissor test off it changes 48000 pixels: it falls outside the scissor box/);
    });

    test('b08: the crates are drawn with the bar texture', async () =>
    {
        const { capture, session } = await captured('b08');
        const draw = await scanline('draw', capture, 6, '--session', session);

        // The crates sample what was bound long before them, and the capture says so.
        assert.match(draw.out, /unit 0: 2D tex_2 {2}\(32×1 [^)]*\) {3}← last bound at call \d+, for event 0; not bound again for this draw/);

        // Call arguments read as names and handles: nothing binds a texture for the crates.
        const binds = await scanline('query', capture, "select for_draw, args from commands where method = 'gl.bindTexture'", '--session', session);

        assert.match(binds.out, /0 \| \["TEXTURE_2D","tex_2"\]/);
        assert.doesNotMatch(binds.out, /\n\s+[678] \| /);

        const bare = await scanline('query', capture, "select command from commands where method = 'bindTexture'", '--session', session);

        assert.match(bare.out, /No rows\. Method names carry their owner, as in 'gl\.bindTexture'/);
    });

    test('b09: the minimap viewport is never put back', async () =>
    {
        const { summary, capture, session } = await captured('b09');

        assert.match(summary, /Every event on canvas \(events 4–24\) uses viewport 0, 0, 64, 64, but canvas is 480×360\. The viewport was last set at call \d+/);

        const list = await scanline('draw_list', capture, '--session', session);

        assert.match(list.out, /→ canvas .* viewport 0, 0, 64, 64 \(target is 480×360\)/);
        assert.doesNotMatch(list.out, /→ tex_3 .* viewport/);
    });

    test('b10: a texture is created every frame and never deleted', async () =>
    {
        const { summary, session } = await captured('b10');

        assert.match(summary, /The frame itself created 1 texture and deleted nothing\. It created more than it deleted/);

        await scanline('step', 30, '--session', session);

        const kinds = await scanline('resources', '--session', session);

        assert.match(kinds.out, /texture +\d+ alive, [\d.]+ MB/);
        assert.match(kinds.out, /LIKELY LEAK: \d+ textures still alive \([\d.]+ MB\) were all created by one line, over frames \d+ to \d+ \(about 1 a frame\): makeMapTarget \(fixtures\/bugs\/scene\.js:\d+/);

        const memory = await scanline('memory', '--snapshot', 'before', '--session', session);

        assert.match(memory.out, /LIKELY LEAK: \d+ textures/);
        assert.match(memory.out, /The browser's GPU process holds [\d.]+ [MG]B in all \(os-measured/);

        // The memory journey (J4): two snapshots, what grew between them and where it was
        // made, and the GPU process's own figure to say the growth is real.
        await scanline('step', 400, '--session', session);

        const diff = await scanline('memory', '--diff', '["before", "now"]', '--session', session, '--json');

        assert.equal(diff.json.data.created, 400);
        assert.match(diff.json.summary, /Possible leak: one call site created 400 identical textures between the snapshots and none were destroyed/);
        assert.match(diff.json.summary, /\+[\d.]+ MB {2}400 textures {2}256×256 .* at makeMapTarget \(fixtures\/bugs\/scene\.js:\d+/);
        assert.match(diff.json.summary, /The browser's GPU process held [\d.]+ [MG]B at "before" and holds [\d.]+ [MG]B at "now": \+[\d.]+ MB \(os-measured/);

        // 400 textures of 256×256 RGBA8 are 100 MB. The process grew by a good part of that.
        const process = diff.json.data.gpu_process;

        assert.ok(process.after - process.before > 40 * 1024 * 1024, `the GPU process grew by ${(process.after - process.before) / 1048576} MB`);
        assert.match(diff.json.summary, /That bears the estimate out|That is some of the estimated growth/);
    });

    test('b11: a program is compiled and linked every frame', async () =>
    {
        const { summary, session } = await captured('b11');

        assert.match(summary, /The frame itself created 1 program, 2 shaders \(compiled 2 shaders, linked 1 program\), and deleted 1 program, 2 shaders\. prg_\d+ is used by events 10–21\. Compiling and linking are slow/);

        await scanline('step', 30, '--session', session);

        const memory = await scanline('memory', '--session', session);

        assert.match(memory.out, /CHURN: \d+ programs have been created in all and \d+ destroyed/);

        // A destroyed program is not reported as one that failed to link.
        const newest = await scanline('resources', 'program', '--sort', 'created', '--dead', '--limit', 3, '--session', session);
        const gone = /(prg_\d+)[^\n]*destroyed/i.exec(newest.out)?.[1];

        assert.ok(gone, newest.out);

        const program = await scanline('resource', gone, '--session', session);

        assert.match(program.out, /Linked once\. It has since been destroyed/);
        assert.doesNotMatch(program.out, /LINK FAILED/);
    });

    test('b12: the minimap is drawn to while bound', async () =>
    {
        const { summary, capture, session } = await captured('b12');

        assert.match(summary, /event 1, call \d+ gl\.drawArrays: INVALID_OPERATION — a feedback loop: tex_3 is the target being drawn to and is also bound on texture unit 0/);

        const draw = await scanline('draw', capture, 1, '--session', session);

        assert.match(draw.out, /It is a feedback loop: tex_3 is the target being drawn to and is also bound on texture unit 0/);
    });
});

describe('the history of a pixel', () =>
{
    const history = async (capture, session, x, y) => (await scanline('pixel_history', capture, x, y, '--session', session, '--json'));
    const events = (reply) => reply.json.data.history.map((row) => [row.draw, row.changed]);

    test('b00: a crate seen through the glass was cleared, drawn, then tinted', async () =>
    {
        const { capture, session } = await captured('b00');
        const reply = await history(capture, session, 250, 210);

        assert.equal(reply.code, 0, reply.out);
        assert.deepEqual(events(reply), [[4, true], [7, true], [9, true]]);
        assert.deepEqual(reply.json.data.history[1].after, [185, 129, 74, 255]);
        assert.deepEqual(reply.json.data.history[2].after, [131, 118, 146, 255]);
        assert.match(reply.json.summary, /Its final value \(131, 118, 146, 255\) was produced by event 9/);
        assert.match(reply.json.summary, /18 other draws on this target did not reach the pixel/);

        // The ground is under none of that: only the clear and the ground touch a pixel of it.
        assert.deepEqual(events(await history(capture, session, 30, 320)), [[4, true], [5, true]]);

        // The minimap's texture has a history of its own.
        const map = await scanline('pixel_history', capture, 13, 24, '--target', 'tex_3', '--session', session, '--json');

        assert.equal(map.code, 0, map.out);
        assert.ok(map.json.data.history.length >= 2, map.json.summary);
    });

    test('b01: where a crate should be, its draw was culled', async () =>
    {
        const { capture, session } = await captured('b01');
        const reply = await history(capture, session, 100, 220);

        assert.deepEqual(events(reply), [[4, true], [6, false]]);
        assert.deepEqual(reply.json.data.history[1].passes, { scissor: true, cull: false, depth: true, stencil: null });
        assert.match(reply.json.summary, /event {4}6 {2}REJECTED: its triangle is culled \(cull BACK, front face CW\)/);
    });

    test('b05: the ground failed the depth test', async () =>
    {
        const { capture, session } = await captured('b05');
        const reply = await history(capture, session, 30, 320);

        assert.deepEqual(events(reply), [[4, true], [5, false]]);
        assert.match(reply.json.summary, /event {4}5 {2}REJECTED: it fails the depth test \(LESS\)/);
    });

    test('b06: the crate was drawn over the glass', async () =>
    {
        const { capture, session } = await captured('b06');

        assert.deepEqual(events(await history(capture, session, 250, 210)), [[4, true], [6, true], [8, true]]);
    });

    test('b07: everything in the middle of the canvas fell outside the scissor box', async () =>
    {
        const { capture, session } = await captured('b07');
        const reply = await history(capture, session, 240, 200);

        assert.ok(reply.json.data.history.length >= 3);
        assert.ok(reply.json.data.history.every((row) => !row.changed && row.passes.scissor === false), reply.json.summary);
        assert.match(reply.json.summary, /REJECTED: it is outside the scissor box \(12, 336, 150, 12\)/);
    });
});

describe('lint and shader analysis', () =>
{
    // fixtures/history/webgl2.html: a scene whose every pixel's history is known by hand.
    // Events: 0 the clear, 1 a grey floor, 2 a red disc (corners discarded), 3 a green ramp
    // whose shader writes its own depth, 4 a blue quad behind the floor.
    for (const [name, query, target] of [['to the canvas', '', []], ['to a multisampled renderbuffer', '?samples=4', ['--target', 'fbo_1']]])
    {
        test(`pixel history is right on discard, shader-written depth and a quad behind another, ${name}`, async () =>
        {
            const launched = await scanline('launch', server.url(`fixtures/history/webgl2.html${query}`), '--headless', '--paused');
            const session = /Launched (ses_\d+)/.exec(launched.out)?.[1];

            await scanline('step', 3, '--session', session);

            const taken = await scanline('capture', '--session', session);
            const capture = /^(cap_\d+):/m.exec(taken.out)?.[1];

            assert.match(taken.out, /Replay check: replaying the capture gives an image identical/);

            const history = async (x, y) => (await scanline('pixel_history', capture, x, y, ...target, '--session', session, '--json')).json;
            const steps = (reply) => reply.data.history.map((row) => [row.draw, row.changed, row.after]);
            const [sky, grey, red, green] = [[32, 64, 96, 255], [128, 128, 128, 255], [255, 0, 0, 255], [0, 255, 0, 255]];

            // The middle of the disc: cleared, then drawn red.
            assert.deepEqual(steps(await history(80, 60)), [[0, true, sky], [2, true, red]]);

            // A corner of the disc's quad: the triangle covers it, the shader discards it.
            const corner = await history(44, 24);

            assert.deepEqual(steps(corner), [[0, true, sky], [2, false, sky]]);
            assert.equal(corner.data.history[1].discarded, true);
            assert.match(corner.summary, /event {4}2 {2}REJECTED: its fragment shader discarded it/);
            assert.match(corner.summary, /3 other draws on this target did not reach the pixel: their triangles do not cover it\./);

            // The ramp's left side: its quad sits behind the floor (0.9 against 0.5), but the
            // shader writes a depth of 0.125 there, so it wins.
            assert.deepEqual(steps(await history(100, 180)), [[0, true, sky], [1, true, grey], [3, true, green]]);

            // Its right side: the shader writes 0.875, and it loses to the floor.
            const right = await history(220, 180);

            assert.deepEqual(steps(right), [[0, true, sky], [1, true, grey], [3, false, grey]]);
            assert.equal(right.data.history[2].passes.depth, false);
            assert.equal(right.data.history[2].discarded, false);
            assert.match(right.summary, /event {4}3 {2}REJECTED: it fails the depth test \(LESS\)/);

            // The blue quad, behind the floor.
            const behind = await history(260, 180);

            assert.deepEqual(steps(behind), [[0, true, sky], [1, true, grey], [4, false, grey]]);
            assert.match(behind.summary, /event {4}4 {2}REJECTED: it fails the depth test \(LESS\)/);

            if (target.length > 0)
            {
                // On the canvas the pixel came from the blit, which says where to look.
                const canvas = await scanline('pixel_history', capture, 80, 60, '--session', session);

                assert.match(canvas.out, /event {4}5 {2}\(0, 0, 0, 255\) → \(255, 0, 0, 255\) {3}\[blit\]/);
                assert.match(canvas.out, /Event 5 is a blit from fbo_1, so the colour was made there\. pixel_history\(capture: "cap_\d+", x, y, target: "fbo_1"\)/);
                assert.match((await scanline('draw', capture, 5, '--session', session)).out, /Copies from fbo_1, the box from \(0, 0\) to \(320, 240\)/);

                // What each event changed is measured on the renderbuffer, resolved.
                const list = await scanline('draw_list', capture, '--session', session);

                assert.match(list.out, /2 {2}TRIANGLE_STRIP ×4 {2}prg_2 → fbo_1 {2}depth LESS {2}⇒ 50\d\d px at 40, 20, 80, 80/);
                assert.match(list.out, /4 {2}TRIANGLE_STRIP ×4 {2}prg_1 → fbo_1 {2}depth LESS {2}⇒ changed nothing/);

                // And the target can be looked at as it stood after any event.
                const shot = await scanline('pixels', 80, 60, '--capture', capture, '--at_draw', 1, '--target', 'fbo_1', '--session', session, '--json');

                assert.match(shot.json.summary, /fbo_1 after event 1, pixel \(80, 60\): rgba8 \(32, 64, 96, 255\)/, shot.out);
            }
        });
    }

    test('geometry gives a draw\'s vertices and where its vertex shader puts them', async () =>
    {
        // A crate of the correct scene: two triangles, both facing the front, 80×80 pixels.
        const right = await captured('b00');
        const crate = await scanline('geometry', right.capture, 6, '--session', right.session, '--json');

        assert.equal(crate.code, 0, crate.out);
        assert.match(crate.json.summary, /event 6: TRIANGLE_STRIP × 4\./);
        assert.match(crate.json.summary, /corner \(vec2, location 0\): 2 × FLOAT from buf_1, stride 8, offset 0\n {4}\(0, 0\) {2}\(1, 0\) {2}\(0, 1\) {2}\(1, 1\)/);
        assert.match(crate.json.summary, /2 of 2 triangles would reach the rasteriser/);
        assert.match(crate.json.summary, /2 face the front, 0 the back \(front is CW\)\. Culling is BACK, so 0 of them are culled\./);
        assert.match(crate.json.summary, /that is about 80×80 pixels, from x 60, y 100 up from the bottom/);
        assert.deepEqual(crate.json.data.geometry.output.first[0].map((part) => Math.round(part * 1000) / 1000 + 0), [-0.75, 0, 0, 1]);

        // The same crate mirrored (b01): the same place, the other winding, and all of it culled.
        const wrong = await captured('b01');
        const culled = await scanline('geometry', wrong.capture, 6, '--session', wrong.session);

        assert.match(culled.out, /0 face the front, 2 the back \(front is CW\)\. Culling is BACK, so 2 of them are culled: NOTHING IS LEFT TO DRAW\./);

        // A clear has none, and says so.
        assert.match((await scanline('geometry', wrong.capture, 0, '--session', wrong.session)).out, /Event 0 is a clear, which has no geometry/);
    });

    test('geometry on an engine\'s draw: indices, an instanced attribute, and triangles facing away', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/adapters/three.html'), '--headless', '--paused');
        const session = /Launched (ses_\d+)/.exec(launched.out)?.[1];

        await scanline('step', 5, '--session', session);

        const capture = /^(cap_\d+):/m.exec((await scanline('capture', '--session', session)).out)?.[1];

        // The five pillars: one indexed, instanced draw of a twelve-sided cylinder.
        const pillars = await scanline('geometry', capture, 7, '--session', session, '--json');

        assert.equal(pillars.code, 0, pillars.out);
        assert.match(pillars.json.summary, /event 7: TRIANGLES × 144, indexed, 5 instances \(what follows is the first\)/);
        assert.match(pillars.json.summary, /Indices run from 0 to 75/);
        assert.match(pillars.json.summary, /instanceMatrix \(mat4, location \d+\): 4 × FLOAT from buf_\d+, stride 64, offset 0, one value per instance/);
        assert.match(pillars.json.summary, /position \(vec3, location 0\): 3 × FLOAT from buf_\d+, stride 12, offset 0/);

        const output = pillars.json.data.geometry.output;

        assert.equal(output.total, 48);
        assert.equal(output.reach, 48);
        assert.equal(output.front + output.back, 48, 'every triangle of a closed cylinder faces one way or the other');
        assert.ok(output.front > 0 && output.back > 0);
        assert.match(pillars.json.summary, /Culling is BACK, so \d+ of them are culled\./);
    });

    test('lint gathers what is worth a look, for a capture and for a live session', async () =>
    {
        const { capture, session } = await captured('b10', 30);
        const frame = await scanline('lint', '--capture', capture, '--session', session, '--json');

        assert.equal(frame.json.data.findings.length, 1);
        assert.match(frame.json.summary, /1 thing worth a look/);
        assert.match(frame.json.summary, /The frame itself created 1 texture and deleted nothing/);

        const live = await scanline('lint', '--session', session, '--json');

        assert.match(live.json.data.findings[0], /^LIKELY LEAK: \d+ textures still alive/);

        // A frame with nothing wrong, and a page with nothing wrong.
        const good = await captured('b00');

        assert.match((await scanline('lint', '--capture', good.capture, '--session', good.session)).out, /nothing stands out/);
        assert.match((await scanline('lint', '--session', good.session)).out, /nothing stands out in the page's objects or its console/);

        // A rejected call comes first.
        const loop = await captured('b12');
        const rejected = await scanline('lint', '--capture', loop.capture, '--session', loop.session, '--json');

        assert.match(rejected.json.data.findings[0], /^The browser rejected call \d+ \(gl\.drawArrays\): INVALID_OPERATION/);
    });

    test('a shader is read for what it could cost, live and from a capture', async () =>
    {
        const { capture, session } = await captured('b00');

        await scanline('resources', 'program', '--session', session);

        const live = await scanline('shader_analysis', 'prg_1', '--session', session, '--json');

        assert.equal(live.code, 0, live.out);
        assert.deepEqual(live.json.data.shaders.map((shader) => shader.stage), ['vertex shader', 'fragment shader']);
        assert.equal(live.json.data.shaders[1].figures.samples, 1);
        assert.equal(live.json.data.shaders[1].figures.samples_per_run, 1);
        assert.match(live.json.summary, /Texture samples: 1 call site, none in a loop/);
        assert.match(live.json.summary, /static, not measured/);

        const kept = await scanline('shader_analysis', 'prg_1', '--capture', capture, '--json');

        assert.deepEqual(kept.json.data.shaders.map((shader) => shader.figures), live.json.data.shaders.map((shader) => shader.figures));

        // This page deletes its shaders once they are linked, and a deleted shader cannot be
        // asked what it was compiled to: the capture has no translation of them.
        assert.deepEqual(kept.json.data.shaders.map((shader) => shader.translated), [undefined, undefined]);

        // A page that keeps its shaders: the capture holds what the browser compiled each to.
        const second = /Launched (ses_\d+)/.exec((await scanline('launch', server.url('fixtures/history/views.html'), '--headless', '--paused')).out)?.[1];

        await scanline('step', 3, '--session', second);

        const other = /^(cap_\d+):/m.exec((await scanline('capture', '--session', second)).out)?.[1];
        const whole = await scanline('shader_analysis', 'prg_1', '--capture', other, '--json');
        const translated = whole.json.data.shaders.map((shader) => shader.translated);

        assert.equal(translated.length, 2);

        for (const path of translated)
        {
            // Metal's shading language on a Mac, GLSL or HLSL elsewhere: a program either way.
            assert.match(readFileSync(path, 'utf8'), /metal_stdlib|void main\s*\(|float4/);
        }

        assert.match(whole.json.summary, /What the browser compiled it to \(ANGLE's translation into the graphics driver's own language, \d+ lines\), as it stood when the frame was captured/);

        const column = await scanline('query', other, "select handle, length(translated) > 40 from objects where kind = 'shader'", '--json');

        assert.deepEqual(column.json.data.rows.map((row) => row[1]), [1, 1], column.out);

        const wrong = await scanline('shader_analysis', 'tex_1', '--session', session);

        assert.equal(wrong.code, 1);
    });
});

describe('views of a capture', () =>
{
    test('overdraw counts how often each pixel was drawn, with and without the depth test', async () =>
    {
        const { capture, session } = await captured('b00');
        const reply = await scanline('view', capture, 'overdraw', '--session', session, '--json');

        assert.equal(reply.code, 0, reply.out);

        // The crates behind the glass are drawn twice; a spark over the glass makes three.
        const { all, visible } = reply.json.data;

        assert.equal(all.max, 3);
        assert.ok(all.mean > 0.6 && all.mean < 0.8, `mean ${all.mean}`);
        assert.ok(all.twice_or_more > 8 && all.twice_or_more < 14, `${all.twice_or_more}% drawn twice`);
        assert.deepEqual(visible, all, 'nothing in the correct scene is drawn and then hidden');
        assert.equal(reply.json.images.length, 2);
        assert.deepEqual(readFileSync(reply.json.images[0].view).subarray(0, 4), PNG);

        // With the depth buffer cleared to 0, nearly everything is rasterised and then thrown away.
        const hidden = await captured('b05');
        const wasted = (await scanline('view', hidden.capture, 'overdraw', '--session', hidden.session, '--json')).json.data;

        assert.ok(wasted.all.mean > wasted.visible.mean * 4, `drawn ${wasted.all.mean} a pixel, kept ${wasted.visible.mean}`);
    });

    test('profile times every draw by replay and ranks them', async () =>
    {
        const { capture, session } = await captured('b00');
        const draws = await scanline('profile', capture, '--top', 30, '--session', session, '--json');

        assert.equal(draws.code, 0, draws.out);
        assert.equal(draws.json.data.draws, 23, 'every draw of the frame was timed');
        assert.equal(draws.json.data.rows.length, 23);
        assert.ok(draws.json.data.rows.every((row) => row.ns >= 0));
        assert.ok(draws.json.data.total_ns > 0);
        assert.match(draws.json.summary, /each timed over 16 repeats, the middle of 3 runs/);
        assert.match(draws.json.summary, /made to finish each draw before the next is timed/);

        // Summed by the program the draws use: the scene has two.
        const shaders = await scanline('profile', capture, '--by', 'shader', '--session', session, '--json');

        assert.deepEqual(shaders.json.data.rows.map((row) => row.shader).sort(), ['prg_1', 'prg_2']);
        assert.equal(shaders.json.data.rows.reduce((sum, row) => sum + row.draws.length, 0), 23);

        const passes = await scanline('profile', capture, '--by', 'pass', '--session', session, '--json');

        assert.equal(passes.json.data.rows.length, 2);
    });

    test('b14: one draw takes nearly all the GPU time, and its shader samples 64 times a pixel', async () =>
    {
        const { capture, session } = await captured('b14');
        const draws = await scanline('profile', capture, '--session', session, '--json');

        assert.equal(draws.code, 0, draws.out);

        // The haze is event 10. It is not charged to the sparks drawn after it.
        const rows = draws.json.data.rows;

        assert.equal(rows[0].draw, 10, draws.json.summary);
        assert.ok(rows[0].ns > draws.json.data.total_ns * 0.6, draws.json.summary);
        assert.ok(rows[1].ns < rows[0].ns / 5, draws.json.summary);

        const shaders = await scanline('profile', capture, '--by', 'shader', '--session', session, '--json');

        assert.equal(shaders.json.data.rows[0].shader, 'prg_2');

        const read = await scanline('shader_analysis', 'prg_2', '--capture', capture, '--session', session);

        assert.match(read.out, /1 inside a loop: up to 64 samples every time the shader runs/);
    });

    test('the draw_id view says which draw owns each pixel, and the depth view what depth it holds', async () =>
    {
        // The hand-checked scene (fixtures/README.md, "Pixel history").
        const launched = await scanline('launch', server.url('fixtures/history/webgl2.html'), '--headless', '--paused');
        const session = /Launched (ses_\d+)/.exec(launched.out)?.[1];

        await scanline('step', 3, '--session', session);

        const capture = /^(cap_\d+):/m.exec((await scanline('capture', '--session', session)).out)?.[1];
        const owners = await scanline('view', capture, 'draw_id', '--session', session, '--json');

        assert.equal(owners.code, 0, owners.out);

        // The floor owns the bottom half. The disc owns its whole quad: discard is the
        // shader's doing, and this view is about shapes. The ramp and the blue quad own
        // nothing: their triangles sit behind the floor.
        assert.deepEqual(owners.json.data.owners, [
            { draw: 1, pixels: 38400, box: { x: 0, y: 120, w: 320, h: 120 } },
            { draw: 2, pixels: 6400, box: { x: 40, y: 20, w: 80, h: 80 } }
        ]);
        assert.equal(owners.json.data.no_draw_pixels, 32000);
        assert.deepEqual(owners.json.data.hidden, ['3', '4']);
        assert.deepEqual(readFileSync(owners.json.images[0].view).subarray(0, 4), PNG);

        // Depth: the floor at 0.5, the disc at 0.4, the ramp at what its shader wrote, and
        // the far value where only the clear reached.
        const depthAt = async (x, y, ...more) => (await scanline('view', capture, 'depth', '--x', x, '--y', y, ...more, '--session', session, '--json')).json;
        const close = (value, wanted) => Math.abs(value - wanted) < 1e-5;

        const floor = await depthAt(220, 180);

        assert.ok(close(floor.data.depth_at.depth, 0.5), floor.summary);
        assert.ok(close((await depthAt(80, 60)).data.depth_at.depth, 0.4));
        assert.ok(close((await depthAt(100, 180)).data.depth_at.depth, 20.5 / 160), 'the ramp wrote (x − 80) / 160 at the pixel\'s centre');
        assert.equal((await depthAt(10, 10)).data.depth_at.depth, 1);
        assert.ok(close(floor.data.farthest, 0.5));
        assert.match(floor.summary, /4[0-9]\.\d% of pixels are at 1, the far value/);

        // After the floor alone, the ramp's place still holds the floor's depth.
        assert.ok(close((await depthAt(100, 180, '--at_draw', 1)).data.depth_at.depth, 0.5));
    });

    test('the nan view finds what is not a number in a float target', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/history/nan.html'), '--headless', '--paused');
        const session = /Launched (ses_\d+)/.exec(launched.out)?.[1];

        await scanline('step', 3, '--session', session);

        const capture = /^(cap_\d+):/m.exec((await scanline('capture', '--session', session)).out)?.[1];

        // The canvas cannot hold one, and the view says which target can.
        const canvas = await scanline('view', capture, 'nan', '--session', session);

        assert.match(canvas.out, /the canvas holds 8-bit values, which cannot be NaN or infinite/);
        assert.match(canvas.out, /Float targets the frame draws to: tex_1\. Pass one as target\./);

        // The left quarter is normalize(vec3(0)), the next 1.0 / 0.0.
        const found = await scanline('view', capture, 'nan', '--target', 'tex_1', '--session', session, '--json');

        assert.equal(found.json.data.nan, 4800);
        assert.equal(found.json.data.infinite, 4800);
        assert.deepEqual(found.json.data.box, { x: 0, y: 0, w: 80, h: 120 });
        assert.deepEqual(readFileSync(found.json.images[0].view).subarray(0, 4), PNG);

        assert.match((await scanline('view', capture, 'nope', '--session', session)).out, /Views are overdraw, wireframe, draw_id, depth, stencil, mip and nan/);
    });

    test('the stencil view reads the buffer back, value by value', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/history/views.html'), '--headless', '--paused');
        const session = /Launched (ses_\d+)/.exec(launched.out)?.[1];

        await scanline('step', 3, '--session', session);

        const capture = /^(cap_\d+):/m.exec((await scanline('capture', '--session', session)).out)?.[1];

        // Square A writes 5, square B adds 1: 6 where they overlap. Worked out by hand in the fixture.
        const end = await scanline('view', capture, 'stencil', '--x', 100, '--y', 100, '--session', session, '--json');

        assert.equal(end.code, 0, end.out);
        assert.deepEqual(end.json.data.values, [
            { value: 0, pixels: 58400, box: { x: 0, y: 0, w: 320, h: 240 } },
            { value: 1, pixels: 8400, box: { x: 80, y: 80, w: 100, h: 100 } },
            { value: 5, pixels: 8400, box: { x: 20, y: 20, w: 100, h: 100 } },
            { value: 6, pixels: 1600, box: { x: 80, y: 80, w: 40, h: 40 } }
        ]);
        assert.deepEqual(end.json.data.stencil_at, { x: 100, y: 100, value: 6 });
        assert.match(end.json.summary, / {4}6 \(0x06\) {2}1600 px, 2\.1%, within x 80 y 80 40×40/);
        assert.deepEqual(readFileSync(end.json.images[0].view).subarray(0, 4), PNG);

        // After the first square alone, before the second has added to it.
        const early = await scanline('view', capture, 'stencil', '--at_draw', 1, '--x', 100, '--y', 100, '--session', session, '--json');

        assert.deepEqual(early.json.data.values.map((entry) => [entry.value, entry.pixels]), [[0, 66800], [5, 10000]]);
        assert.equal(early.json.data.stencil_at.value, 5);

        // After the clear, nothing.
        const cleared = await scanline('view', capture, 'stencil', '--at_draw', 0, '--session', session);

        assert.match(cleared.out, /Every pixel holds 0: nothing has written the stencil buffer since it was cleared/);

        // A page whose canvas has no stencil buffer is told so.
        await scanline('close', '--session', session);

        const other = await captured('b00');
        const none = await scanline('view', other.capture, 'stencil', '--session', other.session);

        assert.equal(none.code, 1);
        assert.match(none.out, /That target has no stencil buffer/);
    });

    test('the mip view shows which level each pixel sampled', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/history/views.html'), '--headless', '--paused');
        const session = /Launched (ses_\d+)/.exec(launched.out)?.[1];

        await scanline('step', 3, '--session', session);

        const capture = /^(cap_\d+):/m.exec((await scanline('capture', '--session', session)).out)?.[1];

        // One texture with a full chain, drawn at 64, 16 and 8 pixels across: levels 0, 2 and 3.
        const all = await scanline('view', capture, 'mip', '--session', session, '--json');

        assert.equal(all.code, 0, all.out);
        assert.deepEqual(all.json.data.textures, ['tex_1']);
        assert.deepEqual(all.json.data.levels, [{ level: 0, pixels: 4096 }, { level: 2, pixels: 256 }, { level: 3, pixels: 64 }]);
        assert.match(all.json.summary, /with the mip levels of tex_1 \(64×64, 7 levels\) drawn as flat colours/);
        assert.match(all.json.summary, /level 2 \(yellow\) {2}256 px/);
        assert.deepEqual(readFileSync(all.json.images[0].view).subarray(0, 4), PNG);

        // The texture without mipmaps is left alone unless it is named, and then has its one level.
        const one = await scanline('view', capture, 'mip', '--texture', 'tex_2', '--session', session, '--json');

        assert.deepEqual(one.json.data.textures, ['tex_2']);
        assert.deepEqual(one.json.data.levels, [{ level: 0, pixels: 1024 }]);

        // Before the smallest square is drawn, its level is not there.
        const early = await scanline('view', capture, 'mip', '--at_draw', 4, '--session', session, '--json');

        assert.deepEqual(early.json.data.levels, [{ level: 0, pixels: 4096 }, { level: 2, pixels: 256 }]);

        const wrong = await scanline('view', capture, 'mip', '--texture', 'tex_99', '--session', session);

        assert.equal(wrong.code, 1);
        assert.match(wrong.out, /"tex_99" is not a texture in cap_\d+/);

        // A frame with no mipmapped texture says so, and what that means.
        await scanline('close', '--session', session);

        const flat = await captured('b02');
        const none = await scanline('view', flat.capture, 'mip', '--session', flat.session);

        assert.match(none.out, /no texture the frame uses has more than one mip level, so every sample reads level 0/);
    });

    test('wireframe draws the frame as outlines', async () =>
    {
        const { capture, session } = await captured('b00');
        const whole = await scanline('view', capture, 'wireframe', '--session', session, '--json');

        assert.equal(whole.code, 0, whole.out);
        assert.deepEqual(readFileSync(whole.json.images[0].view).subarray(0, 4), PNG);

        // Outlines cover far less of the canvas than the filled frame does: most of it is still the clear colour.
        const filled = await scanline('pixels', 100, 220, '--capture', capture, '--session', session, '--json');

        assert.deepEqual(filled.json.data.rgba8, [187, 131, 75, 255], 'the middle of a crate, filled');

        const partial = await scanline('view', capture, 'wireframe', '--at-draw', 5, '--session', session, '--json');

        assert.match(partial.json.summary, /up to event 5/);

        const unknown = await scanline('view', capture, 'x-ray', '--session', session);

        assert.equal(unknown.code, 1);
        assert.match(unknown.out, /There is no "x-ray" view\. Views are overdraw, wireframe, draw_id, depth, stencil, mip and nan\./);
    });
});

describe('what the first evaluation asked for', () =>
{
    test('a capture of another page is called out', async () =>
    {
        const first = await captured('b00');
        const second = await captured('b01');

        const mine = await scanline('draw_list', second.capture, '--limit', 1, '--session', second.session);

        assert.match(mine.out, new RegExp(`^${second.capture} \\(frame \\d+ of http://[^)]*b01\\.html\\): 25 events`));

        const theirs = await scanline('draw_list', first.capture, '--limit', 1, '--session', second.session);

        assert.match(theirs.out, new RegExp(`WARNING: not a capture of the page ${second.session} has open`));
    });

    test('a query that names a column wrongly is shown the columns', async () =>
    {
        const { capture, session } = await captured('b00');
        const wrong = await scanline('query', capture, 'select name from commands', '--session', session);

        assert.equal(wrong.code, 1);
        assert.match(wrong.out, /no such column: name/);
        assert.match(wrong.out, /commands: command, method, args, draw, for_draw, gl_error/);
        assert.match(wrong.out, /draws: draw, command, .*pixels_changed, changed_box, path, entity, entity_detail, state/);
    });

    test('help shows how a call is typed, and each command explains itself', async () =>
    {
        const topic = await scanline('help', 'capture');

        assert.match(topic.out, /Worth a look/);
        assert.match(topic.out, /scanline draw --capture cap_1 --draw 7/);

        for (const asked of [['draw', '--help'], ['help', 'draw']])
        {
            const usage = await scanline(...asked);

            assert.match(usage.out, /^scanline draw <capture> <draw> \[--name value …\]/);
            assert.match(usage.out, /--draw +integer {2}\(position 2, required\)/);
            assert.match(usage.out, /Example: scanline draw cap_1 7/);
        }

        const launch = await scanline('launch', '--help');

        assert.match(launch.out, /^scanline launch <url>/);
        assert.match(launch.out, /--headless +boolean/);
    });
});
