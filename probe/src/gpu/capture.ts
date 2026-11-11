// Capturing a WebGPU frame.
//
// The stream is every call the frame made on one device and the objects made from it: on
// the device, its queue, its encoders and passes, its textures and buffers. A command is
//
//   [method, arguments, what it made (or null), what it was called on]
//
// Objects are named in three ways:
//   { o: kind, i: id }   one the registry knows (a texture, buffer, pipeline, bind group …)
//   { l: n }             one made during the frame that the registry does not keep: an
//                        encoder, a pass, a command buffer, a view, the canvas's texture
//   { v: { t, d } }      a view made before the frame: its texture's ID and its descriptor
//
// WebGPU has no state to read back, so what the frame began with is the objects themselves:
// each is described by the descriptor it was created from, which is enough to make it again.
// Textures and buffers also carry their contents, read when the frame has ended. Render
// targets are read before the frame as well, because a frame may sample what the last drew.

import { blob, pixelsOf, type Capture } from '../capture';
import { currentFrame } from '../clock/gate';
import type { ContextInfo } from '../contexts';
import { METHOD_NAMES } from '../hooks/generated';
import type { Rec } from '../hooks/hub';
import { G } from '../natives';
import { readBuffer, readGpuRaw } from '../readback';
import { alive, all, deviceFor, entryOf, find, type Entry, type Kind } from '../registry';
import { emit } from '../transport';
import { copyBytes } from './formats';
import { mapWatch } from './rec';
import { viewOf } from './tracker';

interface PassState
{
    index: number;
    kind: 'render' | 'compute';
    target: number;         // a texture's ID; 0 for the canvas; -1 for none
    targetLevel: number;
    size: [number, number];
    pipeline: number | null;
    groups: Array<number | null>;
    vertex: Array<{ slot: number; buffer: number | null; offset: number; size: number | null }>;
    indexBuffer: { buffer: number | null; format: string; offset: number } | null;
    viewport: number[] | null;
    scissor: number[] | null;
    blendConstant: unknown;
    stencilReference: number;
}

export interface GpuState
{
    device: any;
    queue: any;
    deviceId: number;
    locals: Map<object, number>;
    nextLocal: number;
    // In a flight recording, the first number given out since its present oldest frames
    // began. An object with a lower number may not be there when the recording is replayed.
    firstLocal: number;
    passes: Map<object, PassState>;
    passCount: number;
    // Ranges of buffers the page has mapped, and what they held when the buffer was unmapped.
    mapped: Map<object, Array<{ range: ArrayBuffer; offset: number }>>;
    unmapped: Map<object, Array<{ o: number; b: number }>>;
    // Worked out once and used at every draw: what a pipeline's descriptor says of a draw
    // made with it, and the textures a bind group holds.
    pipelines: Map<number, Record<string, unknown>>;
    groups: Map<number, Array<Record<string, unknown>>>;
}

const names: string[] = METHOD_NAMES.map((qualified) => qualified.slice(qualified.indexOf('.') + 1));
const owners: string[] = METHOD_NAMES.map((qualified) => qualified.slice(0, qualified.indexOf('.')));

// Calls that change nothing a replay needs, or that a replay must not repeat.
const skipped: boolean[] = METHOD_NAMES.map((qualified, index) =>
{
    const owner = owners[index];
    const name = names[index];

    return owner === 'GPU' || owner === 'GPUAdapter'
        || ['getMappedRange', 'mapAsync', 'getConfiguration', 'configure', 'unconfigure', 'onSubmittedWorkDone', 'pushErrorScope', 'popErrorScope', 'getBindGroupLayout'].includes(name)
        || qualified === 'GPUDevice.destroy';
});

const DRAWS = ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'];

const BUFFER_MAP_READ = 0x0001;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_PRE_FRAME = 256 * 1024 * 1024;

function note (capture: Capture, text: string): void
{
    if (!capture.notes.includes(text))
    {
        capture.notes.push(text);
    }
}

