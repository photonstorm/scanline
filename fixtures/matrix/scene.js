// The scene every matrix page draws. See ../README.md.

export const WIDTH = 320;
export const HEIGHT = 240;
export const BACKGROUND = [32 / 255, 64 / 255, 96 / 255, 1];

// x, y, width, height in canvas pixels (origin top-left), then RGBA.
export const QUADS = [
    { name: 'background', x: 0, y: 0, w: 320, h: 240, colour: BACKGROUND },
    { name: 'red', x: 40, y: 40, w: 40, h: 40, colour: [1, 0, 0, 1] },
    { name: 'green', x: 140, y: 40, w: 40, h: 40, colour: [0, 1, 0, 1] },
    { name: 'blue', x: 240, y: 40, w: 40, h: 40, colour: [0, 0, 1, 1] },
    { name: 'mover', x: 0, y: 200, w: 20, h: 20, colour: [1, 1, 1, 1] }
];

export function moverX (elapsedMs)
{
    return Math.floor(elapsedMs * 0.06) % 300;
}

// One instance per quad: offset and scale in clip space, then colour. 8 floats each.
export function instanceData (elapsedMs)
{
    const data = new Float32Array(QUADS.length * 8);

    QUADS.forEach((quad, i) =>
    {
        const x = quad.name === 'mover' ? moverX(elapsedMs) : quad.x;

        // Clip space has y up; canvas pixels have y down.
        data.set([
            (x / WIDTH) * 2 - 1,
            1 - ((quad.y + quad.h) / HEIGHT) * 2,
            (quad.w / WIDTH) * 2,
            (quad.h / HEIGHT) * 2,
            ...quad.colour
        ], i * 8);
    });

    return data;
}

// Runs `draw(elapsedMs)` every frame and publishes the fixture's state.
export function loop (name, draw, schedule = (callback) => requestAnimationFrame(callback))
{
    const state = { name, frames: 0, elapsed: 0, lastDelta: 0, moverX: 0 };

    let first = null;

    const frame = (timestamp) =>
    {
        if (first === null)
        {
            first = timestamp;
        }

        state.lastDelta = timestamp - first - state.elapsed;
        state.elapsed = timestamp - first;
        state.moverX = moverX(state.elapsed);

        draw(state.elapsed);

        state.frames++;
        schedule(frame);
    };

    globalThis.fixture = state;
    schedule(frame);

    return state;
}
