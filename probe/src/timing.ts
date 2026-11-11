// GPU time, measured by the GPU (03-INSPECTION.md, section 5). Provenance: gpu-measured.
//
// WebGL: one timer query around each frame. Results arrive a few frames later and are
// thrown away when the driver says its timer was disturbed.
// WebGPU: a timestamp at the start and end of every pass, resolved once a frame.
//
// Both change something a page could notice, so neither runs in unmodified mode.

import { config } from './config';
import { currentFrame, onFrameBegin, onFrameEnd } from './clock/gate';
import { allContexts, type ContextInfo } from './contexts';
import { hub } from './hooks/hub';
import { recordIntercepted } from './gpu/rec';
import { gpuPassBegan, gpuPassGiven } from './gpu/patch';
import { noteTargets } from './gpu/tracker';
import { natives, type Handlers } from './hooks/install';
import { declare } from './mods';
import { noteDevice } from './registry';
import { G, type Fn } from './natives';
import type { Tag } from './tag';
import { gpuEncoderTag } from './tags.generated';
import { emit } from './transport';

export interface GpuSample
{
    frame: number;
    ms: number;
    passes: Array<{ label: string; ms: number }> | null;
}

const SAMPLES = 600;
const samples: GpuSample[] = [];

function record (sample: GpuSample): void
{
    samples.push(sample);

    if (samples.length > SAMPLES)
    {
        samples.shift();
    }
}

export function gpuSamples (count: number): GpuSample[]
{
    return samples.slice(-count);
}

// Why a context or device is not being timed, for the report.
const notes = new G.Map() as Map<string, string>;

export function timingNotes (): string[]
{
    return [...notes.values()];
}

let glActive = false;
let gpuActive = false;

function enabled (): boolean
{
    return !config.unmodified && !hub.off;
}

// ---- WebGL ----

const TIME_ELAPSED = 0x88BF;
const GPU_DISJOINT = 0x8FBB;
const RESULT = 0x8866;
const RESULT_AVAILABLE = 0x8867;
const PENDING_LIMIT = 6;

interface GlTimer
{
    info: ContextInfo;
    extension: any;
    current: object | null;
    pending: Array<{ query: object; frame: number }>;
    stopped: boolean;
    // The context's draw count when the last frame began: a context that is not drawing is not timed.
    draws: number;
}

const glTimers = new WeakMap<object, GlTimer>();

// The query calls, whichever API version provides them: WebGL 2 on the context, WebGL 1
// on the extension object. Always the unwrapped functions.
function queryCalls (timer: GlTimer): { create: () => object; begin: (query: object) => void; end: () => void; get: (query: object, pname: number) => any; remove: (query: object) => void }
{
    const gl = timer.info.ctx;
    const n = timer.info.natives;

    if (timer.info.api === 'webgl2')
    {
        return {
            create: () => n.createQuery.call(gl),
            begin: (query) => n.beginQuery.call(gl, TIME_ELAPSED, query),
            end: () => n.endQuery.call(gl, TIME_ELAPSED),
            get: (query, pname) => n.getQueryParameter.call(gl, query, pname),
            remove: (query) => n.deleteQuery.call(gl, query)
        };
    }

    const extension = timer.extension;
    const table = natives.EXT_disjoint_timer_query ?? {};
    const call = (name: string, ...args: unknown[]): any => (table[name] ?? extension[name]).apply(extension, args);

    return {
        create: () => call('createQueryEXT'),
        begin: (query) => call('beginQueryEXT', TIME_ELAPSED, query),
        end: () => call('endQueryEXT', TIME_ELAPSED),
        get: (query, pname) => call('getQueryObjectEXT', query, pname),
        remove: (query) => call('deleteQueryEXT', query)
    };
}

function glTimer (info: ContextInfo): GlTimer | null
{
    let timer = glTimers.get(info.ctx);

    if (timer === undefined)
    {
        const name = info.api === 'webgl2' ? 'EXT_disjoint_timer_query_webgl2' : 'EXT_disjoint_timer_query';
        const extension = info.natives.getExtension?.call(info.ctx, name) ?? null;

        timer = { info, extension, current: null, pending: [], stopped: extension === null, draws: 0 };
        glTimers.set(info.ctx, timer);

        if (extension === null)
        {
            notes.set(`gl${info.id}`, `Context ${info.id}: the browser offers no timer queries (${name}), so GPU time is not measured.`);
        }
    }

    return timer.stopped ? null : timer;
}

function glFrameBegin (): void
{
    if (!enabled())
    {
        return;
    }

    for (const info of allContexts())
    {
        // Only contexts that drew in the frame before: engines make spare contexts to test
        // what the browser supports, and those are never worth a query.
        if ((info.api !== 'webgl' && info.api !== 'webgl2') || info.lost || info.record.draws === 0)
        {
            continue;
        }

        const timer = glTimer(info);

        if (timer)
        {
            const drew = info.record.draws !== timer.draws;

            timer.draws = info.record.draws;

            if (!drew)
            {
                continue;
            }
        }

        // If results are not coming back, stop asking rather than pile queries up.
        if (!timer || timer.current || timer.pending.length >= PENDING_LIMIT)
        {
            continue;
        }

        const calls = queryCalls(timer);

        timer.current = calls.create();
        calls.begin(timer.current!);
        glActive = true;
    }
}

