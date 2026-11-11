// The analysis of a WebGPU capture that needs the frame drawn differently from how the
// page drew it: which draw owns a pixel, how often each pixel is drawn, the triangles as
// outlines, what happened to one pixel, what a vertex shader made of its vertices, how
// long each draw takes, and what the uniform buffers hold by name.
//
// WebGPU fixes most of what WebGL lets a debugger switch on the fly: the tests, the
// blend and the shaders are all part of a pipeline, and a pipeline cannot be changed. So
// each recipe here makes *variants* of the page's pipelines, from the descriptors the
// capture kept, and issues the page's draws with those in place of its own.
//
// Two things make that harder than it sounds, and shape the code below:
//
//   - A pipeline made with layout 'auto' takes only bind groups made from its own
//     layouts. A variant of one is a different pipeline, so its bind groups are made
//     again from the page's descriptors, against the variant's layouts.
//   - A draw's fragment shader cannot be swapped for another without changing which
//     resources the pipeline uses. Where a recipe needs a colour of its own written, it
//     writes a second entry point that calls the page's and then replaces the colour
//     (wgsl.ts), so the same fragments are kept and the same resources used.

import { DRAW_CALLS, GpuRun, endOf, halfToFloat, isFloat, pixelOf, sameTarget, targetOf, toRgba8, type Json, type Loaded, type PassNow, type Raw } from './gpu';
import { LINES, LINE_STRIP, POINTS, TRIANGLES, TRIANGLE_STRIP, tally } from './tally';
import * as wgsl from '../../shared/wgsl';

const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_RENDER = 0x10;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_INDEX = 0x0010;
const BUFFER_QUERY_RESOLVE = 0x0200;
const BUFFER_MAP_READ = 0x0001;

const KEEP_ALL = '@fragment fn scanline_keep () {}';

// Stands for "this variant has no bind group at that place".
const NONE = Symbol('none');

interface Variant
{
    key: string;
    pipeline: any;
    auto: boolean;                  // made with layout 'auto': bind groups are made again for it
    keep: Set<string> | null;       // "group:binding" of what its layouts hold, when that is less than the page's
}

// What a change to a pipeline's descriptor reports: null when the variant cannot be made.
type Changed = { keep?: Set<string> | null } | null;

class Variants
{
    run: GpuRun;
    made = new Map<string, Variant | null>();
    groups = new Map<string, any>();
    modules = new Map<number, wgsl.Module | null>();
    shaders = new Map<string, any>();
    failed = 0;

    constructor (run: GpuRun)
    {
        this.run = run;
    }

    // A shader module of the capture, read. Null when the reader could not follow it.
    module (id: number): wgsl.Module | null
    {
        if (!this.modules.has(id))
        {
            let read: wgsl.Module | null = null;

            try
            {
                read = wgsl.scan(String(this.run.records.get(`shader:${id}`)?.source ?? ''));
            }
            catch
            {
                read = null;
            }

            this.modules.set(id, read);
        }

        return this.modules.get(id)!;
    }

    shader (source: string): any
    {
        let made = this.shaders.get(source);

        if (!made)
        {
            made = this.run.device.createShaderModule({ label: 'scanline: a stand-in', code: source });
            this.shaders.set(source, made);
        }

        return made;
    }

    // The page's own descriptor for a pipeline, as the capture kept it.
    raw (pipeline: number | null): Json | null
    {
        const record = pipeline === null ? null : this.run.records.get(`pipeline:${pipeline}`);

        return record && record.type !== 'compute' ? record.descriptor : null;
    }

    // A pipeline like one of the page's, with `change` made to its descriptor.
    async make (pipeline: number, kind: string, change: (descriptor: Json, raw: Json) => Changed): Promise<Variant | null>
    {
        const key = `${pipeline}:${kind}`;

        if (this.made.has(key))
        {
            return this.made.get(key)!;
        }

        const raw = this.raw(pipeline);

        let variant: Variant | null = null;

        if (raw)
        {
            let made: any = null;
            let changed: Changed = null;
            let auto = false;

            const error = await this.run.checked(() =>
            {
                const descriptor = this.run.revive(raw);

                changed = change(descriptor, raw);

                if (changed)
                {
                    auto = descriptor.layout === 'auto';
                    made = this.run.device.createRenderPipeline(descriptor);
                }
            });

            if (made && !error)
            {
                variant = { key, pipeline: made, auto, keep: (changed as Changed)?.keep ?? null };
            }
            else if (error)
            {
                this.failed++;
            }
        }

        this.made.set(key, variant);

        return variant;
    }

    // One of the page's bind groups, made again for a variant's own layout. Null when it
    // cannot be made; NONE when the variant's layout has no such group to fill.
    async group (variant: Variant, index: number, id: number): Promise<any>
    {
        const key = `${variant.key}:${index}:${id}`;

        if (this.groups.has(key))
        {
            return this.groups.get(key);
        }

        let made: any = null;
        let empty = false;

        const error = await this.run.checked(() =>
        {
            const descriptor = this.run.revive(this.run.records.get(`bind_group:${id}`)?.descriptor);

            descriptor.layout = variant.pipeline.getBindGroupLayout(index);

            if (variant.keep)
            {
                descriptor.entries = (descriptor.entries ?? []).filter((entry: Json) => variant.keep!.has(`${index}:${entry.binding}`));
                empty = descriptor.entries.length === 0;
            }

            made = this.run.device.createBindGroup(descriptor);
        });

        // A layout that stops short of this group raises an error when asked for it.
        const result = error ? (empty ? NONE : null) : made;

        this.groups.set(key, result);

        return result;
    }

    // Puts a variant in place on a pass. False when its bind groups could not be made.
    async use (pass: any, now: PassNow, variant: Variant): Promise<boolean>
    {
        pass.setPipeline(variant.pipeline);

        if (!variant.auto)
        {
            return true;
        }

        for (const [index, group] of now.groups)
        {
            const made = await this.group(variant, index, group.id);

            if (!made)
            {
                return false;
            }

            if (made !== NONE)
            {
                pass.setBindGroup(index, made);
            }
        }

        return true;
    }

    // Puts back what the page had set.
    restore (pass: any, now: PassNow): void
    {
        if (now.pipeline !== null)
        {
            pass.setPipeline(this.run.object('pipeline', now.pipeline));
        }

        for (const [index, group] of now.groups)
        {
            pass.setBindGroup(index, this.run.object('bind_group', group.id), ...group.offsets);
        }

        if (now.index)
        {
            pass.setIndexBuffer(this.run.object('buffer', now.index.id), now.index.format, now.index.offset, now.index.size ?? undefined);
        }
    }

    // What the vertex stage of a pipeline can reach, as "group:binding". Null when its
    // shader could not be read.
    vertexUses (raw: Json): Set<string> | null
    {
        const module = this.module(raw.vertex?.module?.id);
        const entry = module ? wgsl.entryPoint(module, 'vertex', raw.vertex?.entryPoint ?? null) : null;

        return module && entry ? new Set(wgsl.reachable(module, entry).map((global) => `${global.group}:${global.binding}`)) : null;
    }
}

function byCommandOf (item: Loaded): Map<number, number>
{
    const out = new Map<number, number>();

    item.data.draws.forEach((row, index) => out.set(row.command, index));

    return out;
}

// The first colour attachment of a pass, by its place in the list.
function firstColour (descriptor: Json): number
{
    return Array.from(descriptor?.colorAttachments ?? []).findIndex(Boolean);
}

// The texture a pass draws to: what its first colour attachment resolves to, or is.
function drawnTo (run: GpuRun, descriptor: Json): any
{
    const first: any = Array.from(descriptor?.colorAttachments ?? []).find(Boolean);

    return first ? run.viewOwner.get(first.resolveTarget ?? first.view) : null;
}

function textureOf (run: GpuRun, target: Json): any
{
    try
    {
        return run.texture(target);
    }
    catch
    {
        return null;
    }
}

