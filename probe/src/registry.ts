// One record per GPU object, from the moment it is created (01-PRD.md, OBS-1).
//
// The trackers for WebGL (gl/tracker.ts) and WebGPU (gpu/tracker.ts) create and update the
// records; this file holds what they share: the record itself, creation call sites, and the
// queries the host makes.

import { currentFrame } from './clock/gate';
import { G } from './natives';

export type Kind =
    | 'texture' | 'buffer' | 'shader' | 'program' | 'pipeline' | 'framebuffer' | 'renderbuffer'
    | 'sampler' | 'bind_group' | 'vertex_array' | 'layout' | 'query';

export interface Entry
{
    id: number;             // unique within its kind, in this probe
    kind: Kind;
    api: 'webgl' | 'webgpu';
    context: number;        // the context's ID for WebGL; 0 for WebGPU
    ref: WeakRef<object>;   // weak: the probe must not keep a page's object alive
    label: string | null;
    created: number;        // frame
    site: number;           // index into the call-site table
    destroyed: boolean;
    destroyedAt: number;
    used: number;           // last frame it was bound or drawn with
    written: number;        // last frame its contents were written
    bytes: number;          // estimated memory
    p: Record<string, any>; // what is known about it, by kind
}

// The record for any object, whatever its kind. A map lookup: for listings and checks, not
// for anything that runs on every graphics call. The trackers keep faster, per-kind tags
// for those (tags.generated.ts).
const byObject = new WeakMap<object, Entry>();

export function entryOf (object: object | null | undefined): Entry | undefined
{
    return object ? byObject.get(object) : undefined;
}

// WebGPU objects do not say which device made them. Readback needs to know.
const devices = new WeakMap<object, object>();

export function noteDevice (object: object, device: object): void
{
    devices.set(object, device);
}

export function deviceFor (object: object): object | undefined
{
    return devices.get(object);
}

const entries = new Map<Kind, Entry[]>();
const counters = new Map<Kind, number>();

// ---- Call sites ----

interface Site
{
    text: string;
    count: number;
}

const sites: Site[] = [{ text: '(unknown)', count: 0 }];
const siteIndex = new Map<string, number>();

// The host names the probe's script with a sourceURL, so its own frames can be told from the page's.
const PROBE_MARK = 'scanline-probe';
const NativeError: ErrorConstructor & { stackTraceLimit: number } = G.Error;

let siteCapture = true;

export function setSiteCapture (on: boolean): void
{
    siteCapture = on;
}

// Where in the page's code the current call came from: the first few frames of the stack
// that are not the probe's own. About a few microseconds, paid once per object created.
function captureSite (): number
{
    if (!siteCapture)
    {
        return 0;
    }

    const limit = NativeError.stackTraceLimit;

    NativeError.stackTraceLimit = 12;

    const stack = new NativeError().stack ?? '';

    NativeError.stackTraceLimit = limit;

    const frames: string[] = [];

    for (const line of stack.split('\n'))
    {
        const at = line.indexOf('at ');

        if (at < 0 || line.includes(PROBE_MARK))
        {
            continue;
        }

        frames.push(line.slice(at + 3).trim());

        if (frames.length === 3)
        {
            break;
        }
    }

    if (frames.length === 0)
    {
        return 0;
    }

    const text = frames.join(' < ');

    let index = siteIndex.get(text);

    if (index === undefined)
    {
        index = sites.length;
        sites.push({ text, count: 0 });
        siteIndex.set(text, index);
    }

    sites[index].count++;

    return index;
}

export function siteText (index: number): string
{
    return sites[index]?.text ?? '(unknown)';
}

// ---- Records ----

export function create (kind: Kind, api: Entry['api'], context: number, object: object, p: Record<string, any>, label: string | null = null): Entry
{
    const id = (counters.get(kind) ?? 0) + 1;

    counters.set(kind, id);

    const frame = currentFrame();

    const entry: Entry = {
        id,
        kind,
        api,
        context,
        ref: new G.WeakRef(object),
        label,
        created: frame,
        site: captureSite(),
        destroyed: false,
        destroyedAt: -1,
        used: -1,
        written: -1,
        bytes: 0,
        p
    };

    let list = entries.get(kind);

    if (!list)
    {
        list = [];
        entries.set(kind, list);
    }

    list.push(entry);
    byObject.set(object, entry);

    return entry;
}

export function destroy (entry: Entry | undefined): void
{
    if (entry && !entry.destroyed)
    {
        entry.destroyed = true;
        entry.destroyedAt = currentFrame();
    }
}

export function all (kind: Kind): Entry[]
{
    return entries.get(kind) ?? [];
}

export function find (kind: Kind, id: number): Entry | undefined
{
    return entries.get(kind)?.find((entry) => entry.id === id);
}

// An object the page dropped without deleting it is gone once the collector has taken it.
export function alive (entry: Entry): boolean
{
    if (entry.destroyed)
    {
        return false;
    }

    if (entry.ref.deref() === undefined)
    {
        entry.destroyed = true;
        entry.destroyedAt = currentFrame();
        entry.p.collected = true;

        return false;
    }

    return true;
}

export function kinds (): Kind[]
{
    return [...entries.keys()];
}

// Records of long-dead objects are dropped so a page that churns objects does not grow the
// registry without bound. The most recent stay, for "what was destroyed just now" questions.
const DEAD_LIMIT = 2000;

export function prune (): void
{
    for (const [kind, list] of entries)
    {
        const dead = list.filter((entry) => !alive(entry));

        if (dead.length > DEAD_LIMIT)
        {
            const cut = new G.Set(dead.slice(0, dead.length - DEAD_LIMIT));

            entries.set(kind, list.filter((entry) => !cut.has(entry)));
        }
    }
}
