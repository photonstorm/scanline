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

const binary = join(repoRoot, 'target', 'debug', 'scanline');
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
    if (existsSync(join(home, 'control.sock')))
    {
        await scanline('stop');
    }
});

// GPU time of a frame, the middle of thirty.
async function gpuTime ()
{
    await scanline('step', 34);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const stats = await scanline('stats', '--window_frames', 30, '--json');

    assert.ok(stats.json.data.gpu.frames > 10, stats.out);

    return stats.json.data.gpu.ms.p50;
}

// J3. Slow frame: profile, find the pass and the shader, test that the cost is fill, read
// the shader, patch it live, compare the picture and the timing, and get the source change.
async function slowFrame (page, programs)
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
    const patched = await scanline('patch_shader', worst.shader, '--edits', JSON.stringify([{ find: programs.find, replace: programs.replace }]));

    assert.match(patched.out, /pat_\d+: .*compiled/s, patched.out);

    // 5. The picture is all but the same, and the frame is much cheaper.
    await scanline('step', 1);

    const after = await scanline('screenshot', '--json');
    const difference = await scanline('diff', '--a', before.json.images[0].original, '--b', after.json.images[0].original, '--json');

    assert.equal(difference.code, 0, difference.out);
    assert.ok(difference.json.data.mean < 6, `the picture barely moved: ${difference.json.summary}`);

    const afterMs = await gpuTime();

    assert.ok(afterMs < beforeMs * 0.75, `${afterMs} ms a frame after the patch, ${beforeMs} ms before`);

    // 6. The change to make in the source.
    const listed = await scanline('patches');

    assert.match(listed.out, new RegExp(`${programs.find}» → «${programs.replace}`), listed.out);

    // Reverting puts the cost back.
    await scanline('patches', '--revert', 'all');

    const reverted = await gpuTime();

    assert.ok(reverted > afterMs * 1.25, `${reverted} ms a frame once reverted, ${afterMs} ms patched`);
}

describe('J3, the slow frame', () =>
{
    test('on WebGL 2', async () =>
    {
        await slowFrame('fixtures/slow/webgl2.html', { shafts: 'prg_3', find: 'SAMPLES = 64', replace: 'SAMPLES = 24' });
    });
});