function ours (capture: Capture, object: any): boolean
{
    const gpu = capture.gpu!;

    if (object === gpu.device || object === gpu.queue || object === capture.info.ctx || gpu.locals.has(object))
    {
        return true;
    }

    const entry = entryOf(object);

    return entry !== undefined && entry.api === 'webgpu' && deviceFor(object) === gpu.device;
}

function local (capture: Capture, object: object): { l: number }
{
    const gpu = capture.gpu!;

    let id = gpu.locals.get(object);

    if (id === undefined)
    {
        id = gpu.nextLocal++;
        gpu.locals.set(object, id);
    }

    return { l: id };
}

function bytesOf (value: any): Uint8Array
{
    return G.ArrayBuffer.isView(value)
        ? new G.Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
        : new G.Uint8Array(value).slice();
}

// A value as plain data a replay can turn back into the call's argument.
function encode (capture: Capture, value: any, depth = 0): unknown
{
    if (value === undefined)
    {
        return { $u: 1 };
    }

    if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')
    {
        return value;
    }

    if (typeof value !== 'object' || depth > 8)
    {
        return null;
    }

    const gpu = capture.gpu!;

    const made = gpu.locals.get(value);

    // A view made in frames that may be dropped from a flight recording is described in
    // full instead, like any view made before the capture began.
    if (made !== undefined && (made >= gpu.firstLocal || !viewOf(value)))
    {
        return { l: made };
    }

    const entry = entryOf(value);

    if (entry)
    {
        capture.used.add(entry);
        capture.strong?.add(value);

        return { o: entry.kind, i: entry.id };
    }

    const view = viewOf(value);

    if (view)
    {
        if (view.texture)
        {
            capture.used.add(view.texture);
        }

        return { v: { t: view.texture?.id ?? 0, d: view.descriptor } };
    }

    if (value === gpu.device)
    {
        return { dev: 1 };
    }

    if (value === gpu.queue)
    {
        return { q: 1 };
    }

    if (value === capture.info.ctx)
    {
        return { ctx: 1 };
    }

    if (G.ArrayBuffer.isView(value) || value instanceof G.ArrayBuffer || (typeof G.SharedArrayBuffer === 'function' && value instanceof G.SharedArrayBuffer))
    {
        return { b: blob(capture, bytesOf(value)), a: G.ArrayBuffer.isView(value) ? value.constructor.name : 'ArrayBuffer' };
    }

    if (typeof value[G.Symbol.iterator] === 'function')
    {
        return G.Array.from(value as Iterable<unknown>, (item: unknown) => encode(capture, item, depth + 1));
    }

    const tag = G.Object.prototype.toString.call(value).slice(8, -1);

    if (tag !== 'Object')
    {
        // An image, a canvas, a video frame: what copyExternalImageToTexture reads from.
        const pixels = pixelsOf(capture, value);

        if (pixels)
        {
            return pixels;
        }

        note(capture, `The frame used a ${tag}, which a capture cannot hold. The call that used it will not replay.`);

        return { x: tag };
    }

    const out: Record<string, unknown> = {};

    // Inherited members too: a descriptor may be built on top of another object.
    for (const key in value)
    {
        const member = value[key];

        if (member !== undefined && typeof member !== 'function')
        {
            out[key] = encode(capture, member, depth + 1);
        }
    }

    return out;
}

function encodeArgs (capture: Capture, method: number, args: any[]): unknown[]
{
    const qualified = METHOD_NAMES[method];

    if (qualified === 'GPUQueue.writeBuffer' && args.length >= 3 && args[2] && typeof args[2] === 'object')
    {
        // Only the part of the data that is written is kept, as bytes.
        const data = args[2];
        const unit: number = G.ArrayBuffer.isView(data) ? ((data as any).BYTES_PER_ELEMENT ?? 1) : 1;
        const all = G.ArrayBuffer.isView(data) ? new G.Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new G.Uint8Array(data);
        const from = (G.Number(args[3]) || 0) * unit;
        const length = args[4] === undefined ? all.byteLength - from : G.Number(args[4]) * unit;

        return [encode(capture, args[0]), encode(capture, args[1]), { b: blob(capture, all.slice(from, from + length)), a: 'Uint8Array' }];
    }

    if (qualified === 'GPUBuffer.unmap')
    {
        return [];
    }

    return args.map((arg) => encode(capture, arg));
}

