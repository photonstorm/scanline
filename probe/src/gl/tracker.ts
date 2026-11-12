// The WebGL tracker: every object a context creates, and a mirror of the context's state.
//
// Every state-changing call updates the mirror, so the full state at any moment is known
// without asking the context (02-ARCHITECTURE.md, section 3.4). `verify` compares the mirror
// with the real state and reports any drift.
//
// The mirror follows the rules WebGL applies to valid calls. A call the browser rejects with
// a GL error leaves the real state unchanged; the commonest of those are mirrored (binding a
// texture to a second target, an unknown capability) and the rest show up in `verify`.

import { currentFrame, onFrameEnd } from '../clock/gate';
import type { ContextInfo } from '../contexts';
import type { Handlers } from '../hooks/install';
import type { Rec } from '../hooks/hub';
import { G, type Fn } from '../natives';
import { alive, all, create, destroy, entryOf, type Entry } from '../registry';
import type { Tag } from '../tag';
import { glBufferTag, glFramebufferTag, glProgramTag, glRenderbufferTag, glSamplerTag, glShaderTag, glTextureTag, uniformLocationTag, vertexArrayStateTag } from '../tags.generated';
import { bytesPerPixel, fullMipCount, mipChainFactor } from './formats';

const TEXTURE_2D = 0x0DE1;
const TEXTURE_CUBE_MAP = 0x8513;
const TEXTURE_3D = 0x806F;
const TEXTURE_2D_ARRAY = 0x8C1A;
const ARRAY_BUFFER = 0x8892;
const ELEMENT_ARRAY_BUFFER = 0x8893;
const COPY_READ_BUFFER = 0x8F36;
const COPY_WRITE_BUFFER = 0x8F37;
const FRAMEBUFFER = 0x8D40;
const READ_FRAMEBUFFER = 0x8CA8;
const DRAW_FRAMEBUFFER = 0x8CA9;
const FRONT = 0x0404;
const BACK = 0x0405;
const FRONT_AND_BACK = 0x0408;

interface Attrib
{
    enabled: boolean;
    size: number;
    type: number;
    normalized: boolean;
    stride: number;
    offset: number;
    buffer: object | null;
    divisor: number;
    integer: boolean;
}

interface Vao
{
    element: object | null;
    attribs: Attrib[];
}

interface Unit
{
    t2d: object | null;
    cube: object | null;
    t3d: object | null;
    array: object | null;
    sampler: object | null;
}

interface StencilSide
{
    func: number;
    ref: number;
    mask: number;
    writeMask: number;
    fail: number;
    zfail: number;
    zpass: number;
}

export interface UniformSlot
{
    name: string;
    program: number; // the program's registry ID
    values: number[];
    set: number; // frame it was last set in
}

export function slotOf (location: object | null | undefined): UniformSlot | undefined
{
    return location ? locationTag.get(location) : undefined;
}

export function vaoStateOf (vao: object): Vao | undefined
{
    return vaoTag.get(vao);
}

const vaoTag: Tag<Vao> = vertexArrayStateTag;
const locationTag: Tag<UniformSlot> = uniformLocationTag;

// The record of an object of a known kind, read from the object itself. These run on every
// bind and every upload, so each is its own tag with its own inline cache.
const texOf = (object: object | null | undefined): Entry | undefined => (object ? glTextureTag.get(object) : undefined);
const bufOf = (object: object | null | undefined): Entry | undefined => (object ? glBufferTag.get(object) : undefined);

// A buffer that transform feedback writes to is one the GPU fills: a capture reads it
// before the frame, since the frame may step what the last one left there.
function feedbackTarget (target: number, buffer: object | null): void
{
    if (target === 0x8C8E && buffer)
    {
        const entry = bufOf(buffer);

        if (entry)
        {
            entry.p.feedback = true;
        }
    }
}
const shdOf = (object: object | null | undefined): Entry | undefined => (object ? glShaderTag.get(object) : undefined);
const prgOf = (object: object | null | undefined): Entry | undefined => (object ? glProgramTag.get(object) : undefined);
const fboOf = (object: object | null | undefined): Entry | undefined => (object ? glFramebufferTag.get(object) : undefined);
const rboOf = (object: object | null | undefined): Entry | undefined => (object ? glRenderbufferTag.get(object) : undefined);
const smpOf = (object: object | null | undefined): Entry | undefined => (object ? glSamplerTag.get(object) : undefined);

const KIND_TAGS: Partial<Record<Entry['kind'], Tag<Entry>>> = {
    texture: glTextureTag,
    buffer: glBufferTag,
    shader: glShaderTag,
    program: glProgramTag,
    framebuffer: glFramebufferTag,
    renderbuffer: glRenderbufferTag,
    sampler: glSamplerTag
};

// Capabilities, in the order of the `caps` array.
export const CAP_CODES = [0x0BE2, 0x0B44, 0x0B71, 0x0BD0, 0x8037, 0x809E, 0x80A0, 0x0C11, 0x0B90, 0x8C89];

function capIndex (cap: number): number
{
    switch (cap)
    {
        case 0x0BE2: return 0; // BLEND
        case 0x0B44: return 1; // CULL_FACE
        case 0x0B71: return 2; // DEPTH_TEST
        case 0x0BD0: return 3; // DITHER
        case 0x8037: return 4; // POLYGON_OFFSET_FILL
        case 0x809E: return 5; // SAMPLE_ALPHA_TO_COVERAGE
        case 0x80A0: return 6; // SAMPLE_COVERAGE
        case 0x0C11: return 7; // SCISSOR_TEST
        case 0x0B90: return 8; // STENCIL_TEST
        case 0x8C89: return 9; // RASTERIZER_DISCARD (WebGL 2)
        default: return -1;
    }
}

function newAttrib (): Attrib
{
    return { enabled: false, size: 4, type: 0x1406, normalized: false, stride: 0, offset: 0, buffer: null, divisor: 0, integer: false };
}

function newVao (): Vao
{
    return { element: null, attribs: [] };
}

function newUnit (): Unit
{
    return { t2d: null, cube: null, t3d: null, array: null, sampler: null };
}

function newStencil (): StencilSide
{
    return { func: 0x0207, ref: 0, mask: 0xFFFFFFFF, writeMask: 0xFFFFFFFF, fail: 0x1E00, zfail: 0x1E00, zpass: 0x1E00 };
}

