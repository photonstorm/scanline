// What becomes of a draw's primitives once its vertex shader has placed them: how many
// would reach the rasteriser at all, and why the others would not. Shared by the WebGL and
// WebGPU geometry recipes, which differ only in how they read the positions.

type Json = any;

// Topologies, by the numbers WebGL gives them.
export const POINTS = 0x0000;
export const LINES = 0x0001;
export const LINE_LOOP = 0x0002;
export const LINE_STRIP = 0x0003;
export const TRIANGLES = 0x0004;
export const TRIANGLE_STRIP = 0x0005;

export function tally (
    named: number[],                                // the vertices the draw names, in order
    at: (vertex: number) => number[] | null,        // a vertex's clip-space position, if it was read
    mode: number,
    clockwise: boolean,                             // whether a clockwise triangle faces the front
    show: number,
    zeroToOne: boolean                              // depth runs from 0 to w (WebGPU), not −w to w
): Json
{
    // The primitives, as lists of vertex numbers, in the winding the mode gives them.
    const primitives: number[][] = [];
    const n = named.length;

    switch (mode)
    {
        case POINTS: for (let i = 0; i < n; i++) { primitives.push([named[i]]); } break;
        case LINES: for (let i = 0; i + 1 < n; i += 2) { primitives.push([named[i], named[i + 1]]); } break;
        case LINE_STRIP: for (let i = 0; i + 1 < n; i++) { primitives.push([named[i], named[i + 1]]); } break;
        case LINE_LOOP:
            for (let i = 0; i + 1 < n; i++) { primitives.push([named[i], named[i + 1]]); }
            if (n > 2) { primitives.push([named[n - 1], named[0]]); }
            break;
        case TRIANGLES: for (let i = 0; i + 2 < n; i += 3) { primitives.push([named[i], named[i + 1], named[i + 2]]); } break;
        case TRIANGLE_STRIP: for (let i = 0; i + 2 < n; i++) { primitives.push(i % 2 ? [named[i + 1], named[i], named[i + 2]] : [named[i], named[i + 1], named[i + 2]]); } break;
        default: for (let i = 1; i + 1 < n; i++) { primitives.push([named[0], named[i], named[i + 1]]); } break;
    }

    const per = mode === POINTS ? 1 : (mode <= LINE_STRIP ? 2 : 3);
    const counts = { total: primitives.length, unread: 0, nan: 0, behind: 0, outside: 0, flat: 0, reach: 0, front: 0, back: 0 };
    const planes: Record<string, number> = { left: 0, right: 0, bottom: 0, top: 0, near: 0, far: 0 };
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

    const sides: Array<[string, (c: number[]) => boolean]> = [
        ['left', (c) => c[0] < -c[3]], ['right', (c) => c[0] > c[3]],
        ['bottom', (c) => c[1] < -c[3]], ['top', (c) => c[1] > c[3]],
        ['near', (c) => c[2] < (zeroToOne ? 0 : -c[3])], ['far', (c) => c[2] > c[3]]
    ];

    for (const primitive of primitives)
    {
        const found = primitive.map(at);

        if (found.some((vertex) => vertex === null))
        {
            counts.unread++;
            continue;
        }

        const v = found as number[][];

        if (v.some((vertex) => vertex.some((part) => !Number.isFinite(part))))
        {
            counts.nan++;
            continue;
        }

        if (v.every((vertex) => vertex[3] <= 0))
        {
            counts.behind++;
            continue;
        }

        // Wholly beyond one side of the view volume: clipped away entire.
        const beyond = sides.find(([, test]) => v.every(test));

        if (beyond)
        {
            counts.outside++;
            planes[beyond[0]]++;
            continue;
        }

        if (per === 3 && v.every((vertex) => vertex[3] > 0))
        {
            const [a, b, c] = v.map((vertex) => [vertex[0] / vertex[3], vertex[1] / vertex[3]]);
            const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);

            if (Math.abs(area) < 1e-12)
            {
                counts.flat++;
                continue;
            }

            // Counter-clockwise, seen with y up, is a positive area.
            if ((area > 0) !== clockwise) { counts.front++; } else { counts.back++; }
        }

        for (const vertex of v)
        {
            if (vertex[3] > 0)
            {
                for (let axis = 0; axis < 3; axis++)
                {
                    const ndc = vertex[axis] / vertex[3];

                    bounds.min[axis] = Math.min(bounds.min[axis], ndc);
                    bounds.max[axis] = Math.max(bounds.max[axis], ndc);
                }
            }
        }

        counts.reach++;
    }

    return {
        ...counts,
        per,
        planes,
        bounds: counts.reach > 0 ? bounds : null,
        first: named.slice(0, show).map((vertex) => at(vertex))
    };
}