// ---- The state a draw runs with ----

function sizeOfTarget (capture: Capture, texture: Entry | undefined, level: number): [number, number]
{
    if (!texture)
    {
        return [capture.header.width as number, capture.header.height as number];
    }

    return [G.Math.max(1, texture.p.width >> level), G.Math.max(1, texture.p.height >> level)];
}

function colourOf (value: any): number[]
{
    if (!value)
    {
        return [0, 0, 0, 0];
    }

    if (typeof value[G.Symbol.iterator] === 'function')
    {
        return G.Array.from(value as Iterable<number>);
    }

    return [value.r ?? 0, value.g ?? 0, value.b ?? 0, value.a ?? 0];
}

// Where a pass or a copy draws: the texture behind a view, or the canvas.
function targetOf (view: any): { texture: Entry | undefined; level: number; known: boolean }
{
    const record = view ? viewOf(view) : undefined;

    if (!record)
    {
        return { texture: undefined, level: 0, known: false };
    }

    return { texture: record.texture, level: G.Number((record.descriptor as any)?.baseMipLevel) || 0, known: true };
}

function beginPass (capture: Capture, kind: 'render' | 'compute', pass: object, descriptor: any, command: number): void
{
    const gpu = capture.gpu!;

    const state: PassState = {
        index: gpu.passCount++,
        kind,
        target: -1,
        targetLevel: 0,
        size: [capture.header.width as number, capture.header.height as number],
        pipeline: null,
        groups: [],
        vertex: [],
        indexBuffer: null,
        viewport: null,
        scissor: null,
        blendConstant: null,
        stencilReference: 0
    };

    gpu.passes.set(pass, state);

    if (kind !== 'render' || !descriptor)
    {
        return;
    }

    const attachments: any[] = descriptor.colorAttachments ? G.Array.from(descriptor.colorAttachments as Iterable<any>) : [];
    const first = attachments.find((attachment) => attachment);

    if (first)
    {
        const target = targetOf(first.resolveTarget ?? first.view);

        if (target.known)
        {
            state.target = target.texture?.id ?? 0;
            state.targetLevel = target.level;
            state.size = sizeOfTarget(capture, target.texture, target.level);
        }
    }

    const depth = descriptor.depthStencilAttachment;
    const cleared = attachments.some((attachment) => attachment?.loadOp === 'clear');

    // A pass that clears on load is an event: it changes its target before any draw does.
    if (cleared || depth?.depthLoadOp === 'clear' || depth?.stencilLoadOp === 'clear')
    {
        capture.draws.push({
            api: 'webgpu',
            kind: 'clear',
            method: 'beginRenderPass',
            command,
            pass: state.index,
            target: G.Math.max(0, state.target),
            targetLevel: state.targetLevel,
            noTarget: state.target < 0,
            clearColor: colourOf(first?.clearValue),
            clearDepth: depth?.depthLoadOp === 'clear' ? (depth.depthClearValue ?? null) : null,
            clearStencil: depth?.stencilLoadOp === 'clear' ? (depth.stencilClearValue ?? 0) : null,
            mask: (cleared ? 0x4000 : 0) | (depth?.depthLoadOp === 'clear' ? 0x100 : 0) | (depth?.stencilLoadOp === 'clear' ? 0x400 : 0),
            viewport: [0, 0, state.size[0], state.size[1]],
            scissor: null,
            colorMask: [true, true, true, true]
        });
    }
}

function id (object: any): number | null
{
    return entryOf(object)?.id ?? null;
}