export class GlTracker
{
    info: ContextInfo;
    gl2: boolean;

    // Extensions the page has enabled, by name. A replay must enable the same ones.
    extensions = new G.Set() as Set<string>;

    // Textures that have been a framebuffer's colour attachment, by id: what a post effect or a
    // final composite samples.
    renderTargets = new G.Set() as Set<number>;

    // Bindings
    unit = 0;
    units: Unit[] = [newUnit()];
    arrayBuffer: object | null = null;
    otherBuffers = new G.Map() as Map<number, object | null>;
    drawFramebuffer: object | null = null;
    readFramebuffer: object | null = null;
    renderbuffer: object | null = null;
    program: object | null = null;
    defaultVao: Vao = newVao();
    vao: Vao = this.defaultVao;
    vaoObject: object | null = null;
    transformFeedback: object | null = null;

    // State. Capabilities are indexed as CAP_CODES; any other argument to enable() is a GL
    // error and changes nothing.
    caps = new G.Uint8Array(CAP_CODES.length) as Uint8Array;
    viewport = [0, 0, 0, 0];
    scissor = [0, 0, 0, 0];
    clearColor = [0, 0, 0, 0];
    clearDepth = 1;
    clearStencil = 0;
    colorMask = [true, true, true, true];
    depthMask = true;
    depthFunc = 0x0201;
    depthRange = [0, 1];
    blendColor = [0, 0, 0, 0];
    blendEquationRgb = 0x8006;
    blendEquationAlpha = 0x8006;
    blendSrcRgb = 1;
    blendDstRgb = 0;
    blendSrcAlpha = 1;
    blendDstAlpha = 0;
    cullFace = BACK;
    frontFace = 0x0901;
    lineWidth = 1;
    polygonOffsetFactor = 0;
    polygonOffsetUnits = 0;
    sampleCoverageValue = 1;
    sampleCoverageInvert = false;
    stencilFront: StencilSide = newStencil();
    stencilBack: StencilSide = newStencil();
    pixelStore = new G.Map() as Map<number, number | boolean>;
    drawBuffers: number[] = [BACK];
    readBuffer = BACK;

    private drawsAtFrameEnd = 0;

    constructor (info: ContextInfo)
    {
        this.info = info;
        this.gl2 = info.api === 'webgl2';
        this.reset();
    }

    // Initial state, at creation and after a context is restored.
    reset (): void
    {
        const gl = this.info.ctx;
        const width: number = gl.drawingBufferWidth;
        const height: number = gl.drawingBufferHeight;

        this.unit = 0;
        this.units = [newUnit()];
        this.arrayBuffer = null;
        this.otherBuffers.clear();
        this.drawFramebuffer = null;
        this.readFramebuffer = null;
        this.renderbuffer = null;
        this.program = null;
        this.defaultVao = newVao();
        this.vao = this.defaultVao;
        this.vaoObject = null;
        this.transformFeedback = null;

        this.caps.fill(0);
        this.caps[3] = 1; // DITHER starts enabled

        this.viewport = [0, 0, width, height];
        this.scissor = [0, 0, width, height];
        this.clearColor = [0, 0, 0, 0];
        this.clearDepth = 1;
        this.clearStencil = 0;
        this.colorMask = [true, true, true, true];
        this.depthMask = true;
        this.depthFunc = 0x0201;
        this.depthRange = [0, 1];
        this.blendColor = [0, 0, 0, 0];
        this.blendEquationRgb = this.blendEquationAlpha = 0x8006;
        this.blendSrcRgb = this.blendSrcAlpha = 1;
        this.blendDstRgb = this.blendDstAlpha = 0;
        this.cullFace = BACK;
        this.frontFace = 0x0901;
        this.lineWidth = 1;
        this.polygonOffsetFactor = this.polygonOffsetUnits = 0;
        this.sampleCoverageValue = 1;
        this.sampleCoverageInvert = false;
        this.stencilFront = newStencil();
        this.stencilBack = newStencil();
        this.pixelStore.clear();
        this.drawBuffers = [BACK];
        this.readBuffer = BACK;
    }

    unitState (): Unit
    {
        let unit = this.units[this.unit];

        if (unit === undefined)
        {
            // Fill any gap, so every index up to the one in use has a record.
            while (this.units.length <= this.unit)
            {
                this.units.push(newUnit());
            }

            unit = this.units[this.unit];
        }

        return unit;
    }

    // The texture bound to a target (or to the cube map a face target belongs to) on the active unit.
    boundTexture (target: number): object | null
    {
        const unit = this.unitState();

        switch (target)
        {
            case TEXTURE_2D:
                return unit.t2d;
            case TEXTURE_3D:
                return unit.t3d;
            case TEXTURE_2D_ARRAY:
                return unit.array;
            default:
                return target === TEXTURE_CUBE_MAP || (target >= 0x8515 && target <= 0x851A) ? unit.cube : null;
        }
    }

    boundBuffer (target: number): object | null
    {
        if (target === ARRAY_BUFFER)
        {
            return this.arrayBuffer;
        }

        if (target === ELEMENT_ARRAY_BUFFER)
        {
            return this.vao.element;
        }

        return this.otherBuffers.get(target) ?? null;
    }

    boundFramebuffer (target: number): object | null
    {
        return target === READ_FRAMEBUFFER ? this.readFramebuffer : this.drawFramebuffer;
    }

    attrib (index: number): Attrib
    {
        const attribs = this.vao.attribs;

        while (attribs.length <= index)
        {
            attribs.push(newAttrib());
        }

        return attribs[index];
    }

    // Objects in use by this frame's draws, for "last used". Done once a frame, not per draw.
    markUsed (draws: number): void
    {
        if (draws === this.drawsAtFrameEnd)
        {
            return;
        }

        this.drawsAtFrameEnd = draws;

        const frame = currentFrame();
        const mark = (object: object | null): void =>
        {
            const entry = entryOf(object);

            if (entry)
            {
                entry.used = frame;
            }
        };

        mark(this.program);
        mark(this.arrayBuffer);
        mark(this.vao.element);
        mark(this.drawFramebuffer);

        for (const unit of this.units)
        {
            mark(unit.t2d);
            mark(unit.cube);
            mark(unit.t3d);
            mark(unit.array);
        }
    }
}

function tracker (record: Rec): GlTracker | null
{
    return record.x as GlTracker | null;
}

