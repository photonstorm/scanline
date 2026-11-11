// What Scanline says, unasked, about each planted bug (fixtures/bugs, evals/bugs.json).
//
//   npm run build && cargo build && npm run test:findings
//
// The agent evaluation in evals/ measures whether an agent finds each bug. These tests pin
// down what the tool hands it: for each bug, the capture's summary or one further command
// has to state the fact that is the cause. The correct page has to raise nothing.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { repoRoot, serve } from '../spikes/lib/serve.mjs';

const binary = join(repoRoot, 'target', 'debug', 'scanline');
const home = mkdtempSync(join(tmpdir(), 'scanline-findings-'));
const env = { ...process.env, SCANLINE_HOME: home };

let server;

function scanline (...args)
{
    return new Promise((resolve) =>
    {
        execFile(binary, args.map(String), { env, timeout: 60000 }, (error, stdout, stderr) =>
        {
            resolve({ code: error ? error.code ?? 1 : 0, out: (stdout + stderr).trim() });
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

        const memory = await scanline('memory', '--session', session);

        assert.match(memory.out, /LIKELY LEAK: \d+ textures/);
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
        assert.match(wrong.out, /draws: draw, command, .*pixels_changed, changed_box, state/);
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
