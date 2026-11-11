// The journeys of the specification (01-PRD.md, section 7), run end to end through the CLI
// the way an agent would run them.
//
//   npm run build && cargo build && npm run test:journeys

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { repoRoot, serve } from '../spikes/lib/serve.mjs';

import { binary, hostRunning } from './host.mjs';
const home = mkdtempSync(join(tmpdir(), 'scanline-journeys-'));
const env = { ...process.env, SCANLINE_HOME: home };

let server;

function scanline (...args)
{
    return new Promise((resolve) =>
    {
        execFile(binary, args.map(String), { env, timeout: 90000 }, (error, stdout, stderr) =>
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
    if (hostRunning(home))
    {
        await scanline('stop');
    }
});

// Frame statistics over thirty frames, once the GPU's timings for them have come back.
// They arrive a few frames late, and later still on a busy machine.
async function timed ()
{
    await scanline('step', 34);

    let stats = null;

    for (let attempt = 0; attempt < 8; attempt++)
    {
        await new Promise((resolve) => setTimeout(resolve, 150));
        stats = await scanline('stats', '--window_frames', 30, '--json');

        if (stats.json?.data.gpu.frames > 10)
        {
            return stats;
        }

        await scanline('step', 4);
    }

    assert.fail(`GPU timings did not arrive: ${stats?.out}`);
}

// GPU time of a frame, the middle of thirty.
async function gpuTime ()
{
    return (await timed()).json.data.gpu.ms.p50;
}

const middle = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];

// GPU time with a patch and without it, measured turn about: after the first reading of
// each, the patch is reverted and applied twice more, with a reading each time. It ends
// with the patch in force.
//
// A desktop graphics card slows its clock when it has little to do, so the same frame can
// take several times as long a few seconds later: through Direct3D on an NVIDIA card this
// scene was seen to go from 0.27 ms to 2 ms with nothing changed. One reading of each would
// compare two states of the machine and not two shaders. The middle reading of each kind is
// what is compared.
//
// Turn about is not always enough. On such a card a lighter frame can slow the clock
// further, and the readings of one unchanged frame have been seen a factor of four apart
// inside ten seconds. When the readings of the same frame are not within half as much
// again of each other, a difference between the two kinds says nothing about the shader:
// the comparison is then reported and not asserted. On a GPU whose clock holds (the Mac's)
// the readings agree and it is asserted.
const steady = (values) => Math.max(...values) <= Math.min(...values) * 1.5;

function timingHolds (context, holds, sets, said)
{
    if (sets.every(steady))
    {
        assert.ok(holds, said);
    }
    else
    {
        context.diagnostic(`GPU time was not steady on this machine, so it was not compared: ${said}`);
    }
}

async function turnAbout (beforeMs, afterMs, apply)
{
    const patched = [afterMs];
    const reverted = [];

    for (let round = 0; round < 2; round++)
    {
        await scanline('patches', '--revert', 'all');
        reverted.push(await gpuTime());
        await apply();
        patched.push(await gpuTime());
    }

    return { plain: [beforeMs, ...reverted], patched, reverted };
}

// J3. Slow frame: profile, find the pass and the shader, test that the cost is fill, read
// the shader, patch it live, compare the picture and the timing, and get the source change.
async function slowFrame (context, page, programs)
{
    const launched = await scanline('launch', server.url(page), '--headless', '--paused');

    assert.match(launched.out, /Launched ses_1/, launched.out);

    await scanline('step', 6);

    // 1. Where does the GPU time go?
    const taken = await scanline('capture');
    const capture = /^(cap_\d+):/m.exec(taken.out)?.[1];

    assert.ok(capture, taken.out);

    const byShader = await scanline('profile', capture, '--by', 'shader', '--json');

    assert.equal(byShader.code, 0, byShader.out);

    const worst = byShader.json.data.rows[0];

    assert.equal(worst.shader, programs.shafts, byShader.json.summary);
    assert.ok(worst.ns > byShader.json.data.total_ns * 0.8, `the shafts take most of the frame: ${byShader.json.summary}`);
    assert.equal(worst.draws.length, 1, 'in one draw');

    // 2. Is it fill? With every draw clipped to a pixel the time goes.
    const clipped = await scanline('experiment', 'scissor_1px', '--frames', 30, '--json');

    assert.equal(clipped.code, 0, clipped.out);

    const fill = clipped.json.data.gpu_ms;

    assert.ok(fill.with < fill.without * 0.5, `clipped ${fill.with} ms against ${fill.without} ms`);

    // 3. What does the shader do for each pixel?
    const read = await scanline('shader_analysis', worst.shader);

    assert.match(read.out, /up to 64 samples every time the shader runs/, read.out);

    // 4. Patch it live to 24 samples.
    const beforeMs = await gpuTime();
    const before = await scanline('screenshot', '--json');
    const apply = () => scanline('patch_shader', worst.shader, '--edits', JSON.stringify([{ find: programs.find, replace: programs.replace }]));
    const patched = await apply();

    assert.match(patched.out, /pat_\d+: .*compiled/s, patched.out);

    // 5. The picture is all but the same, and the frame is much cheaper.
    await scanline('step', 1);

    const after = await scanline('screenshot', '--json');
    const difference = await scanline('diff', '--a', before.json.images[0].original, '--b', after.json.images[0].original, '--json');

    assert.equal(difference.code, 0, difference.out);
    assert.ok(difference.json.data.mean < 6, `the picture barely moved: ${difference.json.summary}`);

    const times = await turnAbout(beforeMs, await gpuTime(), apply);

    timingHolds(context, middle(times.patched) < middle(times.plain) * 0.75, [times.patched, times.plain], `${times.patched} ms a frame with the patch, ${times.plain} ms without`);

    // 6. The change to make in the source.
    const listed = await scanline('patches');

    assert.match(listed.out, new RegExp(`${programs.find}» → «${programs.replace}`), listed.out);

    // Reverting puts the cost back.
    await scanline('patches', '--revert', 'all');
    times.reverted.push(await gpuTime());

    timingHolds(context, middle(times.reverted) > middle(times.patched) * 1.25, [times.reverted, times.patched], `${times.reverted} ms a frame once reverted, ${times.patched} ms patched`);
}

// The same journey on WebGPU. The pass comes from the live per-pass GPU timings, and the
// pipeline from a capture of the frame; the rest is the same commands.
async function slowFrameGpu (context, page)
{
    const launched = await scanline('launch', server.url(page), '--headless', '--paused');

    assert.match(launched.out, /Launched ses_1/, launched.out);

    // 1. Where does the GPU time go? One pass has most of it.
    const stats = await timed();
    const passes = [...stats.json.data.gpu.passes].sort((a, b) => b.mean - a.mean);

    assert.equal(passes[0].label, 'godrays', stats.json.summary);
    assert.ok(passes[0].mean > stats.json.data.gpu.ms.mean * 0.6, stats.json.summary);

    // Which draw, and which pipeline, is that pass? Its label is the draw's group.
    const taken = await scanline('capture');
    const capture = /^(cap_\d+):/m.exec(taken.out)?.[1];

    assert.ok(capture, taken.out);

    const draws = await scanline('query', capture, "SELECT draw, program FROM draws WHERE kind = 'draw' AND path = 'godrays'", '--json');

    assert.equal(draws.json.data.rows.length, 1, 'one draw in the pass');

    const pipeline = draws.json.data.rows[0][1];

    assert.match(pipeline, /^pip_\d+$/);

    // 2. Is it fill?
    const clipped = await scanline('experiment', 'scissor_1px', '--frames', 30, '--json');
    const fill = clipped.json.data.gpu_ms;

    assert.ok(fill.with < fill.without * 0.5, `clipped ${fill.with} ms against ${fill.without} ms`);

    // 3. What does the shader do for each pixel?
    const read = await scanline('shader_analysis', pipeline);

    assert.match(read.out, /up to 64 samples every time the shader runs/, read.out);

    // 4. Patch it live to 24 samples.
    const beforeMs = await gpuTime();
    const before = await scanline('screenshot', '--json');
    const apply = () => scanline('patch_shader', pipeline, '--edits', JSON.stringify([{ find: 'SAMPLES: i32 = 64', replace: 'SAMPLES: i32 = 24' }]));
    const patched = await apply();

    assert.match(patched.out, /pat_\d+: .*It compiled, and the pipelines rebuilt with it are valid/s, patched.out);

    // 5. The picture is all but the same, and the frame is much cheaper.
    await scanline('step', 1);

    const after = await scanline('screenshot', '--json');
    const difference = await scanline('diff', '--a', before.json.images[0].original, '--b', after.json.images[0].original, '--json');

    assert.ok(difference.json.data.mean < 6, `the picture barely moved: ${difference.json.summary}`);

    const times = await turnAbout(beforeMs, await gpuTime(), apply);

    timingHolds(context, middle(times.patched) < middle(times.plain) * 0.75, [times.patched, times.plain], `${times.patched} ms a frame with the patch, ${times.plain} ms without`);

    // 6. The change to make in the source.
    const listed = await scanline('patches');

    assert.match(listed.out, /SAMPLES: i32 = 64» → «SAMPLES: i32 = 24»/, listed.out);

    await scanline('patches', '--revert', 'all');
    times.reverted.push(await gpuTime());

    timingHolds(context, middle(times.reverted) > middle(times.patched) * 1.25, [times.reverted, times.patched], `${times.reverted} ms a frame once reverted, ${times.patched} ms patched`);
}

describe('J3, the slow frame', () =>
{
    test('on WebGL 2', async (context) =>
    {
        await slowFrame(context, 'fixtures/slow/webgl2.html', { shafts: 'prg_3', find: 'SAMPLES = 64', replace: 'SAMPLES = 24' });
    });

    test('on WebGPU', async (context) =>
    {
        await slowFrameGpu(context, 'fixtures/slow/webgpu.html');
    });
});
