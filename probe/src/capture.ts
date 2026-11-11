// Captures one WebGL frame: every call in order, the state at each draw, and the contents
// of every object the frame used (02-ARCHITECTURE.md, section 4).
//
// A capture is what the replay page needs to run the frame again on the same GPU:
//
//   header     the context's API, size, attributes and enabled extensions
//   objects    every object the frame referenced, with its creation parameters and contents
//   initial    the context's state as the frame began, from the tracker's mirror
//   commands   the calls, with data arguments held as blobs
//   draws      one row per draw, clear and blit, with its resolved state
//
// Contents are read when the frame ends, not when it starts. An object's contents at the
// end are its contents at the start plus the frame's own writes, and replay makes those
// writes again, so this is right except where a frame reads data left by an earlier frame
// and then overwrites it. Render targets are the common case of that (a frame that samples
// last frame's result), so their contents are read before the frame as well.

import { currentFrame, isPaused, onFrameSettled } from './clock/gate';
import { allContexts, contextById, type ContextInfo } from './contexts';
import { formatName } from './gl/formats';
import { gpuBegin, gpuDescribe, gpuFinish, gpuRecorder, gpuWatchMaps, type GpuState } from './gpu/capture';
import { openGroups, setGroupSink, type GroupOp } from './groups';
import { hub } from './hooks/hub';
import { CAP_CODES, slotOf, trackerFor, vaoStateOf, type GlTracker, type UniformSlot } from './gl/tracker';
import { METHOD_NAMES } from './hooks/generated';
import type { Rec } from './hooks/hub';
import { G } from './natives';
import { isCompressedFormat, isSrgbCompressed } from './gl/sample';
import { base64, gzip, readBuffer, readGlTexture } from './readback';
import { alive, all, entryOf, find, type Entry, type Kind } from './registry';
import { emit, expose } from './transport';

export interface Capture
{
    id: number;
    info: ContextInfo;
    frame: number;
    header: Record<string, unknown>;
    initial: Record<string, unknown> | null;
    objects: Array<Record<string, unknown>>;
    commands: unknown[];
    draws: Array<Record<string, unknown>>;
    blobs: Uint8Array[];
    notes: string[];

    // While recording
    used: Set<Entry>;
    renderTargets: Map<number, number[]>;   // texture ID -> blob index per level, read before the frame
    buffersBefore?: Map<number, number>;    // WebGPU: buffer ID -> blob, for buffers the GPU writes, read before the frame
    uniformsAtStart: Map<number, Record<string, number[]>>;
    done: boolean;
    waiters: Array<() => void>;

    // Set for a WebGPU capture (gpu/capture.ts).
    gpu?: GpuState;

    // Blob numbers in the stream start here. Zero, except in a flight recording, whose
    // earliest frames (and their blobs) have been dropped.
    blobBase: number;

    // A flight recording spans several frames: where each one ends in the stream.
    frames?: Array<{ frame: number; command: number; draw: number; group?: number }>;

    // Named groups and game objects declared while recording (groups.ts): the number of
    // commands recorded when each was said, what was said, and its name or details. 'open'
    // is a group that was already open when recording began.
    groups: Array<[command: number, op: GroupOp | 'open', payload: unknown]>;

    // Set while the flight recorder fills this capture: the page's objects themselves, so
    // that one the page drops is still there to be read when the recording is taken.
    strong?: Set<object>;

    // Left out for the flight recorder: reading render targets back stalls the page.
    light?: boolean;

    // The flight recorder: what a texture or buffer held just before the page deleted it,
    // read then because it cannot be read afterwards.
    early?: Map<Entry, Promise<Record<string, unknown>>>;
}

const captures = new G.Map() as Map<number, Capture>;

let nextId = 1;
let recording: Capture | null = null;

// Methods that change nothing and are left out of the stream.
const skipped: boolean[] = METHOD_NAMES.map((qualified) =>
{
    const name = qualified.slice(qualified.indexOf('.') + 1);

    return (/^(get|is|check)[A-Z]/.test(name) && name !== 'getExtension') || name === 'readPixels' || name === 'finish' || name === 'flush';
});

type EventKind = 'draw' | 'clear' | 'blit';

const events = new G.Map() as Map<string, EventKind>;

for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'drawArraysInstancedANGLE',
    'drawElementsInstancedANGLE', 'multiDrawArraysWEBGL', 'multiDrawElementsWEBGL', 'multiDrawArraysInstancedWEBGL', 'multiDrawElementsInstancedWEBGL',
    'drawArraysInstancedBaseInstanceWEBGL', 'drawElementsInstancedBaseVertexBaseInstanceWEBGL'])
{
    events.set(name, 'draw');
}

for (const name of ['clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi'])
{
    events.set(name, 'clear');
}

events.set('blitFramebuffer', 'blit');

const eventKinds: Array<EventKind | undefined> = METHOD_NAMES.map((qualified) => events.get(qualified.slice(qualified.indexOf('.') + 1)));
const shortNames: string[] = METHOD_NAMES.map((qualified) => qualified.slice(qualified.indexOf('.') + 1));

// Methods that take a window of a typed array: [index of the data argument, index of the
// offset into it, whether a length follows the offset]. bufferData's usage sits between
// its data and its offset.
const windows: Record<string, [number, number, boolean]> = {
    bufferData: [1, 3, true],
    bufferSubData: [2, 3, true]
};

for (const name of shortNames)
{
    if (/^uniform[1-4](f|i|ui)v$/.test(name))
    {
        windows[name] = [1, 2, true];
    }
    else if (/^uniformMatrix/.test(name))
    {
        windows[name] = [2, 3, true];
    }
}

const SMALL = 64;

