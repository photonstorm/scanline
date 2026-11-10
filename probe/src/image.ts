// Keeps the final image of a frame and answers questions about its pixels.
//
// A WebGL drawing buffer is cleared once the browser has presented it, and a WebGPU canvas
// texture expires at the end of the task. So the image is copied at the end of the frame's
// last callback, and only for frames that need it: the frame the page stops on, or a frame
// a screenshot was asked of (03-INSPECTION.md, section 1.1).
//
// Everything here is a GPU readback of what the page drew: provenance `gpu-measured`.

import { currentFrame, isPaused, onFrameBegin, onFrameEnd, requestGrab } from './clock/gate';
import { allContexts, contextById, type ContextInfo } from './contexts';
import { natives } from './hooks/install';
import { G, nSetTimeout } from './natives';
import { base64, gzip, halfToFloat, prepareRead, restoreReadState } from './readback';
import { emit, expose } from './transport';

type Format = 'rgba8unorm' | 'bgra8unorm' | 'rgba16float';

interface Kept
{
    frame: number;
    width: number;
    height: number;
    format: Format;

    // Rows top to bottom, tightly packed, in the target's own format.
    data: Uint8Array | Uint16Array | null;

    // Set while a WebGPU copy is still being mapped.
    pending: Promise<void> | null;
    premultiplied: boolean;
    note: string | null;
}

const kept = new Map<number, Kept>();

let grabWaiters: Array<() => void> = [];

const GL = {
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401
};

