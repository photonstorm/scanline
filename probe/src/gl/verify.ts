// Compares the tracker's mirror of WebGL state with what the context itself reports.
//
// This is the check the build plan asks of the shadow state: after any number of frames,
// the two must agree. A difference means a method's effect is mirrored wrongly (a bug in the
// tracker), or the page made a call the browser rejected with a GL error.
//
// It asks the context dozens of questions, each a round trip to the GPU process, so it runs
// on request and never during normal observation.

import type { ContextInfo } from '../contexts';
import { G } from '../natives';
import { entryOf } from '../registry';
import { CAP_CODES, trackerFor, type GlTracker } from './tracker';

export interface Drift
{
    what: string;
    mirror: string;
    real: string;
}

function show (value: unknown): string
{
    if (value === null || value === undefined)
    {
        return 'null';
    }

    if (typeof value === 'object')
    {
        const entry = entryOf(value as object);

        if (entry)
        {
            return `${entry.kind} ${entry.id}`;
        }

        if (typeof (value as ArrayLike<unknown>).length === 'number')
        {
            return `[${G.Array.from(value as ArrayLike<unknown>).join(', ')}]`;
        }

        return G.Object.prototype.toString.call(value);
    }

    return G.String(value);
}

function same (mirror: unknown, real: unknown): boolean
{
    if (mirror === real)
    {
        return true;
    }

    if (typeof mirror === 'number' && typeof real === 'number')
    {
        // Colours and depths are stored as 32-bit floats; some are clamped when read back.
        return G.Math.abs(mirror - real) < 1e-6 || G.Math.fround(mirror) === real || G.Math.min(1, G.Math.max(0, mirror)) === real;
    }

    if (mirror && real && typeof mirror === 'object' && typeof real === 'object' && typeof (mirror as any).length === 'number' && typeof (real as any).length === 'number')
    {
        const a = mirror as ArrayLike<unknown>;
        const b = real as ArrayLike<unknown>;

        if (a.length !== b.length)
        {
            return false;
        }

        for (let i = 0; i < a.length; i++)
        {
            if (!same(a[i], b[i]))
            {
                return false;
            }
        }

        return true;
    }

    return false;
}

