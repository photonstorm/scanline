// Reads the contents of textures and buffers back from the GPU (03-INSPECTION.md, section 1).
//
// Every result is `gpu-measured`: a copy of what the object holds now. The probe's own GPU
// calls go through the unwrapped functions, and whatever state they disturb is put back
// from the tracker's mirror, so the page sees nothing.

import { contextById, type ContextInfo } from './contexts';
import { formatName } from './gl/formats';
import { trackerFor } from './gl/tracker';
import { copyBytes } from './gpu/formats';
import { natives } from './hooks/install';
import { G, nBtoa, nFromCharCode } from './natives';
import { alive, deviceFor, find, type Entry } from './registry';
import { expose } from './transport';

export function base64 (bytes: Uint8Array): string
{
    const CHUNK = 0x8000;

    let binary = '';

    for (let i = 0; i < bytes.length; i += CHUNK)
    {
        binary += nFromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
    }

    return nBtoa(binary);
}

export async function gzip (bytes: Uint8Array): Promise<Uint8Array>
{
    const stream = new G.Blob([bytes]).stream().pipeThrough(new G.CompressionStream('gzip'));

    return new G.Uint8Array(await new G.Response(stream).arrayBuffer());
}

export function halfToFloat (half: number): number
{
    const exponent = (half >> 10) & 0x1F;
    const mantissa = half & 0x3FF;
    const sign = half & 0x8000 ? -1 : 1;

    if (exponent === 0)
    {
        return sign * G.Math.pow(2, -14) * (mantissa / 1024);
    }

    if (exponent === 31)
    {
        return mantissa ? NaN : sign * Infinity;
    }

    return sign * G.Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}

// What a readback produces before it is packaged: four channels per pixel, rows in the
// order asked for, as numbers in the target's own range.
export interface Pixels
{
    width: number;
    height: number;
    channels: Float32Array | Uint8Array | Int32Array | Uint32Array;
    // 'unorm8': 0–255. 'float': as stored. 'int': as stored.
    kind: 'unorm8' | 'float' | 'int';
    format: string;
    note: string | null;
}

interface Region { x?: number; y?: number; w?: number; h?: number }

function clip (width: number, height: number, region: Region): { x: number; y: number; w: number; h: number }
{
    const x = G.Math.max(0, G.Math.min(width, G.Math.floor(region.x ?? 0)));
    const y = G.Math.max(0, G.Math.min(height, G.Math.floor(region.y ?? 0)));

    return {
        x,
        y,
        w: G.Math.max(0, G.Math.min(width - x, G.Math.floor(region.w ?? width - x))),
        h: G.Math.max(0, G.Math.min(height - y, G.Math.floor(region.h ?? height - y)))
    };
}

// ---- WebGL ----

const scratch = new WeakMap<object, object>();

const FLOAT_FORMATS = new G.Set([0x822D, 0x822F, 0x881B, 0x881A, 0x822E, 0x8230, 0x8815, 0x8814, 0x8C3A, 0x8C3D]);
const INT_FORMATS = new G.Set([0x8231, 0x8233, 0x8235, 0x8237, 0x8239, 0x823B, 0x8D8F, 0x8D8E, 0x8D88, 0x8D82]);
const UINT_FORMATS = new G.Set([0x8232, 0x8234, 0x8236, 0x8238, 0x823A, 0x823C, 0x8D7D, 0x8D7C, 0x8D76, 0x8D70, 0x906F]);

// Restores the framebuffer and pixel-pack state a readback changed, from the mirror.
export function restoreReadState (info: ContextInfo): void
{
    const t = trackerFor(info);
    const gl = info.ctx;
    const n = info.natives;

    if (!t)
    {
        return;
    }

    if (t.gl2)
    {
        n.bindFramebuffer.call(gl, 0x8CA9, t.drawFramebuffer);
        n.bindFramebuffer.call(gl, 0x8CA8, t.readFramebuffer);
        n.bindBuffer.call(gl, 0x88EB, t.otherBuffers.get(0x88EB) ?? null);
        n.pixelStorei.call(gl, 0x0D02, t.pixelStore.get(0x0D02) ?? 0);
        n.pixelStorei.call(gl, 0x0D03, t.pixelStore.get(0x0D03) ?? 0);
        n.pixelStorei.call(gl, 0x0D04, t.pixelStore.get(0x0D04) ?? 0);
    }
    else
    {
        n.bindFramebuffer.call(gl, 0x8D40, t.drawFramebuffer);
    }

    n.pixelStorei.call(gl, 0x0D05, t.pixelStore.get(0x0D05) ?? 4);
}

