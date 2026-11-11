// Reads a texture by drawing it: for the formats a framebuffer cannot hold.
//
// A compressed texture, a depth texture and a luminance or alpha texture cannot be attached
// to a framebuffer and read with readPixels. They can all be sampled, so one level is drawn
// into a scratch RGBA8 target by a shader of the probe's own, texel for texel, and that is
// read. What comes back is what a shader of the page's would see: a compressed texture's
// blocks decoded by the GPU, a depth texture's depth.
//
// The draw uses the page's context, so everything it changes is put back from the
// tracker's mirror: the page sees nothing.

import type { ContextInfo } from '../contexts';
import { G, type Fn } from '../natives';
import type { Entry } from '../registry';
import { CAP_CODES, trackerFor } from './tracker';

const TEXTURE_2D = 0x0DE1;
const TEXTURE_CUBE_MAP = 0x8513;
const TEXTURE_3D = 0x806F;
const TEXTURE_2D_ARRAY = 0x8C1A;
const MIN_FILTER = 0x2801;
const MAG_FILTER = 0x2800;
const WRAP_S = 0x2802;
const WRAP_T = 0x2803;
const BASE_LEVEL = 0x813C;
const COMPARE_MODE = 0x884C;
const NEAREST = 0x2600;

const DEPTH_FORMATS = new G.Set([0x1902, 0x84F9, 0x81A5, 0x81A6, 0x8CAC, 0x88F0, 0x8CAD]) as Set<number>;

// Block-compressed formats, by the ranges their extensions were given.
export function isCompressedFormat (format: number): boolean
{
    return (format >= 0x83F0 && format <= 0x83F3)       // S3TC
        || (format >= 0x8C4C && format <= 0x8C4F)       // S3TC, sRGB
        || (format >= 0x8DBB && format <= 0x8DBE)       // RGTC
        || (format >= 0x8E8C && format <= 0x8E8F)       // BPTC
        || format === 0x8D64                            // ETC1
        || (format >= 0x9270 && format <= 0x9279)       // ETC2 and EAC
        || (format >= 0x93B0 && format <= 0x93BD)       // ASTC
        || (format >= 0x93D0 && format <= 0x93DD)       // ASTC, sRGB
        || (format >= 0x8C00 && format <= 0x8C03)       // PVRTC
        || format === 0x9137 || format === 0x9138;      // PVRTC 2
}

// The compressed formats whose texels are sRGB-encoded.
export function isSrgbCompressed (format: number): boolean
{
    return (format >= 0x8C4C && format <= 0x8C4F)
        || format === 0x8E8D
        || format === 0x9275 || format === 0x9277 || format === 0x9279
        || (format >= 0x93D0 && format <= 0x93DD);
}

// Signed or floating-point blocks: an 8-bit target holds 0 to 1 of them.
function isClamped (format: number): boolean
{
    return format === 0x8DBC || format === 0x8DBE       // signed RGTC
        || format === 0x9271 || format === 0x9273       // signed EAC
        || format === 0x8E8E || format === 0x8E8F;      // BPTC float
}

export function isDepthFormat (format: number): boolean
{
    return DEPTH_FORMATS.has(format);
}

// True for a texture that readPixels cannot reach and this file can.
export function mustBeSampled (p: Record<string, any>): boolean
{
    return Boolean(p.compressed) || isCompressedFormat(p.internalFormat) || isDepthFormat(p.internalFormat);
}

interface Program
{
    program: object;
    sampler: unknown;
    at: unknown;
    size: unknown;
    depth: unknown;
}

interface Scratch
{
    framebuffer: object;
    target: object | null;          // WebGL 1: one texture, given new storage each time
    vao: object | null;             // WebGL 2
    corners: object | null;         // WebGL 1
    programs: Map<string, Program | null>;
}

const scratch = new G.WeakMap() as WeakMap<object, Scratch>;

const DIRECTION = `
vec3 direction (float face, vec2 uv)
{
    vec2 c = uv * 2.0 - 1.0;

    if (face < 0.5) { return vec3(1.0, -c.y, -c.x); }
    if (face < 1.5) { return vec3(-1.0, -c.y, c.x); }
    if (face < 2.5) { return vec3(c.x, 1.0, c.y); }
    if (face < 3.5) { return vec3(c.x, -1.0, -c.y); }
    if (face < 4.5) { return vec3(c.x, -c.y, 1.0); }

    return vec3(-c.x, -c.y, -1.0);
}`;

// Depth as 24 bits across red, green and blue, least significant first.
const PACK = `
vec4 depthBytes (float depth)
{
    float v = min(floor(clamp(depth, 0.0, 1.0) * 16777215.0 + 0.5), 16777215.0);
    float low = mod(v, 256.0);

    v = floor(v / 256.0);

    return vec4(low, mod(v, 256.0), floor(v / 256.0), 255.0) / 255.0;
}`;