function keepGl (info: ContextInfo): void
{
    const gl = info.ctx;
    const n = info.natives;
    const width: number = gl.drawingBufferWidth;
    const height: number = gl.drawingBufferHeight;

    if (info.lost || width === 0 || height === 0)
    {
        return;
    }

    // Nothing has been issued since the last copy: that image is still the frame's image.
    const previous = kept.get(info.id);

    if (previous && info.record.keptAtCalls === info.record.calls && previous.width === width && previous.height === height)
    {
        previous.frame = currentFrame();

        return;
    }

    const flipped = new G.Uint8Array(width * height * 4) as Uint8Array;

    // The default framebuffer, into client memory. What this disturbs is put back from the
    // tracker's mirror of the context's state, with no questions asked of the context.
    try
    {
        prepareRead(info, null);
        n.readPixels.call(gl, 0, 0, width, height, GL.RGBA, GL.UNSIGNED_BYTE, flipped);
    }
    finally
    {
        restoreReadState(info);
    }

    // readPixels returns rows bottom to top. Everything Scanline reports is top to bottom.
    const data = new G.Uint8Array(flipped.length) as Uint8Array;
    const stride = width * 4;

    for (let y = 0; y < height; y++)
    {
        data.set(flipped.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
    }

    const attributes = info.attributes as { premultipliedAlpha?: boolean; alpha?: boolean } | null;

    info.record.keptAtCalls = info.record.calls;

    kept.set(info.id, {
        frame: currentFrame(),
        width,
        height,
        format: 'rgba8unorm',
        data,
        pending: null,
        premultiplied: Boolean(attributes?.alpha !== false && attributes?.premultipliedAlpha !== false),
        note: null
    });
}

const BYTES: Record<string, number> = { rgba8unorm: 4, bgra8unorm: 4, rgba16float: 8 };

function keepGpu (info: ContextInfo): void
{
    const state = info.gpu;

    if (!state || !state.current)
    {
        // The page did not draw to this canvas in the frame that just ended.
        return;
    }

    const bytes = BYTES[state.format];

    if (!state.copyable || bytes === undefined)
    {
        kept.set(info.id, {
            frame: currentFrame(),
            width: 0,
            height: 0,
            format: 'rgba8unorm',
            data: null,
            pending: null,
            premultiplied: false,
            note: state.copyable
                ? `Canvas format ${state.format} is not supported for readback yet.`
                : 'The canvas texture has no COPY_SRC usage (unmodified mode), so it cannot be read back.'
        });

        return;
    }

    const texture = state.current;

    state.current = null;

    const width: number = texture.width;
    const height: number = texture.height;
    const rowBytes = width * bytes;
    const stride = G.Math.ceil(rowBytes / 256) * 256;

    const device = state.device;
    const n = natives;

    const buffer = n.GPUDevice.createBuffer.call(device, {
        label: 'scanline: canvas readback',
        size: stride * height,
        usage: 0x0001 | 0x0008   // MAP_READ | COPY_DST
    });

    const encoder = n.GPUDevice.createCommandEncoder.call(device, { label: 'scanline: canvas readback' });

    n.GPUCommandEncoder.copyTextureToBuffer.call(
        encoder,
        { texture },
        { buffer, bytesPerRow: stride, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 }
    );

    n.GPUQueue.submit.call(device.queue, [n.GPUCommandEncoder.finish.call(encoder)]);

    const entry: Kept = {
        frame: currentFrame(),
        width,
        height,
        format: state.format as Format,
        data: null,
        pending: null,
        premultiplied: state.alphaMode === 'premultiplied',
        note: null
    };

    entry.pending = n.GPUBuffer.mapAsync.call(buffer, 0x0001).then(() =>
    {
        const mapped = new G.Uint8Array(n.GPUBuffer.getMappedRange.call(buffer)) as Uint8Array;
        const packed = new G.Uint8Array(rowBytes * height) as Uint8Array;

        for (let y = 0; y < height; y++)
        {
            packed.set(mapped.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
        }

        n.GPUBuffer.unmap.call(buffer);
        n.GPUBuffer.destroy.call(buffer);

        entry.data = bytes === 8 ? new G.Uint16Array(packed.buffer) : packed;
        entry.pending = null;
    }, (error: any) =>
    {
        entry.note = `Readback failed: ${G.String(error?.message ?? error)}`;
        entry.pending = null;
    });

    kept.set(info.id, entry);
}

function keepAll (): void
{
    for (const info of allContexts())
    {
        try
        {
            if (info.api === 'webgl' || info.api === 'webgl2')
            {
                keepGl(info);
            }
            else if (info.api === 'webgpu')
            {
                keepGpu(info);
            }
        }
        catch (error: any)
        {
            emit('probe-fault', { where: 'image', message: G.String(error?.stack ?? error) });
        }
    }

    const waiters = grabWaiters;

    grabWaiters = [];

    for (const resolve of waiters)
    {
        resolve();
    }
}

// One pixel as [r, g, b, a] in 8-bit and in float.
function pixelAt (image: Kept, x: number, y: number): { u8: number[]; f: number[] }
{
    const data = image.data!;
    const i = (y * image.width + x) * 4;

    if (image.format === 'rgba16float')
    {
        const f = [halfToFloat(data[i]), halfToFloat(data[i + 1]), halfToFloat(data[i + 2]), halfToFloat(data[i + 3])];

        return { u8: f.map((value) => G.Math.round(G.Math.min(1, G.Math.max(0, value || 0)) * 255)), f };
    }

    const u8 = image.format === 'bgra8unorm'
        ? [data[i + 2], data[i + 1], data[i], data[i + 3]]
        : [data[i], data[i + 1], data[i + 2], data[i + 3]];

    return { u8, f: u8.map((value) => value / 255) };
}

// The image for a context, waiting for one if the page is running or a copy is in flight.
async function imageFor (id: number): Promise<{ info: ContextInfo; image: Kept }>
{
    const info = contextById(id);

    if (!info)
    {
        const known = allContexts().map((other) => `ctx ${other.id} (${other.api})`).join(', ') || 'none';

        throw new Error(`No rendering context ${id}. Contexts on this page: ${known}.`);
    }

    if (info.api !== 'webgl' && info.api !== 'webgl2' && info.api !== 'webgpu')
    {
        throw new Error(`Context ${id} is a ${info.api} context. Only WebGL and WebGPU canvases have a retained image; use a page screenshot for this one.`);
    }

    if (!isPaused())
    {
        // Running: copy the next frame's image.
        await new G.Promise((resolve: () => void) =>
        {
            grabWaiters.push(resolve);
            requestGrab();
            nSetTimeout(resolve, 1000);
        });
    }

    let image = kept.get(id);

    if (image?.pending)
    {
        await image.pending;
        image = kept.get(id);
    }

    if (!image || image.data === null)
    {
        throw new Error(image?.note
            ?? (isPaused()
                ? `Context ${id} has no retained image: the page has not drawn a frame to it since Scanline began watching. Step one frame and ask again.`
                : `Context ${id} produced no frame within a second. The page may not be drawing to it.`));
    }

    return { info, image };
}

interface Region { x?: number; y?: number; w?: number; h?: number }

function clip (image: Kept, region: Region): { x: number; y: number; w: number; h: number }
{
    const x = G.Math.max(0, G.Math.min(image.width, G.Math.floor(region.x ?? 0)));
    const y = G.Math.max(0, G.Math.min(image.height, G.Math.floor(region.y ?? 0)));
    const w = G.Math.max(0, G.Math.min(image.width - x, G.Math.floor(region.w ?? image.width - x)));
    const h = G.Math.max(0, G.Math.min(image.height - y, G.Math.floor(region.h ?? image.height - y)));

    return { x, y, w, h };
}

export function installImage (): void
{
    onFrameEnd((keep) =>
    {
        if (keep || grabWaiters.length)
        {
            keepAll();
        }
    });

    // A canvas texture expires when its task ends. One left over from an earlier frame or
    // timer must not be copied.
    onFrameBegin(() =>
    {
        for (const info of allContexts())
        {
            if (info.gpu)
            {
                info.gpu.current = null;
            }
        }
    });

    // Which contexts have an image, and of which frame.
    expose('image.list', () => allContexts().map((info) =>
    {
        const image = kept.get(info.id);

        return {
            context: info.id,
            api: info.api,
            frame: image?.frame ?? null,
            width: image?.width ?? null,
            height: image?.height ?? null,
            format: image?.format ?? null,
            note: image?.note ?? null
        };
    }));

    // Exact values of a small region, as numbers.
    expose('image.pixels', async (args: Region & { context: number }) =>
    {
        const { image } = await imageFor(args.context);
        const region = clip(image, { ...args, w: args.w ?? 1, h: args.h ?? 1 });

        if (region.w * region.h > 4096)
        {
            throw new Error(`Region ${region.w}x${region.h} is too large to return as numbers (limit 4096 pixels). Use image.grab.`);
        }

        const u8: number[] = [];
        const float: number[] = [];

        for (let y = region.y; y < region.y + region.h; y++)
        {
            for (let x = region.x; x < region.x + region.w; x++)
            {
                const pixel = pixelAt(image, x, y);

                u8.push(...pixel.u8);
                float.push(...pixel.f);
            }
        }

        return {
            frame: image.frame,
            format: image.format,
            premultipliedAlpha: image.premultiplied,
            size: { width: image.width, height: image.height },
            region,
            rgba8: u8,
            rgbaFloat: image.format === 'rgba16float' ? float : null
        };
    });

    // A region as RGBA8 bytes, rows top to bottom, gzip-compressed and base64-encoded.
    // This is the slow path the architecture keeps as a fallback; the bulk channel replaces it.
    expose('image.grab', async (args: Region & { context: number }) =>
    {
        const { image } = await imageFor(args.context);
        const region = clip(image, args);
        const out = new G.Uint8Array(region.w * region.h * 4) as Uint8Array;

        let o = 0;

        if (image.format === 'rgba8unorm')
        {
            const data = image.data as Uint8Array;

            for (let y = region.y; y < region.y + region.h; y++)
            {
                const start = (y * image.width + region.x) * 4;

                out.set(data.subarray(start, start + region.w * 4), o);
                o += region.w * 4;
            }
        }
        else
        {
            for (let y = region.y; y < region.y + region.h; y++)
            {
                for (let x = region.x; x < region.x + region.w; x++)
                {
                    const pixel = pixelAt(image, x, y).u8;

                    out[o++] = pixel[0];
                    out[o++] = pixel[1];
                    out[o++] = pixel[2];
                    out[o++] = pixel[3];
                }
            }
        }

        return {
            frame: image.frame,
            sourceFormat: image.format,
            premultipliedAlpha: image.premultiplied,
            size: { width: image.width, height: image.height },
            region,
            encoding: 'rgba8+gzip+base64',
            data: base64(await gzip(out))
        };
    });
}