export function blob (capture: Capture, bytes: Uint8Array): number
{
    capture.blobs.push(bytes);

    return capture.blobBase + capture.blobs.length - 1;
}

function reference (capture: Capture, object: object): unknown
{
    const entry = entryOf(object);

    if (entry)
    {
        capture.used.add(entry);
        capture.strong?.add(object);

        return { o: entry.kind, i: entry.id };
    }

    const slot = slotOf(object);

    if (slot)
    {
        return { u: slot.program, n: slot.name };
    }

    return undefined;
}

// A drawable source (an image, a canvas, a video frame) as the pixels WebGL would read from it.
export function pixelsOf (capture: Capture, source: any): unknown
{
    try
    {
        if (typeof G.ImageData === 'function' && source instanceof G.ImageData)
        {
            return { img: blob(capture, new G.Uint8Array(source.data.buffer.slice(0))), w: source.width, h: source.height };
        }

        const width: number = source.naturalWidth ?? source.videoWidth ?? source.displayWidth ?? source.width;
        const height: number = source.naturalHeight ?? source.videoHeight ?? source.displayHeight ?? source.height;

        if (!width || !height)
        {
            return null;
        }

        const canvas = new G.OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });

        context.drawImage(source, 0, 0);

        const data = context.getImageData(0, 0, width, height);

        if (!capture.notes.includes('image-source'))
        {
            capture.notes.push('image-source');
        }

        return { img: blob(capture, new G.Uint8Array(data.data.buffer)), w: width, h: height };
    }
    catch
    {
        return null;
    }
}

function encode (capture: Capture, value: any): unknown
{
    if (value === null || value === undefined)
    {
        return null;
    }

    const type = typeof value;

    if (type === 'number')
    {
        // JSON has no NaN or Infinity.
        return G.Number.isFinite(value) ? value : { f: G.String(value) };
    }

    if (type === 'boolean' || type === 'string')
    {
        return value;
    }

    if (type !== 'object')
    {
        return null;
    }

    const ref = reference(capture, value);

    if (ref !== undefined)
    {
        return ref;
    }

    if (G.ArrayBuffer.isView(value) || value instanceof G.ArrayBuffer || (typeof G.SharedArrayBuffer === 'function' && value instanceof G.SharedArrayBuffer))
    {
        const view = G.ArrayBuffer.isView(value) ? value as ArrayBufferView : null;
        const name: string = view ? view.constructor.name : 'ArrayBuffer';
        const length: number = view && name !== 'DataView' ? (view as unknown as ArrayLike<number>).length : -1;

        if (length >= 0 && length <= SMALL)
        {
            return { t: name, a: G.Array.from(view as unknown as ArrayLike<number>, (item: number) => (G.Number.isFinite(item) ? item : G.String(item))) };
        }

        const bytes = view ? new G.Uint8Array(view.buffer, view.byteOffset, view.byteLength) : new G.Uint8Array(value);

        // A copy: the page is free to change its array the moment the call returns.
        return { t: name, b: blob(capture, bytes.slice()) };
    }

    if (G.Array.isArray(value))
    {
        return { a: value.map((item: unknown) => (typeof item === 'number' ? item : encode(capture, item))) };
    }

    return pixelsOf(capture, value);
}

// Encodes a call's arguments. Where the page passes a window into a larger array (a data
// argument followed by an offset), only the window is kept and the offset becomes zero.
function encodeArgs (capture: Capture, name: string, args: any[]): unknown[]
{
    const window = windows[name];

    if (window)
    {
        const [at, from, hasLength] = window;
        const data = args[at];
        const offset = args[from];

        if (G.ArrayBuffer.isView(data) && typeof offset === 'number' && offset > 0 && data.constructor.name !== 'DataView')
        {
            const length = hasLength && typeof args[from + 1] === 'number' && args[from + 1] > 0 ? args[from + 1] : undefined;

            args = args.slice();
            args[at] = (data as any).subarray(offset, length === undefined ? undefined : offset + length);
            args[from] = 0;

            // The length went with the window: what is left is the whole of the array given.
            if (length !== undefined)
            {
                args[from + 1] = 0;
            }
        }
    }

    return args.map((arg) => encode(capture, arg));
}

function use (capture: Capture, object: object | null): number | null
{
    const entry = object ? entryOf(object) : undefined;

    if (entry)
    {
        capture.used.add(entry);
    }

    return object ? entry?.id ?? 0 : null;
}

// The texture a framebuffer's first colour attachment is, if it is one.
function colourTarget (framebuffer: object | null): { texture: number; level: number } | null
{
    const entry = framebuffer ? entryOf(framebuffer) : undefined;
    const attached = entry?.p.attachments?.[0x8CE0];

    return attached && attached.texture ? { texture: attached.texture, level: attached.level ?? 0 } : null;
}

function uniformValues (program: object | null): Record<string, number[]>
{
    const out: Record<string, number[]> = {};
    const slots: Map<string, UniformSlot> | undefined = program ? entryOf(program)?.p.uniforms : undefined;

    if (slots)
    {
        for (const [name, slot] of slots)
        {
            if (slot.set >= 0)
            {
                out[name] = slot.values.slice();
            }
        }
    }

    return out;
}

