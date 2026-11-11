// The WebGPU tracker: every object a device creates, with the descriptor it was created from.
//
// WebGPU has no state getters, so the creation descriptors are the record
// (02-ARCHITECTURE.md, section 3.4). Pass calls are recorded at the capture level, not here.

import { config } from '../config';
import { currentFrame } from '../clock/gate';
import type { Handlers } from '../hooks/install';
import { hub, type Rec } from '../hooks/hub';
import { declare } from '../mods';
import { G, type Fn } from '../natives';
import { all, alive, create, destroy, deviceFor, entryOf, noteDevice, type Entry, type Kind } from '../registry';
import type { Tag } from '../tag';
import { gpuDeviceTag, gpuViewTag } from '../tags.generated';
import { textureBytes } from './formats';
import { mapWatch, recordIntercepted } from './rec';

const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_TRANSIENT = 0x20;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_SRC = 0x0004;

// A view leads back to its texture; a device has a number, so its objects can be found.
const viewTag: Tag<{ texture: Entry | undefined; descriptor: unknown }> = gpuViewTag;
const deviceTag: Tag<number> = gpuDeviceTag;

let devices = 0;
let addedCopySrc = false;

function deviceId (device: object): number
{
    let id = deviceTag.get(device);

    if (id === undefined)
    {
        id = ++devices;
        deviceTag.set(device, id);
    }

    return id;
}

function label (descriptor: any): string | null
{
    const text = descriptor?.label;

    return typeof text === 'string' && text !== '' ? text : null;
}

// A descriptor as plain data: page objects become references to their records, and
// anything unreadable or too deep is left out. Never throws.
export function viewOf (view: object): { texture: Entry | undefined; descriptor: unknown } | undefined
{
    return viewTag.get(view);
}

export function snapshot (value: any, depth = 0): unknown
{
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean')
    {
        return value ?? null;
    }

    if (typeof value === 'string')
    {
        // Long enough for any label or entry point; a capture recreates objects from these.
        return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
    }

    if (typeof value !== 'object' || depth > 6)
    {
        return null;
    }

    try
    {
        const entry = entryOf(value);

        if (entry)
        {
            return { ref: entry.kind, id: entry.id };
        }

        const view = viewTag.get(value);

        if (view)
        {
            return { ref: 'texture', id: view.texture?.id ?? 0, view: view.descriptor };
        }

        if (G.ArrayBuffer.isView(value) || value instanceof G.ArrayBuffer)
        {
            return { bytes: value.byteLength };
        }

        if (typeof value[G.Symbol.iterator] === 'function')
        {
            return G.Array.from(value as Iterable<unknown>, (item: unknown) => snapshot(item, depth + 1));
        }

        const tag = G.Object.prototype.toString.call(value).slice(8, -1);

        if (tag !== 'Object')
        {
            // A platform object the probe has no record of (an external texture, say).
            return { object: tag, label: label(value) };
        }

        const out: Record<string, unknown> = {};

        // Inherited members too: an engine may pass an instance of its own class as a
        // descriptor, and the browser reads those members like any others.
        for (const key in value)
        {
            const member = value[key];

            if (member !== undefined && typeof member !== 'function')
            {
                out[key] = snapshot(member, depth + 1);
            }
        }

        return out;
    }
    catch
    {
        return null;
    }
}

function register (kind: Kind, device: object, object: object | null | undefined, p: Record<string, any>, descriptor: any): Entry | undefined
{
    if (!object)
    {
        return undefined;
    }

    p.device = deviceId(device);

    const entry = create(kind, 'webgpu', 0, object, p, label(descriptor));

    noteDevice(object, device);

    return entry;
}

function size3 (size: any): [number, number, number]
{
    if (!size)
    {
        return [0, 0, 1];
    }

    if (typeof size[G.Symbol.iterator] === 'function')
    {
        const [width = 0, height = 1, depth = 1] = size as Iterable<number>;

        return [width, height, depth];
    }

    return [size.width ?? 0, size.height ?? 1, size.depthOrArrayLayers ?? 1];
}

// The page's descriptor with some fields replaced. It inherits from the original, so
// everything else the browser reads still comes from the page's object.
function amended (given: object, fields: Record<string, unknown>): object
{
    const properties: PropertyDescriptorMap = {};

    for (const key of G.Object.keys(fields))
    {
        properties[key] = { value: fields[key], enumerable: true };
    }

    return G.Object.create(given, properties);
}

