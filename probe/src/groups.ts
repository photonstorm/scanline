// Named groups around draws, and the game objects they belong to (05-PAGE-PROTOCOL.md,
// sections 1.1 and 4). The page declares them through the protocol; an adapter declares
// them for an engine it recognises. Both end up here.
//
// A group costs one entry in the frame's list, and one more in a capture if one is running.

import { G } from './natives';

export type GroupOp = 'push' | 'pop' | 'entity';

// Where a capture in progress takes the same calls (capture.ts).
let sink: ((op: GroupOp, payload: unknown) => void) | null = null;

// Draws issued so far, on every context (index.ts).
let drawsNow: () => number = () => 0;

export function setGroupSink (to: (op: GroupOp, payload: unknown) => void): void
{
    sink = to;
}

export function setDrawCounter (counter: () => number): void
{
    drawsNow = counter;
}

// The groups that are open now, outermost first.
const stack: string[] = [];

// This frame's calls in order, and the last whole frame's.
const LIMIT = 20000;

type Row = [op: GroupOp, payload: unknown, draws: number];

let current: Row[] = [];
let last: Row[] = [];
let lastDraws = 0;
let lastStart = 0;
let currentStart = 0;
let dropped = 0;

function text (value: unknown, most: number): string
{
    const string = typeof value === 'string' ? value : G.String(value);

    return string.length > most ? string.slice(0, most) : string;
}

function note (op: GroupOp, payload: unknown): void
{
    if (current.length < LIMIT)
    {
        current.push([op, payload, drawsNow()]);
    }
    else
    {
        dropped++;
    }

    if (sink !== null)
    {
        sink(op, payload);
    }
}

export function pushGroup (name: unknown): void
{
    const label = text(name, 120);

    stack.push(label);
    note('push', label);
}

export function popGroup (): void
{
    if (stack.length === 0)
    {
        return;
    }

    stack.pop();
    note('pop', null);
}

// Small, plain and bounded: what a page says about a game object is kept as it was said,
// and is never trusted.
export function plain (value: unknown, depth = 0): unknown
{
    if (value === null || typeof value === 'boolean')
    {
        return value;
    }

    if (typeof value === 'number')
    {
        return G.Number.isFinite(value) ? value : G.String(value);
    }

    if (typeof value === 'string')
    {
        return text(value, 200);
    }

    if (typeof value !== 'object' || depth >= 3)
    {
        return value === undefined ? null : text(G.Object.prototype.toString.call(value), 60);
    }

    if (G.Array.isArray(value))
    {
        return (value as unknown[]).slice(0, 16).map((item) => plain(item, depth + 1));
    }

    const out: Record<string, unknown> = {};
    let count = 0;

    for (const key in value as Record<string, unknown>)
    {
        if (count++ >= 16)
        {
            break;
        }

        try
        {
            out[text(key, 60)] = plain((value as Record<string, unknown>)[key], depth + 1);
        }
        catch
        {
            // A getter that throws says nothing.
        }
    }

    return out;
}

export function noteEntity (info: unknown): void
{
    note('entity', plain(info));
}

export function openGroups (): string[]
{
    return stack.slice();
}

// Called as a frame ends: what was said during it is kept whole.
export function rollGroups (): void
{
    last = current;
    lastStart = currentStart;
    lastDraws = currentStart = drawsNow();
    current = [];
    dropped = 0;
}

// The last whole frame as a tree, flattened: one row per group in the order they were
// opened, with how deep it sits, how many draws were issued inside it, and its game object.
export function frameGroups (most = 2000): { rows: Array<Record<string, unknown>>; total: number; loose: number; truncated: boolean }
{
    const rows: Array<Record<string, unknown>> = [];
    const open: Array<{ row: Record<string, unknown>; draws: number }> = [];
    let grouped = 0;
    let total = 0;

    for (const [op, payload, draws] of last)
    {
        if (op === 'push')
        {
            const row: Record<string, unknown> = { depth: open.length, name: payload, draws: 0 };

            total++;

            if (rows.length < most)
            {
                rows.push(row);
            }

            open.push({ row, draws });
        }
        else if (op === 'pop')
        {
            const top = open.pop();

            if (top)
            {
                top.row.draws = draws - top.draws;

                if (open.length === 0)
                {
                    grouped += draws - top.draws;
                }
            }
        }
        else if (open.length > 0)
        {
            open[open.length - 1].row.entity = payload;
        }
    }

    // Groups left open as the frame ended hold the draws up to its end.
    for (const entry of open)
    {
        entry.row.draws = lastDraws - entry.draws;
        entry.row.open = true;
    }

    if (open.length > 0)
    {
        grouped += lastDraws - open[0].draws;
    }

    return { rows, total, loose: G.Math.max(0, lastDraws - lastStart - grouped), truncated: total > rows.length || dropped > 0 };
}