// The state a draw runs with, from the mirror. Only what is switched on is included.
function drawState (capture: Capture, t: GlTracker, kind: EventKind, name: string, args: any[], command: number): Record<string, unknown>
{
    const enabled: number[] = [];

    for (let i = 0; i < CAP_CODES.length; i++)
    {
        if (t.caps[i] === 1)
        {
            enabled.push(CAP_CODES[i]);
        }
    }

    const on = (cap: number): boolean => t.caps[CAP_CODES.indexOf(cap)] === 1;
    const target = colourTarget(t.drawFramebuffer);

    const row: Record<string, unknown> = {
        command,
        kind,
        method: name,
        framebuffer: use(capture, t.drawFramebuffer),
        target: target ? target.texture : 0,
        targetLevel: target ? target.level : 0,
        viewport: t.viewport.slice(),
        scissor: on(0x0C11) ? t.scissor.slice() : null,
        colorMask: t.colorMask.slice(),
        enabled
    };

    if (kind === 'clear')
    {
        row.mask = name === 'clear' ? args[0] : null;
        row.clearColor = t.clearColor.slice();
        row.clearDepth = t.clearDepth;
        row.clearStencil = t.clearStencil;

        return row;
    }

    if (kind === 'blit')
    {
        row.readFramebuffer = use(capture, t.readFramebuffer);
        row.rects = args.slice(0, 8);

        return row;
    }

    const indexed = name.startsWith('drawElements') || name === 'drawRangeElements';

    G.Object.assign(row, {
        mode: args[0],
        count: name === 'drawRangeElements' ? args[3] : (indexed ? args[1] : args[2]),
        first: indexed ? null : args[1],
        indexType: name === 'drawRangeElements' ? args[4] : (indexed ? args[2] : null),
        indexOffset: name === 'drawRangeElements' ? args[5] : (indexed ? args[3] : null),
        instances: name.includes('Instanced') ? (indexed ? args[4] : args[3]) : 1,
        program: use(capture, t.program),
        vertexArray: use(capture, t.vaoObject),
        elementBuffer: use(capture, t.vao.element),
        attributes: t.vao.attribs.map((attrib, index) => ({ index, ...attrib, buffer: use(capture, attrib.buffer) })).filter((attrib) => attrib.enabled),
        textures: t.units.map((unit, index) => ({
            unit: index,
            t2d: use(capture, unit.t2d),
            cube: use(capture, unit.cube),
            t3d: use(capture, unit.t3d),
            array: use(capture, unit.array),
            sampler: use(capture, unit.sampler)
        })).filter((unit) => unit.t2d !== null || unit.cube !== null || unit.t3d !== null || unit.array !== null),
        uniforms: uniformValues(t.program),
        blend: on(0x0BE2)
            ? { equationRgb: t.blendEquationRgb, equationAlpha: t.blendEquationAlpha, srcRgb: t.blendSrcRgb, dstRgb: t.blendDstRgb, srcAlpha: t.blendSrcAlpha, dstAlpha: t.blendDstAlpha, color: t.blendColor.slice() }
            : null,
        depth: on(0x0B71) ? { func: t.depthFunc, write: t.depthMask, range: t.depthRange.slice() } : null,
        stencil: on(0x0B90) ? { front: { ...t.stencilFront }, back: { ...t.stencilBack } } : null,
        cull: on(0x0B44) ? t.cullFace : null,
        frontFace: t.frontFace,
        polygonOffset: on(0x8037) ? [t.polygonOffsetFactor, t.polygonOffsetUnits] : null
    });

    return row;
}

function record (c: Rec, method: number, self: unknown, result: unknown, count: number, ...args: any[]): void
{
    if (recording !== null)
    {
        recordInto(recording, c, method, self, result, count, args);
    }
}

function recordInto (capture: Capture, c: Rec, method: number, _self: unknown, result: unknown, count: number, args: any[]): void
{
    if (skipped[method])
    {
        return;
    }

    const t = c.x as GlTracker | null;

    if (!t)
    {
        return;
    }

    try
    {
        const name = shortNames[method];
        const kind = eventKinds[method];
        const given = args.slice(0, count);
        const index = capture.commands.length;
        const made = result && typeof result === 'object' ? reference(capture, result) : undefined;

        capture.commands.push(made === undefined ? [method, encodeArgs(capture, name, given)] : [method, encodeArgs(capture, name, given), made]);

        if (kind !== undefined)
        {
            capture.draws.push(drawState(capture, t, kind, name, given, index));
        }
    }
    catch (error: any)
    {
        emit('probe-fault', { where: 'capture', message: G.String(error?.stack ?? error) });
    }
}

// ---- State and contents ----

function initialState (capture: Capture, t: GlTracker): Record<string, unknown>
{
    const vaos: Array<Record<string, unknown>> = [];

    const layout = (vao: { element: object | null; attribs: any[] }): Record<string, unknown> => ({
        element: use(capture, vao.element),
        attribs: vao.attribs.map((attrib, index) => ({ index, ...attrib, buffer: use(capture, attrib.buffer) }))
    });

    for (const entry of all('vertex_array'))
    {
        const object = entry.ref.deref();
        const state = object ? vaoStateOf(object) : undefined;

        if (entry.context === t.info.id && alive(entry) && state)
        {
            capture.used.add(entry);
            vaos.push({ id: entry.id, ...layout(state) });
        }
    }

    const pixelStore: Record<string, unknown> = {};

    for (const [pname, value] of t.pixelStore)
    {
        pixelStore[pname] = value;
    }

    const otherBuffers: Record<string, unknown> = {};

    for (const [target, buffer] of t.otherBuffers)
    {
        otherBuffers[target] = use(capture, buffer);
    }

    return {
        unit: t.unit,
        units: t.units.map((unit) => ({
            t2d: use(capture, unit.t2d),
            cube: use(capture, unit.cube),
            t3d: use(capture, unit.t3d),
            array: use(capture, unit.array),
            sampler: use(capture, unit.sampler)
        })),
        arrayBuffer: use(capture, t.arrayBuffer),
        otherBuffers,
        drawFramebuffer: use(capture, t.drawFramebuffer),
        readFramebuffer: use(capture, t.readFramebuffer),
        renderbuffer: use(capture, t.renderbuffer),
        program: use(capture, t.program),
        vertexArray: use(capture, t.vaoObject),
        defaultVertexArray: layout(t.defaultVao),
        vertexArrays: vaos,
        caps: G.Array.from(t.caps),
        viewport: t.viewport.slice(),
        scissor: t.scissor.slice(),
        clearColor: t.clearColor.slice(),
        clearDepth: t.clearDepth,
        clearStencil: t.clearStencil,
        colorMask: t.colorMask.slice(),
        depthMask: t.depthMask,
        depthFunc: t.depthFunc,
        depthRange: t.depthRange.slice(),
        blendColor: t.blendColor.slice(),
        blendEquationRgb: t.blendEquationRgb,
        blendEquationAlpha: t.blendEquationAlpha,
        blendSrcRgb: t.blendSrcRgb,
        blendDstRgb: t.blendDstRgb,
        blendSrcAlpha: t.blendSrcAlpha,
        blendDstAlpha: t.blendDstAlpha,
        cullFace: t.cullFace,
        frontFace: t.frontFace,
        lineWidth: t.lineWidth,
        polygonOffset: [t.polygonOffsetFactor, t.polygonOffsetUnits],
        sampleCoverage: [t.sampleCoverageValue, t.sampleCoverageInvert],
        stencilFront: { ...t.stencilFront },
        stencilBack: { ...t.stencilBack },
        pixelStore,
        drawBuffers: t.drawBuffers.slice(),
        readBuffer: t.readBuffer
    };
}