// ---- Object helpers ----

function make (t: GlTracker, kind: Entry['kind'], object: object | null, p: Record<string, any>): void
{
    if (object)
    {
        const entry = create(kind, 'webgl', t.info.id, object, p);

        KIND_TAGS[kind]?.set(object, entry);
    }
}

function textureBytes (p: Record<string, any>): number
{
    if (!p.width || !p.height)
    {
        return 0;
    }

    const faces = p.target === TEXTURE_CUBE_MAP ? 6 : 1;
    const depth = p.depth || 1;
    const chain = mipChainFactor(p.width, p.height, p.target === TEXTURE_3D ? depth : 1, p.levels || 1);

    if (p.compressed)
    {
        // The size of the level-0 upload is exact; the chain is the usual third on top.
        return G.Math.round((p.compressedBytes || 0) * faces * chain);
    }

    return G.Math.round(p.width * p.height * depth * bytesPerPixel(p.internalFormat, p.type) * faces * chain);
}

// A level of a texture has been (re)defined.
function defineLevel (t: GlTracker, target: number, level: number, internalFormat: number, width: number, height: number, depth: number, type: number, compressedBytes: number): void
{
    const entry = texOf(t.boundTexture(target));

    if (!entry)
    {
        return;
    }

    const p = entry.p;

    if (level === 0)
    {
        p.width = width;
        p.height = height;
        p.depth = depth;
        p.internalFormat = internalFormat;
        p.type = type;
        p.compressed = compressedBytes > 0;
        p.compressedBytes = compressedBytes;
    }

    if (level + 1 > (p.levels || 1))
    {
        p.levels = level + 1;
    }

    entry.bytes = textureBytes(p);
    entry.written = currentFrame();
}

function sourceSize (source: any): [number, number]
{
    // Images report their natural size, video its frame size, everything else width and height.
    const width = source.naturalWidth ?? source.videoWidth ?? source.displayWidth ?? source.width ?? 0;
    const height = source.naturalHeight ?? source.videoHeight ?? source.displayHeight ?? source.height ?? 0;

    return [width, height];
}

function written (t: GlTracker, target: number): void
{
    const entry = texOf(t.boundTexture(target));

    if (entry)
    {
        entry.written = currentFrame();
    }
}

function byteLength (data: any, srcOffset: number | undefined, length: number | undefined): number
{
    if (typeof data === 'number')
    {
        return data;
    }

    if (!data)
    {
        return 0;
    }

    const element: number = data.BYTES_PER_ELEMENT ?? 1;

    if (length)
    {
        return length * element;
    }

    return (data.byteLength ?? 0) - (srcOffset ?? 0) * element;
}

// The bytes of whatever buffer source a page hands to WebGL.
function bytesOf (data: any): Uint8Array
{
    return G.ArrayBuffer.isView(data) ? new G.Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new G.Uint8Array(data);
}

function attachment (t: GlTracker, target: number, point: number, value: Record<string, any> | null): void
{
    const entry = fboOf(t.boundFramebuffer(target));

    if (!entry)
    {
        return;
    }

    if (value === null)
    {
        delete entry.p.attachments[point];
    }
    else
    {
        entry.p.attachments[point] = value;

        // Colour attachments are 0x8CE0 to 0x8CFF; depth and stencil lie outside.
        if (value.texture && point >= 0x8CE0 && point <= 0x8CFF)
        {
            t.renderTargets.add(value.texture);
        }
    }
}

function setStencil (t: GlTracker, face: number, apply: (side: StencilSide) => void): void
{
    if (face === FRONT || face === FRONT_AND_BACK)
    {
        apply(t.stencilFront);
    }

    if (face === BACK || face === FRONT_AND_BACK)
    {
        apply(t.stencilBack);
    }
}

// ---- Uniforms ----

// Set while a live patch needs to know of every uniform the page sets (patch.ts).
export const uniformWatch: { set: null | ((slot: UniformSlot) => void) } = { set: null };

// Set while frames are timed (timing.ts): called when a context starts drawing somewhere else.
export const targetWatch: { changed: null | ((tracker: GlTracker) => void) } = { changed: null };

// Set while a live view holds the clear colour (patch.ts): called when the page has set its own.
export const clearWatch: { set: null | ((tracker: GlTracker) => void) } = { set: null };

function uniformN (location: object | null, count: number, a: number, b: number, c: number, d: number): void
{
    const slot = location ? locationTag.get(location) : undefined;

    if (slot === undefined)
    {
        return;
    }

    let values = slot.values;

    if (values.length !== count)
    {
        values = slot.values = new G.Array(count).fill(0);
    }

    values[0] = a;

    if (count > 1)
    {
        values[1] = b;

        if (count > 2)
        {
            values[2] = c;

            if (count > 3)
            {
                values[3] = d;
            }
        }
    }

    slot.set = currentFrame();

    if (uniformWatch.set !== null)
    {
        uniformWatch.set(slot);
    }
}

function uniformV (location: object | null, data: ArrayLike<number> | null, srcOffset: number | undefined, srcLength: number | undefined): void
{
    const slot = location ? locationTag.get(location) : undefined;

    if (slot === undefined || !data)
    {
        return;
    }

    const start = srcOffset || 0;
    const count = srcLength || data.length - start;

    let values = slot.values;

    if (values.length !== count)
    {
        values = slot.values = new G.Array(count).fill(0);
    }

    for (let i = 0; i < count; i++)
    {
        values[i] = data[start + i];
    }

    slot.set = currentFrame();

    if (uniformWatch.set !== null)
    {
        uniformWatch.set(slot);
    }
}

const scalar = (count: number): Fn => (_c: Rec, _self: unknown, _r: unknown, location: object | null, a: number, b: number, c: number, d: number) => uniformN(location, count, a, b, c, d);
const vector: Fn = (_c: Rec, _self: unknown, _r: unknown, location: object | null, data: ArrayLike<number>, srcOffset?: number, srcLength?: number) => uniformV(location, data, srcOffset, srcLength);
const matrix: Fn = (_c: Rec, _self: unknown, _r: unknown, location: object | null, _transpose: boolean, data: ArrayLike<number>, srcOffset?: number, srcLength?: number) => uniformV(location, data, srcOffset, srcLength);

// ---- Handlers: (record, self, result, ...arguments) ----

