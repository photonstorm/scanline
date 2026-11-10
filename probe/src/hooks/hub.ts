// What every generated wrapper talks to: the overhead level, the record for the object a
// call was made on, and the frame counters.

import type { Tag } from '../tag';
import { contextTag, extensionTag } from '../tags.generated';
import { COUNTERS } from './generated';

type CounterName = typeof COUNTERS[number];

export type Counters = Record<CounterName, number>;

// One per WebGL context, plus one shared by all WebGPU objects until the registry
// (milestone 2) gives each device its own.
export interface Rec extends Counters
{
    // Set while a capture is recording: (record, methodId, receiver, result, argCount, ...args).
    rec: null | ((record: Rec, method: number, self: unknown, result: unknown, count: number, ...args: any[]) => void);

    // The value of `calls` when this record's image was last kept.
    keptAtCalls: number;

    // The tracker for the context this record belongs to (gl/tracker.ts), once it has one.
    x: unknown;
}

export interface Hub
{
    // True at the `off` level: wrappers call straight through.
    off: boolean;
    ctx: (gl: object) => Rec;
    ext: (extension: object) => Rec;
    gpu: Rec;
    draw: (record: Rec, mode: number, count: number, instances: number) => void;
    multiDraw: (record: Rec, mode: number, drawCount: number) => void;
}

export function newRecord (): Rec
{
    const record: any = { rec: null, keptAtCalls: -1, x: null };

    for (const name of COUNTERS)
    {
        record[name] = 0;
    }

    return record as Rec;
}

// Records ride on the context and extension objects themselves (see tag.ts): finding one
// costs a property read, not a map lookup, on every graphics call.
const contexts: Tag<Rec> = contextTag;
const extensions: Tag<Rec> = extensionTag;

export function recordFor (gl: object): Rec
{
    let record = contexts.get(gl);

    if (record === undefined)
    {
        record = newRecord();
        contexts.set(gl, record);
    }

    return record;
}

export function bindExtension (extension: object, record: Rec): void
{
    extensions.set(extension, record);
}

// Calls on objects the probe never saw created land here, so they are still counted.
const orphan = newRecord();

export const hub: Hub = {

    off: false,

    ctx (gl: object): Rec
    {
        return contexts.get(gl) ?? recordFor(gl);
    },

    ext (extension: object): Rec
    {
        return extensions.get(extension) ?? orphan;
    },

    gpu: newRecord(),

    // `mode` is a WebGL primitive mode, or -1 when the topology lives in a pipeline.
    // `count` and `instances` are -1 when they are not arguments (indirect draws).
    draw (record: Rec, mode: number, count: number, instances: number): void
    {
        const copies = instances > 0 ? instances : (instances === 0 ? 0 : 1);

        record.draws++;
        record.instances += copies;

        if (count > 0)
        {
            record.vertices += count * copies;

            if (mode === 4)
            {
                record.triangles += ((count / 3) | 0) * copies;
            }
            else if (mode === 5 || mode === 6)
            {
                record.triangles += (count - 2) * copies;
            }
        }
    },

    multiDraw (record: Rec, _mode: number, drawCount: number): void
    {
        record.draws += drawCount > 0 ? drawCount : 0;
    }
};

export function totals (records: Rec[]): Counters
{
    const sum: any = {};

    for (const name of COUNTERS)
    {
        sum[name] = 0;

        for (const record of records)
        {
            sum[name] += record[name];
        }
    }

    return sum as Counters;
}