export function verify (info: ContextInfo): { checked: number; drift: Drift[] }
{
    const t = trackerFor(info);

    if (!t || info.lost)
    {
        return { checked: 0, drift: [] };
    }

    const gl = info.ctx;
    const n = info.natives;
    const get = (pname: number): unknown => n.getParameter.call(gl, pname);
    const drift: Drift[] = [];

    let checked = 0;

    const check = (what: string, mirror: unknown, real: unknown): void =>
    {
        checked++;

        if (!same(mirror, real))
        {
            drift.push({ what, mirror: show(mirror), real: show(real) });
        }
    };

    const state: Array<[string, number, unknown]> = [
        ['ACTIVE_TEXTURE', 0x84E0, 0x84C0 + t.unit],
        ['ARRAY_BUFFER_BINDING', 0x8894, t.arrayBuffer],
        ['ELEMENT_ARRAY_BUFFER_BINDING', 0x8895, t.vao.element],
        ['FRAMEBUFFER_BINDING', 0x8CA6, t.drawFramebuffer],
        ['RENDERBUFFER_BINDING', 0x8CA7, t.renderbuffer],
        ['CURRENT_PROGRAM', 0x8B8D, t.program],
        ['VIEWPORT', 0x0BA2, t.viewport],
        ['SCISSOR_BOX', 0x0C10, t.scissor],
        ['COLOR_CLEAR_VALUE', 0x0C22, t.clearColor],
        ['DEPTH_CLEAR_VALUE', 0x0B73, t.clearDepth],
        ['STENCIL_CLEAR_VALUE', 0x0B91, t.clearStencil],
        ['COLOR_WRITEMASK', 0x0C23, t.colorMask],
        ['DEPTH_WRITEMASK', 0x0B72, t.depthMask],
        ['DEPTH_FUNC', 0x0B74, t.depthFunc],
        ['DEPTH_RANGE', 0x0B70, t.depthRange],
        ['BLEND_COLOR', 0x8005, t.blendColor],
        ['BLEND_EQUATION_RGB', 0x8009, t.blendEquationRgb],
        ['BLEND_EQUATION_ALPHA', 0x883D, t.blendEquationAlpha],
        ['BLEND_SRC_RGB', 0x80C9, t.blendSrcRgb],
        ['BLEND_DST_RGB', 0x80C8, t.blendDstRgb],
        ['BLEND_SRC_ALPHA', 0x80CB, t.blendSrcAlpha],
        ['BLEND_DST_ALPHA', 0x80CA, t.blendDstAlpha],
        ['CULL_FACE_MODE', 0x0B45, t.cullFace],
        ['FRONT_FACE', 0x0B46, t.frontFace],
        ['LINE_WIDTH', 0x0B21, t.lineWidth],
        ['POLYGON_OFFSET_FACTOR', 0x8038, t.polygonOffsetFactor],
        ['POLYGON_OFFSET_UNITS', 0x2A00, t.polygonOffsetUnits],
        ['SAMPLE_COVERAGE_VALUE', 0x80AA, t.sampleCoverageValue],
        ['SAMPLE_COVERAGE_INVERT', 0x80AB, t.sampleCoverageInvert],
        ['STENCIL_FUNC', 0x0B92, t.stencilFront.func],
        ['STENCIL_VALUE_MASK', 0x0B93, t.stencilFront.mask],
        ['STENCIL_WRITEMASK', 0x0B98, t.stencilFront.writeMask],
        ['STENCIL_FAIL', 0x0B94, t.stencilFront.fail],
        ['STENCIL_PASS_DEPTH_FAIL', 0x0B95, t.stencilFront.zfail],
        ['STENCIL_PASS_DEPTH_PASS', 0x0B96, t.stencilFront.zpass],
        ['STENCIL_BACK_FUNC', 0x8800, t.stencilBack.func],
        ['STENCIL_BACK_VALUE_MASK', 0x8CA4, t.stencilBack.mask],
        ['STENCIL_BACK_WRITEMASK', 0x8CA5, t.stencilBack.writeMask],
        ['STENCIL_BACK_FAIL', 0x8801, t.stencilBack.fail],
        ['STENCIL_BACK_PASS_DEPTH_FAIL', 0x8802, t.stencilBack.zfail],
        ['STENCIL_BACK_PASS_DEPTH_PASS', 0x8803, t.stencilBack.zpass]
    ];

    if (t.gl2)
    {
        state.push(
            ['READ_FRAMEBUFFER_BINDING', 0x8CAA, t.readFramebuffer],
            ['VERTEX_ARRAY_BINDING', 0x85B5, t.vaoObject],
            ['PIXEL_PACK_BUFFER_BINDING', 0x88ED, t.otherBuffers.get(0x88EB) ?? null],
            ['PIXEL_UNPACK_BUFFER_BINDING', 0x88EF, t.otherBuffers.get(0x88EC) ?? null],
            ['COPY_READ_BUFFER_BINDING', 0x8F36, t.otherBuffers.get(0x8F36) ?? null],
            ['COPY_WRITE_BUFFER_BINDING', 0x8F37, t.otherBuffers.get(0x8F37) ?? null],
            ['UNIFORM_BUFFER_BINDING', 0x8A28, t.otherBuffers.get(0x8A11) ?? null],
            ['TRANSFORM_FEEDBACK_BUFFER_BINDING', 0x8C8F, t.otherBuffers.get(0x8C8E) ?? null],
            ['TRANSFORM_FEEDBACK_BINDING', 0x8E25, t.transformFeedback]
        );
    }

    for (const [name, pname, mirror] of state)
    {
        check(name, mirror, get(pname));
    }

    // The stencil reference is clamped to the stencil buffer's range when read.
    const clampRef = (ref: number): number => G.Math.min(255, G.Math.max(0, ref));

    check('STENCIL_REF', clampRef(t.stencilFront.ref), clampRef(get(0x0B97) as number));
    check('STENCIL_BACK_REF', clampRef(t.stencilBack.ref), clampRef(get(0x8CA3) as number));

    for (let i = 0; i < CAP_CODES.length; i++)
    {
        const cap = CAP_CODES[i];

        if (cap === 0x8C89 && !t.gl2)
        {
            continue;
        }

        check(`isEnabled(0x${cap.toString(16)})`, t.caps[i] === 1, n.isEnabled.call(gl, cap));
    }

    for (const [pname, value] of t.pixelStore)
    {
        const real = get(pname);

        // Booleans may be set with 0 and 1.
        check(`pixelStorei(0x${pname.toString(16)})`, typeof real === 'boolean' ? !!value : value, real);
    }

    // Texture bindings, unit by unit. Reading them means moving the active unit, natively,
    // and putting it back.
    for (let i = 0; i < t.units.length; i++)
    {
        const unit = t.units[i];

        n.activeTexture.call(gl, 0x84C0 + i);

        check(`unit ${i} TEXTURE_BINDING_2D`, unit.t2d, get(0x8069));
        check(`unit ${i} TEXTURE_BINDING_CUBE_MAP`, unit.cube, get(0x8514));

        if (t.gl2)
        {
            check(`unit ${i} TEXTURE_BINDING_3D`, unit.t3d, get(0x806A));
            check(`unit ${i} TEXTURE_BINDING_2D_ARRAY`, unit.array, get(0x8C1D));
            check(`unit ${i} SAMPLER_BINDING`, unit.sampler, get(0x8919));
        }
    }

    n.activeTexture.call(gl, 0x84C0 + t.unit);

    // Vertex attributes of the bound vertex array.
    checkAttribs(t, check);

    return { checked, drift };
}

function checkAttribs (t: GlTracker, check: (what: string, mirror: unknown, real: unknown) => void): void
{
    const gl = t.info.ctx;
    const n = t.info.natives;
    const attribs = t.vao.attribs;

    for (let i = 0; i < attribs.length; i++)
    {
        const attrib = attribs[i];
        const real = (pname: number): unknown => n.getVertexAttrib.call(gl, i, pname);

        check(`attribute ${i} enabled`, attrib.enabled, real(0x8622));
        check(`attribute ${i} buffer`, attrib.buffer, real(0x889F));

        // Layout only means anything once vertexAttribPointer has been called with a buffer.
        if (attrib.buffer)
        {
            check(`attribute ${i} size`, attrib.size, real(0x8623));
            check(`attribute ${i} type`, attrib.type, real(0x8625));
            check(`attribute ${i} normalized`, attrib.normalized, real(0x886A));
            check(`attribute ${i} stride`, attrib.stride, real(0x8624));
            check(`attribute ${i} offset`, attrib.offset, n.getVertexAttribOffset.call(gl, i, 0x8645));
        }

        if (t.gl2)
        {
            check(`attribute ${i} divisor`, attrib.divisor, real(0x88FE));
        }
    }
}
