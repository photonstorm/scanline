// What WebGL formats cost in memory, and what to call them.

const UNSIGNED_BYTE = 0x1401;
const FLOAT = 0x1406;
const HALF_FLOAT = 0x140B;
const HALF_FLOAT_OES = 0x8D61;
const UNSIGNED_SHORT = 0x1403;
const UNSIGNED_INT = 0x1405;

// Sized internal formats: [name, bytes per pixel].
const SIZED: Record<number, [string, number]> = {
    0x8229: ['R8', 1], 0x822B: ['RG8', 2], 0x8051: ['RGB8', 3], 0x8058: ['RGBA8', 4],
    0x8C41: ['SRGB8', 3], 0x8C43: ['SRGB8_ALPHA8', 4], 0x8D62: ['RGB565', 2], 0x8056: ['RGBA4', 2],
    0x8057: ['RGB5_A1', 2], 0x8059: ['RGB10_A2', 4], 0x906F: ['RGB10_A2UI', 4],
    0x822D: ['R16F', 2], 0x822F: ['RG16F', 4], 0x881B: ['RGB16F', 6], 0x881A: ['RGBA16F', 8],
    0x822E: ['R32F', 4], 0x8230: ['RG32F', 8], 0x8815: ['RGB32F', 12], 0x8814: ['RGBA32F', 16],
    0x8C3A: ['R11F_G11F_B10F', 4], 0x8C3D: ['RGB9_E5', 4],
    0x8231: ['R8I', 1], 0x8232: ['R8UI', 1], 0x8233: ['R16I', 2], 0x8234: ['R16UI', 2],
    0x8235: ['R32I', 4], 0x8236: ['R32UI', 4], 0x8237: ['RG8I', 2], 0x8238: ['RG8UI', 2],
    0x8239: ['RG16I', 4], 0x823A: ['RG16UI', 4], 0x823B: ['RG32I', 8], 0x823C: ['RG32UI', 8],
    0x8D8F: ['RGB8I', 3], 0x8D7D: ['RGB8UI', 3], 0x8D8E: ['RGBA8I', 4], 0x8D7C: ['RGBA8UI', 4],
    0x8D88: ['RGBA16I', 8], 0x8D76: ['RGBA16UI', 8], 0x8D82: ['RGBA32I', 16], 0x8D70: ['RGBA32UI', 16],
    0x8F94: ['R8_SNORM', 1], 0x8F95: ['RG8_SNORM', 2], 0x8F96: ['RGB8_SNORM', 3], 0x8F97: ['RGBA8_SNORM', 4],
    0x81A5: ['DEPTH_COMPONENT16', 2], 0x81A6: ['DEPTH_COMPONENT24', 4], 0x8CAC: ['DEPTH_COMPONENT32F', 4],
    0x88F0: ['DEPTH24_STENCIL8', 4], 0x8CAD: ['DEPTH32F_STENCIL8', 8], 0x8D48: ['STENCIL_INDEX8', 1]
};

// Unsized formats: [name, components].
const UNSIZED: Record<number, [string, number]> = {
    0x1906: ['ALPHA', 1], 0x1909: ['LUMINANCE', 1], 0x190A: ['LUMINANCE_ALPHA', 2],
    0x1907: ['RGB', 3], 0x1908: ['RGBA', 4], 0x1903: ['RED', 1], 0x8227: ['RG', 2],
    0x1902: ['DEPTH_COMPONENT', 1], 0x84F9: ['DEPTH_STENCIL', 2],
    0x8C40: ['SRGB', 3], 0x8C42: ['SRGB_ALPHA', 4]
};

const COMPRESSED: Record<number, string> = {
    0x83F0: 'COMPRESSED_RGB_S3TC_DXT1', 0x83F1: 'COMPRESSED_RGBA_S3TC_DXT1', 0x83F2: 'COMPRESSED_RGBA_S3TC_DXT3',
    0x83F3: 'COMPRESSED_RGBA_S3TC_DXT5', 0x8D64: 'COMPRESSED_RGB_ETC1', 0x9274: 'COMPRESSED_RGB8_ETC2',
    0x9278: 'COMPRESSED_RGBA8_ETC2_EAC', 0x93B0: 'COMPRESSED_RGBA_ASTC_4x4', 0x8E8C: 'COMPRESSED_RGBA_BPTC_UNORM',
    0x8C00: 'COMPRESSED_RGB_PVRTC_4BPPV1', 0x8C02: 'COMPRESSED_RGBA_PVRTC_4BPPV1'
};

export function formatName (internalFormat: number): string
{
    return SIZED[internalFormat]?.[0] ?? UNSIZED[internalFormat]?.[0] ?? COMPRESSED[internalFormat] ?? `0x${internalFormat.toString(16).toUpperCase()}`;
}

// Bytes for one pixel of a texture level. `format` and `type` matter only for unsized
// internal formats (all of WebGL 1).
export function bytesPerPixel (internalFormat: number, type: number): number
{
    const sized = SIZED[internalFormat];

    if (sized)
    {
        return sized[1];
    }

    const unsized = UNSIZED[internalFormat];

    if (!unsized)
    {
        return 4;
    }

    switch (type)
    {
        case UNSIGNED_BYTE:
            return unsized[1];
        case FLOAT:
            return unsized[1] * 4;
        case HALF_FLOAT:
        case HALF_FLOAT_OES:
            return unsized[1] * 2;
        case UNSIGNED_SHORT:
            return internalFormat === 0x1902 ? 2 : unsized[1] * 2;
        case UNSIGNED_INT:
        case 0x84FA: // UNSIGNED_INT_24_8
            return 4;
        default:
            // The packed 16-bit types (5_6_5, 4_4_4_4, 5_5_5_1).
            return 2;
    }
}

// The whole mip chain of a level-0 size costs this many times level 0.
export function mipChainFactor (width: number, height: number, depth: number, levels: number): number
{
    let total = 0;
    let w = width;
    let h = height;
    let d = depth;

    for (let level = 0; level < levels; level++)
    {
        total += w * h * d;
        w = w > 1 ? w >> 1 : 1;
        h = h > 1 ? h >> 1 : 1;
        d = d > 1 ? d >> 1 : 1;
    }

    const base = width * height * depth;

    return base > 0 ? total / base : 1;
}

export function fullMipCount (width: number, height: number, depth = 1): number
{
    let largest = width > height ? width : height;

    if (depth > largest)
    {
        largest = depth;
    }

    let levels = 1;

    while (largest > 1)
    {
        largest >>= 1;
        levels++;
    }

    return levels;
}