function pipeline (type: 'render' | 'compute', device: object, result: any, descriptor: any): void
{
    const p = { type, descriptor: snapshot(descriptor) };

    if (result && typeof result.then === 'function')
    {
        // The asynchronous form: the pipeline exists when the promise resolves.
        const started = G.performance.timeOrigin;

        result.then((made: object) =>
        {
            register('pipeline', device, made, { ...p, async: true, started }, descriptor);
        }, () => undefined);
    }
    else
    {
        register('pipeline', device, result, p, descriptor);
    }
}

// A bind group layout a pipeline made for itself. It is recreated by asking a pipeline again.
function derivedLayout (pipeline: object, layout: object | null | undefined, index: unknown): void
{
    const from = entryOf(pipeline);
    const device = deviceFor(pipeline);

    if (layout && from && device && !entryOf(layout))
    {
        register('layout', device, layout, { type: 'bind group', pipeline: from.id, index: G.Number(index) || 0 }, null);
    }
}

// Marks the textures a render pass draws to, so a capture knows to read them before a frame.
export function noteTargets (descriptor: any): void
{
    try
    {
        for (const attachment of descriptor?.colorAttachments ?? [])
        {
            for (const view of [attachment?.view, attachment?.resolveTarget])
            {
                const texture = view ? viewTag.get(view)?.texture : undefined;

                if (texture)
                {
                    texture.p.renderTarget = true;
                }
            }
        }
    }
    catch
    {
        // A descriptor the probe cannot read is the page's business.
    }
}

type Post = (record: Rec, self: any, result: any, ...args: any[]) => void;

const post: Record<string, Post> = {

    'GPUDevice.createShaderModule' (_c, device, module, descriptor)
    {
        const code = G.String(descriptor?.code ?? '');
        const entry = register('shader', device, module, { language: 'wgsl', source: code }, descriptor);

        if (entry)
        {
            entry.bytes = code.length;
        }
    },

    'GPUDevice.createRenderPipeline' (_c, device, result, descriptor)
    {
        pipeline('render', device, result, descriptor);
    },

    'GPUDevice.createRenderPipelineAsync' (_c, device, result, descriptor)
    {
        pipeline('render', device, result, descriptor);
    },

    'GPUDevice.createComputePipeline' (_c, device, result, descriptor)
    {
        pipeline('compute', device, result, descriptor);
    },

    'GPUDevice.createComputePipelineAsync' (_c, device, result, descriptor)
    {
        pipeline('compute', device, result, descriptor);
    },

    'GPUDevice.createBindGroup' (_c, device, group, descriptor)
    {
        register('bind_group', device, group, { descriptor: snapshot(descriptor) }, descriptor);
    },

    'GPUDevice.createBindGroupLayout' (_c, device, layout, descriptor)
    {
        register('layout', device, layout, { type: 'bind group', descriptor: snapshot(descriptor) }, descriptor);
    },

    'GPUDevice.createPipelineLayout' (_c, device, layout, descriptor)
    {
        register('layout', device, layout, { type: 'pipeline', descriptor: snapshot(descriptor) }, descriptor);
    },

    'GPUDevice.createSampler' (_c, device, sampler, descriptor)
    {
        register('sampler', device, sampler, { descriptor: snapshot(descriptor ?? {}) }, descriptor);
    },

    'GPUDevice.createQuerySet' (_c, device, set, descriptor)
    {
        register('query', device, set, { type: G.String(descriptor?.type ?? ''), count: descriptor?.count ?? 0 }, descriptor);
    },

    'GPUDevice.destroy' (_c, device)
    {
        // Destroying a device destroys everything made from it.
        const id = deviceTag.get(device);

        for (const kind of ['texture', 'buffer', 'query'] as const)
        {
            for (const entry of all(kind))
            {
                if (entry.api === 'webgpu' && entry.p.device === id && alive(entry))
                {
                    destroy(entry);
                    entry.p.destroyedWithDevice = true;
                }
            }
        }
    },

    'GPUTexture.createView' (_c, texture, view, descriptor)
    {
        if (view)
        {
            viewTag.set(view, { texture: entryOf(texture), descriptor: snapshot(descriptor ?? null) });
        }
    },

    'GPUTexture.destroy' (_c, texture)
    {
        destroy(entryOf(texture));
    },

    'GPUBuffer.destroy' (_c, buffer)
    {
        destroy(entryOf(buffer));
    },

    'GPUBuffer.getMappedRange' (_c, buffer, range, offset)
    {
        if (mapWatch.range !== null && range)
        {
            mapWatch.range(buffer, range, G.Number(offset) || 0);
        }
    },

    'GPURenderPipeline.getBindGroupLayout' (_c, pipeline, layout, index)
    {
        derivedLayout(pipeline, layout, index);
    },

    'GPUComputePipeline.getBindGroupLayout' (_c, pipeline, layout, index)
    {
        derivedLayout(pipeline, layout, index);
    },

    'GPUQueue.writeBuffer' (_c, _queue, _r, buffer)
    {
        const entry = entryOf(buffer);

        if (entry)
        {
            entry.written = currentFrame();
        }
    },

    'GPUQueue.writeTexture' (_c, _queue, _r, destination)
    {
        const entry = entryOf(destination?.texture);

        if (entry)
        {
            entry.written = currentFrame();
        }
    },

    'GPUQueue.copyExternalImageToTexture' (_c, _queue, _r, _source, destination)
    {
        const entry = entryOf(destination?.texture);

        if (entry)
        {
            entry.written = currentFrame();
        }
    }
};

