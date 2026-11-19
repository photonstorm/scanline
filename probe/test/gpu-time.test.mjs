// Tests of how a WebGPU frame's GPU time is worked out from its passes' time stamps, which
// run in Node with no browser.
//
//   node --test probe/test/gpu-time.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameGpuTime } from '../../shared/gpu-time.ts';

const pass = (start, end) => ({ start, end });

test('no passes take no time', () =>
{
    assert.deepEqual(frameGpuTime([]), { busy: 0, span: 0, sum: 0, overlap: 0, added: [] });
});

test('one pass is the frame', () =>
{
    assert.deepEqual(frameGpuTime([pass(100, 350)]), { busy: 250, span: 250, sum: 250, overlap: 0, added: [250] });
});

test('passes one after another add up', () =>
{
    // Touching, as an immediate-mode GPU runs them.
    assert.deepEqual(frameGpuTime([pass(0, 300), pass(300, 400), pass(400, 1000)]), { busy: 1000, span: 1000, sum: 1000, overlap: 0, added: [300, 100, 600] });
});

test('time the GPU had nothing of the frame to do between passes is not counted', () =>
{
    const time = frameGpuTime([pass(0, 300), pass(500, 600)]);

    assert.equal(time.busy, 400);
    assert.equal(time.span, 600);
    assert.equal(time.sum, 400);
    assert.equal(time.overlap, 0);
    assert.deepEqual(time.added, [300, 100]);
});

test('passes that overlap are counted once: a scene pass and a HUD pass on a tile-based GPU', () =>
{
    // As Apple's GPU stamped one frame of a game, in microseconds: the HUD pass (a line of
    // text) starts just after the scene pass and ends just after it.
    const scene = pass(655, 12583);
    const hud = pass(1049, 13697);
    const time = frameGpuTime([pass(0, 1311), pass(328, 1638), scene, hud]);

    assert.equal(time.busy, 13697, 'first start to last end, there being no gap');
    assert.equal(time.span, 13697);
    assert.equal(time.sum, 1311 + 1310 + 11928 + 12648, 'what adding the passes up would have said');
    assert.equal(time.overlap, time.sum - time.busy);

    // What each added beyond the passes that ended before it: the HUD pass, 12.6 ms from
    // its start to its end, added 1.1 ms.
    assert.deepEqual(time.added, [1311, 327, 10945, 1114]);
    assert.equal(time.added.reduce((a, b) => a + b, 0), time.busy);
});

test('a pass inside another adds nothing, and the order given does not matter', () =>
{
    const inner = pass(200, 300);
    const outer = pass(0, 1000);

    assert.deepEqual(frameGpuTime([inner, outer]), { busy: 1000, span: 1000, sum: 1100, overlap: 100, added: [100, 900] });
    assert.deepEqual(frameGpuTime([outer, inner]), { busy: 1000, span: 1000, sum: 1100, overlap: 100, added: [900, 100] });
});

test('a pass that joins two stretches adds only the gap between them', () =>
{
    // Ends last, so it is counted last: it covers both of the others and the 100 between.
    const time = frameGpuTime([pass(0, 200), pass(300, 500), pass(100, 600)]);

    assert.equal(time.busy, 600);
    assert.equal(time.sum, 900);
    assert.equal(time.overlap, 300);
    assert.deepEqual(time.added, [200, 200, 200]);
});

test('a pass shorter than a time stamp step is there and adds nothing', () =>
{
    const time = frameGpuTime([pass(0, 0), pass(0, 131), pass(131, 131)]);

    assert.equal(time.busy, 131);
    assert.equal(time.overlap, 0);
    assert.deepEqual(time.added, [0, 131, 0]);
});

test('passes that share an end are counted once between them', () =>
{
    const time = frameGpuTime([pass(50, 400), pass(0, 400)]);

    assert.equal(time.busy, 400);
    assert.deepEqual(time.added, [0, 400], 'the one that started sooner is counted first');
});