type H = (record: Rec, self: any, result: any, ...args: any[]) => void;

const handlers: Record<string, H> = {

    // Bindings

    activeTexture (c, _s, _r, texture: number)
    {
        const t = tracker(c);

        if (t && texture >= 0x84C0 && texture < 0x84C0 + 64)
        {
            t.unit = texture - 0x84C0;
        }
    },

    bindTexture (c, _s, _r, target: number, texture: object | null)
    {
        const t = tracker(c);

        if (!t)
        {
            return;
        }

        const entry = texOf(texture);

        if (entry)
        {
            // A texture belongs to the first target it is bound to. Binding it to another is an error.
            if (entry.p.target === undefined)
            {
                entry.p.target = target;
            }
            else if (entry.p.target !== target)
            {
                return;
            }

            entry.used = currentFrame();
        }

        const unit = t.unitState();

        switch (target)
        {
            case TEXTURE_2D:
                unit.t2d = texture;
                break;
            case TEXTURE_CUBE_MAP:
                unit.cube = texture;
                break;
            case TEXTURE_3D:
                unit.t3d = texture;
                break;
            case TEXTURE_2D_ARRAY:
                unit.array = texture;
                break;
        }
    },

    bindBuffer (c, _s, _r, target: number, buffer: object | null)
    {
        const t = tracker(c);

        if (!t)
        {
            return;
        }

        const entry = bufOf(buffer);
        const element = target === ELEMENT_ARRAY_BUFFER;

        if (entry && target !== COPY_READ_BUFFER && target !== COPY_WRITE_BUFFER)
        {
            // A buffer is an index buffer or it is not, for life.
            if (entry.p.element === undefined)
            {
                entry.p.element = element;
                entry.p.target = target;
            }
            else if (entry.p.element !== element)
            {
                return;
            }

            entry.used = currentFrame();
        }

        if (target === ARRAY_BUFFER)
        {
            t.arrayBuffer = buffer;
        }
        else if (element)
        {
            t.vao.element = buffer;
        }
        else
        {
            t.otherBuffers.set(target, buffer);
        }
    },

    bindBufferBase (c, _s, _r, target: number, _index: number, buffer: object | null)
    {
        // The indexed bind also sets the generic binding point.
        tracker(c)?.otherBuffers.set(target, buffer);
        feedbackTarget(target, buffer);
    },

    bindBufferRange (c, _s, _r, target: number, _index: number, buffer: object | null)
    {
        tracker(c)?.otherBuffers.set(target, buffer);
        feedbackTarget(target, buffer);
    },

    bindFramebuffer (c, _s, _r, target: number, framebuffer: object | null)
    {
        const t = tracker(c);

        if (!t)
        {
            return;
        }

        if (target === FRAMEBUFFER || target === DRAW_FRAMEBUFFER)
        {
            const moved = t.drawFramebuffer !== framebuffer;

            t.drawFramebuffer = framebuffer;

            if (moved && targetWatch.changed !== null)
            {
                targetWatch.changed(t);
            }
        }

        if (target === FRAMEBUFFER || target === READ_FRAMEBUFFER)
        {
            t.readFramebuffer = framebuffer;
        }

        const entry = fboOf(framebuffer);

        if (entry)
        {
            entry.used = currentFrame();
        }
    },

    bindRenderbuffer (c, _s, _r, _target: number, renderbuffer: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            t.renderbuffer = renderbuffer;
        }
    },

    useProgram (c, _s, _r, program: object | null)
    {
        const t = tracker(c);

        if (!t)
        {
            return;
        }

        t.program = program;

        const entry = prgOf(program);

        if (entry)
        {
            entry.used = currentFrame();
        }
    },

    bindVertexArray (c, _s, _r, vao: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            t.vaoObject = vao;
            t.vao = (vao && vaoTag.get(vao)) || t.defaultVao;
        }
    },

    bindSampler (c, _s, _r, unit: number, sampler: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            while (t.units.length <= unit)
            {
                t.units.push(newUnit());
            }

            t.units[unit].sampler = sampler;
        }
    },

    bindTransformFeedback (c, _s, _r, _target: number, feedback: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            t.transformFeedback = feedback;
        }
    },

    // State

    enable (c, _s, _r, cap: number)
    {
        const t = tracker(c);
        const index = capIndex(cap);

        if (t && index >= 0)
        {
            t.caps[index] = 1;
        }
    },

    disable (c, _s, _r, cap: number)
    {
        const t = tracker(c);
        const index = capIndex(cap);

        if (t && index >= 0)
        {
            t.caps[index] = 0;
        }
    },

    viewport (c, _s, _r, x: number, y: number, width: number, height: number)
    {
        const t = tracker(c);

        if (t && width >= 0 && height >= 0)
        {
            const v = t.viewport;

            v[0] = x;
            v[1] = y;
            v[2] = width;
            v[3] = height;
        }
    },

    scissor (c, _s, _r, x: number, y: number, width: number, height: number)
    {
        const t = tracker(c);

        if (t && width >= 0 && height >= 0)
        {
            const v = t.scissor;

            v[0] = x;
            v[1] = y;
            v[2] = width;
            v[3] = height;
        }
    },

    clearColor (c, _s, _r, r: number, g: number, b: number, a: number)
    {
        const t = tracker(c);

        if (t)
        {
            const v = t.clearColor;

            v[0] = r;
            v[1] = g;
            v[2] = b;
            v[3] = a;

            if (clearWatch.set !== null)
            {
                clearWatch.set(t);
            }
        }
    },

    clearDepth (c, _s, _r, depth: number)
    {
        const t = tracker(c);

        if (t)
        {
            t.clearDepth = depth < 0 ? 0 : (depth > 1 ? 1 : depth);
        }
    },

    clearStencil (c, _s, _r, value: number)
    {
        const t = tracker(c);

        if (t)
        {
            t.clearStencil = value;
        }
    },

    colorMask (c, _s, _r, r: boolean, g: boolean, b: boolean, a: boolean)
    {
        const t = tracker(c);

        if (t)
        {
            const v = t.colorMask;

            v[0] = !!r;
            v[1] = !!g;
            v[2] = !!b;
            v[3] = !!a;
        }
    },

    depthMask (c, _s, _r, flag: boolean)
    {
        const t = tracker(c);

        if (t)
        {
            t.depthMask = !!flag;
        }
    },

    depthFunc (c, _s, _r, func: number)
    {
        const t = tracker(c);

        if (t && func >= 0x0200 && func <= 0x0207)
        {
            t.depthFunc = func;
        }
    },

    depthRange (c, _s, _r, near: number, far: number)
    {
        const t = tracker(c);

        if (t && near <= far)
        {
            t.depthRange[0] = near < 0 ? 0 : (near > 1 ? 1 : near);
            t.depthRange[1] = far < 0 ? 0 : (far > 1 ? 1 : far);
        }
    },

    blendColor (c, _s, _r, r: number, g: number, b: number, a: number)
    {
        const t = tracker(c);

        if (t)
        {
            const v = t.blendColor;

            v[0] = r;
            v[1] = g;
            v[2] = b;
            v[3] = a;
        }
    },

    blendEquation (c, _s, _r, mode: number)
    {
        const t = tracker(c);

        if (t)
        {
            t.blendEquationRgb = t.blendEquationAlpha = mode;
        }
    },

    blendEquationSeparate (c, _s, _r, rgb: number, alpha: number)
    {
        const t = tracker(c);

        if (t)
        {
            t.blendEquationRgb = rgb;
            t.blendEquationAlpha = alpha;
        }
    },

    blendFunc (c, _s, _r, src: number, dst: number)
    {
        const t = tracker(c);

        if (t)
        {
            t.blendSrcRgb = t.blendSrcAlpha = src;
            t.blendDstRgb = t.blendDstAlpha = dst;
        }
    },

    blendFuncSeparate (c, _s, _r, srcRgb: number, dstRgb: number, srcAlpha: number, dstAlpha: number)
    {
        const t = tracker(c);

        if (t)
        {
            t.blendSrcRgb = srcRgb;
            t.blendDstRgb = dstRgb;
            t.blendSrcAlpha = srcAlpha;
            t.blendDstAlpha = dstAlpha;
        }
    },

    cullFace (c, _s, _r, mode: number)
    {
        const t = tracker(c);

        if (t && (mode === FRONT || mode === BACK || mode === FRONT_AND_BACK))
        {
            t.cullFace = mode;
        }
    },

    frontFace (c, _s, _r, mode: number)
    {
        const t = tracker(c);

        if (t && (mode === 0x0900 || mode === 0x0901))
        {
            t.frontFace = mode;
        }
    },

    lineWidth (c, _s, _r, width: number)
    {
        const t = tracker(c);

        if (t && width > 0)
        {
            t.lineWidth = width;
        }
    },

    polygonOffset (c, _s, _r, factor: number, units: number)
    {
        const t = tracker(c);

        if (t)
        {
            t.polygonOffsetFactor = factor;
            t.polygonOffsetUnits = units;
        }
    },

    sampleCoverage (c, _s, _r, value: number, invert: boolean)
    {
        const t = tracker(c);

        if (t)
        {
            t.sampleCoverageValue = value < 0 ? 0 : (value > 1 ? 1 : value);
            t.sampleCoverageInvert = !!invert;
        }
    },

    stencilFunc (c, _s, _r, func: number, ref: number, mask: number)
    {
        const t = tracker(c);

        if (t)
        {
            setStencil(t, FRONT_AND_BACK, (side) =>
            {
                side.func = func;
                side.ref = ref;
                side.mask = mask >>> 0;
            });
        }
    },

    stencilFuncSeparate (c, _s, _r, face: number, func: number, ref: number, mask: number)
    {
        const t = tracker(c);

        if (t)
        {
            setStencil(t, face, (side) =>
            {
                side.func = func;
                side.ref = ref;
                side.mask = mask >>> 0;
            });
        }
    },

    stencilMask (c, _s, _r, mask: number)
    {
        const t = tracker(c);

        if (t)
        {
            t.stencilFront.writeMask = t.stencilBack.writeMask = mask >>> 0;
        }
    },

    stencilMaskSeparate (c, _s, _r, face: number, mask: number)
    {
        const t = tracker(c);

        if (t)
        {
            setStencil(t, face, (side) =>
            {
                side.writeMask = mask >>> 0;
            });
        }
    },

    stencilOp (c, _s, _r, fail: number, zfail: number, zpass: number)
    {
        const t = tracker(c);

        if (t)
        {
            setStencil(t, FRONT_AND_BACK, (side) =>
            {
                side.fail = fail;
                side.zfail = zfail;
                side.zpass = zpass;
            });
        }
    },

    stencilOpSeparate (c, _s, _r, face: number, fail: number, zfail: number, zpass: number)
    {
        const t = tracker(c);

        if (t)
        {
            setStencil(t, face, (side) =>
            {
                side.fail = fail;
                side.zfail = zfail;
                side.zpass = zpass;
            });
        }
    },

    pixelStorei (c, _s, _r, pname: number, value: number | boolean)
    {
        tracker(c)?.pixelStore.set(pname, value);
    },

    drawBuffers (c, _s, _r, buffers: number[])
    {
        const t = tracker(c);

        if (!t || !buffers)
        {
            return;
        }

        const entry = fboOf(t.drawFramebuffer);

        if (entry)
        {
            entry.p.drawBuffers = [...buffers];
        }
        else
        {
            t.drawBuffers = [...buffers];
        }
    },

    readBuffer (c, _s, _r, source: number)
    {
        const t = tracker(c);

        if (!t)
        {
            return;
        }

        const entry = fboOf(t.readFramebuffer);

        if (entry)
        {
            entry.p.readBuffer = source;
        }
        else
        {
            t.readBuffer = source;
        }
    },

    // Vertex layout

    enableVertexAttribArray (c, _s, _r, index: number)
    {
        const t = tracker(c);

        if (t && index >= 0 && index < 64)
        {
            t.attrib(index).enabled = true;
        }
    },

    disableVertexAttribArray (c, _s, _r, index: number)
    {
        const t = tracker(c);

        if (t && index >= 0 && index < 64)
        {
            t.attrib(index).enabled = false;
        }
    },

    vertexAttribPointer (c, _s, _r, index: number, size: number, type: number, normalized: boolean, stride: number, offset: number)
    {
        const t = tracker(c);

        if (t && index >= 0 && index < 64)
        {
            const attrib = t.attrib(index);

            attrib.size = size;
            attrib.type = type;
            attrib.normalized = !!normalized;
            attrib.stride = stride;
            attrib.offset = offset;
            attrib.buffer = t.arrayBuffer;
            attrib.integer = false;
        }
    },

    vertexAttribIPointer (c, _s, _r, index: number, size: number, type: number, stride: number, offset: number)
    {
        const t = tracker(c);

        if (t && index >= 0 && index < 64)
        {
            const attrib = t.attrib(index);

            attrib.size = size;
            attrib.type = type;
            attrib.normalized = false;
            attrib.stride = stride;
            attrib.offset = offset;
            attrib.buffer = t.arrayBuffer;
            attrib.integer = true;
        }
    },

    vertexAttribDivisor (c, _s, _r, index: number, divisor: number)
    {
        const t = tracker(c);

        if (t && index >= 0 && index < 64)
        {
            t.attrib(index).divisor = divisor;
        }
    },

    // Textures

    createTexture (c, _s, texture: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            make(t, 'texture', texture, { levels: 1, params: {} });
        }
    },

    deleteTexture (c, _s, _r, texture: object | null)
    {
        const t = tracker(c);

        if (!t || !texture)
        {
            return;
        }

        destroy(texOf(texture));

        // Deleting a bound texture unbinds it everywhere in this context.
        for (const unit of t.units)
        {
            if (unit.t2d === texture) { unit.t2d = null; }
            if (unit.cube === texture) { unit.cube = null; }
            if (unit.t3d === texture) { unit.t3d = null; }
            if (unit.array === texture) { unit.array = null; }
        }
    },

    texImage2D (c, _s, _r, target: number, level: number, internalFormat: number, a3: any, a4: any, a5: any, a6: any, a7: any)
    {
        const t = tracker(c);

        if (!t)
        {
            return;
        }

        if (a6 === undefined && a5 !== null && typeof a5 === 'object')
        {
            // (target, level, internalformat, format, type, source)
            const [width, height] = sourceSize(a5);

            defineLevel(t, target, level, internalFormat, width, height, 1, a4, 0);
        }
        else
        {
            // (target, level, internalformat, width, height, border, format, type, …)
            defineLevel(t, target, level, internalFormat, a3, a4, 1, a7, 0);
        }
    },

    texImage3D (c, _s, _r, target: number, level: number, internalFormat: number, width: number, height: number, depth: number, _border: number, _format: number, type: number)
    {
        const t = tracker(c);

        if (t)
        {
            defineLevel(t, target, level, internalFormat, width, height, depth, type, 0);
        }
    },

    texStorage2D (c, _s, _r, target: number, levels: number, internalFormat: number, width: number, height: number)
    {
        const t = tracker(c);
        const entry = t ? texOf(t.boundTexture(target)) : undefined;

        if (t && entry)
        {
            defineLevel(t, target, 0, internalFormat, width, height, 1, 0, 0);
            entry.p.levels = levels;
            entry.p.immutable = true;
            entry.bytes = textureBytes(entry.p);
        }
    },

    texStorage3D (c, _s, _r, target: number, levels: number, internalFormat: number, width: number, height: number, depth: number)
    {
        const t = tracker(c);
        const entry = t ? texOf(t.boundTexture(target)) : undefined;

        if (t && entry)
        {
            defineLevel(t, target, 0, internalFormat, width, height, depth, 0, 0);
            entry.p.levels = levels;
            entry.p.immutable = true;
            entry.bytes = textureBytes(entry.p);
        }
    },

    texSubImage2D (c, _s, _r, target: number)
    {
        const t = tracker(c);

        if (t)
        {
            written(t, target);
        }
    },

    texSubImage3D (c, _s, _r, target: number)
    {
        const t = tracker(c);

        if (t)
        {
            written(t, target);
        }
    },

    compressedTexImage2D (c, _s, _r, target: number, level: number, internalFormat: number, width: number, height: number, _border: number, a6: any, a7: any, a8: any)
    {
        const t = tracker(c);

        if (t)
        {
            // (…, imageSize, offset) for a pixel-unpack buffer, or (…, data, srcOffset, srcLengthOverride).
            const bytes = typeof a6 === 'number' ? a6 : (a8 || (a6 ? a6.byteLength - (a7 || 0) : 0));

            defineLevel(t, target, level, internalFormat, width, height, 1, 0, bytes || 1);
        }
    },

    compressedTexImage3D (c, _s, _r, target: number, level: number, internalFormat: number, width: number, height: number, depth: number, _border: number, a7: any, a8: any, a9: any)
    {
        const t = tracker(c);

        if (t)
        {
            const bytes = typeof a7 === 'number' ? a7 : (a9 || (a7 ? a7.byteLength - (a8 || 0) : 0));

            defineLevel(t, target, level, internalFormat, width, height, depth, 0, bytes || 1);
        }
    },

    compressedTexSubImage2D (c, _s, _r, target: number)
    {
        const t = tracker(c);

        if (t)
        {
            written(t, target);
        }
    },

    compressedTexSubImage3D (c, _s, _r, target: number)
    {
        const t = tracker(c);

        if (t)
        {
            written(t, target);
        }
    },

    copyTexImage2D (c, _s, _r, target: number, level: number, internalFormat: number, _x: number, _y: number, width: number, height: number)
    {
        const t = tracker(c);

        if (t)
        {
            defineLevel(t, target, level, internalFormat, width, height, 1, 0x1401, 0);
        }
    },

    copyTexSubImage2D (c, _s, _r, target: number)
    {
        const t = tracker(c);

        if (t)
        {
            written(t, target);
        }
    },

    copyTexSubImage3D (c, _s, _r, target: number)
    {
        const t = tracker(c);

        if (t)
        {
            written(t, target);
        }
    },

    generateMipmap (c, _s, _r, target: number)
    {
        const t = tracker(c);
        const entry = t ? texOf(t.boundTexture(target)) : undefined;

        if (entry && entry.p.width)
        {
            entry.p.levels = fullMipCount(entry.p.width, entry.p.height, target === TEXTURE_3D ? entry.p.depth : 1);
            entry.p.generatedMips = true;
            entry.bytes = textureBytes(entry.p);
            entry.written = currentFrame();
        }
    },

    texParameteri (c, _s, _r, target: number, pname: number, value: number)
    {
        const t = tracker(c);
        const entry = t ? texOf(t.boundTexture(target)) : undefined;

        if (entry)
        {
            entry.p.params[pname] = value;
        }
    },

    texParameterf (c, _s, _r, target: number, pname: number, value: number)
    {
        const t = tracker(c);
        const entry = t ? texOf(t.boundTexture(target)) : undefined;

        if (entry)
        {
            entry.p.params[pname] = value;
        }
    },

    // Buffers

    createBuffer (c, _s, buffer: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            make(t, 'buffer', buffer, { size: 0 });
        }
    },

    deleteBuffer (c, _s, _r, buffer: object | null)
    {
        const t = tracker(c);

        if (!t || !buffer)
        {
            return;
        }

        destroy(bufOf(buffer));

        // Unbound from the context's binding points and from the bound vertex array.
        if (t.arrayBuffer === buffer)
        {
            t.arrayBuffer = null;
        }

        if (t.vao.element === buffer)
        {
            t.vao.element = null;
        }

        for (const attrib of t.vao.attribs)
        {
            if (attrib.buffer === buffer)
            {
                attrib.buffer = null;
            }
        }

        for (const [target, bound] of t.otherBuffers)
        {
            if (bound === buffer)
            {
                t.otherBuffers.set(target, null);
            }
        }
    },

    bufferData (c, _s, _r, target: number, data: any, usage: number, srcOffset?: number, length?: number)
    {
        const t = tracker(c);
        const entry = t ? bufOf(t.boundBuffer(target)) : undefined;

        if (entry)
        {
            entry.p.size = byteLength(data, srcOffset, length);
            entry.p.usage = usage;
            entry.bytes = entry.p.size;
            entry.written = currentFrame();

            if (t && !t.gl2)
            {
                // WebGL 1 has no call that reads a buffer back, so a copy of what the page
                // uploads is the only record of its contents (03-INSPECTION.md, section 1.2).
                entry.p.mirror = new G.Uint8Array(entry.p.size);

                if (data && typeof data !== 'number')
                {
                    entry.p.mirror.set(bytesOf(data));
                }
            }
        }
    },

    bufferSubData (c, _s, _r, target: number, offset: number, data: any)
    {
        const t = tracker(c);
        const entry = t ? bufOf(t.boundBuffer(target)) : undefined;

        if (entry)
        {
            entry.written = currentFrame();

            const mirror: Uint8Array | undefined = entry.p.mirror;

            if (mirror && data)
            {
                const bytes = bytesOf(data);

                if (offset >= 0 && offset + bytes.length <= mirror.length)
                {
                    mirror.set(bytes, offset);
                }
            }
        }
    },

    // Shaders and programs

    createShader (c, _s, shader: object | null, type: number)
    {
        const t = tracker(c);

        if (t)
        {
            make(t, 'shader', shader, { type, source: '', compiles: 0 });
        }
    },

    deleteShader (_c, _s, _r, shader: object | null)
    {
        destroy(shdOf(shader));
    },

    shaderSource (_c, _s, _r, shader: object | null, source: string)
    {
        const entry = shdOf(shader);

        if (entry)
        {
            entry.p.source = G.String(source);
            entry.bytes = entry.p.source.length;
        }
    },

    compileShader (_c, _s, _r, shader: object | null)
    {
        const entry = shdOf(shader);

        if (entry)
        {
            entry.p.compiles++;
            entry.p.compiledAt = currentFrame();
        }
    },

    createProgram (c, _s, program: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            make(t, 'program', program, { shaders: [], links: 0, uniforms: new G.Map() });
        }
    },

    deleteProgram (_c, _s, _r, program: object | null)
    {
        destroy(prgOf(program));
    },

    attachShader (_c, _s, _r, program: object | null, shader: object | null)
    {
        const entry = prgOf(program);
        const attached = shdOf(shader);

        if (entry && attached && !entry.p.shaders.includes(attached.id))
        {
            entry.p.shaders.push(attached.id);
        }
    },

    detachShader (_c, _s, _r, program: object | null, shader: object | null)
    {
        const entry = prgOf(program);
        const attached = shdOf(shader);

        if (entry && attached)
        {
            // What was linked stays linked: the list of shaders a program was built from is kept.
            entry.p.detached = true;
        }
    },

    linkProgram (_c, _s, _r, program: object | null)
    {
        const entry = prgOf(program);

        if (entry)
        {
            entry.p.links++;
            entry.p.linkedAt = currentFrame();

            // A relink invalidates every uniform location and resets uniform values.
            entry.p.uniforms = new G.Map();
        }
    },

    getUniformLocation (_c, _s, location: object | null, program: object | null, name: string)
    {
        const entry = prgOf(program);

        if (!entry || !location)
        {
            return;
        }

        const key = G.String(name);

        let slot: UniformSlot | undefined = entry.p.uniforms.get(key);

        if (!slot)
        {
            slot = { name: key, program: entry.id, values: [], set: -1 };
            entry.p.uniforms.set(key, slot);
        }

        // Every location object the page gets for this uniform shares the one slot.
        locationTag.set(location, slot);
    },

    uniformBlockBinding (_c, _s, _r, program: object | null, index: number, binding: number)
    {
        const entry = prgOf(program);

        if (entry)
        {
            (entry.p.blockBindings ??= {})[index] = binding;
        }
    },

    // Framebuffers and renderbuffers

    createFramebuffer (c, _s, framebuffer: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            make(t, 'framebuffer', framebuffer, { attachments: {} });
        }
    },

    deleteFramebuffer (c, _s, _r, framebuffer: object | null)
    {
        const t = tracker(c);

        if (!t || !framebuffer)
        {
            return;
        }

        destroy(fboOf(framebuffer));

        if (t.drawFramebuffer === framebuffer)
        {
            t.drawFramebuffer = null;
        }

        if (t.readFramebuffer === framebuffer)
        {
            t.readFramebuffer = null;
        }
    },

    framebufferTexture2D (c, _s, _r, target: number, point: number, textarget: number, texture: object | null, level: number)
    {
        const t = tracker(c);

        if (!t)
        {
            return;
        }

        const entry = texOf(texture);

        if (entry)
        {
            entry.p.renderTarget = true;
        }

        attachment(t, target, point, texture ? { texture: entry?.id ?? 0, level, face: textarget } : null);
    },

    framebufferTextureLayer (c, _s, _r, target: number, point: number, texture: object | null, level: number, layer: number)
    {
        const t = tracker(c);

        if (!t)
        {
            return;
        }

        const entry = texOf(texture);

        if (entry)
        {
            entry.p.renderTarget = true;
        }

        attachment(t, target, point, texture ? { texture: entry?.id ?? 0, level, layer } : null);
    },

    framebufferRenderbuffer (c, _s, _r, target: number, point: number, _rbTarget: number, renderbuffer: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            attachment(t, target, point, renderbuffer ? { renderbuffer: rboOf(renderbuffer)?.id ?? 0 } : null);
        }
    },

    createRenderbuffer (c, _s, renderbuffer: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            make(t, 'renderbuffer', renderbuffer, {});
        }
    },

    deleteRenderbuffer (c, _s, _r, renderbuffer: object | null)
    {
        const t = tracker(c);

        if (!t || !renderbuffer)
        {
            return;
        }

        destroy(rboOf(renderbuffer));

        if (t.renderbuffer === renderbuffer)
        {
            t.renderbuffer = null;
        }
    },

    renderbufferStorage (c, _s, _r, _target: number, internalFormat: number, width: number, height: number)
    {
        const t = tracker(c);
        const entry = t ? rboOf(t.renderbuffer) : undefined;

        if (entry)
        {
            G.Object.assign(entry.p, { internalFormat, width, height, samples: 0 });
            entry.bytes = width * height * bytesPerPixel(internalFormat === 0x84F9 ? 0x88F0 : internalFormat, 0x1401);
        }
    },

    renderbufferStorageMultisample (c, _s, _r, _target: number, samples: number, internalFormat: number, width: number, height: number)
    {
        const t = tracker(c);
        const entry = t ? rboOf(t.renderbuffer) : undefined;

        if (entry)
        {
            G.Object.assign(entry.p, { internalFormat, width, height, samples });
            entry.bytes = width * height * bytesPerPixel(internalFormat, 0x1401) * (samples > 1 ? samples : 1);
        }
    },

    // Other objects

    createSampler (c, _s, sampler: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            make(t, 'sampler', sampler, { params: {} });
        }
    },

    deleteSampler (c, _s, _r, sampler: object | null)
    {
        const t = tracker(c);

        if (!t || !sampler)
        {
            return;
        }

        destroy(smpOf(sampler));

        for (const unit of t.units)
        {
            if (unit.sampler === sampler)
            {
                unit.sampler = null;
            }
        }
    },

    samplerParameteri (_c, _s, _r, sampler: object | null, pname: number, value: number)
    {
        const entry = smpOf(sampler);

        if (entry)
        {
            entry.p.params[pname] = value;
        }
    },

    samplerParameterf (_c, _s, _r, sampler: object | null, pname: number, value: number)
    {
        const entry = smpOf(sampler);

        if (entry)
        {
            entry.p.params[pname] = value;
        }
    },

    createVertexArray (c, _s, vao: object | null)
    {
        const t = tracker(c);

        if (t && vao)
        {
            make(t, 'vertex_array', vao, {});
            vaoTag.set(vao, newVao());
        }
    },

    deleteVertexArray (c, _s, _r, vao: object | null)
    {
        const t = tracker(c);

        if (!t || !vao)
        {
            return;
        }

        destroy(entryOf(vao));

        if (t.vaoObject === vao)
        {
            t.vaoObject = null;
            t.vao = t.defaultVao;
        }
    },

    createQuery (c, _s, query: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            make(t, 'query', query, {});
        }
    },

    deleteQuery (_c, _s, _r, query: object | null)
    {
        destroy(entryOf(query));
    },

    createTransformFeedback (c, _s, feedback: object | null)
    {
        const t = tracker(c);

        if (t)
        {
            make(t, 'query', feedback, { transformFeedback: true });
        }
    },

    deleteTransformFeedback (c, _s, _r, feedback: object | null)
    {
        const t = tracker(c);

        destroy(entryOf(feedback));

        if (t && t.transformFeedback === feedback)
        {
            t.transformFeedback = null;
        }
    }
};