// A WebGPU write mask as four booleans, the way a WebGL colour mask reads.
function maskOf (mask: unknown): boolean[]
{
    const bits = typeof mask === 'number' ? mask : 0xF;

    return [(bits & 1) !== 0, (bits & 2) !== 0, (bits & 4) !== 0, (bits & 8) !== 0];
}

// The textures a draw can sample: every texture view in the bind groups it has set.
function texturesOf (gpu: GpuState, state: PassState): Array<Record<string, unknown>>
{
    const out: Array<Record<string, unknown>> = [];

    for (let index = 0; index < state.groups.length; index++)
    {
        const group = state.groups[index];

        if (group === null || group === undefined)
        {
            continue;
        }

        // A bind group never changes, so what it holds is worked out once.
        let held = gpu.groups.get(group);

        if (held === undefined)
        {
            held = [];

            for (const bound of (find('bind_group', group)?.p.descriptor as any)?.entries ?? [])
            {
                const resource = bound?.resource;

                if (resource && resource.ref === 'texture' && resource.id)
                {
                    held.push({ binding: G.Number(bound.binding) || 0, t2d: resource.id });
                }
            }

            gpu.groups.set(group, held);
        }

        for (const texture of held)
        {
            // Units are numbered group × 100 + binding, so one number names both.
            out.push({ unit: index * 100 + (texture.binding as number), group: index, binding: texture.binding, t2d: texture.t2d, sampler: null });
        }
    }

    return out;
}

// What a pipeline's descriptor says of every draw made with it.
function pipelineFacts (gpu: GpuState, id: number | null): Record<string, unknown>
{
    let facts = id === null ? undefined : gpu.pipelines.get(id);

    if (facts !== undefined)
    {
        return facts;
    }

    const made: any = (id === null ? undefined : find('pipeline', id))?.p.descriptor ?? {};
    const primitive = made.primitive ?? {};
    const depth = made.depthStencil ?? null;
    const target = made.fragment?.targets?.[0] ?? null;
    const blend = target?.blend ?? null;
    const tests = depth !== null && ((depth.depthCompare ?? 'always') !== 'always' || depth.depthWriteEnabled === true);
    const stencil = depth !== null && ((depth.stencilFront?.compare ?? 'always') !== 'always' || (depth.stencilBack?.compare ?? 'always') !== 'always');

    facts = {
        mode: primitive.topology ?? 'triangle-list',
        blend: blend
            ? {
                srcRgb: blend.color?.srcFactor ?? 'one',
                dstRgb: blend.color?.dstFactor ?? 'zero',
                equationRgb: blend.color?.operation ?? 'add',
                srcAlpha: blend.alpha?.srcFactor ?? 'one',
                dstAlpha: blend.alpha?.dstFactor ?? 'zero',
                equationAlpha: blend.alpha?.operation ?? 'add'
            }
            : null,
        depth: tests ? { func: depth.depthCompare ?? 'always', write: depth.depthWriteEnabled === true } : null,
        stencilFaces: stencil ? { front: depth.stencilFront ?? null, back: depth.stencilBack ?? null } : null,
        cull: primitive.cullMode && primitive.cullMode !== 'none' ? primitive.cullMode : null,
        frontFace: primitive.frontFace ?? 'ccw',
        colorMask: maskOf(target?.writeMask)
    };

    if (id !== null)
    {
        gpu.pipelines.set(id, facts);
    }

    return facts;
}

