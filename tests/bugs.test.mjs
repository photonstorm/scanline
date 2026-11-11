// Checks that every planted bug shows the symptom its manifest entry describes, and that
// the reference scene shows none of them. A planted bug that does not reproduce would make
// an evaluation meaningless.
//
//   npm run build && node --test tests/bugs.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { open } from '../spikes/lib/session.mjs';
import { serve } from '../spikes/lib/serve.mjs';
import { run } from '../evals/run.mjs';
import { score } from '../evals/score.mjs';
import { assertPixel } from './host.mjs';

const manifest = JSON.parse(readFileSync(new URL('../evals/bugs.json', import.meta.url), 'utf8'));

let server;

before(async () =>
{
    server = await serve();
});

after(async () =>
{
    await server.close();
});

// The scene after 20 frames, and what the probe measured over them.
async function look (id, body)
{
    const session = await open({ url: server.url(`fixtures/bugs/${id}.html`), startPaused: true });

    try
    {
        // The WebGPU scene asks for its device before it draws: wait until it has one, or
        // the frames would be stepped past a page that is not ready to draw them.
        // (window.game is the canvas itself, by its id, until the scene puts its state there.)
        for (let tries = 0; tries < 200 && !(await session.evaluate('typeof window.game?.frame === "number"')); tries++)
        {
            await new Promise((done) => setTimeout(done, 25));
        }

        await session.probe('step', { frames: 20 });

        await body({
            pixel: async ([x, y]) => (await session.probe('image.pixels', { context: 1, x, y })).rgba8,
            stats: () => session.probe('stats', { frames: 10 }),
            textures: async () => (await session.probe('registry.summary')).byKind.texture.alive,
            step: (frames) => session.probe('step', { frames })
        });

        assert.deepEqual(session.exceptions, []);
    }
    finally
    {
        await session.close();
    }
}

