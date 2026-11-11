// Checks that every planted bug shows the symptom its manifest entry describes, and that
// the reference scene shows none of them. A planted bug that does not reproduce would make
// an evaluation meaningless.
//
//   npm run build && node --test tests/bugs.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { open } from '../spikes/lib/session.mjs';
import { serve } from '../spikes/lib/serve.mjs';
import { score } from '../evals/score.mjs';

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
            assert.deepEqual(await pixel([30, 320]), [64, 128, 51, 255], 'the ground');
            assert.deepEqual(await pixel([250, 210]), [131, 118, 146, 255], 'a crate through the glass');
            assert.deepEqual(await pixel([419, 49]), [255, 204, 51, 255], 'a dot on the minimap');
            assert.deepEqual(await pixel([60, 18]), [255, 84, 40, 255], 'the health bar');

            const before = await textures();

            await step(30);

            assert.equal(await textures(), before, 'no textures are created as it runs');
            assert.equal((await stats()).counters.compiles.max, 0, 'and no shaders are compiled');
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
                    assert.deepEqual(await pixel(check.pixel), check.value);
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
                else if (check.counter)
                {
                    assert.ok((await stats()).counters[check.counter].last >= 2, 'shaders are compiled in every frame');
                }
            });
        });
    }

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