function drawRow (capture: Capture, state: PassState, name: string, args: any[], command: number): Record<string, unknown>
{
    const gpu = capture.gpu!;
    const facts = pipelineFacts(gpu, state.pipeline);
    const indexed = name.startsWith('drawIndexed');
    const direct = !name.endsWith('Indirect');
    const [width, height] = state.size;
    const scissor = state.scissor;
    const clipped = scissor !== null && (scissor[0] > 0 || scissor[1] > 0 || scissor[0] + scissor[2] < width || scissor[1] + scissor[3] < height);
    const faces: any = facts.stencilFaces;

    return {
        api: 'webgpu',
        kind: 'draw',
        method: name,
        command,
        pass: state.index,
        target: state.target < 0 ? 0 : state.target,
        targetLevel: state.targetLevel,
        noTarget: state.target < 0,
        mode: facts.mode,
        count: direct ? (args[0] ?? 0) : null,
        instances: direct ? (args[1] ?? 1) : null,
        first: direct ? (args[2] ?? 0) : null,
        baseVertex: direct && indexed ? (args[3] ?? 0) : null,
        firstInstance: direct ? (args[indexed ? 4 : 3] ?? 0) : null,
        indirect: direct ? null : { buffer: id(args[0]), offset: args[1] ?? 0 },
        indexType: indexed ? (state.indexBuffer?.format ?? null) : null,
        pipeline: state.pipeline,
        bindGroups: state.groups.slice(),
        vertexBuffers: state.vertex.filter(Boolean).map((buffer) => ({ ...buffer })),
        indexBuffer: indexed ? state.indexBuffer : null,
        blend: facts.blend,
        depth: facts.depth,
        stencil: faces ? { front: faces.front, back: faces.back, reference: state.stencilReference } : null,
        cull: facts.cull,
        frontFace: facts.frontFace,
        viewport: state.viewport ? state.viewport.slice(0, 4) : [0, 0, width, height],
        depthRange: state.viewport ? state.viewport.slice(4, 6) : [0, 1],
        scissor: clipped ? scissor : null,
        colorMask: facts.colorMask,
        blendConstant: state.blendConstant,
        textures: texturesOf(gpu, state),
        uniforms: {},
        attributes: []
    };
}

function passCommand (capture: Capture, state: PassState, name: string, args: any[], command: number): void
{
    switch (name)
    {
        case 'setPipeline':
            state.pipeline = id(args[0]);
            break;

        case 'setBindGroup':
            state.groups[G.Number(args[0]) || 0] = id(args[1]);
            break;

        case 'setVertexBuffer':
        {
            const slot = G.Number(args[0]) || 0;

            state.vertex[slot] = { slot, buffer: id(args[1]), offset: args[2] ?? 0, size: args[3] ?? null };
            break;
        }

        case 'setIndexBuffer':
            state.indexBuffer = { buffer: id(args[0]), format: G.String(args[1]), offset: args[2] ?? 0 };
            break;

        case 'setViewport':
            state.viewport = args.slice(0, 6).map(G.Number);
            break;

        case 'setScissorRect':
            state.scissor = args.slice(0, 4).map(G.Number);
            break;

        case 'setBlendConstant':
            state.blendConstant = colourOf(args[0]);
            break;

        case 'setStencilReference':
            state.stencilReference = G.Number(args[0]) || 0;
            break;

        case 'executeBundles':
            // What a bundle draws was decided when it was built; here it is one event.
            capture.draws.push({ ...drawRow(capture, state, name, [], command), count: null, instances: null, bundles: G.Array.from(args[0] as Iterable<unknown> ?? []).length });
            break;

        case 'dispatchWorkgroups':
        case 'dispatchWorkgroupsIndirect':
            capture.draws.push({
                api: 'webgpu',
                kind: 'dispatch',
                method: name,
                command,
                pass: state.index,
                target: 0,
                noTarget: true,
                pipeline: state.pipeline,
                bindGroups: state.groups.slice(),
                count: name === 'dispatchWorkgroups' ? [args[0] ?? 1, args[1] ?? 1, args[2] ?? 1] : null,
                viewport: [0, 0, 0, 0],
                colorMask: [true, true, true, true],
                textures: texturesOf(capture.gpu!, state),
                uniforms: {},
                attributes: []
            });
            break;

        default:
            if (DRAWS.includes(name))
            {
                capture.draws.push(drawRow(capture, state, name, args, command));
            }
    }
}

