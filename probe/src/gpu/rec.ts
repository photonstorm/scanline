// Recording for WebGPU methods the probe intercepts.
//
// A generated wrapper passes each call to the capture recorder itself. An intercepted
// method has a hand-written body instead, so it reports its own call here: the page's
// arguments, not the amended ones the browser was given.

import { METHOD_NAMES } from '../hooks/generated';
import { hub } from '../hooks/hub';
import { G } from '../natives';

const ids = new G.Map() as Map<string, number>;

export function methodId (name: string): number
{
    let id = ids.get(name);

    if (id === undefined)
    {
        id = METHOD_NAMES.indexOf(name);
        ids.set(name, id);
    }

    return id;
}

export function recordIntercepted (name: string, self: unknown, result: unknown, args: ArrayLike<unknown>): void
{
    const rec = hub.gpu.rec;

    if (rec !== null)
    {
        rec(hub.gpu, methodId(name), self, result, args.length, ...G.Array.from(args));
    }
}

// A range of a buffer the page has mapped, and where in the buffer it begins.
export interface MappedRange
{
    range: ArrayBuffer;
    offset: number;
}

// Set while a capture records: told when a buffer is about to be unmapped, with the ranges
// of it the page had mapped, so that what it wrote there can be read before they go.
export const mapWatch: { unmap: null | ((buffer: object, ranges: MappedRange[] | undefined) => void) } = { unmap: null };
