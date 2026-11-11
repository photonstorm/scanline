// What WebGPU texture formats cost in memory.

// Bytes per texel for uncompressed formats.
function texelBytes (format: string): number
{
    if (format.startsWith('depth') || format === 'stencil8')
    {
        switch (format)
        {
            case 'stencil8':
                return 1;
            case 'depth16unorm':
                return 2;
            case 'depth32float-stencil8':
                return 8;
            default:
                return 4;
        }
    }

    if (format === 'rgb10a2unorm' || format === 'rgb10a2uint' || format === 'rg11b10ufloat' || format === 'rgb9e5ufloat')
    {
        return 4;
    }

    const channels = format.startsWith('rgba') || format.startsWith('bgra') ? 4 : (format.startsWith('rg') ? 2 : 1);
    const bits = format.includes('32') ? 32 : (format.includes('16') ? 16 : 8);

    return channels * bits / 8;
}

// For block-compressed formats: [block width, block height, bytes per block].
export function block (format: string): [number, number, number] | null
{
    if (format.startsWith('bc'))
    {
        return [4, 4, format.startsWith('bc1') || format.startsWith('bc4') ? 8 : 16];
    }

    if (format.startsWith('etc2') || format.startsWith('eac'))
    {
        return [4, 4, format.startsWith('etc2-rgba8') || format.startsWith('eac-rg11') ? 16 : 8];
    }

    if (format.startsWith('astc-'))
    {
        const [width, height] = format.slice(5).split('-')[0].split('x').map(Number);

        return [width || 4, height || 4, 16];
    }

    return null;
}

// Estimated bytes of a texture: every mip level, layer and sample.
export function textureBytes (format: string, width: number, height: number, depthOrLayers: number, mipLevels: number, samples: number, dimension: string): number
{
    const blocks = block(format);

    let total = 0;
    let w = width;
    let h = height;
    let d = dimension === '3d' ? depthOrLayers : 1;

    for (let level = 0; level < mipLevels; level++)
    {
        total += blocks
            ? Math.ceil(w / blocks[0]) * Math.ceil(h / blocks[1]) * blocks[2] * d
            : w * h * d * texelBytes(format);

        w = w > 1 ? w >> 1 : 1;
        h = h > 1 ? h >> 1 : 1;
        d = d > 1 ? d >> 1 : 1;
    }

    return total * (dimension === '3d' ? 1 : depthOrLayers) * (samples > 1 ? samples : 1);
}

// Bytes per texel when a texture is copied to a buffer, or 0 where a copy cannot give texels:
// a compressed format (it gives blocks) and depth24plus (it cannot be copied).
export function copyBytes (format: string): number
{
    if (block(format) || format === 'depth24plus' || format === 'depth24plus-stencil8')
    {
        return 0;
    }

    // The depth of a depth and stencil texture, or the stencil of a stencil one.
    if (format === 'depth32float-stencil8')
    {
        return 4;
    }

    if (format === 'stencil8')
    {
        return 1;
    }

    return texelBytes(format);
}