// A copy into a texture changes pixels, so it is an event too.
function copyEvent (capture: Capture, name: string, destination: any, command: number): void
{
    const texture = destination?.texture;

    if (!texture)
    {
        return;
    }

    const entry = entryOf(texture);
    const level = G.Number(destination.mipLevel) || 0;
    const size = sizeOfTarget(capture, entry, level);

    capture.draws.push({
        api: 'webgpu',
        kind: 'blit',
        method: name,
        command,
        pass: -1,
        target: entry?.id ?? 0,
        targetLevel: level,
        viewport: [0, 0, size[0], size[1]],
        scissor: null,
        colorMask: [true, true, true, true]
    });
}

// ---- Recording ----

export function gpuRecord (capture: Capture, _c: Rec, method: number, self: any, result: any, count: number, args: any[]): void
{
    if (skipped[method] || !ours(capture, self))
    {
        return;
    }

    try
    {
        const gpu = capture.gpu!;
        const owner = owners[method];
        const name = names[method];
        const given = args.slice(0, count);
        const index = capture.commands.length;
        const encoded = encodeArgs(capture, method, given);

        let made: unknown = null;

        if (result && typeof result === 'object' && typeof result.then !== 'function')
        {
            const entry = entryOf(result);

            if (entry)
            {
                capture.used.add(entry);
                made = { o: entry.kind, i: entry.id };
            }
            else
            {
                made = local(capture, result);
            }
        }

        const command: unknown[] = [method, encoded, made, encode(capture, self)];

        if (name === 'unmap' && owner === 'GPUBuffer')
        {
            // What the page wrote into the mapped ranges, read just before they were detached.
            const written = gpu.unmapped.get(self);

            if (written)
            {
                command[1] = [written];
                gpu.unmapped.delete(self);
            }
        }

        capture.commands.push(command);

        if (owner === 'GPUCommandEncoder')
        {
            if (name === 'beginRenderPass' || name === 'beginComputePass')
            {
                beginPass(capture, name === 'beginRenderPass' ? 'render' : 'compute', result, given[0], index);
            }
            else if (name === 'copyTextureToTexture' || name === 'copyBufferToTexture')
            {
                copyEvent(capture, name, given[1], index);
            }
        }
        else if (owner === 'GPURenderPassEncoder' || owner === 'GPUComputePassEncoder')
        {
            const state = gpu.passes.get(self);

            if (state)
            {
                if (name === 'end')
                {
                    gpu.passes.delete(self);
                }
                else
                {
                    passCommand(capture, state, name, given, index);
                }
            }
        }
    }
    catch (error: any)
    {
        emit('probe-fault', { where: 'capture', message: G.String(error?.stack ?? error) });
    }
}

function layersOf (p: Record<string, any>, level: number): number
{
    return p.dimension === '3d' ? G.Math.max(1, p.depthOrArrayLayers >> level) : (p.depthOrArrayLayers || 1);
}

function unreadable (p: Record<string, any>): string | null
{
    const format: string = p.format;

    if (!p.readable)
    {
        return p.sampleCount > 1 ? 'multisampled' : 'no COPY_SRC usage';
    }

    if (format.startsWith('depth') || format.includes('stencil'))
    {
        return 'depth or stencil format';
    }

    if (copyBytes(format) === 0)
    {
        return 'compressed format';
    }

    return null;
}

async function readLevels (capture: Capture, entry: Entry, levels: number): Promise<Array<Record<string, unknown>>>
{
    const out: Array<Record<string, unknown>> = [];

    for (let level = 0; level < levels; level++)
    {
        for (let layer = 0; layer < layersOf(entry.p, level); layer++)
        {
            const read = await readGpuRaw(entry, level, layer);

            out.push({ level, layer, blob: blob(capture, read.packed), width: read.width, height: read.height });
        }
    }

    return out;
}