type Intercept = (self: any, native: Fn, args: IArguments) => unknown;

const intercept: Record<string, Intercept> = {

    'GPUDevice.createTexture' (device, native, args)
    {
        const given = args[0];

        hub.gpu.calls++;

        if (!given || typeof given !== 'object' || args.length !== 1)
        {
            return native.apply(device, args as any);
        }

        const usage = given.usage;
        const samples = given.sampleCount ?? 1;

        // COPY_SRC lets the probe read the texture back. Not on transient attachments, which
        // have no storage to copy, nor on multisampled textures, which cannot be copied.
        const add = !config.unmodified && typeof usage === 'number' && (usage & (TEXTURE_COPY_SRC | TEXTURE_TRANSIENT)) === 0 && samples === 1;

        if (add)
        {
            addedCopySrc = true;
        }

        const texture = native.call(device, add ? amended(given, { usage: usage | TEXTURE_COPY_SRC }) : given);

        try
        {
            const [width, height, depth] = size3(given.size);
            const format = G.String(given.format);
            const mips = given.mipLevelCount ?? 1;
            const dimension = G.String(given.dimension ?? '2d');

            const entry = register('texture', device, texture, {
                descriptor: snapshot(given),
                width,
                height,
                depthOrArrayLayers: depth,
                format,
                usage,
                mipLevelCount: mips,
                sampleCount: samples,
                dimension,
                readable: add || (typeof usage === 'number' && (usage & TEXTURE_COPY_SRC) !== 0)
            }, given);

            if (entry)
            {
                entry.bytes = textureBytes(format, width, height, depth, mips, samples, dimension);
            }
        }
        catch
        {
            // A descriptor the probe cannot read is the page's business; the texture still exists.
        }

        recordIntercepted('GPUDevice.createTexture', device, texture, args);

        return texture;
    },

    'GPUDevice.createBuffer' (device, native, args)
    {
        const given = args[0];

        hub.gpu.calls++;

        if (!given || typeof given !== 'object' || args.length !== 1)
        {
            return native.apply(device, args as any);
        }

        const usage = given.usage;

        // A buffer that can be mapped for reading may carry no other usage but COPY_DST, and
        // can be read by mapping anyway.
        const add = !config.unmodified && typeof usage === 'number' && (usage & (BUFFER_COPY_SRC | BUFFER_MAP_READ)) === 0;

        if (add)
        {
            addedCopySrc = true;
        }

        const buffer = native.call(device, add ? amended(given, { usage: usage | BUFFER_COPY_SRC }) : given);

        try
        {
            const size = G.Number(given.size) || 0;
            const entry = register('buffer', device, buffer, {
                size,
                usage,
                mappedAtCreation: Boolean(given.mappedAtCreation),
                readable: add || (typeof usage === 'number' && (usage & BUFFER_COPY_SRC) !== 0)
            }, given);

            if (entry)
            {
                entry.bytes = size;
            }
        }
        catch
        {
            // As above.
        }

        recordIntercepted('GPUDevice.createBuffer', device, buffer, args);

        return buffer;
    },

    'GPUBuffer.unmap' (buffer, native, args)
    {
        hub.gpu.calls++;

        // Before the browser detaches the mapped ranges, and their bytes with them.
        if (mapWatch.unmap !== null)
        {
            mapWatch.unmap(buffer);
        }

        const result = native.apply(buffer, args as any);

        recordIntercepted('GPUBuffer.unmap', buffer, result, args);

        return result;
    }
};

export const gpuHandlers: Handlers = { ...post, ...intercept };

export function installGpuTracking (): void
{
    declare({
        id: 'webgpu-resource-copy-src',
        what: 'COPY_SRC is added to the usage of WebGPU textures and buffers that lack it',
        why: 'Reading back texture and buffer contents',
        optional: true,
        active: () => addedCopySrc
    });
}