function srgbToLinear (value: number): number
{
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb (value: number): number
{
    return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

interface Args
{
    indexed: boolean;
    count: number;
    instances: number;
    first: number;
    baseVertex: number;
    firstInstance: number;
}

// What a draw call asks for. An indirect draw's numbers are read from its buffer, which
// splits the open pass: ask for the pass again afterwards.
async function drawArgs (run: GpuRun, name: string, args: any[]): Promise<Args | null>
{
    const number = (value: any, otherwise: number): number => (typeof value === 'number' ? value : otherwise);

    if (name === 'draw')
    {
        return { indexed: false, count: number(args[0], 0), instances: number(args[1], 1), first: number(args[2], 0), baseVertex: 0, firstInstance: number(args[3], 0) };
    }

    if (name === 'drawIndexed')
    {
        return { indexed: true, count: number(args[0], 0), instances: number(args[1], 1), first: number(args[2], 0), baseVertex: number(args[3], 0), firstInstance: number(args[4], 0) };
    }

    if (name !== 'drawIndirect' && name !== 'drawIndexedIndirect')
    {
        return null;
    }

    await run.flush();

    const indexed = name === 'drawIndexedIndirect';
    const bytes = await run.bytes(args[0], number(args[1], 0), indexed ? 20 : 16);

    if (!bytes || bytes.length < (indexed ? 20 : 16))
    {
        return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    return indexed
        ? { indexed, count: view.getUint32(0, true), instances: view.getUint32(4, true), first: view.getUint32(8, true), baseVertex: view.getInt32(12, true), firstInstance: view.getUint32(16, true) }
        : { indexed, count: view.getUint32(0, true), instances: view.getUint32(4, true), first: view.getUint32(8, true), baseVertex: 0, firstInstance: view.getUint32(12, true) };
}

// The index values a draw names, in order. Splits the open pass.
async function indicesOf (run: GpuRun, now: PassNow, args: Args, most: number): Promise<number[] | null>
{
    if (!args.indexed || !now.index)
    {
        return null;
    }

    const wide = now.index.format === 'uint32';
    const size = wide ? 4 : 2;
    const count = Math.min(args.count, most);

    await run.flush();

    const bytes = await run.bytes(run.object('buffer', now.index.id), now.index.offset + args.first * size, count * size);

    if (!bytes)
    {
        return null;
    }

    const whole = bytes.length - (bytes.length % size);
    const copy = bytes.slice(0, whole);

    return Array.from(wide ? new Uint32Array(copy.buffer) : new Uint16Array(copy.buffer));
}

// A texture of the replay's own, read whole: rows from the top, packed.
async function readOwn (run: GpuRun, texture: any, bytes: number): Promise<Uint8Array>
{
    const { width, height } = texture;
    const stride = Math.ceil(width * bytes / 256) * 256;
    const buffer = run.device.createBuffer({ size: Math.max(4, stride * height), usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
    const encoder = run.device.createCommandEncoder();

    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
    run.queue.submit([encoder.finish()]);

    await buffer.mapAsync(0x0001);

    const mapped = new Uint8Array(buffer.getMappedRange());
    const out = new Uint8Array(width * height * bytes);

    for (let y = 0; y < height; y++)
    {
        out.set(mapped.subarray(y * stride, y * stride + width * bytes), y * width * bytes);
    }

    buffer.unmap();
    buffer.destroy();

    return out;
}

// The tests a pipeline makes, switched off or kept, with nothing written anywhere.
function probing (descriptor: Json, raw: Json, keep: { cull?: boolean; depth?: boolean; stencil?: boolean }): void
{
    descriptor.primitive = { ...(descriptor.primitive ?? {}), cullMode: keep.cull ? (raw.primitive?.cullMode ?? 'none') : 'none' };

    if (descriptor.depthStencil)
    {
        const always = { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'keep' };

        descriptor.depthStencil = {
            ...descriptor.depthStencil,
            depthWriteEnabled: false,
            depthCompare: keep.depth ? (raw.depthStencil?.depthCompare ?? 'always') : 'always',
            stencilFront: keep.stencil ? { ...always, compare: raw.depthStencil?.stencilFront?.compare ?? 'always' } : always,
            stencilBack: keep.stencil ? { ...always, compare: raw.depthStencil?.stencilBack?.compare ?? 'always' } : always,
            stencilWriteMask: 0
        };
    }

    if (descriptor.fragment)
    {
        descriptor.fragment.targets = Array.from(descriptor.fragment.targets ?? [], (target: any) => (target ? { ...target, writeMask: 0 } : target));
    }
}

// A descriptor's fragment stage replaced by one that calls the page's and then writes
// `value` to the colour output at `location`, blended as `blend` says.
function writing (variants: Variants, descriptor: Json, raw: Json, location: number, value: number[], blend: Json): Changed
{
    const module = raw.fragment ? variants.module(raw.fragment.module?.id) : null;
    const entry = module ? wgsl.entryPoint(module, 'fragment', raw.fragment.entryPoint ?? null) : null;
    const source = module && entry ? wgsl.fragmentWriting(module, entry, location, value) : null;

    if (!source)
    {
        return null;
    }

    descriptor.fragment.module = variants.shader(source);
    descriptor.fragment.entryPoint = wgsl.FRAGMENT_ENTRY;
    descriptor.fragment.targets = Array.from(descriptor.fragment.targets ?? [], (target: any, index: number) =>
    {
        if (!target)
        {
            return target;
        }

        return index === location ? { ...target, blend, writeMask: 0xF } : { ...target, writeMask: 0 };
    });

    return {};
}

// Whether a pipeline writes any colour to one of its targets.
function writesColour (raw: Json, location: number): boolean
{
    const target = raw?.fragment?.targets?.[location];

    return Boolean(target) && (target.writeMask ?? 0xF) !== 0;
}

// The frame's target read as 8-bit colour, rounding: a float target holds what was
// written as a fraction of 255.
function rounded (raw: Raw): Uint8Array
{
    if (!isFloat(raw.format))
    {
        return toRgba8(raw);
    }

    const out = new Uint8Array(raw.width * raw.height * 4);

    for (let i = 0; i < raw.width * raw.height; i++)
    {
        const value = pixelOf(raw, i);

        for (let channel = 0; channel < 4; channel++)
        {
            out[i * 4 + channel] = Math.max(0, Math.min(255, Math.round(value[channel] * 255)));
        }
    }

    return out;
}

const WRITES_BUFFER = ['writeBuffer', 'unmap', 'copyBufferToBuffer', 'copyTextureToBuffer', 'dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'resolveQuerySet'];
const WRITES_TEXTURE: Record<string, number> = { writeTexture: 0, copyExternalImageToTexture: 1, copyBufferToTexture: 1, copyTextureToTexture: 1 };

const TOPOLOGY: Record<string, number> = { 'point-list': POINTS, 'line-list': LINES, 'line-strip': LINE_STRIP, 'triangle-list': TRIANGLES, 'triangle-strip': TRIANGLE_STRIP };

// How a vertex format is laid out, and how to read one value of it.
function vertexFormat (format: string): { type: string; size: number; bytes: number; normalized: boolean; read: (view: DataView, at: number) => number[] } | null
{
    if (format === 'unorm10-10-10-2')
    {
        return {
            type: 'unorm10-10-10-2',
            size: 4,
            bytes: 4,
            normalized: true,
            read: (view, at) =>
            {
                const packed = view.getUint32(at, true);

                return [packed & 1023, (packed >>> 10) & 1023, (packed >>> 20) & 1023, packed >>> 30];
            }
        };
    }

    const found = /^(uint|sint|unorm|snorm|float)(8|16|32)(?:x([234]))?(-bgra)?$/.exec(format);

    if (!found)
    {
        return null;
    }

    const [, kind, bits, count] = found;
    const each = Number(bits) / 8;
    const size = Number(count ?? 1);
    const signed = kind === 'sint' || kind === 'snorm';

    const one = (view: DataView, at: number): number =>
    {
        if (kind === 'float')
        {
            return each === 4 ? view.getFloat32(at, true) : halfToFloat(view.getUint16(at, true));
        }

        switch (each)
        {
            case 1: return signed ? view.getInt8(at) : view.getUint8(at);
            case 2: return signed ? view.getInt16(at, true) : view.getUint16(at, true);
            default: return signed ? view.getInt32(at, true) : view.getUint32(at, true);
        }
    };

    return {
        type: `${kind}${bits}`,
        size,
        bytes: each * size,
        normalized: kind === 'unorm' || kind === 'snorm',
        read: (view, at) => Array.from({ length: size }, (_, i) => one(view, at + i * each))
    };
}

export const gpuAnalysis = {

    // Which event owns each pixel of a target. Every draw on the target is issued with a
    // fragment stage that keeps the page's own fragments and writes the event's number as
    // a colour: the number arrives as the blend constant, so one variant serves every draw
    // made with a pipeline. A multisampled pass is resolved by taking one sample, since
    // an average of two events' numbers is neither.
    async drawId (item: Loaded, methods: string[], args: { target?: Json }): Promise<Json>
    {
        const run = await GpuRun.create(item, methods);

        try
        {
            const variants = new Variants(run);
            const byCommand = byCommandOf(item);
            const target = args.target ?? null;
            const blits = new Map<string, any>();

            let skipped = 0;
            let bundles = 0;
            let format: string | null = null;

            const supported = (name: string): boolean => /^(rgba8unorm|bgra8unorm)(-srgb)?$/.test(name) || name === 'rgba16float';

            run.onBegin = (descriptor, index) =>
            {
                const on = textureOf(run, target);

                if (!on || drawnTo(run, descriptor) !== on)
                {
                    return descriptor;
                }

                const row = item.data.draws[byCommand.get(index) ?? -1];

                // A clear leaves "nobody" behind, whatever colour the page clears to.
                const out = { ...descriptor, scanlineResolve: [] as Json[] };

                out.colorAttachments = descriptor.colorAttachments.map((attachment: any, place: number) =>
                {
                    if (!attachment || place !== firstColour(descriptor))
                    {
                        return attachment;
                    }

                    const next = { ...attachment };

                    if (next.loadOp === 'clear' && (!row || sameTarget(row, target)))
                    {
                        next.clearValue = [0, 0, 0, 0];
                    }

                    if (next.resolveTarget)
                    {
                        out.scanlineResolve.push({ from: next.view, to: next.resolveTarget, format: run.viewOwner.get(next.view)?.format });
                        delete next.resolveTarget;
                    }

                    return next;
                });

                return out;
            };

            run.onEnd = (open, encoder) =>
            {
                for (const resolve of open.descriptor.scanlineResolve ?? [])
                {
                    let pipeline = blits.get(resolve.format);

                    if (!pipeline)
                    {
                        const module = run.device.createShaderModule({ code: `
                            @group(0) @binding(0) var samples: texture_multisampled_2d<f32>;
                            @vertex fn vertex (@builtin(vertex_index) index: u32) -> @builtin(position) vec4f
                            {
                                return vec4f(f32(i32(index) % 2) * 4.0 - 1.0, f32(i32(index) / 2) * 4.0 - 1.0, 0.0, 1.0);
                            }
                            @fragment fn fragment (@builtin(position) at: vec4f) -> @location(0) vec4f
                            {
                                return textureLoad(samples, vec2i(at.xy), 0);
                            }` });

                        pipeline = run.device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vertex' }, fragment: { module, entryPoint: 'fragment', targets: [{ format: resolve.format }] } });
                        blits.set(resolve.format, pipeline);
                    }

                    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: resolve.to, loadOp: 'load', storeOp: 'store' }] });

                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, run.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: resolve.from }] }));
                    pass.draw(3);
                    pass.end();
                }
            };

            run.onDraw = async (index, name, drawn) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined || !sameTarget(item.data.draws[draw], target))
                {
                    return false;
                }

                if (name === 'executeBundles')
                {
                    // A bundle's pipelines were set when it was built and cannot be replaced.
                    bundles++;

                    return true;
                }

                const now = run.now();
                const raw = variants.raw(now.pipeline);
                const location = firstColour(run.open!.descriptor);

                if (!raw || now.pipeline === null || !writesColour(raw, location))
                {
                    // It writes no colour (a depth pass), so it owns nothing and runs as it is.
                    return false;
                }

                const wanted: string = raw.fragment.targets[location].format;

                format = wanted;

                if (!supported(wanted))
                {
                    return true;
                }

                const variant = await variants.make(now.pipeline, `id:${location}`, (descriptor) => writing(variants, descriptor, raw, location, [1, 1, 1, 1], {
                    color: { srcFactor: 'constant', dstFactor: 'zero', operation: 'add' },
                    alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' }
                }));
                const pass = run.pass();

                if (!variant || !(await variants.use(pass, now, variant)))
                {
                    skipped++;
                    variants.restore(pass, now);

                    return true;
                }

                // An sRGB target stores what it is given encoded, so it is given the number decoded.
                const id = draw + 1;
                const parts = [id & 255, (id >> 8) & 255, (id >> 16) & 255].map((part) => (wanted.endsWith('-srgb') ? srgbToLinear(part / 255) : part / 255));

                pass.setBlendConstant([parts[0], parts[1], parts[2], 1]);
                pass[name](...drawn);
                variants.restore(pass, now);

                return true;
            };

            await run.play(item.data.commands.length);
            await run.flush();

            if (format !== null && !supported(format))
            {
                return { unsupported: 'target-format', format };
            }

            const raw = await run.read(target);

            if (!supported(raw.format))
            {
                return { unsupported: 'target-format', format: raw.format };
            }

            if (bundles > 0)
            {
                run.note(`${bundles} render bundle${bundles === 1 ? ' was' : 's were'} left out: what a bundle draws with was fixed when it was built.`);
            }

            return { width: raw.width, height: raw.height, data: rounded(raw), skipped, notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    },

    // Overdraw of the canvas: how many times each pixel was drawn to. Every draw to the
    // canvas is issued with a fragment stage that keeps the page's own fragments and adds
    // one to the pixel. `visible` keeps the page's depth and stencil tests, so only what
    // passed them is counted; otherwise every fragment is.
    async overdraw (item: Loaded, methods: string[], args: { visible?: boolean }): Promise<Json>
    {
        const format: string = item.data.header.format;
        const float = format === 'rgba16float';

        if (!float && !/^(rgba8unorm|bgra8unorm)$/.test(format))
        {
            return { unsupported: 'target-format', format };
        }

        const run = await GpuRun.create(item, methods);

        try
        {
            const variants = new Variants(run);
            const byCommand = byCommandOf(item);
            const step = float ? 1 : 1 / 255;
            const add = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };

            let skipped = 0;
            let bundles = 0;
            let encoded = false;

            run.onBegin = (descriptor) =>
            {
                if (drawnTo(run, descriptor) !== run.canvasTexture)
                {
                    return descriptor;
                }

                const place = firstColour(descriptor);

                return {
                    ...descriptor,
                    colorAttachments: descriptor.colorAttachments.map((attachment: any, index: number) => (attachment && index === place && attachment.loadOp === 'clear' ? { ...attachment, clearValue: [0, 0, 0, 0] } : attachment))
                };
            };

            run.onDraw = async (index, name, drawn) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined || !sameTarget(item.data.draws[draw], null))
                {
                    return false;
                }

                if (name === 'executeBundles')
                {
                    bundles++;

                    return true;
                }

                const now = run.now();
                const raw = variants.raw(now.pipeline);
                const location = firstColour(run.open!.descriptor);

                if (!raw || now.pipeline === null || !writesColour(raw, location))
                {
                    return false;
                }

                if (String(raw.fragment.targets[location].format).endsWith('-srgb'))
                {
                    // Counts added through an sRGB view would not add up.
                    encoded = true;

                    return true;
                }

                const variant = await variants.make(now.pipeline, `over:${args.visible ? 'visible' : 'all'}:${location}`, (descriptor) =>
                {
                    if (!args.visible && descriptor.depthStencil)
                    {
                        const always = { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'keep' };

                        descriptor.depthStencil = { ...descriptor.depthStencil, depthCompare: 'always', depthWriteEnabled: false, stencilFront: always, stencilBack: always, stencilWriteMask: 0 };
                    }

                    return writing(variants, descriptor, raw, location, [step, 0, 0, step], { color: add, alpha: add });
                });
                const pass = run.pass();

                if (!variant || !(await variants.use(pass, now, variant)))
                {
                    skipped++;
                    variants.restore(pass, now);

                    return true;
                }

                pass[name](...drawn);
                variants.restore(pass, now);

                return true;
            };

            const started = performance.now();

            await run.play(item.data.commands.length);
            await run.flush();

            if (encoded)
            {
                return { unsupported: 'srgb-view' };
            }

            const raw = await run.read(null);
            const counts = new Uint8Array(raw.width * raw.height);

            for (let i = 0; i < counts.length; i++)
            {
                counts[i] = Math.max(0, Math.min(255, Math.round(pixelOf(raw, i)[0])));
            }

            if (bundles > 0)
            {
                run.note(`${bundles} render bundle${bundles === 1 ? ' was' : 's were'} left out of the count: what a bundle draws with was fixed when it was built.`);
            }

            if (skipped > 0)
            {
                run.note(`${skipped} draw${skipped === 1 ? '' : 's'} could not be given a counting shader and ${skipped === 1 ? 'was' : 'were'} left out.`);
            }

            return { width: raw.width, height: raw.height, counts, top: 255, skipped, notes: run.notes, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    },

    // The frame with its triangles drawn as outlines. WebGPU has no outline mode, so each
    // triangle draw is issued again as lines: a pipeline with the page's shaders and a
    // line topology, and an index buffer that names each triangle's three edges.
    async wireframe (item: Loaded, methods: string[], args: { draw?: number | null; target?: Json }): Promise<Json>
    {
        const run = await GpuRun.create(item, methods);

        try
        {
            const variants = new Variants(run);
            const edges = new Map<string, { buffer: any; count: number } | null>();
            const MOST = 3_000_000;

            let large = 0;
            let culling = false;

            run.onDraw = async (_index, name, drawn) =>
            {
                if (name === 'executeBundles')
                {
                    run.note('A render bundle is drawn filled: what a bundle draws with was fixed when it was built.');

                    return false;
                }

                const now = run.now();
                const raw = variants.raw(now.pipeline);
                const topology: string = raw?.primitive?.topology ?? 'triangle-list';

                if (!raw || now.pipeline === null || !topology.startsWith('triangle'))
                {
                    return false;
                }

                const asked = await drawArgs(run, name, drawn);

                if (!asked || asked.count < 3)
                {
                    return false;
                }

                if (asked.count > MOST)
                {
                    large++;

                    return false;
                }

                const key = asked.indexed && now.index
                    ? `i:${now.index.id}:${now.index.offset}:${now.index.format}:${asked.first}:${asked.count}:${topology}`
                    : `n:${asked.count}:${topology}`;

                if (!edges.has(key))
                {
                    const named = asked.indexed ? await indicesOf(run, now, asked, MOST) : Array.from({ length: asked.count }, (_, i) => i);
                    const restart = now.index?.format === 'uint32' ? 0xFFFFFFFF : 0xFFFF;
                    const lines: number[] = [];

                    if (named)
                    {
                        const strip = topology === 'triangle-strip';

                        for (let i = 0; i + 2 < named.length; i += strip ? 1 : 3)
                        {
                            const [a, b, c] = [named[i], named[i + 1], named[i + 2]];

                            // A strip is broken where its indices say so.
                            if (strip && asked.indexed && (a === restart || b === restart || c === restart))
                            {
                                continue;
                            }

                            lines.push(a, b, b, c, c, a);
                        }
                    }

                    if (lines.length === 0)
                    {
                        edges.set(key, null);
                    }
                    else
                    {
                        const buffer = run.device.createBuffer({ size: lines.length * 4, usage: BUFFER_INDEX | BUFFER_COPY_DST });

                        run.queue.writeBuffer(buffer, 0, new Uint32Array(lines));
                        edges.set(key, { buffer, count: lines.length });
                    }
                }

                const lines = edges.get(key);

                if (!lines)
                {
                    return false;
                }

                const variant = await variants.make(now.pipeline, 'wire', (descriptor) =>
                {
                    descriptor.primitive = { ...(descriptor.primitive ?? {}), topology: 'line-list' };
                    delete descriptor.primitive.stripIndexFormat;

                    // A depth bias is for filled triangles only.
                    if (descriptor.depthStencil)
                    {
                        descriptor.depthStencil = { ...descriptor.depthStencil, depthBias: 0, depthBiasSlopeScale: 0, depthBiasClamp: 0 };
                    }

                    return {};
                });
                const pass = run.pass();

                if (!variant || !(await variants.use(pass, now, variant)))
                {
                    variants.restore(pass, now);

                    return false;
                }

                culling ||= (raw.primitive?.cullMode ?? 'none') !== 'none';
                pass.setIndexBuffer(lines.buffer, 'uint32');
                pass.drawIndexed(lines.count, asked.instances, 0, asked.indexed ? asked.baseVertex : asked.first, asked.firstInstance);
                variants.restore(pass, now);

                return true;
            };

            await run.play(endOf(item.data, args.draw), async (index) =>
            {
                // The edges were read from buffers that this may have changed.
                if (WRITES_BUFFER.includes(run.name(index)[1]))
                {
                    edges.clear();
                }
            });
            await run.flush();

            const row = args.draw === null || args.draw === undefined ? null : item.data.draws[args.draw];
            const target = args.target ?? (row ? targetOf(row) : null);
            const raw = await run.read(target);

            if (large > 0)
            {
                run.note(`${large} draw${large === 1 ? '' : 's'} of more than ${MOST} vertices ${large === 1 ? 'is' : 'are'} drawn filled.`);
            }

            if (culling)
            {
                run.note('Lines are never culled, so a triangle the frame culls for facing away still shows its outline here.');
            }

            if (variants.failed > 0)
            {
                run.note(`${variants.failed} pipeline${variants.failed === 1 ? '' : 's'} could not be made again with lines, and what ${variants.failed === 1 ? 'it draws is' : 'they draw is'} filled.`);
            }

            return { width: raw.width, height: raw.height, data: toRgba8(raw), notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    },

    // Where a float target holds a number that is not one: NaN, or infinite.
    async nan (item: Loaded, methods: string[], args: { draw?: number | null; target?: Json }): Promise<Json>
    {
        const run = await GpuRun.create(item, methods);

        try
        {
            await run.play(endOf(item.data, args.draw));
            await run.flush();

            const row = args.draw === null || args.draw === undefined ? null : item.data.draws[args.draw];
            const raw = await run.read(args.target ?? (row ? targetOf(row) : null));
            const { width, height } = raw;

            if (!isFloat(raw.format))
            {
                return { notFloat: true, width, height };
            }

            // One byte a pixel, rows from the top: 1 for NaN in any channel, 2 for infinite.
            const marks = new Uint8Array(width * height);

            let nan = 0;
            let infinite = 0;

            for (let i = 0; i < marks.length; i++)
            {
                const value = pixelOf(raw, i);
                const mark = value.some(Number.isNaN) ? 1 : (value.some((channel) => !Number.isFinite(channel)) ? 2 : 0);

                marks[i] = mark;
                nan += mark === 1 ? 1 : 0;
                infinite += mark === 2 ? 1 : 0;
            }

            return { width, height, nan, infinite, marks, notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    },

    // Which mip level is sampled: the frame replayed with each mipmapped texture's levels
    // made one flat colour each (one texture only, when one is named). Whatever the frame
    // writes to such a texture is written over again before the next draw that could
    // sample it.
    async mip (item: Loaded, methods: string[], args: { draw?: number | null; target?: Json; texture?: number | null }, colours: Array<[number, number, number]>): Promise<Json>
    {
        const run = await GpuRun.create(item, methods);

        try
        {
            const row = args.draw === null || args.draw === undefined ? null : item.data.draws[args.draw];
            const target = args.target ?? (row ? targetOf(row) : null);
            const targetRecord = target?.texture ? run.records.get(`texture:${target.texture}`) : null;
            const encodedTarget = String(targetRecord?.format ?? item.data.header.format).endsWith('-srgb');

            const tinted = new Map<any, Json>();
            const dirty = new Set<any>();
            const listed: Json[] = [];

            run.onTexture = (texture, id) =>
            {
                const record = run.records.get(`texture:${id}`);
                const levels: number = texture.mipLevelCount;

                if (!(args.texture ? id === args.texture : levels > 1))
                {
                    return;
                }

                if (!/^(rgba8unorm|bgra8unorm)(-srgb)?$/.test(texture.format) || texture.dimension !== '2d' || texture.sampleCount > 1)
                {
                    return;
                }

                tinted.set(texture, record);
                dirty.add(texture);
                listed.push({ id, width: texture.width, height: texture.height, levels });
            };

            const paint = (texture: any): void =>
            {
                const encoded = String(texture.format).endsWith('-srgb');
                const swap = String(texture.format).startsWith('bgra');

                for (let level = 0; level < texture.mipLevelCount; level++)
                {
                    const width = Math.max(1, texture.width >> level);
                    const height = Math.max(1, texture.height >> level);
                    const colour = colours[Math.min(level, colours.length - 1)].map((channel) =>
                    {
                        // The colour is what should arrive in the target, whichever of the two is sRGB.
                        if (encoded === encodedTarget)
                        {
                            return channel;
                        }

                        return Math.round((encoded ? linearToSrgb(channel / 255) : srgbToLinear(channel / 255)) * 255);
                    });
                    const pixels = new Uint8Array(width * height * 4);

                    for (let i = 0; i < width * height; i++)
                    {
                        pixels[i * 4] = colour[swap ? 2 : 0];
                        pixels[i * 4 + 1] = colour[1];
                        pixels[i * 4 + 2] = colour[swap ? 0 : 2];
                        pixels[i * 4 + 3] = 255;
                    }

                    for (let layer = 0; layer < texture.depthOrArrayLayers; layer++)
                    {
                        run.queue.writeTexture({ texture, mipLevel: level, origin: [0, 0, layer] }, pixels, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height, 1]);
                    }
                }
            };

            // The textures the open pass draws to are left alone until it has ended.
            const attached = (): Set<any> =>
            {
                const out = new Set<any>();

                for (const attachment of run.open?.descriptor?.colorAttachments ?? [])
                {
                    if (attachment)
                    {
                        out.add(run.viewOwner.get(attachment.view));
                        out.add(run.viewOwner.get(attachment.resolveTarget));
                    }
                }

                return out;
            };

            run.onEnd = (open) =>
            {
                for (const attachment of open.descriptor.colorAttachments ?? [])
                {
                    const texture = attachment ? run.viewOwner.get(attachment.resolveTarget ?? attachment.view) : null;

                    if (texture && tinted.has(texture))
                    {
                        dirty.add(texture);
                    }
                }
            };

            run.onDraw = async () =>
            {
                if (dirty.size === 0)
                {
                    return false;
                }

                const busy = attached();
                const ready = [...dirty].filter((texture) => !busy.has(texture));

                if (ready.length)
                {
                    // Everything issued so far is made to happen first, so that the colours go on top.
                    await run.flush();

                    for (const texture of ready)
                    {
                        paint(texture);
                        dirty.delete(texture);
                    }
                }

                return false;
            };

            await run.play(endOf(item.data, args.draw), async (index) =>
            {
                const [, name] = run.name(index);
                const place = WRITES_TEXTURE[name];

                if (place !== undefined)
                {
                    const [, encoded] = item.data.commands[index];
                    const texture = encoded[place]?.texture ? run.decode(encoded[place].texture) : null;

                    if (texture && tinted.has(texture))
                    {
                        dirty.add(texture);
                    }
                }
            });
            await run.flush();

            const raw = await run.read(target);

            await run.queue.onSubmittedWorkDone();

            return { width: raw.width, height: raw.height, data: toRgba8(raw), target, tinted: listed, colours, float: isFloat(raw.format), error: run.uncaptured + run.failed, notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    },

    // The history of one pixel: every event on its target, with the pixel's value before
    // and after, and for draws whether the pixel was covered at all and which tests it
    // passed.
    //
    // Coverage and the tests are found with occlusion queries. Just before each draw, a
    // pass of the replay's own on the same attachments issues the draw again with nothing
    // written and the scissor box shrunk to the one pixel: with every test off (did any
    // fragment land here?), with a fragment stage that keeps everything (does the shape
    // cover it, whatever the shader discards?), and with one test on at a time.
    async history (item: Loaded, methods: string[], args: { x: number; y: number; target?: Json }): Promise<Json>
    {
        const run = await GpuRun.create(item, methods);
        const started = performance.now();

        try
        {
            const variants = new Variants(run);
            const byCommand = byCommandOf(item);
            const target = args.target ?? null;
            const rows: Json[] = [];
            const asked: Array<{ row: Json; tests: string[]; buffer: any }> = [];

            let current: Json | null = null;
            let float = false;

            const value = async (): Promise<number[]> =>
            {
                const raw = await run.read(target, { x: args.x, y: args.y, w: 1, h: 1 });

                float = isFloat(raw.format);

                return pixelOf(raw, 0);
            };

            const probe = async (row: Json, index: number): Promise<void> =>
            {
                const open = run.open;
                const now = run.now();
                const raw = variants.raw(now.pipeline);
                const [, name] = run.name(index);

                if (!open || open.kind !== 'render' || !raw || now.pipeline === null || !DRAW_CALLS.includes(name))
                {
                    return;
                }

                const tests: Array<[string, (descriptor: Json) => Changed]> = [
                    ['covered', (descriptor) => (probing(descriptor, raw, {}), {})],
                    ['shape', (descriptor) =>
                    {
                        // With layout 'auto', what is left of the layout is what the vertex stage uses.
                        const keep = descriptor.layout === 'auto' ? variants.vertexUses(raw) : null;

                        if (descriptor.layout === 'auto' && !keep)
                        {
                            return null;
                        }

                        probing(descriptor, raw, {});
                        descriptor.fragment = {
                            module: variants.shader(KEEP_ALL),
                            entryPoint: 'scanline_keep',
                            targets: Array.from(raw.fragment?.targets ?? [], (found: any) => (found ? { format: found.format, writeMask: 0 } : found))
                        };

                        if (descriptor.multisample)
                        {
                            descriptor.multisample = { ...descriptor.multisample, alphaToCoverageEnabled: false };
                        }

                        return { keep };
                    }]
                ];

                if ((raw.primitive?.cullMode ?? 'none') !== 'none')
                {
                    tests.push(['cull', (descriptor) => (probing(descriptor, raw, { cull: true }), {})]);
                }

                if ((raw.depthStencil?.depthCompare ?? 'always') !== 'always')
                {
                    tests.push(['depth', (descriptor) => (probing(descriptor, raw, { depth: true }), {})]);
                }

                if ((raw.depthStencil?.stencilFront?.compare ?? 'always') !== 'always' || (raw.depthStencil?.stencilBack?.compare ?? 'always') !== 'always')
                {
                    tests.push(['stencil', (descriptor) => (probing(descriptor, raw, { stencil: true }), {})]);
                }

                const made: Array<[string, Variant]> = [];

                for (const [test, change] of tests)
                {
                    const variant = await variants.make(now.pipeline, `history:${test}`, change);

                    if (variant)
                    {
                        made.push([test, variant]);
                    }
                }

                if (made.length === 0)
                {
                    return;
                }

                const set = run.device.createQuerySet({ type: 'occlusion', count: made.length });
                const buffer = run.device.createBuffer({ size: made.length * 8, usage: BUFFER_QUERY_RESOLVE | BUFFER_COPY_SRC });
                const encoder = run.device.createCommandEncoder();
                const pass = encoder.beginRenderPass({ ...open.descriptor, occlusionQuerySet: set });
                const drawn = item.data.commands[index][1].map((encoded: Json) => run.decode(encoded));
                const tried: string[] = [];

                run.apply(pass, ['setPipeline', 'setScissorRect']);
                pass.setScissorRect(args.x, args.y, 1, 1);

                for (let i = 0; i < made.length; i++)
                {
                    const [test, variant] = made[i];

                    if (!(await variants.use(pass, now, variant)))
                    {
                        tried.push('');
                        continue;
                    }

                    pass.beginOcclusionQuery(i);
                    pass[name](...drawn);
                    pass.endOcclusionQuery();
                    tried.push(test);
                }

                pass.end();
                encoder.resolveQuerySet(set, 0, made.length, buffer, 0);
                run.queue.submit([encoder.finish()]);
                asked.push({ row, tests: tried, buffer });
            };

            await run.play(item.data.commands.length, async (index) =>
            {
                if (current !== null && byCommand.get(index) === current.draw)
                {
                    await run.flush();
                    current.after = await value();
                    rows.push(current);
                    current = null;
                }
            },
            async (index) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined || !sameTarget(item.data.draws[draw], target) || !textureOf(run, target))
                {
                    return;
                }

                const event = item.data.draws[draw];
                const box: number[] | null = event.scissor ?? null;

                await run.flush();

                current = {
                    draw,
                    kind: event.kind,
                    before: await value(),
                    after: null,
                    scissor: box === null || (args.x >= box[0] && args.x < box[0] + box[2] && args.y >= box[1] && args.y < box[1] + box[3]),
                    covered: null,
                    shape: null,
                    cull: null,
                    depth: null,
                    stencil: null
                };

                if (event.kind === 'draw')
                {
                    await probe(current, index);
                }
            });

            for (const entry of asked)
            {
                const bytes = await run.bytes(entry.buffer, 0, entry.tests.length * 8);

                if (!bytes)
                {
                    continue;
                }

                const counts = new BigUint64Array(bytes.buffer, bytes.byteOffset, entry.tests.length);

                entry.tests.forEach((test, i) =>
                {
                    if (test)
                    {
                        entry.row[test] = counts[i] !== 0n;
                    }
                });
            }

            await run.queue.onSubmittedWorkDone();

            return { rows, queries: true, float, error: run.uncaptured + run.failed, notes: run.notes, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    },

    // Why a draw changed nothing: it is issued with each test it is subject to switched
    // off in turn, and whichever then lets it change pixels is what rejected it.
    async why (item: Loaded, methods: string[], args: { draw: number; part?: number }): Promise<Json>
    {
        const row = item.data.draws[args.draw];

        if (!row)
        {
            throw new Error(`The capture has ${item.data.draws.length} events, numbered from 0; there is no draw ${args.draw}.`);
        }

        // One draw of those a render bundle makes, by its place among them. What a bundle
        // recorded is issued on the pass draw by draw, so one of them can be issued another way.
        const bundled = row.method === 'executeBundles' && typeof args.part === 'number';
        const part = bundled ? args.part! : 0;

        if (row.kind !== 'draw' || row.noTarget || !(DRAW_CALLS.includes(row.method) || bundled))
        {
            return { unsupported: row.method === 'executeBundles' ? 'bundle' : 'not-a-draw' };
        }

        const target = targetOf(row);
        const started = performance.now();

        // What the draw is drawn with, for one inside a bundle: the event's row describes
        // the bundles, not each draw in them.
        let facts: Json = null;
        let parts = 0;

        const attempt = async (off: string[]): Promise<number> =>
        {
            const run = await GpuRun.create(item, methods);

            try
            {
                const variants = new Variants(run);

                let seen = 0;
                let changed = -1;

                await run.play(row.command);

                run.onDraw = async (index, name, drawn) =>
                {
                    if (index !== row.command || seen++ !== part)
                    {
                        return false;
                    }

                    // The target just before this draw, and just after it.
                    await run.flush();

                    const before = await run.read(target);
                    const now = run.now();
                    const raw = variants.raw(now.pipeline);
                    const location = firstColour(run.open!.descriptor);

                    if (raw && facts === null)
                    {
                        const colour = Array.from(raw.fragment?.targets ?? [])[location] as any;
                        const depth = raw.depthStencil;
                        const always = (face: any): boolean => (face?.compare ?? 'always') === 'always';
                        const whole = (box: number[] | null): boolean => !box || (box[0] === 0 && box[1] === 0 && box[2] === before.width && box[3] === before.height);
                        const mask: number = colour?.writeMask ?? 0xF;

                        facts = {
                            pipeline: now.pipeline,
                            method: name,
                            cull: (raw.primitive?.cullMode ?? 'none') === 'none' ? null : raw.primitive.cullMode,
                            frontFace: raw.primitive?.frontFace ?? 'ccw',
                            depth: depth && (depth.depthCompare ?? 'always') !== 'always' ? { func: depth.depthCompare, write: Boolean(depth.depthWriteEnabled) } : null,
                            stencil: Boolean(depth && !(always(depth.stencilFront) && always(depth.stencilBack))),
                            blend: Boolean(colour?.blend),
                            colorMask: [(mask & 1) !== 0, (mask & 2) !== 0, (mask & 4) !== 0, (mask & 8) !== 0],
                            scissor: whole(now.scissor) ? null : now.scissor,
                            viewport: whole(now.viewport ? now.viewport.slice(0, 4) : null) ? null : now.viewport!.slice(0, 4)
                        };
                    }

                    let issued = false;

                    if (off.length > 0 && raw && now.pipeline !== null)
                    {
                        const variant = await variants.make(now.pipeline, `why:${off.join('+')}`, (descriptor) =>
                        {
                            if (off.includes('cull'))
                            {
                                descriptor.primitive = { ...(descriptor.primitive ?? {}), cullMode: 'none' };
                            }

                            if (descriptor.depthStencil && off.includes('depth'))
                            {
                                descriptor.depthStencil = { ...descriptor.depthStencil, depthCompare: 'always' };
                            }

                            if (descriptor.depthStencil && off.includes('stencil'))
                            {
                                descriptor.depthStencil = {
                                    ...descriptor.depthStencil,
                                    stencilFront: { ...(descriptor.depthStencil.stencilFront ?? {}), compare: 'always' },
                                    stencilBack: { ...(descriptor.depthStencil.stencilBack ?? {}), compare: 'always' }
                                };
                            }

                            if (descriptor.fragment)
                            {
                                descriptor.fragment.targets = Array.from(descriptor.fragment.targets ?? [], (found: any, index: number) =>
                                {
                                    if (!found || index !== location)
                                    {
                                        return found;
                                    }

                                    const next = { ...found };

                                    if (off.includes('blend'))
                                    {
                                        delete next.blend;
                                    }

                                    if (off.includes('color_mask'))
                                    {
                                        next.writeMask = 0xF;
                                    }

                                    return next;
                                });
                            }

                            return {};
                        });
                        const pass = run.pass();

                        if (variant && (await variants.use(pass, now, variant)))
                        {
                            if (off.includes('scissor'))
                            {
                                pass.setScissorRect(0, 0, before.width, before.height);
                            }

                            if (off.includes('viewport'))
                            {
                                pass.setViewport(0, 0, before.width, before.height, 0, 1);
                            }

                            pass[name](...drawn);
                            issued = true;
                        }
                        else
                        {
                            variants.restore(pass, now);
                        }
                    }

                    if (!issued)
                    {
                        run.pass()[name](...drawn);
                    }

                    // A flush puts the pass back as the page had it, for the draws that follow.
                    await run.flush();

                    const after = await run.read(target);
                    const bytes = after.bytes;

                    changed = 0;

                    for (let i = 0; i < after.width * after.height; i++)
                    {
                        for (let k = 0; k < bytes; k++)
                        {
                            if (after.data[i * bytes + k] !== before.data[i * bytes + k])
                            {
                                changed++;
                                break;
                            }
                        }
                    }

                    return true;
                };

                await run.execute(row.command);
                parts = seen;

                if (changed < 0)
                {
                    throw new Error(bundled
                        ? `Event ${args.draw} runs ${seen} draw${seen === 1 ? '' : 's'} from its render bundles, numbered from 0; there is no draw ${part} inside it.`
                        : `Event ${args.draw} did not come to be issued in the replay.`);
                }

                return changed;
            }
            finally
            {
                run.dispose();
            }
        };

        const unchanged = await attempt([]);

        // Only what this draw is subject to can have rejected it.
        const tests: string[] = [];

        if (bundled)
        {
            const subject: Json = facts ?? {};

            if (subject.cull) { tests.push('cull'); }
            if (subject.depth) { tests.push('depth'); }
            if (subject.scissor) { tests.push('scissor'); }
            if (subject.stencil) { tests.push('stencil'); }
            if (subject.blend) { tests.push('blend'); }
            if ((subject.colorMask ?? []).some((channel: boolean) => !channel)) { tests.push('color_mask'); }
            if (subject.viewport) { tests.push('viewport'); }

            // One that drew has nothing to explain.
            if (unchanged > 0)
            {
                return { unchanged, tried: [], together: null, part, parts, facts, ms: performance.now() - started };
            }
        }
        else
        {
            const mask: boolean[] = row.colorMask ?? [true, true, true, true];
            const texture = target ? item.data.objects.find((object) => object.kind === 'texture' && object.id === target.texture) : null;
            const size = texture ? [Math.max(1, texture.width >> (target.level || 0)), Math.max(1, texture.height >> (target.level || 0))] : [item.data.header.width, item.data.header.height];
            const viewport: number[] = row.viewport ?? [0, 0, size[0], size[1]];

            if (row.cull) { tests.push('cull'); }
            if (row.depth && row.depth.func !== 'always') { tests.push('depth'); }
            if (row.scissor) { tests.push('scissor'); }
            if (row.stencil) { tests.push('stencil'); }
            if (row.blend) { tests.push('blend'); }
            if (mask.some((channel) => !channel)) { tests.push('color_mask'); }
            if (viewport[0] !== 0 || viewport[1] !== 0 || viewport[2] !== size[0] || viewport[3] !== size[1]) { tests.push('viewport'); }
        }

        const tried: Json[] = [];

        for (const what of tests)
        {
            tried.push({ what, changed: await attempt([what]) });
        }

        // Two tests can each be enough to reject a draw; then no single one shows it.
        const together = tried.every((entry) => entry.changed === 0) && tests.length > 1 ? await attempt(tests) : null;

        return bundled
            ? { unchanged, tried, together, part, parts, facts, ms: performance.now() - started }
            : { unchanged, tried, together, ms: performance.now() - started };
    },

    // What one draw is given and what its vertex shader makes of it.
    //
    // Given: each attribute of the pipeline's vertex layout, with the values of the first
    // few vertices, read from the buffers as they stand just before the draw.
    //
    // Made: the clip-space position of every vertex. WebGPU has no transform feedback, so
    // the draw's vertices are drawn as points to a float texture of the replay's own, by
    // an entry point that calls the page's vertex shader, puts each vertex on a pixel of
    // its own and carries the position the page's shader gave it. This is the first
    // instance only.
    async geometry (item: Loaded, methods: string[], args: { draw: number; vertices?: number; part?: number }): Promise<Json>
    {
        const row = item.data.draws[args.draw];

        if (!row)
        {
            throw new Error(`The capture has ${item.data.draws.length} events, numbered from 0; there is no draw ${args.draw}.`);
        }

        // One draw of those a render bundle makes, by its place among them.
        const bundled = row.method === 'executeBundles' && typeof args.part === 'number';

        if (row.kind !== 'draw' || !(DRAW_CALLS.includes(row.method) || bundled))
        {
            return { unsupported: 'not-a-draw', kind: row.method === 'executeBundles' ? 'render bundle' : row.kind };
        }

        const run = await GpuRun.create(item, methods);
        const show = Math.max(1, Math.min(args.vertices ?? 8, 64));
        const CAP = 60000;

        try
        {
            const variants = new Variants(run);

            // Everything up to the draw, and not the draw itself.
            await run.play(row.command);

            if (bundled)
            {
                // What the bundles recorded is issued on the pass draw by draw: the one asked
                // about is looked at where it stands, with the state the bundle had set for it.
                let seen = 0;
                let found: Json = null;

                run.onDraw = async (index, name, drawn) =>
                {
                    if (index === row.command && seen++ === args.part)
                    {
                        await run.flush();
                        found = await measure(run.now(), name, drawn);
                    }

                    return false;
                };

                await run.execute(row.command);

                return found ?? { unsupported: 'no-such-part', parts: seen };
            }

            await run.flush();

            return await measure(run.now(), run.name(row.command)[1], item.data.commands[row.command][1].map((encoded: Json) => run.decode(encoded)));

            async function measure (now: PassNow, name: string, given: any[]): Promise<Json>
            {
            const raw = variants.raw(now.pipeline);

            if (!raw || now.pipeline === null || !run.open)
            {
                return { unsupported: 'no-program' };
            }

            const asked = await drawArgs(run, name, given);

            if (!asked)
            {
                return { unsupported: 'no-program' };
            }

            const count = Math.max(0, Math.min(asked.count, CAP));
            const indices = await indicesOf(run, now, asked, CAP);
            const named = indices ? indices.map((index) => index + asked.baseVertex) : Array.from({ length: count }, (_, i) => asked.first + i);

            let lowest = Infinity;
            let highest = -Infinity;

            for (const index of named)
            {
                lowest = Math.min(lowest, index);
                highest = Math.max(highest, index);
            }

            // ---- What it is given ----

            const module = variants.module(raw.vertex?.module?.id);
            const entry = module ? wgsl.entryPoint(module, 'vertex', raw.vertex?.entryPoint ?? null) : null;
            const names = module && entry ? wgsl.inputNames(module, entry) : new Map<number, { name: string; type: string }>();
            const attributes: Json[] = [];
            const layouts: Json[] = Array.from(raw.vertex?.buffers ?? []);

            for (let slot = 0; slot < layouts.length; slot++)
            {
                const layout = layouts[slot];

                if (!layout)
                {
                    continue;
                }

                const instanced = layout.stepMode === 'instance';
                const stride: number = layout.arrayStride ?? 0;
                const bound = now.vertex.get(slot);
                const buffer = bound ? run.objects.get(`buffer:${bound.id}`) : null;
                const length = buffer ? (bound!.size ?? buffer.size - bound!.offset) : 0;

                for (const attribute of layout.attributes ?? [])
                {
                    const format = vertexFormat(attribute.format);
                    const out: Json = {
                        name: names.get(attribute.shaderLocation)?.name ?? `location ${attribute.shaderLocation}`,
                        location: attribute.shaderLocation,
                        wgslType: names.get(attribute.shaderLocation)?.type ?? attribute.format,
                        size: format?.size ?? 0,
                        type: format?.type ?? attribute.format,
                        normalized: format?.normalized ?? false,
                        stride,
                        offset: attribute.offset ?? 0,
                        divisor: instanced ? 1 : 0,
                        buffer: bound?.id ?? null
                    };

                    attributes.push(out);

                    if (!buffer || !format)
                    {
                        out.missing = !buffer ? 'no buffer is set in its slot' : 'its values cannot be read here';
                        continue;
                    }

                    // Per-instance attributes are shown for the first few instances; the rest
                    // for the first few vertices the draw names.
                    const which = instanced ? Array.from({ length: Math.min(show, asked.instances) }, (_, k) => asked.firstInstance + k) : named.slice(0, show);
                    const low = Math.min(...which);
                    const high = Math.max(...which);
                    const from = bound!.offset + out.offset + low * stride;
                    const window = which.length && (high - low) * stride + format.bytes <= 8 << 20 ? await run.bytes(buffer, from, (high - low) * stride + format.bytes) : null;

                    out.bufferBytes = length;

                    if (!window)
                    {
                        out.values = which.map(() => null);
                    }
                    else
                    {
                        const view = new DataView(window.buffer, window.byteOffset, window.byteLength);

                        out.values = which.map((index) =>
                        {
                            const at = (index - low) * stride;

                            return at + format.bytes <= window.byteLength ? format.read(view, at) : null;
                        });
                    }

                    // The furthest the draw reaches into what is bound.
                    const last = instanced ? asked.firstInstance + asked.instances - 1 : (named.length ? highest : -1);
                    const reach = last < 0 ? 0 : out.offset + last * stride + format.bytes;

                    out.overrun = reach > length ? reach - length : 0;
                }
            }

            // ---- What the vertex shader makes of it ----

            let positions: Float32Array | null = null;
            let why: string | null = null;

            const base = Number.isFinite(lowest) ? lowest : 0;
            const span = Number.isFinite(highest) ? Math.min(highest - base + 1, CAP) : 0;
            const width = 256;
            const height = Math.max(1, Math.ceil(span / width));

            if (span === 0)
            {
                why = 'The draw names no vertices.';
            }
            else if (!module || !entry)
            {
                why = 'The vertex shader could not be read to give it a stand-in entry point.';
            }
            else
            {
                const source = wgsl.vertexPositions(module, entry, base, width, height);
                const variant = source ? await variants.make(now.pipeline, `positions:${base}:${height}`, (descriptor) =>
                {
                    const stage = variants.shader(source);

                    descriptor.vertex = { ...descriptor.vertex, module: stage, entryPoint: wgsl.VERTEX_ENTRY };
                    descriptor.fragment = { module: stage, entryPoint: wgsl.POSITIONS_ENTRY, targets: [{ format: 'rgba32float' }] };
                    descriptor.primitive = { topology: 'point-list' };

                    delete descriptor.depthStencil;
                    delete descriptor.multisample;

                    return { keep: descriptor.layout === 'auto' ? new Set(wgsl.reachable(module, entry).map((global) => `${global.group}:${global.binding}`)) : null };
                }) : null;

                if (!variant)
                {
                    why = 'The vertex shader could not be given a stand-in entry point that reports its positions.';
                }
                else
                {
                    const into = run.device.createTexture({ size: [width, height], format: 'rgba32float', usage: TEXTURE_RENDER | TEXTURE_COPY_SRC });

                    let ready = true;

                    // Made ahead: each is checked by the browser, which takes a turn.
                    if (variant.auto)
                    {
                        for (const [index, group] of now.groups)
                        {
                            await variants.group(variant, index, group.id);
                        }
                    }

                    const error = await run.checked(() =>
                    {
                        const encoder = run.device.createCommandEncoder();
                        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: into.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] });

                        run.apply(pass, ['setPipeline', 'setViewport', 'setScissorRect', 'setBlendConstant', 'setStencilReference', 'setIndexBuffer']);
                        pass.setPipeline(variant.pipeline);

                        if (variant.auto)
                        {
                            for (const [index, group] of now.groups)
                            {
                                const made = variants.groups.get(`${variant.key}:${index}:${group.id}`);

                                if (!made)
                                {
                                    ready = false;
                                }
                                else if (made !== NONE)
                                {
                                    pass.setBindGroup(index, made);
                                }
                            }
                        }

                        pass.draw(span, 1, base, asked.firstInstance);
                        pass.end();
                        run.queue.submit([encoder.finish()]);
                    });

                    if (error || !ready)
                    {
                        why = error
                            ? `The browser rejected the draw that reads the vertex shader's output: an attribute may read past the end of its buffer. It said: ${error.slice(0, 200)}`
                            : 'The bind groups could not be made again for the stand-in pipeline.';
                    }
                    else
                    {
                        positions = new Float32Array((await readOwn(run, into, 16)).buffer);
                    }

                    into.destroy();
                }
            }

            let summary: Json = null;

            if (positions)
            {
                const got = positions;
                const at = (vertex: number): number[] | null =>
                {
                    const slot = vertex - base;

                    return slot >= 0 && slot < span ? [got[slot * 4], got[slot * 4 + 1], got[slot * 4 + 2], got[slot * 4 + 3]] : null;
                };

                summary = tally(named, at, TOPOLOGY[raw.primitive?.topology ?? 'triangle-list'] ?? TRIANGLES, raw.primitive?.frontFace === 'cw', show, true);
            }

            // The viewport as WebGL has it, from the bottom-left, so one description serves both.
            const texture = textureOf(run, targetOf(row));
            const tall = texture ? Math.max(1, texture.height >> (row.targetLevel || 0)) : item.data.header.height;
            const wide = texture ? Math.max(1, texture.width >> (row.targetLevel || 0)) : item.data.header.width;
            const box = now.viewport ?? [0, 0, wide, tall];
            const cull = raw.primitive?.cullMode ?? 'none';

            return {
                api: 'webgpu',
                mode: TOPOLOGY[raw.primitive?.topology ?? 'triangle-list'] ?? TRIANGLES,
                count: asked.count,
                capped: asked.count > CAP ? CAP : null,
                first: asked.first,
                indexed: asked.indexed,
                instances: asked.instances,
                indices: indices ? { first: indices.slice(0, show * 3), lowest: lowest - asked.baseVertex, highest: highest - asked.baseVertex } : null,
                attributes,
                output: summary,
                outputMissing: why,
                viewport: [box[0], tall - box[1] - box[3], box[2], box[3]],
                cull: cull === 'front' ? 0x0404 : (cull === 'back' ? 0x0405 : null),
                frontFace: raw.primitive?.frontFace === 'cw' ? 0x0900 : 0x0901,
                notes: run.notes
            };
            }
        }
        finally
        {
            run.dispose();
        }
    },

    // GPU time of each draw. WebGPU times passes, not draws, so each draw is issued in
    // passes of the replay's own on the same attachments: once to warm up, then `times`
    // times in one timed pass and twice that in another. The difference between the two
    // is the time of `times` draws with what a pass costs by itself taken out.
    async profile (item: Loaded, methods: string[], args: { times?: number }): Promise<Json>
    {
        const run = await GpuRun.create(item, methods, ['timestamp-query']);
        const times = Math.max(1, Math.min(args.times ?? 16, 256));
        const started = performance.now();

        try
        {
            if (!run.device.features.has('timestamp-query'))
            {
                return { unsupported: 'no-timestamps' };
            }

            const byCommand = byCommandOf(item);
            const variants = new Variants(run);
            const PER = 1024;
            const sets: Array<{ set: any; buffer: any; draws: number[] }> = [];

            await run.play(item.data.commands.length, undefined, async (index) =>
            {
                const draw = byCommand.get(index);
                const [, name] = run.name(index);

                // A render bundle is timed whole, as the page runs it.
                const bundle = name === 'executeBundles';

                if (draw === undefined || item.data.draws[draw].kind !== 'draw' || !(DRAW_CALLS.includes(name) || bundle) || run.open?.kind !== 'render')
                {
                    return;
                }

                await run.flush();

                let last = sets[sets.length - 1];

                if (!last || last.draws.length === PER)
                {
                    last = {
                        set: run.device.createQuerySet({ type: 'timestamp', count: PER * 4 }),
                        buffer: run.device.createBuffer({ size: PER * 32, usage: BUFFER_QUERY_RESOLVE | BUFFER_COPY_SRC }),
                        draws: []
                    };
                    sets.push(last);
                }

                const first = last.draws.length * 4;
                const open = run.open!;
                const drawn = item.data.commands[index][1].map((encoded: Json) => run.decode(encoded));
                const encoder = run.device.createCommandEncoder();

                // A tile-based GPU (Apple's) shades only the last of several opaque draws to
                // a pixel, so repeats of an opaque draw would cost nothing. A blend that
                // replaces what is there gives the same picture and has every repeat shaded.
                // It is written in terms of the blend constant (source × 1 + what is there
                // × 0), because a blend that plainly replaces is taken for no blend at all.
                const now = run.now();
                const raw = variants.raw(now.pipeline);
                const opaque = (target: any): boolean => Boolean(target) && !target.blend && !/uint|sint|32float/.test(String(target.format));
                const variant = !bundle && raw && now.pipeline !== null && Array.from(raw.fragment?.targets ?? []).some(opaque)
                    ? await variants.make(now.pipeline, 'timed', (descriptor) =>
                    {
                        const replace = { srcFactor: 'constant', dstFactor: 'one-minus-constant', operation: 'add' };

                        descriptor.fragment.targets = Array.from(descriptor.fragment.targets ?? [], (target: any) => (opaque(target) ? { ...target, blend: { color: replace, alpha: replace } } : target));

                        return {};
                    })
                    : null;

                const issue = async (repeats: number, stamps: Json | undefined): Promise<void> =>
                {
                    const pass = encoder.beginRenderPass({ ...open.descriptor, timestampWrites: stamps });

                    run.apply(pass);

                    if (variant && await variants.use(pass, now, variant))
                    {
                        pass.setBlendConstant([1, 1, 1, 1]);
                    }
                    else if (variant)
                    {
                        variants.restore(pass, now);
                    }

                    for (let i = 0; i < repeats; i++)
                    {
                        pass[name](...drawn);
                    }

                    pass.end();
                };

                await issue(1, undefined);
                await issue(times, { querySet: last.set, beginningOfPassWriteIndex: first, endOfPassWriteIndex: first + 1 });
                await issue(times * 2, { querySet: last.set, beginningOfPassWriteIndex: first + 2, endOfPassWriteIndex: first + 3 });
                run.queue.submit([encoder.finish()]);
                last.draws.push(draw);
            });
            await run.flush();

            const rows: Json[] = [];

            // Whether every timestamp is a multiple of 65,536 ns: the browser rounds them
            // unless it was started with its developer features on.
            let coarse = true;

            for (const entry of sets)
            {
                const encoder = run.device.createCommandEncoder();

                encoder.resolveQuerySet(entry.set, 0, entry.draws.length * 4, entry.buffer, 0);
                run.queue.submit([encoder.finish()]);

                const bytes = await run.bytes(entry.buffer, 0, entry.draws.length * 32);

                if (!bytes)
                {
                    continue;
                }

                const stamps = new BigInt64Array(bytes.buffer, bytes.byteOffset, entry.draws.length * 4);

                entry.draws.forEach((draw, i) =>
                {
                    const once = Number(stamps[i * 4 + 1] - stamps[i * 4]);
                    const twice = Number(stamps[i * 4 + 3] - stamps[i * 4 + 2]);

                    rows.push({ draw, ns: Math.max(0, twice - once) / times });

                    for (let k = 0; k < 4; k++)
                    {
                        coarse &&= (stamps[i * 4 + k] & 0xFFFFn) === 0n;
                    }
                });
            }

            await run.queue.onSubmittedWorkDone();

            return { rows, times, disjoint: false, how: 'passes', coarse: coarse && rows.length > 0, error: run.uncaptured + run.failed, notes: run.notes, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    },

    // What a draw's bind groups hold, by the names its shaders give them: every resource
    // variable, and for each buffer the values of its members as the buffer stood just
    // before the draw.
    async uniforms (item: Loaded, methods: string[], args: { draw: number }): Promise<Json>
    {
        const row = item.data.draws[args.draw];

        if (!row || (row.kind !== 'draw' && row.kind !== 'dispatch'))
        {
            return { bindings: [], buffers: [], notes: [] };
        }

        const run = await GpuRun.create(item, methods);

        try
        {
            const variants = new Variants(run);

            await run.play(row.command);
            await run.flush();

            const now = run.now();
            const record = now.pipeline === null ? null : run.records.get(`pipeline:${now.pipeline}`);
            const descriptor = record?.descriptor ?? {};

            // Every resource variable of the pipeline's stages, by where it is bound.
            const declared = new Map<string, { module: wgsl.Module; global: wgsl.Global }>();

            let unread = 0;

            for (const stage of [descriptor.vertex, descriptor.fragment, descriptor.compute])
            {
                if (!stage?.module || typeof stage.module.id !== 'number')
                {
                    continue;
                }

                const module = variants.module(stage.module.id);

                if (!module)
                {
                    unread++;
                    continue;
                }

                for (const global of module.globals.values())
                {
                    if (global.group !== null && global.binding !== null && !declared.has(`${global.group}:${global.binding}`))
                    {
                        declared.set(`${global.group}:${global.binding}`, { module, global });
                    }
                }
            }

            const bindings: Json[] = [];
            const buffers: Json[] = [];

            for (const [index, group] of [...now.groups].sort((a, b) => a[0] - b[0]))
            {
                const made = run.records.get(`bind_group:${group.id}`)?.descriptor;
                const layout = made?.layout && typeof made.layout.id === 'number' ? run.records.get(`layout:${made.layout.id}`)?.descriptor : null;

                // Offsets given with the bind group go, in order, to the bindings that take one.
                const moving: number[] = (layout?.entries ?? [])
                    .filter((entry: Json) => entry?.buffer?.hasDynamicOffset)
                    .map((entry: Json) => Number(entry.binding))
                    .sort((a: number, b: number) => a - b);
                const given: number[] = Array.isArray(group.offsets[0]) || ArrayBuffer.isView(group.offsets[0])
                    ? Array.from(group.offsets[0] as ArrayLike<number>).slice(Number(group.offsets[1] ?? 0))
                    : [];

                for (const entry of made?.entries ?? [])
                {
                    const found = declared.get(`${index}:${entry.binding}`);

                    if (!found)
                    {
                        continue;
                    }

                    const { module, global } = found;

                    bindings.push({ group: index, binding: entry.binding, name: global.name, type: global.type, space: global.space });

                    const id = entry.resource?.buffer?.id;

                    if (typeof id !== 'number' || (global.space !== 'uniform' && global.space !== 'storage'))
                    {
                        continue;
                    }

                    const out: Json = { group: index, binding: entry.binding, name: global.name, type: global.type, space: global.space, buffer: id, values: [] };

                    buffers.push(out);

                    let laid;

                    try
                    {
                        laid = wgsl.layout(module, global, 48);
                    }
                    catch (error: any)
                    {
                        out.unread = String(error?.message ?? error);
                        continue;
                    }

                    const buffer = run.objects.get(`buffer:${id}`) ?? null;
                    const moved = moving.indexOf(Number(entry.binding));
                    const offset = Number(entry.resource.offset ?? 0) + (moved >= 0 ? Number(given[moved] ?? 0) : 0);
                    const extent = laid.leaves.reduce((most, leaf) => Math.max(most, leaf.offset + leaf.columns * leaf.stride), 0);
                    const bytes = buffer ? await run.bytes(buffer, offset, Math.min(extent, buffer.size - offset, 1 << 16)) : null;

                    out.offset = offset;
                    out.more = laid.more;
                    out.extent = extent;

                    if (!bytes)
                    {
                        out.unread = 'the buffer could not be read';
                        continue;
                    }

                    for (const leaf of laid.leaves)
                    {
                        const values = wgsl.valuesOf(leaf, bytes);

                        if (values)
                        {
                            out.values.push({ name: leaf.name, type: leaf.type, values, offset: leaf.offset });
                        }
                    }
                }
            }

            if (unread > 0)
            {
                run.note('A shader of this draw could not be read, so some of its bindings are not named.');
            }

            return { bindings, buffers, notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    }
};