export async function gpuBegin (capture: Capture, info: ContextInfo): Promise<void>
{
    const state = info.gpu;

    if (!state || !state.device)
    {
        throw new Error(`Context ${info.id} is a WebGPU context that has not been configured, so it has no device to capture.`);
    }

    const device = state.device;
    const limits: Record<string, number> = {};

    for (const key in device.limits)
    {
        const value = device.limits[key];

        if (typeof value === 'number')
        {
            limits[key] = value;
        }
    }

    capture.header = {
        api: 'webgpu',
        width: info.canvas.width,
        height: info.canvas.height,
        format: state.format,
        usage: state.usage,
        alphaMode: state.alphaMode,
        features: G.Array.from(device.features as Iterable<string>),
        limits
    };

    capture.gpu = {
        device,
        queue: device.queue,
        deviceId: 0,
        locals: new G.Map(),
        nextLocal: 1,
        firstLocal: 1,
        passes: new G.Map(),
        passCount: 0,
        mapped: new G.Map(),
        unmapped: new G.Map(),
        pipelines: new G.Map(),
        groups: new G.Map()
    };

    // Render targets as the frame begins: a frame may sample what the last one drew.
    let budget = MAX_PRE_FRAME;

    for (const entry of capture.light ? [] : all('texture'))
    {
        if (entry.api !== 'webgpu' || !entry.p.renderTarget || !alive(entry) || deviceFor(entry.ref.deref()!) !== device || unreadable(entry.p) !== null)
        {
            continue;
        }

        if (entry.bytes > budget)
        {
            note(capture, 'Some render targets were too large to read before the frame. If the frame samples what the last one drew there, its replay will differ.');
            continue;
        }

        budget -= entry.bytes;

        try
        {
            capture.renderTargets.set(entry.id, await readLevels(capture, entry, 1) as unknown as number[]);
        }
        catch
        {
            // Unreadable after all: the frame is expected to clear it.
        }
    }
}

// Called by the tracker while a capture records.
export function gpuWatchMaps (capture: Capture | null): void
{
    if (capture === null)
    {
        mapWatch.range = null;
        mapWatch.unmap = null;

        return;
    }

    const gpu = capture.gpu!;

    mapWatch.range = (buffer, range, offset) =>
    {
        const ranges = gpu.mapped.get(buffer) ?? [];

        ranges.push({ range, offset });
        gpu.mapped.set(buffer, ranges);
    };

    mapWatch.unmap = (buffer) =>
    {
        const ranges = gpu.mapped.get(buffer);

        gpu.mapped.delete(buffer);

        // A buffer mapped for reading was not written to.
        if (!ranges || ((entryOf(buffer)?.p.usage ?? 0) & BUFFER_MAP_READ) !== 0)
        {
            return;
        }

        gpu.unmapped.set(buffer, ranges.filter((entry) => entry.range.byteLength > 0).map((entry) => ({ o: entry.offset, b: blob(capture, new G.Uint8Array(entry.range).slice()) })));
    };
}

// Every registered object a descriptor names, so that what a used object was made from is captured too.
function references (value: any, into: Set<Entry>, depth = 0): void
{
    if (!value || typeof value !== 'object' || depth > 10)
    {
        return;
    }

    if (G.Array.isArray(value))
    {
        for (const item of value)
        {
            references(item, into, depth + 1);
        }

        return;
    }

    if (typeof value.ref === 'string' && typeof value.id === 'number')
    {
        const entry = value.id ? find(value.ref as Kind, value.id) : undefined;

        if (entry && !into.has(entry))
        {
            into.add(entry);
            closure(entry, into);
        }

        return;
    }

    for (const key of G.Object.keys(value))
    {
        references(value[key], into, depth + 1);
    }
}

function closure (entry: Entry, into: Set<Entry>): void
{
    references(entry.p.descriptor, into);

    if (entry.kind === 'layout' && entry.p.pipeline)
    {
        references({ ref: 'pipeline', id: entry.p.pipeline }, into);
    }
}