// The bytes of a texture level as RGBA, in the number type it can be read in.
function textureLevel (capture: Capture, entry: Entry, level: number, layer: number): { blob: number; kind: string } | { error: string }
{
    try
    {
        const pixels = readGlTexture(entry, capture.info, level, layer, {});
        const source = pixels.channels;

        return { blob: blob(capture, new G.Uint8Array(source.buffer, source.byteOffset, source.byteLength)), kind: pixels.kind };
    }
    catch (error: any)
    {
        return { error: G.String(error?.message ?? error) };
    }
}

function layersOf (p: Record<string, any>, level: number): number
{
    if (p.target === 0x8513)
    {
        return 6;
    }

    if (p.target === 0x8C1A)
    {
        return p.depth || 1;
    }

    if (p.target === 0x806F)
    {
        return G.Math.max(1, (p.depth || 1) >> level);
    }

    return 1;
}

function describeTexture (capture: Capture, entry: Entry): Record<string, unknown>
{
    const p = entry.p;
    const out: Record<string, unknown> = {
        target: p.target ?? null,
        width: p.width ?? 0,
        height: p.height ?? 0,
        depth: p.depth ?? 1,
        internalFormat: p.internalFormat ?? null,
        format: p.internalFormat === undefined ? null : formatName(p.internalFormat),
        type: p.type ?? 0,
        levels: p.levels ?? 1,
        immutable: Boolean(p.immutable),
        generatedMips: Boolean(p.generatedMips),
        renderTarget: Boolean(p.renderTarget),
        params: p.params ?? {}
    };

    // A compressed texture is read as the texels its blocks decode to, and replayed as a
    // texture of those: 8-bit RGBA, sRGB where the blocks are.
    if (p.compressed || isCompressedFormat(p.internalFormat))
    {
        out.decodedAs = capture.info.api === 'webgl2' ? (isSrgbCompressed(p.internalFormat) ? 0x8C43 : 0x8058) : 0x1908;
    }

    if (!p.width || !p.height || p.createdInFrame)
    {
        return out;
    }

    if (!alive(entry))
    {
        // Reading a deleted texture would raise a GL error the page could see.
        out.unreadable = 'It was deleted during the frame.';

        return out;
    }

    // A render target was read before the frame: that is what the frame started with.
    const before = capture.renderTargets.get(entry.id);

    if (before)
    {
        out.data = before;

        return out;
    }

    // With generated mipmaps only the base level is needed; replay generates the rest.
    const levels = p.generatedMips ? 1 : (p.levels ?? 1);
    const data: unknown[] = [];

    for (let level = 0; level < levels; level++)
    {
        for (let layer = 0; layer < layersOf(p, level); layer++)
        {
            const read = textureLevel(capture, entry, level, layer);

            if ('error' in read)
            {
                out.unreadable = read.error;

                if (!capture.notes.includes('unreadable-texture'))
                {
                    capture.notes.push('unreadable-texture');
                }

                return out;
            }

            data.push({ level, layer, ...read });
        }
    }

    out.data = data;

    return out;
}

