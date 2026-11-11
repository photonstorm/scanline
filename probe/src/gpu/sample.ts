// Reads a WebGPU texture by drawing it: for what a copy cannot read, or reads as blocks.
//
// A depth24plus texture cannot be copied to a buffer, and a compressed texture copies as
// its blocks, not its texels. Both can be sampled, so one level is drawn by a shader of the
// probe's own into a texture that can be copied, and that is read: depth into r32float,
// texels into rgba8unorm (rgba16float for the HDR formats, an sRGB target for sRGB blocks,
// so the bytes read are the texture's own).
//
// Everything is made through the unwrapped functions on the page's device, so none of it
// is in the registry, counted in the frame's statistics or recorded by a capture.

import { natives } from '../hooks/install';
import { G } from '../natives';
import { deviceFor, type Entry } from '../registry';

const DEPTH_FORMATS = ['depth16unorm', 'depth24plus', 'depth24plus-stencil8', 'depth32float', 'depth32float-stencil8'];

export function isDepth (format: string): boolean
{
    return DEPTH_FORMATS.includes(format);
}

// True for a depth format a copy to a buffer cannot read.
export function depthNeedsSampling (format: string): boolean
{
    return format === 'depth24plus' || format === 'depth24plus-stencil8';
}

// An unwrapped method where the probe wraps it, the object's own where it does not.
function call (iface: string, name: string, self: any, ...args: unknown[]): any
{
    return (natives[iface]?.[name] ?? self[name]).apply(self, args);
}

const pipelines = new G.WeakMap() as WeakMap<object, Map<string, { pipeline: object; layout: object }>>;

const VERTEX = `
@vertex fn vertex (@builtin(vertex_index) index: u32) -> @builtin(position) vec4f
{
    return vec4f(vec2f(f32((index << 1u) & 2u), f32(index & 2u)) * 2.0 - 1.0, 0.0, 1.0);
}`;

function pipelineFor (device: any, depth: boolean, target: string): { pipeline: object; layout: object }
{
    const made: Map<string, { pipeline: object; layout: object }> = pipelines.get(device) ?? new G.Map();

    pipelines.set(device, made);

    const key = `${depth}:${target}`;
    const found = made.get(key);

    if (found)
    {
        return found;
    }

    const module = call('GPUDevice', 'createShaderModule', device, {
        label: 'scanline: texture readback',
        code: depth
            ? `@group(0) @binding(0) var source: texture_depth_2d;
${VERTEX}
@fragment fn fragment (@builtin(position) at: vec4f) -> @location(0) vec4f { return vec4f(textureLoad(source, vec2i(at.xy), 0), 0.0, 0.0, 1.0); }`
            : `@group(0) @binding(0) var source: texture_2d<f32>;
${VERTEX}
@fragment fn fragment (@builtin(position) at: vec4f) -> @location(0) vec4f { return textureLoad(source, vec2i(at.xy), 0); }`
    });

    const layout = call('GPUDevice', 'createBindGroupLayout', device, {
        label: 'scanline: texture readback',
        entries: [{ binding: 0, visibility: 2, texture: { sampleType: depth ? 'depth' : 'float', viewDimension: '2d' } }]
    });

    const pipeline = call('GPUDevice', 'createRenderPipeline', device, {
        label: 'scanline: texture readback',
        layout: call('GPUDevice', 'createPipelineLayout', device, { bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target }] },
        primitive: { topology: 'triangle-list' }
    });

    const both = { pipeline, layout };

    made.set(key, both);

    return both;
}

export interface GpuSampled
{
    packed: Uint8Array;     // rows of the area, packed, in `format`
    format: string;         // r32float, rgba8unorm, rgba8unorm-srgb or rgba16float
    bytes: number;          // per texel
}

// One region of one level of one layer, drawn and read.
export async function sampleGpuTexture (entry: Entry, level: number, layer: number, area: { x: number; y: number; w: number; h: number }): Promise<GpuSampled>
{
    const p = entry.p;
    const texture = entry.ref.deref() as any;
    const device = texture ? deviceFor(texture) as any : null;
    const format: string = p.format;
    const depth = isDepth(format);

    if (!device)
    {
        throw new Error('The device this texture belongs to is not known. The texture was created before the probe could record it.');
    }

    if (p.dimension === '3d' || p.sampleCount > 1)
    {
        throw new Error(`A ${p.sampleCount > 1 ? 'multisampled' : '3D'} ${format} texture cannot be read back.`);
    }

    if (!p.sampled)
    {
        throw new Error(`This ${format} texture has no TEXTURE_BINDING usage, so it cannot be drawn to be read. It was created in unmodified mode, or is a transient attachment.`);
    }

    const target = depth ? 'r32float' : (format.startsWith('bc6h') ? 'rgba16float' : (format.endsWith('-srgb') ? 'rgba8unorm-srgb' : 'rgba8unorm'));
    const bytes = target === 'rgba16float' ? 8 : 4;
    const width = G.Math.max(1, p.width >> level);
    const height = G.Math.max(1, p.height >> level);
    const rowBytes = area.w * bytes;
    const packed = new G.Uint8Array(rowBytes * area.h) as Uint8Array;

    if (area.w === 0 || area.h === 0)
    {
        return { packed, format: target, bytes };
    }

    const { pipeline, layout } = pipelineFor(device, depth, target);
    const into = call('GPUDevice', 'createTexture', device, { label: 'scanline: texture readback', size: [width, height], format: target, usage: 0x10 | 0x01 });
    const view = call('GPUTexture', 'createView', texture, {
        dimension: '2d',
        baseMipLevel: level,
        mipLevelCount: 1,
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        aspect: depth ? 'depth-only' : 'all'
    });
    const group = call('GPUDevice', 'createBindGroup', device, { layout, entries: [{ binding: 0, resource: view }] });
    const stride = G.Math.ceil(rowBytes / 256) * 256;
    const buffer = call('GPUDevice', 'createBuffer', device, { label: 'scanline: texture readback', size: G.Math.max(4, stride * area.h), usage: 0x0001 | 0x0008 });
    const encoder = call('GPUDevice', 'createCommandEncoder', device, { label: 'scanline: texture readback' });
    const pass = call('GPUCommandEncoder', 'beginRenderPass', encoder, {
        colorAttachments: [{ view: call('GPUTexture', 'createView', into), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }]
    });

    call('GPURenderPassEncoder', 'setPipeline', pass, pipeline);
    call('GPURenderPassEncoder', 'setBindGroup', pass, 0, group);
    call('GPURenderPassEncoder', 'draw', pass, 3);
    call('GPURenderPassEncoder', 'end', pass);
    call('GPUCommandEncoder', 'copyTextureToBuffer', encoder,
        { texture: into, origin: { x: area.x, y: area.y } },
        { buffer, bytesPerRow: stride, rowsPerImage: area.h },
        { width: area.w, height: area.h, depthOrArrayLayers: 1 });
    call('GPUQueue', 'submit', device.queue, [call('GPUCommandEncoder', 'finish', encoder)]);

    try
    {
        await call('GPUBuffer', 'mapAsync', buffer, 0x0001);

        const mapped = new G.Uint8Array(call('GPUBuffer', 'getMappedRange', buffer)) as Uint8Array;

        for (let y = 0; y < area.h; y++)
        {
            packed.set(mapped.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
        }

        call('GPUBuffer', 'unmap', buffer);
    }
    finally
    {
        call('GPUBuffer', 'destroy', buffer);
        call('GPUTexture', 'destroy', into);
    }

    return { packed, format: target, bytes };
}