async function describe (capture: Capture, entry: Entry): Promise<Record<string, unknown>>
{
    const p = entry.p;
    const inFrame = entry.created >= capture.frame;

    const out: Record<string, unknown> = {
        kind: entry.kind,
        id: entry.id,
        label: entry.label,
        created: entry.created,
        alive: alive(entry),
        createdInFrame: inFrame
    };

    switch (entry.kind)
    {
        case 'texture':
        {
            G.Object.assign(out, {
                width: p.width ?? 0,
                height: p.height ?? 0,
                depthOrArrayLayers: p.depthOrArrayLayers ?? 1,
                format: p.format,
                usage: p.usage,
                levels: p.mipLevelCount ?? 1,
                sampleCount: p.sampleCount ?? 1,
                dimension: p.dimension ?? '2d',
                viewFormats: (p.descriptor as any)?.viewFormats ?? [],
                renderTarget: G.Boolean(p.renderTarget)
            });

            if (inFrame || !p.width)
            {
                break;
            }

            const why = unreadable(p);

            if (why !== null || !alive(entry))
            {
                out.unreadable = why ?? 'destroyed during the frame';

                // A depth buffer or a multisampled target is cleared by the pass that uses it.
                if (why === 'compressed format' || why === 'no COPY_SRC usage')
                {
                    note(capture, 'unreadable-texture');
                }

                break;
            }

            try
            {
                const levels = await readLevels(capture, entry, p.mipLevelCount ?? 1);
                const before = capture.renderTargets.get(entry.id) as unknown as Array<Record<string, unknown>> | undefined;

                // Where the texture was read before the frame, that is what the frame began with.
                out.data = before ? levels.map((level) => before.find((early) => early.level === level.level && early.layer === level.layer) ?? level) : levels;
            }
            catch (error: any)
            {
                out.unreadable = G.String(error?.message ?? error);
            }

            break;
        }

        case 'buffer':
            G.Object.assign(out, { size: p.size ?? 0, usage: p.usage });

            if (inFrame || !p.size)
            {
                break;
            }

            if (!p.readable || !alive(entry) || p.size > MAX_BUFFER)
            {
                out.unreadable = !alive(entry) ? 'destroyed during the frame' : (p.readable ? 'too large to capture' : 'no COPY_SRC usage');
                break;
            }

            try
            {
                out.data = blob(capture, await readBuffer(entry, 0, p.size));
            }
            catch (error: any)
            {
                out.unreadable = G.String(error?.message ?? error);
            }

            break;

        case 'shader':
            out.source = p.source;
            out.language = 'wgsl';
            break;

        case 'pipeline':
            G.Object.assign(out, { type: p.type, descriptor: p.descriptor });
            break;

        case 'layout':
            G.Object.assign(out, { type: p.type, descriptor: p.descriptor ?? null, pipeline: p.pipeline ?? null, index: p.index ?? null });
            break;

        case 'bind_group':
        case 'sampler':
            out.descriptor = p.descriptor;
            break;

        case 'query':
            G.Object.assign(out, { type: p.type, count: p.count });
            break;
    }

    return out;
}

// The frame has ended: describe what it used.
export async function gpuFinish (capture: Capture): Promise<void>
{
    gpuWatchMaps(null);

    const gpu = capture.gpu!;

    capture.header.endFrame = currentFrame();
    capture.header.locals = gpu.nextLocal - 1;

    // Whatever a used object was made from is needed to make it again.
    for (const entry of G.Array.from(capture.used) as Entry[])
    {
        closure(entry, capture.used);
    }

    const order: Kind[] = ['shader', 'sampler', 'texture', 'buffer', 'query', 'layout', 'pipeline', 'bind_group'];
    const entries = (G.Array.from(capture.used) as Entry[]).filter((entry) => entry.api === 'webgpu').sort((a, b) => (order.indexOf(a.kind) - order.indexOf(b.kind)) || (a.id - b.id));

    for (const entry of entries)
    {
        capture.objects.push(await describe(capture, entry));
    }

    if (gpu.passes.size > 0)
    {
        note(capture, 'A pass was still open when the frame ended.');
    }

    gpu.locals.clear();
    gpu.passes.clear();
    gpu.mapped.clear();
    gpu.unmapped.clear();
}

export function gpuRecorder (capture: Capture): Rec['rec']
{
    return (c, method, self, result, count, ...args) => gpuRecord(capture, c, method, self, result, count, args);
}