function sources (gl2: boolean, kind: string): [string, string]
{
    if (gl2)
    {
        const sampler = kind === 'cube' ? 'samplerCube' : (kind === 'array' ? 'sampler2DArray' : (kind === '3d' ? 'sampler3D' : 'sampler2D'));
        const fetch = kind === 'cube'
            ? 'texture(u_texture, direction(u_at.w, (vec2(texel) + 0.5) / u_size))'
            : (kind === '2d' ? 'texelFetch(u_texture, texel, int(u_at.z))' : 'texelFetch(u_texture, ivec3(texel, int(u_at.w)), int(u_at.z))');

        return [
            '#version 300 es\nvoid main () { gl_Position = vec4(vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0, 0.0, 1.0); }',
            `#version 300 es
precision highp float;
precision highp int;
precision highp ${sampler};
uniform ${sampler} u_texture;
uniform vec4 u_at;
uniform vec2 u_size;
uniform float u_depth;
out vec4 colour;
${DIRECTION}
${PACK}
void main ()
{
    ivec2 texel = ivec2(gl_FragCoord.xy) + ivec2(u_at.xy);
    vec4 value = ${fetch};

    colour = u_depth > 0.5 ? depthBytes(value.r) : value;
}`
        ];
    }

    return [
        'attribute vec2 a_corner;\nvoid main () { gl_Position = vec4(a_corner, 0.0, 1.0); }',
        `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform ${kind === 'cube' ? 'samplerCube' : 'sampler2D'} u_texture;
uniform vec4 u_at;
uniform vec2 u_size;
uniform float u_depth;
${DIRECTION}
${PACK}
void main ()
{
    vec2 uv = (gl_FragCoord.xy + u_at.xy) / u_size;
    vec4 value = ${kind === 'cube' ? 'textureCube(u_texture, direction(u_at.w, uv))' : 'texture2D(u_texture, uv)'};

    gl_FragColor = u_depth > 0.5 ? depthBytes(value.r) : value;
}`
    ];
}

function programFor (gl: any, n: Record<string, Fn>, gl2: boolean, held: Scratch, kind: string): Program | null
{
    if (held.programs.has(kind))
    {
        return held.programs.get(kind)!;
    }

    const [vertex, fragment] = sources(gl2, kind);
    const program = n.createProgram.call(gl) as object;

    for (const [type, source] of [[0x8B31, vertex], [0x8B30, fragment]] as Array<[number, string]>)
    {
        const shader = n.createShader.call(gl, type);

        n.shaderSource.call(gl, shader, source);
        n.compileShader.call(gl, shader);
        n.attachShader.call(gl, program, shader);
        n.deleteShader.call(gl, shader);
    }

    if (!gl2)
    {
        n.bindAttribLocation.call(gl, program, 0, 'a_corner');
    }

    n.linkProgram.call(gl, program);

    const made: Program | null = n.getProgramParameter.call(gl, program, 0x8B82)
        ? {
            program,
            sampler: n.getUniformLocation.call(gl, program, 'u_texture'),
            at: n.getUniformLocation.call(gl, program, 'u_at'),
            size: n.getUniformLocation.call(gl, program, 'u_size'),
            depth: n.getUniformLocation.call(gl, program, 'u_depth')
        }
        : null;

    held.programs.set(kind, made);

    return made;
}

export interface Sampled
{
    bytes: Uint8Array;      // RGBA8, w × h, rows as stored
    depth: boolean;         // the bytes are depth, packed: see `depthOf`
    srgb: boolean;          // the bytes are sRGB-encoded, as the texture's texels are
    clamped: boolean;       // the format holds values outside 0 to 1, which were clamped
}

// Depth from the packed bytes of one pixel.
export function depthOf (bytes: Uint8Array, index: number): number
{
    return (bytes[index] + bytes[index + 1] * 256 + bytes[index + 2] * 65536) / 16777215;
}