function glFrameEnd (): void
{
    for (const info of allContexts())
    {
        const timer = glTimers.get(info.ctx);

        if (!timer || timer.stopped || info.lost)
        {
            continue;
        }

        const calls = queryCalls(timer);

        if (timer.current)
        {
            calls.end();
            timer.pending.push({ query: timer.current, frame: currentFrame() });
            timer.current = null;
        }

        // Results come back in order. Take what has arrived.
        while (timer.pending.length && calls.get(timer.pending[0].query, RESULT_AVAILABLE))
        {
            const { query, frame } = timer.pending.shift()!;
            const disjoint = info.natives.getParameter.call(info.ctx, GPU_DISJOINT);

            if (!disjoint)
            {
                record({ frame, ms: calls.get(query, RESULT) / 1e6, passes: null });
            }

            calls.remove(query);
        }
    }
}

// The page is starting a timer query of its own. Only one may be active, so ours gives way
// for good on this context.
function pageBeginsQuery (gl: object, target: unknown): void
{
    if (target !== TIME_ELAPSED)
    {
        return;
    }

    const timer = glTimers.get(gl);

    if (!timer || timer.stopped)
    {
        if (timer === undefined)
        {
            // Not timed yet: make sure it never is.
            const info = allContexts().find((candidate) => candidate.ctx === gl);

            if (info)
            {
                glTimers.set(gl, { info, extension: null, current: null, pending: [], stopped: true, draws: 0 });
            }
        }

        return;
    }

    const calls = queryCalls(timer);

    if (timer.current)
    {
        calls.end();
        calls.remove(timer.current);
        timer.current = null;
    }

    timer.stopped = true;
    notes.set(`gl${timer.info.id}`, `Context ${timer.info.id}: the page uses timer queries itself, and only one can run at a time, so Scanline stopped measuring GPU time there.`);
}

// ---- WebGPU ----

const MAX_PASSES = 64;

interface DeviceTimer
{
    device: any;
    querySet: any;
    resolve: any;
    read: any;
    labels: string[];
    used: number;
    reading: boolean;
}

const deviceTimers = new WeakMap<object, DeviceTimer | null>();
const encoderTag: Tag<DeviceTimer | null> = gpuEncoderTag;

function deviceTimer (device: any): DeviceTimer | null
{
    let timer = deviceTimers.get(device);

    if (timer !== undefined)
    {
        return timer;
    }

    timer = null;

    try
    {
        if (enabled() && device.features.has('timestamp-query'))
        {
            const n = natives.GPUDevice;

            timer = {
                device,
                querySet: n.createQuerySet.call(device, { label: 'scanline: pass timing', type: 'timestamp', count: MAX_PASSES * 2 }),
                resolve: n.createBuffer.call(device, { label: 'scanline: pass timing', size: MAX_PASSES * 16, usage: 0x0200 | 0x0004 }),
                read: n.createBuffer.call(device, { label: 'scanline: pass timing readback', size: MAX_PASSES * 16, usage: 0x0001 | 0x0008 }),
                labels: [],
                used: 0,
                reading: false
            };

            gpuActive = true;
        }
        else if (enabled())
        {
            notes.set('gpu', 'This WebGPU device has no timestamp-query feature, so GPU time is not measured.');
        }
    }
    catch (error: any)
    {
        emit('probe-fault', { where: 'timing', message: G.String(error?.stack ?? error) });
    }

    deviceTimers.set(device, timer);

    return timer;
}

function describePass (kind: string, descriptor: any, index: number): string
{
    const label = descriptor?.label;

    return typeof label === 'string' && label !== '' ? label : `${kind} pass ${index + 1}`;
}

function beginPass (kind: string): Fn
{
    const method = kind === 'render' ? 'GPUCommandEncoder.beginRenderPass' : 'GPUCommandEncoder.beginComputePass';

    const begin = (encoder: any, native: Fn, args: IArguments): unknown =>
    {
        const timer = encoderTag.get(encoder);
        const given = args[0];

        // Left alone: a pass that already has timestamp writes (the page is timing it), more
        // passes than the query set holds, or a descriptor that is not an object.
        if (!timer || timer.used >= MAX_PASSES || args.length > 1 || (given !== undefined && (given === null || typeof given !== 'object')) || given?.timestampWrites)
        {
            return native.apply(encoder, args as any);
        }

        const index = timer.used++;

        timer.labels[index] = describePass(kind, given, index);

        const writes = { querySet: timer.querySet, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 };

        return native.call(encoder, given === undefined ? { timestampWrites: writes } : G.Object.create(given, { timestampWrites: { value: writes, enumerable: true } }));
    };

    return (encoder: any, native: Fn, args: IArguments): unknown =>
    {
        hub.gpu.calls++;
        hub.gpu.passes++;

        // A live view may ask for the pass to begin another way (cleared to black).
        const given = kind === 'render' && args.length === 1 ? gpuPassGiven(args[0]) : args[0];
        const pass = given === args[0] ? begin(encoder, native, args) : begin(encoder, native, [given] as unknown as IArguments);

        if (kind === 'render')
        {
            noteTargets(args[0]);
            gpuPassBegan(pass as object, args[0]);
        }

        // A capture records the pass as the page asked for it, without the timestamp writes.
        recordIntercepted(method, encoder, pass, args);

        return pass;
    };
}

