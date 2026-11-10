// Finds every rendering context the page creates, and what is known about each.

import { config } from './config';
import { currentFrame } from './clock/gate';
import { attachTracker, contextLost, contextRestored } from './gl/tracker';
import { hookExtension, natives, type Handlers } from './hooks/install';
import { withTimestampFeature } from './timing';
import { hub, recordFor, type Rec } from './hooks/hub';
import { patch } from './masquerade';
import { declare } from './mods';
import { G, isWindow, nAddEventListener, type Fn } from './natives';
import { emit } from './transport';

export type Api = 'webgl' | 'webgl2' | 'webgpu' | '2d' | 'bitmaprenderer';

export interface GpuCanvasState
{
    device: any;
    format: string;
    usage: number;
    alphaMode: string;
    copyable: boolean;
    current: any;           // the texture getCurrentTexture() last returned
    currentFrame: number;   // the frame it was returned in
}

export interface ContextInfo
{
    id: number;
    api: Api;
    ctx: any;
    canvas: any;
    offscreen: boolean;
    attributes: unknown;
    record: Rec;
    createdFrame: number;
    lost: boolean;
    gpu: GpuCanvasState | null;
    natives: Record<string, Fn>;
}

const contexts: ContextInfo[] = [];
const byObject = new WeakMap<object, ContextInfo>();

let nextId = 1;

// Facts about adapters and devices, for the status report.
const adapters: Array<Record<string, unknown>> = [];
const deviceAdapters = new WeakMap<object, Record<string, unknown>>();

export function allContexts (): ContextInfo[]
{
    return contexts;
}

export function contextById (id: number): ContextInfo | undefined
{
    return contexts.find((info) => info.id === id);
}

function apiOf (type: unknown): Api | null
{
    switch (G.String(type).toLowerCase())
    {
        case 'webgl':
        case 'experimental-webgl':
            return 'webgl';
        case 'webgl2':
            return 'webgl2';
        case 'webgpu':
            return 'webgpu';
        case '2d':
            return '2d';
        case 'bitmaprenderer':
            return 'bitmaprenderer';
        default:
            return null;
    }
}

function register (canvas: any, type: unknown, ctx: any): void
{
    if (byObject.has(ctx))
    {
        return;
    }

    const api = apiOf(type);

    if (api === null)
    {
        return;
    }

    const isGl = api === 'webgl' || api === 'webgl2';
    const iface = api === 'webgl2' ? 'WebGL2RenderingContext' : 'WebGLRenderingContext';
    const table = isGl ? natives[iface] ?? {} : {};

    const info: ContextInfo = {
        id: nextId++,
        api,
        ctx,
        canvas,
        offscreen: typeof G.OffscreenCanvas === 'function' && canvas instanceof G.OffscreenCanvas,
        attributes: isGl && table.getContextAttributes ? table.getContextAttributes.call(ctx) : null,
        record: isGl ? recordFor(ctx) : hub.gpu,
        createdFrame: currentFrame(),
        lost: false,
        gpu: null,
        natives: table
    };

    contexts.push(info);
    byObject.set(ctx, info);

    if (isGl)
    {
        attachTracker(info);

        nAddEventListener.call(canvas, 'webglcontextlost', () =>
        {
            info.lost = true;
            contextLost(info);
            emit('context-lost', { context: info.id, frame: currentFrame() });
        });

        nAddEventListener.call(canvas, 'webglcontextrestored', () =>
        {
            info.lost = false;
            contextRestored(info);
            emit('context-restored', { context: info.id, frame: currentFrame() });
        });
    }

    emit('context', { context: describe(info) });
}

function rendererOf (info: ContextInfo): { vendor: string; renderer: string; version: string } | null
{
    const { getParameter, getExtension } = info.natives;

    if (!getParameter || !getExtension || info.lost)
    {
        return null;
    }

    try
    {
        const debug = getExtension.call(info.ctx, 'WEBGL_debug_renderer_info');

        return {
            vendor: G.String(getParameter.call(info.ctx, debug ? debug.UNMASKED_VENDOR_WEBGL : 0x1F00)),
            renderer: G.String(getParameter.call(info.ctx, debug ? debug.UNMASKED_RENDERER_WEBGL : 0x1F01)),
            version: G.String(getParameter.call(info.ctx, 0x1F02))
        };
    }
    catch
    {
        return null;
    }
}