describe('the planted bugs', () =>
{
    test('the reference scene is right', async () =>
    {
        await look('b00', async ({ pixel, stats, textures, step }) =>
        {
            assert.deepEqual(await pixel([100, 220]), [187, 131, 75, 255], 'a crate');
            // The ground's green is a tint of 0.5: 127.5, which Metal rounds up and Direct3D down.
            assertPixel(await pixel([30, 320]), [64, [127, 128], 51, 255], 'the ground');
            assert.deepEqual(await pixel([250, 210]), [131, 118, 146, 255], 'a crate through the glass');
            assert.deepEqual(await pixel([419, 49]), [255, 204, 51, 255], 'a dot on the minimap');
            assert.deepEqual(await pixel([60, 18]), [255, 84, 40, 255], 'the health bar');

            const before = await textures();

            await step(30);

            assert.equal(await textures(), before, 'no textures are created as it runs');
            assert.equal((await stats()).counters.compiles.max, 0, 'and no shaders are compiled');
        });
    });

    test('the WebGPU reference scene is right', async () =>
    {
        await look('w00', async ({ pixel, stats, textures, step }) =>
        {
            // The crate is a texture under a tint, and the ground a tint of 0.5: each lands
            // between two values, and Metal and Direct3D round them apart.
            assertPixel(await pixel([100, 220]), [188, [131, 132], 75, 255], 'a crate');
            assertPixel(await pixel([30, 320]), [64, [127, 128], 51, 255], 'the ground');
            assert.deepEqual(await pixel([250, 210]), [133, 120, 147, 255], 'a crate through the glass');
            assert.deepEqual(await pixel([419, 49]), [255, 204, 51, 255], 'a dot on the minimap');
            assert.deepEqual(await pixel([60, 18]), [255, 84, 40, 255], 'the health bar');

            const before = await textures();

            await step(30);

            assert.equal(await textures(), before, 'no textures are created as it runs');
            assert.equal((await stats()).counters.compiles.max, 0, 'and no shader modules are compiled');
        });
    });

    for (const bug of manifest.bugs)
    {
        test(`${bug.id} (${bug.class}): ${bug.symptom}`, async () =>
        {
            await look(bug.id, async ({ pixel, stats, textures, step }) =>
            {
                const check = bug.check;

                if (check.pixel && check.is === 'exactly')
                {
                    // A channel the manifest gives two values for is one that Metal and
                    // Direct3D round apart.
                    assertPixel(await pixel(check.pixel), check.value, bug.id);
                }
                else if (check.pixel)
                {
                    assert.notDeepEqual(await pixel(check.pixel), check.reference, 'differs from the reference scene here');
                }
                else if (check.growth)
                {
                    const before = await textures();

                    await step(30);

                    assert.equal(await textures() - before, 30, 'one more texture alive for every frame');
                }
                else if (check.flicker)
                {
                    // Right on the frames either side, wrong on the one frame in `every`.
                    const { pixel: at, reference, every } = check.flicker;

                    await step(every - 21);
                    assert.deepEqual(await pixel(at), reference, 'right the frame before');

                    await step(1);
                    assert.notDeepEqual(await pixel(at), reference, 'wrong on the frame that flickers');

                    await step(1);
                    assert.deepEqual(await pixel(at), reference, 'right again the frame after');
                }
                else if (check.counter)
                {
                    assert.ok((await stats()).counters[check.counter].last >= (check.least ?? 2), 'shaders are compiled in every frame');
                }
            });
        });
    }

    test('the runner gives each bug to an agent, keeps what it prints and scores it', async () =>
    {
        // A stand-in for an agent: it reads the prompt and answers b03 rightly, b01 wrongly,
        // and never answers b05.
        const folder = mkdtempSync(join(tmpdir(), 'scanline-runner-'));
        const agent = join(folder, 'agent.mjs');

        writeFileSync(agent, `
            let prompt = '';
            for await (const chunk of process.stdin) prompt += chunk;
            const id = /bugs\\/(b\\d+)\\.html/.exec(prompt)[1];
            if (id === 'b03') console.log(${JSON.stringify(`CAUSE: ${manifest.bugs.find((bug) => bug.id === 'b03').diagnosis}\nCALLS: 4`)});
            else if (id === 'b05') await new Promise((done) => setTimeout(done, 30000));
            else console.log('CAUSE: unknown.\\nCALLS: 2');
        `);

        const log = console.log;

        console.log = () => undefined;

        try
        {
            const out = join(folder, 'out');
            const summary = await run({ agent: `node ${JSON.stringify(agent)}`, bugs: 'b01,b03,b05', out, timeout: '2', origin: server.origin });

            assert.deepEqual(summary.rows.map((row) => [row.id, row.correct, row.calls, row.ended]), [['b01', false, 2, null], ['b03', true, 4, null], ['b05', false, null, 'stopped after 2 s']]);
            assert.equal(summary.correct, 1);
            assert.equal(summary.medianCalls, 4);
            assert.match(readFileSync(join(out, 'b03.txt'), 'utf8'), /^CAUSE: /);
            assert.equal(JSON.parse(readFileSync(join(out, 'scores.json'), 'utf8')).bugs, 3);
            await assert.rejects(run({}), /Say which agent to run/);
        }
        finally
        {
            console.log = log;
            rmSync(folder, { recursive: true, force: true });
        }
    });

    test('the scorer accepts the written diagnosis of every bug, and rejects an empty one', () =>
    {
        for (const bug of manifest.bugs)
        {
            const good = score(bug.id, `CAUSE: ${bug.diagnosis}\nEVIDENCE: seen.\nFIX: ${bug.fix}\nCALLS: 7`);

            assert.equal(good.correct, true, `${bug.id}: its own diagnosis should score as correct (missing ${good.missing.join('; ')})`);
            assert.equal(good.calls, 7);
            assert.equal(score(bug.id, 'CAUSE: I could not find it.\nCALLS: 30').correct, false, bug.id);
        }
    });
});