export const glHandlers: Handlers = {};

for (const name of G.Object.keys(handlers))
{
    glHandlers[`gl.${name}`] = handlers[name];
}

for (const [suffix, count] of [['1', 1], ['2', 2], ['3', 3], ['4', 4]] as Array<[string, number]>)
{
    for (const type of ['f', 'i', 'ui'])
    {
        glHandlers[`gl.uniform${suffix}${type}`] = scalar(count);
        glHandlers[`gl.uniform${suffix}${type}v`] = vector;
    }
}

for (const shape of ['2', '3', '4', '2x3', '3x2', '2x4', '4x2', '3x4', '4x3'])
{
    glHandlers[`gl.uniformMatrix${shape}fv`] = matrix;
}

// The same state through extension objects, where WebGL 1 gets it from.
glHandlers['OES_vertex_array_object.createVertexArrayOES'] = handlers.createVertexArray;
glHandlers['OES_vertex_array_object.deleteVertexArrayOES'] = handlers.deleteVertexArray;
glHandlers['OES_vertex_array_object.bindVertexArrayOES'] = handlers.bindVertexArray;
glHandlers['ANGLE_instanced_arrays.vertexAttribDivisorANGLE'] = handlers.vertexAttribDivisor;
glHandlers['WEBGL_draw_buffers.drawBuffersWEBGL'] = handlers.drawBuffers;

const trackers: GlTracker[] = [];

export function attachTracker (info: ContextInfo): GlTracker
{
    const t = new GlTracker(info);

    info.record.x = t;
    trackers.push(t);

    return t;
}

export function trackerFor (info: ContextInfo): GlTracker | null
{
    return (info.record.x as GlTracker | null) ?? null;
}

// A lost context has lost every object and all state.
export function contextLost (info: ContextInfo): void
{
    for (const kind of ['texture', 'buffer', 'shader', 'program', 'framebuffer', 'renderbuffer', 'sampler', 'vertex_array', 'query'] as const)
    {
        for (const entry of all(kind))
        {
            if (entry.context === info.id && alive(entry))
            {
                destroy(entry);
                entry.p.lostWithContext = true;
            }
        }
    }
}

export function contextRestored (info: ContextInfo): void
{
    trackerFor(info)?.reset();
}

export function installGlTracking (): void
{
    onFrameEnd(() =>
    {
        for (const t of trackers)
        {
            t.markUsed(t.info.record.draws);
        }
    });
}