export function describe (info: ContextInfo): Record<string, unknown>
{
    const canvas = info.canvas;
    const out: Record<string, unknown> = {
        id: info.id,
        api: info.api,
        offscreen: info.offscreen,
        width: canvas.width,
        height: canvas.height,
        createdFrame: info.createdFrame,
        lost: info.lost
    };

    if (!info.offscreen && isWindow)
    {
        const rect = canvas.getBoundingClientRect();

        out.element = { id: G.String(canvas.id || ''), connected: Boolean(canvas.isConnected) };
        out.cssRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    if (info.api === 'webgl' || info.api === 'webgl2')
    {
        out.drawingBuffer = { width: info.ctx.drawingBufferWidth, height: info.ctx.drawingBufferHeight };
        out.attributes = info.attributes;
        out.gpu = rendererOf(info);
    }
    else if (info.api === 'webgpu')
    {
        out.configured = info.gpu !== null;

        if (info.gpu)
        {
            out.format = info.gpu.format;
            out.alphaMode = info.gpu.alphaMode;
            out.readable = info.gpu.copyable;
            out.gpu = deviceAdapters.get(info.gpu.device) ?? null;
        }
    }

    return out;
}

export function knownAdapters (): Array<Record<string, unknown>>
{
    return adapters;
}

function noteAdapter (adapter: any): void
{
    if (!adapter)
    {
        return;
    }

    try
    {
        const facts = adapter.info ?? {};

        adapters.push({
            vendor: G.String(facts.vendor ?? ''),
            architecture: G.String(facts.architecture ?? ''),
            device: G.String(facts.device ?? ''),
            description: G.String(facts.description ?? ''),
            fallback: Boolean(facts.isFallbackAdapter),
            features: [...adapter.features]
        });

        adapterFacts.set(adapter, adapters[adapters.length - 1]);
    }
    catch
    {
        // Adapter information is a convenience. Never let it break the page's request.
    }
}

const adapterFacts = new WeakMap<object, Record<string, unknown>>();

const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_RENDER_ATTACHMENT = 0x10;

export const contextHandlers: Handlers = {

    'gl.getExtension': (record: Rec, _self: unknown, extension: unknown, name: unknown) =>
    {
        if (extension && typeof extension === 'object')
        {
            hookExtension(G.String(name), extension, record);
        }
    },

    'GPU.requestAdapter': (self: any, native: Fn, args: IArguments) =>
    {
        return native.apply(self, args as any).then((adapter: any) =>
        {
            noteAdapter(adapter);

            return adapter;
        });
    },

    'GPUAdapter.requestDevice': (self: any, native: Fn, args: IArguments) =>
    {
        // With the timestamp feature added where the adapter has it, for GPU time per pass.
        const amended = withTimestampFeature(self, args);

        return native.apply(self, (amended ?? args) as any).then((device: any) =>
        {
            const facts = adapterFacts.get(self);

            if (device && facts)
            {
                deviceAdapters.set(device, facts);
            }

            return device;
        });
    },

    'GPUCanvasContext.configure': (self: any, native: Fn, args: IArguments) =>
    {
        const given = args[0];

        if (!given || typeof given !== 'object' || args.length !== 1)
        {
            return native.apply(self, args as any);
        }

        const wanted = given.usage === undefined ? TEXTURE_RENDER_ATTACHMENT : given.usage;

        let usage = wanted;
        let descriptor = given;

        if (!config.unmodified && typeof wanted === 'number')
        {
            usage = wanted | TEXTURE_COPY_SRC;

            // Inherit from the page's descriptor, so everything it carries (own, inherited
            // or computed) is still read from it, and only `usage` is ours.
            descriptor = G.Object.create(given, { usage: { value: usage, enumerable: true } });
        }

        const result = native.call(self, descriptor);
        const info = byObject.get(self);

        if (info)
        {
            info.gpu = {
                device: given.device,
                format: G.String(given.format),
                usage,
                alphaMode: G.String(given.alphaMode ?? 'opaque'),
                copyable: (usage & TEXTURE_COPY_SRC) !== 0,
                current: null,
                currentFrame: -1
            };
        }

        return result;
    },

    'GPUCanvasContext.unconfigure': (self: any, native: Fn, args: IArguments) =>
    {
        const info = byObject.get(self);

        if (info)
        {
            info.gpu = null;
        }

        return native.apply(self, args as any);
    },

    'GPUCanvasContext.getCurrentTexture': (self: any, native: Fn, args: IArguments) =>
    {
        const texture = native.apply(self, args as any);
        const info = byObject.get(self);

        if (info && info.gpu)
        {
            info.gpu.current = texture;
            info.gpu.currentFrame = currentFrame();
        }

        return texture;
    }
};

export function installContextDiscovery (): void
{
    const wrap = (native: Fn): Fn => function getContext (this: any, type: unknown): unknown
    {
        const ctx = native.apply(this, arguments as any);

        if (ctx)
        {
            try
            {
                register(this, type, ctx);
            }
            catch (error: any)
            {
                emit('probe-fault', { where: 'getContext', message: G.String(error?.stack ?? error) });
            }
        }

        return ctx;
    };

    if (typeof G.HTMLCanvasElement === 'function')
    {
        patch(G.HTMLCanvasElement.prototype, 'getContext', wrap);
    }

    if (typeof G.OffscreenCanvas === 'function')
    {
        patch(G.OffscreenCanvas.prototype, 'getContext', wrap);
    }

    declare({
        id: 'webgpu-canvas-copy-src',
        what: 'COPY_SRC is added to the usage of every WebGPU canvas configuration',
        why: 'Reading back the final image of a frame',
        optional: true,
        active: () => !config.unmodified && contexts.some((info) => info.api === 'webgpu')
    });
}