// Puts the context in a known state for reading pixels into client memory.
export function prepareRead (info: ContextInfo, framebuffer: object | null): void
{
    const gl = info.ctx;
    const n = info.natives;

    if (info.api === 'webgl2')
    {
        n.bindFramebuffer.call(gl, 0x8CA8, framebuffer);
        n.bindBuffer.call(gl, 0x88EB, null);
        n.pixelStorei.call(gl, 0x0D02, 0);
        n.pixelStorei.call(gl, 0x0D03, 0);
        n.pixelStorei.call(gl, 0x0D04, 0);
    }
    else
    {
        n.bindFramebuffer.call(gl, 0x8D40, framebuffer);
    }

    n.pixelStorei.call(gl, 0x0D05, 1);
}

export function readGlTexture (entry: Entry, info: ContextInfo, level: number, layer: number, region: Region): Pixels
{
    const gl = info.ctx;
    const n = info.natives;
    const p = entry.p;
    const texture = entry.ref.deref();

    if (!p.width || !p.height)
    {
        throw new Error('This texture has no storage yet: nothing has been uploaded to it.');
    }

    if (p.compressed)
    {
        throw new Error(`This texture is compressed (${formatName(p.internalFormat)}). Reading compressed textures back is not built yet.`);
    }

    const width = G.Math.max(1, p.width >> level);
    const height = G.Math.max(1, p.height >> level);
    const area = clip(width, height, region);

    let framebuffer = scratch.get(gl);

    if (!framebuffer)
    {
        // Created through the unwrapped function, so it is not in the registry.
        framebuffer = n.createFramebuffer.call(gl) as object;
        scratch.set(gl, framebuffer);
    }

    const float = FLOAT_FORMATS.has(p.internalFormat) || p.type === 0x1406 || p.type === 0x140B || p.type === 0x8D61;
    const signed = INT_FORMATS.has(p.internalFormat);
    const unsigned = UINT_FORMATS.has(p.internalFormat);
    const count = area.w * area.h * 4;

    let channels: Pixels['channels'];
    let kind: Pixels['kind'];

    try
    {
        prepareRead(info, framebuffer);

        const target = info.api === 'webgl2' ? 0x8CA8 : 0x8D40;

        if (p.target === 0x806F || p.target === 0x8C1A)
        {
            n.framebufferTextureLayer.call(gl, target, 0x8CE0, texture, level, layer);
        }
        else
        {
            // A cube map's faces are separate 2D images; `layer` picks one.
            n.framebufferTexture2D.call(gl, target, 0x8CE0, p.target === 0x8513 ? 0x8515 + layer : 0x0DE1, texture, level);
        }

        const status = n.checkFramebufferStatus.call(gl, target);

        if (status !== 0x8CD5)
        {
            throw new Error(
                `${formatName(p.internalFormat)} cannot be read back through a framebuffer here (status 0x${status.toString(16)}). `
                + (p.internalFormat === 0x1902 || p.internalFormat === 0x84F9 || (p.internalFormat >= 0x81A5 && p.internalFormat <= 0x81A6) || p.internalFormat === 0x8CAC || p.internalFormat === 0x88F0
                    ? 'Depth textures need a sampling pass, which is not built yet.'
                    : 'Float textures need the colour-buffer-float extension enabled by the page; other formats need a sampling pass, which is not built yet.')
            );
        }

        if (float)
        {
            channels = new G.Float32Array(count);
            kind = 'float';
            n.readPixels.call(gl, area.x, area.y, area.w, area.h, 0x1908, 0x1406, channels);
        }
        else if (signed || unsigned)
        {
            channels = signed ? new G.Int32Array(count) : new G.Uint32Array(count);
            kind = 'int';
            n.readPixels.call(gl, area.x, area.y, area.w, area.h, 0x8D99, signed ? 0x1404 : 0x1405, channels);
        }
        else
        {
            channels = new G.Uint8Array(count);
            kind = 'unorm8';
            n.readPixels.call(gl, area.x, area.y, area.w, area.h, 0x1908, 0x1401, channels);
        }

        // Leave nothing attached, so the scratch framebuffer does not keep the texture alive.
        n.framebufferTexture2D.call(gl, target, 0x8CE0, 0x0DE1, null, 0);
    }
    finally
    {
        restoreReadState(info);
    }

    return { width, height, channels: channels!, kind: kind!, format: formatName(p.internalFormat), note: null };
}