// One region of one level of a texture, drawn and read. `area` is within the level.
export function sampleGlTexture (entry: Entry, info: ContextInfo, level: number, layer: number, area: { x: number; y: number; w: number; h: number }): Sampled
{
    const gl = info.ctx;
    const n = info.natives;
    const t = trackerFor(info);
    const p = entry.p;
    const texture = entry.ref.deref();

    if (!t || !texture)
    {
        throw new Error('The context this texture belongs to is gone.');
    }

    const gl2 = t.gl2;
    const target: number = p.target;
    const kind = target === TEXTURE_CUBE_MAP ? 'cube' : (target === TEXTURE_2D_ARRAY ? 'array' : (target === TEXTURE_3D ? '3d' : '2d'));

    if (!gl2 && (kind === 'array' || kind === '3d'))
    {
        throw new Error('This texture cannot be sampled on WebGL 1.');
    }

    const depth = isDepthFormat(p.internalFormat);
    const srgb = gl2 && isSrgbCompressed(p.internalFormat);
    const width = G.Math.max(1, p.width >> level);
    const height = G.Math.max(1, p.height >> level);
    const bytes = new G.Uint8Array(area.w * area.h * 4) as Uint8Array;

    if (area.w === 0 || area.h === 0)
    {
        return { bytes, depth, srgb, clamped: false };
    }

    let held = scratch.get(gl);

    if (!held)
    {
        // Made through the unwrapped functions, so none of it is in the registry.
        held = {
            framebuffer: n.createFramebuffer.call(gl) as object,
            target: null,
            vao: gl2 ? n.createVertexArray.call(gl) as object : null,
            corners: null,
            programs: new G.Map()
        };

        scratch.set(gl, held);
    }

    const program = programFor(gl, n, gl2, held, kind);

    if (!program)
    {
        throw new Error('The shader that samples a texture for reading did not compile here.');
    }

    const first = t.vao.attribs[0];

    if (!gl2 && first && first.divisor !== 0)
    {
        throw new Error('This texture cannot be sampled while vertex attribute 0 is instanced.');
    }

    const unit = t.units[t.unit] ?? { t2d: null, cube: null, t3d: null, array: null, sampler: null };
    const fbTarget = gl2 ? 0x8CA9 : 0x8D40;
    const param = (pname: number, fallback: number): number => (p.params && p.params[pname] !== undefined ? p.params[pname] : fallback);
    const changed: Array<[number, number]> = [];
    const set = (pname: number, value: number, fallback: number): void =>
    {
        if (param(pname, fallback) !== value)
        {
            changed.push([pname, param(pname, fallback)]);
            n.texParameteri.call(gl, target, pname, value);
        }
    };

    let made: object | null = null;

    try
    {
        // The target: an RGBA8 texture the size of what is read. One whose texels are sRGB
        // is drawn to an sRGB target, so the bytes read are the texture's own.
        if (gl2)
        {
            made = n.createTexture.call(gl) as object;
            n.bindTexture.call(gl, TEXTURE_2D, made);
            n.texStorage2D.call(gl, TEXTURE_2D, 1, srgb ? 0x8C43 : 0x8058, area.w, area.h);
        }
        else
        {
            held.target ??= n.createTexture.call(gl) as object;
            made = held.target;
            n.bindTexture.call(gl, TEXTURE_2D, made);
            n.texImage2D.call(gl, TEXTURE_2D, 0, 0x1908, area.w, area.h, 0, 0x1908, 0x1401, null);
            n.texParameteri.call(gl, TEXTURE_2D, MIN_FILTER, NEAREST);
        }

        n.bindFramebuffer.call(gl, fbTarget, held.framebuffer);
        n.framebufferTexture2D.call(gl, fbTarget, 0x8CE0, TEXTURE_2D, made, 0);

        if (n.checkFramebufferStatus.call(gl, fbTarget) !== 0x8CD5)
        {
            throw new Error('The target a texture is sampled into could not be made here.');
        }

        // The texture, where a shader can see every texel of the level asked for.
        n.bindTexture.call(gl, target, texture);

        if (gl2)
        {
            n.bindSampler.call(gl, t.unit, null);
            set(COMPARE_MODE, 0, 0);

            if (kind === 'cube')
            {
                set(BASE_LEVEL, level, 0);
            }
        }
        else
        {
            set(WRAP_S, 0x812F, 0x2901);
            set(WRAP_T, 0x812F, 0x2901);
        }

        set(MIN_FILTER, !gl2 && level > 0 ? 0x2700 : NEAREST, 0x2702);
        set(MAG_FILTER, NEAREST, 0x2601);

        // The draw: nothing but the texels.
        for (let index = 0; index < CAP_CODES.length; index++)
        {
            if (t.caps[index])
            {
                n.disable.call(gl, CAP_CODES[index]);
            }
        }

        n.colorMask.call(gl, true, true, true, true);
        n.viewport.call(gl, 0, 0, area.w, area.h);
        n.useProgram.call(gl, program.program);

        // The texture was bound to the unit the page has active, which need not be unit 0.
        // Left at 0, the shader would sample whatever the page keeps there, and where that
        // is a shadow map or an integer texture the browser rejects the draw.
        n.uniform1i.call(gl, program.sampler, t.unit);
        n.uniform4f.call(gl, program.at, area.x, area.y, level, layer);
        n.uniform2f.call(gl, program.size, width, height);
        n.uniform1f.call(gl, program.depth, depth ? 1 : 0);

        if (gl2)
        {
            n.bindVertexArray.call(gl, held.vao);
        }
        else
        {
            if (!held.corners)
            {
                held.corners = n.createBuffer.call(gl) as object;
                n.bindBuffer.call(gl, 0x8892, held.corners);
                n.bufferData.call(gl, 0x8892, new G.Float32Array([-1, -1, 3, -1, -1, 3]), 0x88E4);
            }

            n.bindBuffer.call(gl, 0x8892, held.corners);
            n.enableVertexAttribArray.call(gl, 0);
            n.vertexAttribPointer.call(gl, 0, 2, 0x1406, false, 0, 0);
        }

        n.drawArrays.call(gl, 4, 0, 3);

        if (gl2)
        {
            n.bindFramebuffer.call(gl, 0x8CA8, held.framebuffer);
            n.bindBuffer.call(gl, 0x88EB, null);
            n.pixelStorei.call(gl, 0x0D02, 0);
            n.pixelStorei.call(gl, 0x0D03, 0);
            n.pixelStorei.call(gl, 0x0D04, 0);
        }

        n.pixelStorei.call(gl, 0x0D05, 1);
        n.readPixels.call(gl, 0, 0, area.w, area.h, 0x1908, 0x1401, bytes);
    }
    finally
    {
        // Everything back as the page left it, from the mirror.
        for (const [pname, value] of changed)
        {
            n.texParameteri.call(gl, target, pname, value);
        }

        n.framebufferTexture2D.call(gl, fbTarget, 0x8CE0, TEXTURE_2D, null, 0);
        n.bindTexture.call(gl, TEXTURE_2D, unit.t2d);

        if (target !== TEXTURE_2D)
        {
            n.bindTexture.call(gl, target, target === TEXTURE_CUBE_MAP ? unit.cube : (target === TEXTURE_3D ? unit.t3d : unit.array));
        }

        if (gl2)
        {
            n.bindSampler.call(gl, t.unit, unit.sampler);
            n.bindVertexArray.call(gl, t.vaoObject);

            if (made)
            {
                n.deleteTexture.call(gl, made);
            }
        }
        else
        {
            if (first && first.buffer)
            {
                n.bindBuffer.call(gl, 0x8892, first.buffer);
                n.vertexAttribPointer.call(gl, 0, first.size, first.type, first.normalized, first.stride, first.offset);
            }
            else
            {
                n.bindBuffer.call(gl, 0x8892, null);
                n.vertexAttribPointer.call(gl, 0, 4, 0x1406, false, 0, 0);
            }

            if (!first || !first.enabled)
            {
                n.disableVertexAttribArray.call(gl, 0);
            }

            n.bindBuffer.call(gl, 0x8892, t.arrayBuffer);

            // The scratch texture keeps no storage between reads.
            if (made)
            {
                n.bindTexture.call(gl, TEXTURE_2D, made);
                n.texImage2D.call(gl, TEXTURE_2D, 0, 0x1908, 1, 1, 0, 0x1908, 0x1401, null);
                n.bindTexture.call(gl, TEXTURE_2D, unit.t2d);
            }
        }

        n.useProgram.call(gl, t.program);
        n.viewport.call(gl, t.viewport[0], t.viewport[1], t.viewport[2], t.viewport[3]);
        n.colorMask.call(gl, t.colorMask[0], t.colorMask[1], t.colorMask[2], t.colorMask[3]);

        for (let index = 0; index < CAP_CODES.length; index++)
        {
            if (t.caps[index])
            {
                n.enable.call(gl, CAP_CODES[index]);
            }
        }

        if (gl2)
        {
            n.bindFramebuffer.call(gl, 0x8CA9, t.drawFramebuffer);
            n.bindFramebuffer.call(gl, 0x8CA8, t.readFramebuffer);
            n.bindBuffer.call(gl, 0x88EB, t.otherBuffers.get(0x88EB) ?? null);
            n.pixelStorei.call(gl, 0x0D02, (t.pixelStore.get(0x0D02) as number) ?? 0);
            n.pixelStorei.call(gl, 0x0D03, (t.pixelStore.get(0x0D03) as number) ?? 0);
            n.pixelStorei.call(gl, 0x0D04, (t.pixelStore.get(0x0D04) as number) ?? 0);
        }
        else
        {
            n.bindFramebuffer.call(gl, 0x8D40, t.drawFramebuffer);
        }

        n.pixelStorei.call(gl, 0x0D05, (t.pixelStore.get(0x0D05) as number) ?? 4);
    }

    return { bytes, depth, srgb, clamped: isClamped(p.internalFormat) };
}