function gpuFrameEnd (): void
{
    for (const info of allContexts())
    {
        const device = info.gpu?.device;
        const timer = device ? deviceTimers.get(device) : null;

        if (!timer || timer.used === 0)
        {
            continue;
        }

        const count = timer.used;
        const labels = timer.labels.slice(0, count);
        const frame = currentFrame();

        timer.used = 0;

        // One readback at a time: a frame that ends while the last is still in flight goes unmeasured.
        if (timer.reading)
        {
            continue;
        }

        timer.reading = true;

        try
        {
            const n = natives;
            const encoder = n.GPUDevice.createCommandEncoder.call(device, { label: 'scanline: pass timing' });

            n.GPUCommandEncoder.resolveQuerySet.call(encoder, timer.querySet, 0, count * 2, timer.resolve, 0);
            n.GPUCommandEncoder.copyBufferToBuffer.call(encoder, timer.resolve, 0, timer.read, 0, count * 16);
            n.GPUQueue.submit.call(device.queue, [n.GPUCommandEncoder.finish.call(encoder)]);

            n.GPUBuffer.mapAsync.call(timer.read, 0x0001, 0, count * 16).then(() =>
            {
                const times = new G.BigUint64Array(n.GPUBuffer.getMappedRange.call(timer.read, 0, count * 16).slice(0));

                n.GPUBuffer.unmap.call(timer.read);
                timer.reading = false;

                const passes = [];

                let total = 0;

                for (let i = 0; i < count; i++)
                {
                    const begin = times[i * 2];
                    const end = times[i * 2 + 1];

                    // A pass whose commands were never submitted this frame leaves no usable pair.
                    if (end > begin)
                    {
                        const ms = G.Number(end - begin) / 1e6;

                        passes.push({ label: labels[i], ms });
                        total += ms;
                    }
                }

                if (passes.length)
                {
                    record({ frame, ms: total, passes });
                }
            }, () =>
            {
                timer.reading = false;
            });
        }
        catch (error: any)
        {
            timer.reading = false;
            emit('probe-fault', { where: 'timing', message: G.String(error?.stack ?? error) });
        }
    }
}

export const timingHandlers: Handlers = {

    'gl.beginQuery': (gl: any, native: Fn, args: IArguments) =>
    {
        hub.ctx(gl).calls++;
        pageBeginsQuery(gl, args[0]);

        return native.apply(gl, args as any);
    },

    'EXT_disjoint_timer_query.beginQueryEXT': (extension: any, native: Fn, args: IArguments) =>
    {
        const info = (hub.ext(extension).x as { info?: ContextInfo } | null)?.info;

        if (info)
        {
            pageBeginsQuery(info.ctx, args[0]);
        }

        return native.apply(extension, args as any);
    },

    'GPUDevice.createCommandEncoder': (_c: unknown, device: any, encoder: any) =>
    {
        if (encoder)
        {
            // Which device an encoder is of: a capture needs it for one made before its frame.
            noteDevice(encoder, device);
            encoderTag.set(encoder, deviceTimer(device));
        }
    },

    'GPUCommandEncoder.beginRenderPass': beginPass('render'),
    'GPUCommandEncoder.beginComputePass': beginPass('compute')
};

// The feature a device needs for pass timing, added to what the page asks for.
export function withTimestampFeature (adapter: any, args: IArguments): unknown[] | null
{
    if (!enabled() || args.length > 1)
    {
        return null;
    }

    try
    {
        if (!adapter.features.has('timestamp-query'))
        {
            return null;
        }

        const given = args[0];

        if (given !== undefined && (given === null || typeof given !== 'object'))
        {
            return null;
        }

        const wanted: string[] = given?.requiredFeatures ? G.Array.from(given.requiredFeatures) : [];

        if (wanted.includes('timestamp-query'))
        {
            return null;
        }

        const features = [...wanted, 'timestamp-query'];

        gpuActive = true;

        return [given === undefined ? { requiredFeatures: features } : G.Object.create(given, { requiredFeatures: { value: features, enumerable: true } })];
    }
    catch
    {
        return null;
    }
}

export function installTiming (): void
{
    onFrameBegin(glFrameBegin);

    onFrameEnd(() =>
    {
        glFrameEnd();
        gpuFrameEnd();
    });

    declare({
        id: 'webgl-timer-query',
        what: 'A timer query runs around each WebGL frame (the page sees it as the current TIME_ELAPSED query)',
        why: 'GPU time per frame',
        optional: true,
        active: () => glActive
    });

    declare({
        id: 'webgpu-timestamp-query',
        what: 'The timestamp-query feature is added to WebGPU devices, and timestamp writes to passes that have none',
        why: 'GPU time per pass',
        optional: true,
        active: () => gpuActive
    });
}