// ---- WebGPU ----

// A texture level's bytes exactly as stored, rows packed with no padding.
export async function readGpuRaw (entry: Entry, level: number, layer: number, region: Region = {}): Promise<{ width: number; height: number; w: number; h: number; packed: Uint8Array; format: string; bytes: number }>
{
    const p = entry.p;
    const texture = entry.ref.deref() as any;
    const format: string = p.format;
    const bytes = copyBytes(format);

    if (!p.readable)
    {
        throw new Error(p.sampleCount > 1
            ? 'A multisampled texture cannot be copied. Read the texture it resolves to instead.'
            : 'This texture has no COPY_SRC usage, so it cannot be read back. It was created in unmodified mode, or is a transient attachment.');
    }

    if (bytes === 0)
    {
        throw new Error(`Reading ${format} textures back is not built yet (compressed, stencil and depth24plus formats need more than a copy).`);
    }

    const width = G.Math.max(1, p.width >> level);
    const height = G.Math.max(1, p.height >> level);
    const area = clip(width, height, region);
    const rowBytes = area.w * bytes;
    const stride = G.Math.ceil(rowBytes / 256) * 256;
    const n = natives;
    const device = deviceFor(texture) as any;

    if (!device)
    {
        throw new Error('The device this texture belongs to is not known. The texture was created before the probe could record it.');
    }

    const buffer = n.GPUDevice.createBuffer.call(device, { label: 'scanline: texture readback', size: G.Math.max(4, stride * area.h), usage: 0x0001 | 0x0008 });
    const encoder = n.GPUDevice.createCommandEncoder.call(device, { label: 'scanline: texture readback' });

    n.GPUCommandEncoder.copyTextureToBuffer.call(
        encoder,
        { texture, mipLevel: level, origin: { x: area.x, y: area.y, z: layer }, aspect: format.startsWith('depth') ? 'depth-only' : 'all' },
        { buffer, bytesPerRow: stride, rowsPerImage: area.h },
        { width: area.w, height: area.h, depthOrArrayLayers: 1 }
    );

    n.GPUQueue.submit.call(device.queue, [n.GPUCommandEncoder.finish.call(encoder)]);

    await n.GPUBuffer.mapAsync.call(buffer, 0x0001);

    const mapped = new G.Uint8Array(n.GPUBuffer.getMappedRange.call(buffer)) as Uint8Array;
    const packed = new G.Uint8Array(rowBytes * area.h) as Uint8Array;

    for (let y = 0; y < area.h; y++)
    {
        packed.set(mapped.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
    }

    n.GPUBuffer.unmap.call(buffer);
    n.GPUBuffer.destroy.call(buffer);

    return { width, height, w: area.w, h: area.h, packed, format, bytes };
}

async function readGpuTexture (entry: Entry, level: number, layer: number, region: Region): Promise<Pixels>
{
    const { width, height, w, h, packed, format, bytes } = await readGpuRaw(entry, level, layer, region);
    const area = { w, h };

    // Spread whatever the format holds across four channels: missing colour channels are 0, missing alpha is 1.
    const pixels = area.w * area.h;
    const present = format.startsWith('rgba') || format.startsWith('bgra') ? 4 : (format.startsWith('rg') && !format.startsWith('rgb') ? 2 : 1);
    const swap = format.startsWith('bgra');

    let channels: Pixels['channels'];
    let kind: Pixels['kind'];
    let read: (index: number) => number;

    if (format.includes('float') || format.startsWith('depth'))
    {
        kind = 'float';
        channels = new G.Float32Array(pixels * 4);

        if (format.includes('32'))
        {
            const source = new G.Float32Array(packed.buffer);

            read = (index) => source[index];
        }
        else if (format === 'depth16unorm')
        {
            const source = new G.Uint16Array(packed.buffer);

            read = (index) => source[index] / 65535;
        }
        else
        {
            const source = new G.Uint16Array(packed.buffer);

            read = (index) => halfToFloat(source[index]);
        }
    }
    else if (format.includes('int'))
    {
        kind = 'int';
        channels = format.includes('uint') ? new G.Uint32Array(pixels * 4) : new G.Int32Array(pixels * 4);

        const source = format.includes('32')
            ? (format.includes('uint') ? new G.Uint32Array(packed.buffer) : new G.Int32Array(packed.buffer))
            : (format.includes('16')
                ? (format.includes('uint') ? new G.Uint16Array(packed.buffer) : new G.Int16Array(packed.buffer))
                : (format.includes('uint') ? packed : new G.Int8Array(packed.buffer)));

        read = (index) => source[index];
    }
    else if (bytes / present === 1)
    {
        kind = 'unorm8';
        channels = new G.Uint8Array(pixels * 4);
        read = (index) => packed[index];
    }
    else
    {
        throw new Error(`Reading ${format} textures back is not built yet.`);
    }

    const opaque = kind === 'unorm8' ? 255 : 1;

    for (let i = 0; i < pixels; i++)
    {
        const r = read(i * present);
        const g = present > 1 ? read(i * present + 1) : 0;
        const b = present > 2 ? read(i * present + 2) : 0;

        channels[i * 4] = swap ? b : r;
        channels[i * 4 + 1] = g;
        channels[i * 4 + 2] = swap ? r : b;
        channels[i * 4 + 3] = present > 3 ? read(i * present + 3) : opaque;
    }

    return { width, height, channels, kind, format, note: null };
}

// ---- Buffers ----

export async function readBuffer (entry: Entry, offset: number, length: number): Promise<Uint8Array>
{
    const object = entry.ref.deref() as any;

    if (entry.api === 'webgl')
    {
        const info = contextById(entry.context);
        const t = info ? trackerFor(info) : null;

        if (!info || !t || info.lost)
        {
            throw new Error('The context this buffer belongs to is gone.');
        }

        if (!t.gl2)
        {
            // WebGL 1 has no call that reads a buffer back: this is the tracker's copy of what
            // the page uploaded.
            const mirror: Uint8Array | undefined = entry.p.mirror;

            if (!mirror)
            {
                throw new Error('This WebGL 1 buffer has had nothing uploaded to it.');
            }

            return mirror.slice(offset, offset + length);
        }

        const gl = info.ctx;
        const n = info.natives;
        const out = new G.Uint8Array(length) as Uint8Array;

        // The copy-read binding point is free of the rules about index buffers.
        n.bindBuffer.call(gl, 0x8F36, object);

        try
        {
            n.getBufferSubData.call(gl, 0x8F36, offset, out);
        }
        finally
        {
            n.bindBuffer.call(gl, 0x8F36, t.otherBuffers.get(0x8F36) ?? null);
        }

        return out;
    }

    if (!entry.p.readable)
    {
        throw new Error('This buffer has no COPY_SRC usage, so it cannot be read back. It was created in unmodified mode, or is a buffer the page maps for reading itself.');
    }

    const n = natives;
    const device = deviceFor(object) as any;

    if (!device)
    {
        throw new Error('The device this buffer belongs to is not known. The buffer was created before the probe could record it.');
    }

    // Copies must start and end on four-byte boundaries.
    const start = offset - (offset % 4);
    const span = G.Math.ceil((offset - start + length) / 4) * 4;
    const staging = n.GPUDevice.createBuffer.call(device, { label: 'scanline: buffer readback', size: span, usage: 0x0001 | 0x0008 });
    const encoder = n.GPUDevice.createCommandEncoder.call(device, { label: 'scanline: buffer readback' });

    n.GPUCommandEncoder.copyBufferToBuffer.call(encoder, object, start, staging, 0, span);
    n.GPUQueue.submit.call(device.queue, [n.GPUCommandEncoder.finish.call(encoder)]);

    await n.GPUBuffer.mapAsync.call(staging, 0x0001);

    const out = new G.Uint8Array(n.GPUBuffer.getMappedRange.call(staging)).slice(offset - start, offset - start + length) as Uint8Array;

    n.GPUBuffer.unmap.call(staging);
    n.GPUBuffer.destroy.call(staging);

    return out;
}

function toRgba8 (pixels: Pixels, count: number): Uint8Array
{
    const out = new G.Uint8Array(count * 4) as Uint8Array;
    const source = pixels.channels;

    if (pixels.kind === 'unorm8')
    {
        out.set(source as Uint8Array);
    }
    else
    {
        // Floats are shown clamped to 0–1; integers clamped to 0–255. Exact values are in `values`.
        const scale = pixels.kind === 'float' ? 255 : 1;

        for (let i = 0; i < out.length; i++)
        {
            const value = source[i] * scale;

            out[i] = value > 255 ? 255 : (value > 0 ? value : 0);
        }
    }

    return out;
}

export function installReadback (): void
{
    // A texture level (or part of one) as RGBA8 rows, plus exact values for small regions.
    expose('registry.readTexture', async (args: Region & { id: number; level?: number; layer?: number; flip?: boolean; values?: boolean }) =>
    {
        const entry = find('texture', args.id);

        if (!entry || !alive(entry))
        {
            throw new Error(`Texture ${args.id} no longer exists.`);
        }

        const level = args.level ?? 0;
        const layer = args.layer ?? 0;
        const levels = entry.api === 'webgpu' ? entry.p.mipLevelCount : entry.p.levels;

        if (level < 0 || level >= (levels || 1))
        {
            throw new Error(`Texture ${args.id} has ${levels || 1} mip level${levels > 1 ? 's' : ''}; level ${level} does not exist.`);
        }

        // A WebGL framebuffer's first row is the bottom of what was rendered. Shown the way
        // it was drawn unless asked otherwise; uploaded textures keep their own row order.
        const flip = args.flip ?? (entry.api === 'webgl' && Boolean(entry.p.renderTarget));

        let region: Region = args;

        const info = entry.api === 'webgl' ? contextById(entry.context) : undefined;

        if (entry.api === 'webgl' && (!info || info.lost))
        {
            throw new Error('The context this texture belongs to is gone.');
        }

        if (flip && entry.api === 'webgl')
        {
            // The caller's y counts from the top of the picture; the framebuffer's from the bottom.
            const height = G.Math.max(1, entry.p.height >> level);
            const h = args.h ?? height - (args.y ?? 0);

            region = { x: args.x, w: args.w, h, y: height - (args.y ?? 0) - h };
        }

        const pixels = entry.api === 'webgl' ? readGlTexture(entry, info!, level, layer, region) : await readGpuTexture(entry, level, layer, region);
        const area = clip(pixels.width, pixels.height, region);

        if (flip)
        {
            const stride = area.w * 4;
            const source = pixels.channels;
            const turned = new (source.constructor as any)(source.length);

            for (let y = 0; y < area.h; y++)
            {
                turned.set(source.subarray((area.h - 1 - y) * stride, (area.h - y) * stride), y * stride);
            }

            pixels.channels = turned;
        }

        const count = area.w * area.h;
        const shown = { x: area.x, y: flip && entry.api === 'webgl' ? pixels.height - area.y - area.h : area.y, w: area.w, h: area.h };

        return {
            size: { width: pixels.width, height: pixels.height },
            level,
            layer,
            region: shown,
            format: pixels.format,
            kind: pixels.kind,
            flipped: flip,
            values: args.values && count <= 256 ? G.Array.from(pixels.channels) : null,
            encoding: 'rgba8+gzip+base64',
            data: base64(await gzip(toRgba8(pixels, count)))
        };
    });

    expose('registry.readBuffer', async (args: { id: number; offset?: number; length?: number }) =>
    {
        const entry = find('buffer', args.id);

        if (!entry || !alive(entry))
        {
            throw new Error(`Buffer ${args.id} no longer exists.`);
        }

        const size: number = entry.p.size ?? 0;
        const offset = G.Math.max(0, G.Math.min(size, args.offset ?? 0));
        const length = G.Math.max(0, G.Math.min(size - offset, args.length ?? 256, 1 << 20));

        if (length === 0)
        {
            return { size, offset, length: 0, data: '' };
        }

        return { size, offset, length, data: base64(await readBuffer(entry, offset, length)) };
    });
}
