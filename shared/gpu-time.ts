// A frame's GPU time from the time stamps of its passes.
//
// WebGPU gives each pass a time stamp as it starts and one as it ends. The passes of a frame
// need not run one after another: a tile-based GPU (Apple's) does the vertex work of every
// pass in a command buffer early and their fragment work later, so a small pass that follows
// a large one starts just after it and ends just after it, and reads nearly as long. Added
// up, such a frame counts the same stretch of time once for every pass that was open.
//
// So the frame's time is the time at least one pass was open: the union of the intervals.
//
// No imports, and nothing of the page's that a page could have replaced (no Math, no
// Array statics): the probe runs this inside the page. The tests run it in Node.

export interface PassInterval
{
    // Times on the GPU's clock from any fixed point, in any one unit. Whole numbers (of
    // nanoseconds, say) keep the sums exact.
    start: number;
    end: number;
}

export interface FrameGpuTime
{
    // Time at least one pass was open: the frame's GPU time.
    busy: number;
    // From the first pass starting to the last ending. More than `busy` when the GPU had
    // nothing of the frame's to do between two passes.
    span: number;
    // The passes' own times added up. More than `busy` when passes overlap.
    sum: number;
    // What adding up counts more than once: sum - busy, and never less than zero.
    overlap: number;
    // What each pass added, in the order given: the part of its interval that no pass
    // ending sooner had covered. These add up to `busy`.
    added: number[];
}

export function frameGpuTime (passes: readonly PassInterval[]): FrameGpuTime
{
    const count = passes.length;
    const added: number[] = [];
    const order: number[] = [];

    let sum = 0;
    let first = 0;
    let last = 0;

    for (let i = 0; i < count; i++)
    {
        const { start, end } = passes[i];

        added.push(0);
        order.push(i);
        sum += end - start;

        if (i === 0 || start < first)
        {
            first = start;
        }

        if (i === 0 || end > last)
        {
            last = end;
        }
    }

    // By when each ended, and by when it started among those that ended together.
    order.sort((a, b) => passes[a].end - passes[b].end || passes[a].start - passes[b].start);

    // The stretches covered so far, apart from one another and in order of time.
    let covered: Array<[number, number]> = [];
    let busy = 0;

    for (const index of order)
    {
        const from = passes[index].start;
        const to = passes[index].end;
        const kept: Array<[number, number]> = [];

        let start = from;
        let end = to;
        let inside = 0;

        for (const stretch of covered)
        {
            if (stretch[1] < from || stretch[0] > to)
            {
                kept.push(stretch);

                continue;
            }

            // It meets this pass: count what they share, and make one stretch of the two.
            inside += (stretch[1] < to ? stretch[1] : to) - (stretch[0] > from ? stretch[0] : from);
            start = stretch[0] < start ? stretch[0] : start;
            end = stretch[1] > end ? stretch[1] : end;
        }

        kept.push([start, end]);
        kept.sort((a, b) => a[0] - b[0]);
        covered = kept;

        const more = to - from - inside;

        added[index] = more > 0 ? more : 0;
        busy += added[index];
    }

    return { busy, span: last - first, sum, overlap: sum > busy ? sum - busy : 0, added };
}