async function describe (capture: Capture, entry: Entry): Promise<Record<string, unknown>>
{
    const p = entry.p;
    const out: Record<string, unknown> = { kind: entry.kind, id: entry.id, label: entry.label, created: entry.created, alive: alive(entry) };
    const gl = capture.info.ctx;
    const n = capture.info.natives;
    const object = entry.ref.deref();

    switch (entry.kind)
    {
        case 'texture':
            G.Object.assign(out, describeTexture(capture, entry));
            break;

        case 'buffer':
            out.size = p.size ?? 0;
            out.usage = p.usage ?? 0x88E4;
            out.element = p.element ?? null;

            if (alive(entry) && p.size > 0 && !p.createdInFrame)
            {
                try
                {
                    out.data = blob(capture, await readBuffer(entry, 0, p.size));
                }
                catch (error: any)
                {
                    out.unreadable = G.String(error?.message ?? error);
                }
            }

            break;

        case 'shader':
            out.type = p.type;
            out.source = p.source;

            // What the browser compiled the source to (ANGLE's translation), where it will say.
            if (object && alive(entry) && p.compiles > 0)
            {
                try
                {
                    const debug = n.getExtension.call(gl, 'WEBGL_debug_shaders');
                    const translated = debug ? G.String(debug.getTranslatedShaderSource(object) ?? '') : '';

                    if (translated)
                    {
                        out.translated = translated;
                    }
                }
                catch { /* a capture is whole without it */ }
            }

            break;

        case 'program':
        {
            out.shaders = p.shaders;
            out.blockBindings = p.blockBindings ?? {};
            out.uniforms = capture.uniformsAtStart.get(entry.id) ?? {};

            // Attribute locations are the linker's choice unless bound. Replay must bind them
            // to the same places, or the vertex layout would point at the wrong attributes.
            const attributes: Record<string, number> = {};

            if (object && alive(entry) && p.links > 0)
            {
                const count: number = n.getProgramParameter.call(gl, object, 0x8B89) ?? 0;

                for (let i = 0; i < count; i++)
                {
                    const active = n.getActiveAttrib.call(gl, object, i);

                    if (active && !active.name.startsWith('gl_'))
                    {
                        attributes[active.name] = n.getAttribLocation.call(gl, object, active.name);
                    }
                }
            }

            out.attributes = attributes;

            for (const shader of p.shaders as number[])
            {
                const attached = find('shader', shader);

                if (attached)
                {
                    capture.used.add(attached);
                }
            }

            break;
        }

        case 'framebuffer':
            out.attachments = p.attachments;
            out.drawBuffers = p.drawBuffers ?? null;
            out.readBuffer = p.readBuffer ?? null;

            for (const point of G.Object.keys(p.attachments))
            {
                const attached = p.attachments[point];
                const other = attached.texture ? find('texture', attached.texture) : (attached.renderbuffer ? find('renderbuffer', attached.renderbuffer) : undefined);

                if (other)
                {
                    capture.used.add(other);
                }
            }

            break;

        case 'renderbuffer':
            G.Object.assign(out, { internalFormat: p.internalFormat ?? null, width: p.width ?? 0, height: p.height ?? 0, samples: p.samples ?? 0 });
            break;

        case 'sampler':
            out.params = p.params ?? {};
            break;

        case 'query':
            out.transformFeedback = Boolean(p.transformFeedback);
            break;
    }

    return out;
}

// Reads the contents of everything the frame used. Describing one object can bring in
// others (a program's shaders, a framebuffer's attachments), so this runs until none are new.
async function gather (capture: Capture): Promise<void>
{
    const described = new G.Set() as Set<Entry>;

    for (let pass = 0; pass < 8; pass++)
    {
        const pending = [...capture.used].filter((entry) => !described.has(entry));

        if (pending.length === 0)
        {
            break;
        }

        // Shaders before programs, attachments before framebuffers: creation order.
        pending.sort((a, b) => a.created - b.created || a.id - b.id);

        for (const entry of pending)
        {
            described.add(entry);

            // Deleted while the recorder ran, and read just before it was: that reading
            // is the only one there can be. Only for an object the recording does not
            // itself create.
            const early = entry.created < capture.frame ? capture.early?.get(entry) : undefined;

            if (early)
            {
                try
                {
                    capture.objects.push({ ...(await early), alive: false });

                    continue;
                }
                catch { /* described as a deleted object, below */ }
            }

            capture.objects.push(await describe(capture, entry));
        }
    }
}

function stopRecording (capture: Capture): void
{
    if (capture.gpu)
    {
        hub.gpu.rec = null;
        gpuWatchMaps(null);
    }
    else
    {
        capture.info.record.rec = null;
    }
}

// A capture with nothing in it yet.
function blank (info: ContextInfo): Capture
{
    return {
        id: nextId++,
        info,
        frame: currentFrame() + 1,
        header: {},
        initial: null,
        objects: [],
        commands: [],
        draws: [],
        blobs: [],
        notes: [],
        used: new G.Set(),
        renderTargets: new G.Map(),
        uniformsAtStart: new G.Map(),
        done: false,
        waiters: [],
        blobBase: 0,
        groups: openGroups().map((name) => [0, 'open', name])
    };
}

function begin (info: ContextInfo, light = false): Capture
{
    const t = trackerFor(info)!;
    const gl = info.ctx;

    const capture: Capture = {
        id: nextId++,
        info,
        frame: currentFrame() + 1,
        header: {
            api: info.api,
            width: gl.drawingBufferWidth,
            height: gl.drawingBufferHeight,
            attributes: info.attributes,
            extensions: [...t.extensions]
        },
        initial: null,
        objects: [],
        commands: [],
        draws: [],
        blobs: [],
        notes: [],
        used: new G.Set(),
        renderTargets: new G.Map(),
        uniformsAtStart: new G.Map(),
        done: false,
        waiters: [],
        blobBase: 0,
        groups: openGroups().map((name) => [0, 'open', name]),
        light
    };

    capture.initial = initialState(capture, t);

    // What each program's uniforms hold as the frame begins.
    for (const entry of all('program'))
    {
        if (entry.context === info.id && alive(entry))
        {
            capture.uniformsAtStart.set(entry.id, uniformValues(entry.ref.deref() ?? null));
        }
    }

    // Render targets as the frame begins: a frame may sample what the last one drew.
    for (const entry of light ? [] : all('texture'))
    {
        if (entry.context === info.id && alive(entry) && entry.p.renderTarget && entry.p.width)
        {
            const levels: unknown[] = [];

            for (let layer = 0; layer < layersOf(entry.p, 0); layer++)
            {
                const read = textureLevel(capture, entry, 0, layer);

                if ('error' in read)
                {
                    // A depth texture, or a format that cannot be read: the frame is expected to clear it.
                    levels.length = 0;
                    break;
                }

                levels.push({ level: 0, layer, ...read });
            }

            if (levels.length)
            {
                capture.renderTargets.set(entry.id, levels as number[]);
            }
        }
    }

    return capture;
}

// Marks objects made during the frame: replay makes them by running the frame's own calls.
function markCreatedInFrame (capture: Capture): void
{
    for (const entry of capture.used)
    {
        if (entry.created >= capture.frame)
        {
            entry.p.createdInFrame = true;
        }
    }
}

async function finish (capture: Capture): Promise<void>
{
    try
    {
        if (capture.gpu)
        {
            await gpuFinish(capture);
        }
        else
        {
            markCreatedInFrame(capture);
            await gather(capture);
        }
    }
    catch (error: any)
    {
        capture.notes.push(`fault: ${G.String(error?.message ?? error)}`);
        emit('probe-fault', { where: 'capture', message: G.String(error?.stack ?? error) });
    }
    finally
    {
        for (const entry of capture.used)
        {
            delete entry.p.createdInFrame;
        }

        capture.done = true;

        for (const resolve of capture.waiters)
        {
            resolve();
        }
    }
}

function gpuContext (id: number | undefined): ContextInfo
{
    const info = id === undefined
        ? allContexts().filter((candidate) => candidate.api === 'webgl' || candidate.api === 'webgl2' || candidate.api === 'webgpu').sort((a, b) => b.record.draws - a.record.draws)[0]
        : contextById(id);

    if (!info)
    {
        throw new Error('There is no WebGL or WebGPU context to capture.');
    }

    if (info.api !== 'webgl' && info.api !== 'webgl2' && info.api !== 'webgpu')
    {
        throw new Error(`Context ${info.id} is a ${info.api} context, which has no frames to capture.`);
    }

    if (info.lost)
    {
        throw new Error(`Context ${info.id} is lost.`);
    }

    return info;
}

// ---- The flight recorder ----
//
// While it runs, every frame is recorded as it goes by, and the last `keep` of them are
// held. Frames are recorded in runs of CHUNK: each run is a capture that begins with the
// state as it then stood, so when the oldest run is dropped the next one can still be
// replayed from its own beginning. Taking the recording joins the runs into one capture
// that spans many frames and reads, once, the contents of what those frames used.

const CHUNK = 30;
const MAX_HELD = 256 * 1024 * 1024;

interface Recorder
{
    info: ContextInfo;
    keep: number;
    chunks: Capture[];      // oldest first; the last is being filled
    blobs: number;          // blobs ever recorded, which is the next chunk's base
    started: boolean;
    shortened: boolean;
}

let recorder: Recorder | null = null;

// The most of one object's contents the recorder will read at the moment it is deleted.
const MAX_EARLY = 64 * 1024 * 1024;

// A texture or buffer is about to be deleted while the recorder runs. If a kept frame used
// it and it was made before this run of frames, its contents are read now: by the time the
// recording is taken there will be nothing to read. (One made during this run is rebuilt
// from the calls recorded.)
function keepBeforeDelete (active: Recorder, object: any): void
{
    try
    {
        const entry = object && typeof object === 'object' ? entryOf(object) : undefined;
        const chunk = active.chunks[active.chunks.length - 1];

        if (!entry || !chunk || (entry.kind !== 'texture' && entry.kind !== 'buffer') || !alive(entry) || entry.created >= chunk.frame)
        {
            return;
        }

        // A WebGL frame names the textures and buffers it uses. A WebGPU frame names bind
        // groups and views, and what they hold is only worked out at the end: there, any
        // texture or buffer older than this run of frames is read.
        if (active.info.api !== 'webgpu' && !active.chunks.some((run) => run.used.has(entry)))
        {
            return;
        }

        const p = entry.p;
        const bytes = entry.kind === 'buffer' ? (p.size ?? 0) : (p.width ?? 0) * (p.height ?? 0) * (p.depth ?? p.depthOrArrayLayers ?? 1) * 4 * 1.34;

        if (bytes > MAX_EARLY)
        {
            return;
        }

        const reading = active.info.api === 'webgpu' ? gpuDescribe(chunk, entry) : describe(chunk, entry);

        // Read when the recording is taken; a failure then is that object's alone.
        reading.catch(() => undefined);
        (chunk.early ??= new G.Map()).set(entry, reading);
    }
    catch (error: any)
    {
        emit('probe-fault', { where: 'recorder', message: G.String(error?.stack ?? error) });
    }
}

function heldBytes (active: Recorder): number
{
    let total = 0;

    for (const chunk of active.chunks)
    {
        for (const bytes of chunk.blobs)
        {
            total += bytes.length;
        }
    }

    return total;
}

// Begins a new run of frames, with the state as it stands between two frames.
async function nextChunk (active: Recorder): Promise<void>
{
    const info = active.info;
    const last = active.chunks[active.chunks.length - 1];

    let chunk: Capture;

    if (info.api === 'webgpu')
    {
        chunk = blank(info);
        chunk.light = true;

        if (last)
        {
            // One set of numbers for the whole recording. A view made in an earlier run is
            // described in full from here on, because that run may be dropped before this one.
            chunk.header = last.header;
            chunk.gpu = last.gpu;
            chunk.gpu!.firstLocal = chunk.gpu!.nextLocal;
        }
        else
        {
            await gpuBegin(chunk, info);
        }

        firstLocals.set(chunk, chunk.gpu!.nextLocal);
    }
    else
    {
        chunk = begin(info, true);
    }

    chunk.blobBase = active.blobs;
    chunk.strong = new G.Set();
    chunk.frames = [];
    active.chunks.push(chunk);

    if (info.api === 'webgpu')
    {
        hub.gpu.rec = gpuRecorder(chunk);
        hub.gpu.before = (_c, self) => keepBeforeDelete(active, self);
        gpuWatchMaps(chunk);
    }
    else
    {
        info.record.rec = (c, method, self, result, count, ...args) => recordInto(chunk, c, method, self, result, count, args);
        info.record.before = (_c, _self, object) => keepBeforeDelete(active, object);
    }
}

function framesIn (chunks: Capture[]): number
{
    return chunks.reduce((sum, chunk) => sum + (chunk.frames?.length ?? 0), 0);
}

// A frame has ended. Marks where, and lets the oldest frames go.
function recorderFrame (active: Recorder): void
{
    const chunk = active.chunks[active.chunks.length - 1];

    if (!chunk)
    {
        return;
    }

    chunk.frames!.push({ frame: currentFrame(), command: chunk.commands.length, draw: chunk.draws.length, group: chunk.groups.length });

    if (chunk.frames!.length < CHUNK)
    {
        return;
    }

    active.blobs += chunk.blobs.length;

    // Synchronous for WebGL. For WebGPU the first run did the only work that waits.
    void nextChunk(active);

    // Drop whole runs from the front while what is left still covers `keep` frames, or
    // while the data the frames wrote is more than is reasonable to hold.
    while (active.chunks.length > 2 && (framesIn(active.chunks.slice(1, -1)) >= active.keep || heldBytes(active) > MAX_HELD))
    {
        if (framesIn(active.chunks.slice(1, -1)) < active.keep)
        {
            active.shortened = true;
        }

        const dropped = active.chunks.shift()!;
        const gpu = dropped.gpu;

        if (gpu)
        {
            // Encoders, passes and views made in the dropped frames.
            const first = active.chunks[0].gpu === gpu ? firstLocalOf(active.chunks[0]) : gpu.nextLocal;

            for (const [object, id] of gpu.locals)
            {
                if (id < first)
                {
                    gpu.locals.delete(object);
                }
            }
        }
    }
}

const firstLocals = new G.WeakMap() as WeakMap<Capture, number>;

function firstLocalOf (chunk: Capture): number
{
    return firstLocals.get(chunk) ?? 1;
}

function stopRecorder (): void
{
    const active = recorder;

    if (!active)
    {
        return;
    }

    recorder = null;

    if (active.info.api === 'webgpu')
    {
        hub.gpu.rec = null;
        hub.gpu.before = null;
        gpuWatchMaps(null);
    }
    else
    {
        active.info.record.rec = null;
        active.info.record.before = null;
    }
}

// Joins the recorder's runs into one capture of many frames.
function joined (active: Recorder): Capture
{
    const chunks = active.chunks;
    const first = chunks[0];

    const capture: Capture = {
        ...first,
        id: nextId++,
        objects: [],
        commands: [],
        draws: [],
        blobs: [],
        notes: [],
        used: new G.Set(),
        frames: [],
        groups: [],
        done: false,
        waiters: [],
        strong: new G.Set(),
        early: undefined
    };

    for (const chunk of chunks)
    {
        const commandBase = capture.commands.length;
        const drawBase = capture.draws.length;

        for (const command of chunk.commands)
        {
            capture.commands.push(command);
        }

        for (const row of chunk.draws)
        {
            row.command = (row.command as number) + commandBase;
            capture.draws.push(row);
        }

        const groupBase = capture.groups.length;
        const opened = chunk !== chunks[0] ? chunk.groups.filter((entry) => entry[1] === 'open').length : 0;

        // Groups already open as a later run began were opened in an earlier one.
        for (const entry of chunk.groups.slice(opened))
        {
            capture.groups.push([entry[0] + commandBase, entry[1], entry[2]]);
        }

        for (const mark of chunk.frames ?? [])
        {
            capture.frames!.push({
                frame: mark.frame,
                command: mark.command + commandBase,
                draw: mark.draw + drawBase,
                group: G.Math.max(0, (mark.group ?? 0) - opened) + groupBase
            });
        }

        for (const bytes of chunk.blobs)
        {
            capture.blobs.push(bytes);
        }

        for (const entry of chunk.used)
        {
            capture.used.add(entry);
        }

        for (const [entry, reading] of chunk.early ?? [])
        {
            (capture.early ??= new G.Map()).set(entry, reading);
        }

        for (const text of chunk.notes)
        {
            if (!capture.notes.includes(text))
            {
                capture.notes.push(text);
            }
        }
    }

    // Calls made after the last whole frame belong to a frame that has not finished.
    const end = capture.frames!.length ? capture.frames![capture.frames!.length - 1] : { command: 0, draw: 0, group: 0 };

    capture.commands.length = end.command;
    capture.draws.length = end.draw;
    capture.groups.length = G.Math.min(capture.groups.length, end.group ?? 0);

    if (active.shortened)
    {
        capture.notes.push('The frames wrote more data than the flight recorder holds, so it kept fewer of them than asked.');
    }

    return capture;
}

// A group opened or closed, or a game object declared, while something is recording.
function noteGroup (op: GroupOp, payload: unknown): void
{
    if (recording !== null)
    {
        recording.groups.push([recording.commands.length, op, payload]);
    }

    if (recorder !== null)
    {
        const chunk = recorder.chunks[recorder.chunks.length - 1];

        if (chunk && chunk !== recording)
        {
            chunk.groups.push([chunk.commands.length, op, payload]);
        }
    }
}

export function installCapture (): void
{
    setGroupSink(noteGroup);

    onFrameSettled(() =>
    {
        const active = recorder;

        if (active === null)
        {
            return;
        }

        if (!active.started)
        {
            // Asked for while a frame was under way: this is the first moment between two.
            active.started = true;
            void nextChunk(active);

            return;
        }

        recorderFrame(active);
    });

    // Starts the flight recorder on a context. Frames are kept from the next one on.
    expose('record.start', async (args: { context?: number; frames?: number }) =>
    {
        if (recording !== null)
        {
            throw new Error('A capture is armed. Take it first.');
        }

        stopRecorder();

        const info = gpuContext(args.context);

        if (info.api === 'webgpu' && !info.gpu?.device)
        {
            throw new Error(`Context ${info.id} is a WebGPU context that has not been configured, so there is nothing to record yet.`);
        }

        const active: Recorder = { info, keep: G.Math.max(1, G.Math.min(args.frames ?? 120, 600)), chunks: [], blobs: 0, started: false, shortened: false };

        recorder = active;

        if (isPaused())
        {
            active.started = true;
            await nextChunk(active);
        }

        return { context: info.id, frames: active.keep, from: currentFrame() + 1 };
    });

    expose('record.status', () =>
    {
        const active = recorder;

        return active ? { recording: true, context: active.info.id, keep: active.keep, held: framesIn(active.chunks), bytes: heldBytes(active) } : { recording: false };
    });

    expose('record.stop', () =>
    {
        stopRecorder();
    });

    // Ends the recording and turns it into one capture of every frame held, to be fetched
    // with capture.take. The page must be paused: contents are read as the last frame left them.
    expose('record.freeze', () =>
    {
        const active = recorder;

        if (!active)
        {
            throw new Error('The flight recorder is not running.');
        }

        stopRecorder();

        const capture = joined(active);

        if (capture.frames!.length === 0)
        {
            throw new Error('The flight recorder has no whole frame yet.');
        }

        captures.set(capture.id, capture);

        void finish(capture);

        const frames = capture.frames!;

        return { capture: capture.id, context: active.info.id, frames: frames.length, first: frames[0].frame, last: frames[frames.length - 1].frame };
    });

    // The frame has ended, and so have the timers that came due with it (a page may draw
    // from those): stop recording and read what the frame used.
    onFrameSettled(() =>
    {
        const capture = recording;

        if (capture === null)
        {
            return;
        }

        recording = null;
        stopRecording(capture);
        capture.header.endFrame = currentFrame();

        void finish(capture);
    });

    // Arms a capture of the next frame. The page must be paused, so that the state read now
    // is the state the frame begins with.
    expose('capture.arm', async (args: { context?: number }) =>
    {
        if (recording !== null)
        {
            throw new Error('A capture is already armed.');
        }

        // One recorder at a time on a context: a single capture takes its place.
        stopRecorder();

        const info = gpuContext(args.context);

        let capture: Capture;

        if (info.api === 'webgpu')
        {
            capture = blank(info);
            await gpuBegin(capture, info);

            // Every WebGPU object shares one record, so the recorder itself keeps to this device.
            hub.gpu.rec = gpuRecorder(capture);
            gpuWatchMaps(capture);
        }
        else
        {
            capture = begin(info);
            info.record.rec = record;
        }

        captures.set(capture.id, capture);
        recording = capture;

        return { capture: capture.id, context: info.id, frame: capture.frame };
    });

    // The capture's description and tables. Everything but the blobs.
    expose('capture.take', async (args: { capture: number }) =>
    {
        const capture = captures.get(args.capture);

        if (!capture)
        {
            throw new Error(`No capture ${args.capture} in this page.`);
        }

        if (recording === capture)
        {
            // The frame it was armed for never ran.
            recording = null;
            stopRecording(capture);
            captures.delete(capture.id);

            throw new Error('The frame the capture was armed for did not run: the page issued no frame.');
        }

        if (!capture.done)
        {
            await new G.Promise((resolve: () => void) => capture.waiters.push(resolve));
        }

        const body = G.JSON.stringify({
            header: { ...capture.header, context: capture.info.id, frame: capture.frame, notes: capture.notes, blobBase: capture.blobBase, frames: capture.frames, groups: capture.groups },
            initial: capture.initial,
            objects: capture.objects,
            // The names its method numbers stand for. A capture carries its own table, so it
            // stays readable when a later version numbers methods differently.
            methods: METHOD_NAMES,
            commands: capture.commands,
            draws: capture.draws,
            blobs: capture.blobs.map((bytes) => bytes.length)
        });

        return {
            frame: capture.frame,
            commands: capture.commands.length,
            draws: capture.draws.length,
            blobs: capture.blobs.length,
            blobBytes: capture.blobs.reduce((sum, bytes) => sum + bytes.length, 0),
            encoding: 'json+gzip+base64',
            body: base64(await gzip(new G.TextEncoder().encode(body)))
        };
    });

    // Blobs in order, several to a call, up to about `budget` bytes of them.
    expose('capture.blobs', async (args: { capture: number; from: number; budget?: number }) =>
    {
        const capture = captures.get(args.capture);

        if (!capture)
        {
            throw new Error(`No capture ${args.capture} in this page.`);
        }

        const budget = args.budget ?? 8 * 1024 * 1024;
        const out: string[] = [];

        let size = 0;
        let index = args.from;

        while (index < capture.blobs.length && (out.length === 0 || size + capture.blobs[index].length <= budget))
        {
            size += capture.blobs[index].length;
            out.push(base64(await gzip(capture.blobs[index])));
            index++;
        }

        return { from: args.from, next: index, done: index >= capture.blobs.length, encoding: 'gzip+base64', blobs: out };
    });

    expose('capture.release', (args: { capture: number }) =>
    {
        captures.delete(args.capture);
    });
}

// Unused kinds are named so the list stays in step with the registry's.
export const CAPTURED_KINDS: Kind[] = ['texture', 'buffer', 'shader', 'program', 'framebuffer', 'renderbuffer', 'sampler', 'vertex_array', 'query'];
