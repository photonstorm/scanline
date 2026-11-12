// Live patches: changes to how a running page draws, made from outside it and undone at will
// (03-INSPECTION.md, section 9).
//
// A patch never edits what the page owns. Draws pass through a gate (hooks/generated.ts):
// it can drop a draw, or change something just before the draw and put it back just after.
//
//   draws     drop the draws that match, or all but those that match, or draw them in
//             one flat colour
//   view      the whole frame drawn another way: overdraw, outlines, a colour for each
//             draw, or depth
//   state     set blend, depth, cull, scissor or the colour mask around matching draws
//   uniform   hold one uniform of a program at a value, whatever the page sets
//   shader    draw with a rebuilt copy of a program in place of the page's
//   texture   draw with a stand-in wherever one texture is bound
//
// A patched shader is a second program, the shadow, linked from the edited source with
// every attribute at the location it had. Before a draw that uses the page's program the
// shadow is made current and given the page's uniform values; after it, the page's program
// is made current again. The page's program and its uniform locations are never touched,
// so reverting is simply to stop.
//
// A flat colour is drawn by a shadow too: the page's fragment shader with its main() renamed
// and a new main() that calls it and then writes the colour, so whatever the page's shader
// discards is still discarded.
//
// This file is WebGL. A WebGPU pipeline cannot be changed, only replaced: gpu/patch.ts.

import { onFrameBegin } from './clock/gate';
import { allContexts, contextById, type ContextInfo } from './contexts';
import { isDepthFormat } from './gl/sample';
import { clearWatch, trackerFor, uniformWatch, type GlTracker, type UniformSlot } from './gl/tracker';
import { gpuPatchAdd, gpuPatchFrame, gpuPatchList, gpuPatchRemove } from './gpu/patch';
import type { Rec } from './hooks/hub';
import { G, type Fn } from './natives';
import { entryOf, find } from './registry';
import { imageOf } from './standin';
import { expose } from './transport';

interface Filter
{
    program?: number;
    texture?: number;
    // The frame's events, numbered as a capture numbers them (draws, clears and blits in
    // order, from 0), both ends included.
    draws?: [number, number];
}

interface ShadowUniform { location: unknown; type: number }

// A program's stand-in that draws one flat colour where the page's draws its own.
interface Solid
{
    shadow: unknown;
    uniforms: Map<string, ShadowUniform>;
    stale: boolean;
    colour: unknown;        // where its colour goes
}

interface Patch
{
    id: number;
    kind: 'draws' | 'state' | 'uniform' | 'shader' | 'texture' | 'view';
    context: number;
    description: string;
    filter: Filter;

    mode?: 'skip' | 'isolate' | 'solid';
    state?: Record<string, unknown>;

    // solid: the colour, or 'draw' for one of each draw's own, or 'depth' for its depth;
    // and the stand-in made for each program it has met (null where one could not be made).
    colour?: number[] | 'draw' | 'depth';
    solids?: Map<number, Solid | null>;
    unmade?: number;

    // view
    view?: string;

    // uniform, shader
    program?: number;
    name?: string;
    value?: number[];
    location?: unknown;
    type?: number;

    // shader
    shadow?: unknown;
    uniforms?: Map<string, ShadowUniform>;
    stale?: boolean;

    // texture
    texture?: number;
    replacement?: unknown;

    // Draws it applied to: in the frame under way, and in the last whole frame.
    hits: number;
    lastHits: number;
}

interface Patched
{
    info: ContextInfo;
    patches: Patch[];
    seen: number;           // draws the gate has seen this frame
    clears: number;         // the context's counts of clears and blits as the frame began
    blits: number;
    restores: Array<() => void>;
    // For the wireframe view: the program of the last draw, and which programs have drawn more
    // than a full-screen quad. A draw by a program that never has, sampling a texture the frame
    // rendered into, is a pass over the whole target (a post effect, the final composite), and
    // is drawn filled, so that what earlier passes drew as outlines shows through it. A quad
    // drawn with an ordinary texture (a floor, a sprite) stays outlined.
    previous?: number;
    large?: Set<number>;
    small?: Set<number>;
}

const patched = new G.Map() as Map<number, Patched>;

let nextId = 1;

const BLEND = 0;
const CULL = 1;
const DEPTH = 2;
const SCISSOR = 7;
const CAPS = [0x0BE2, 0x0B44, 0x0B71, 0x0BD0, 0x8037, 0x809E, 0x80A0, 0x0C11, 0x0B90, 0x8C89];

// ---- Setting a uniform by its type ----

function setUniform (n: Record<string, Fn>, gl: unknown, location: unknown, type: number, values: number[]): void
{
    switch (type)
    {
        case 0x1406: n.uniform1fv.call(gl, location, values); break;
        case 0x8B50: n.uniform2fv.call(gl, location, values); break;
        case 0x8B51: n.uniform3fv.call(gl, location, values); break;
        case 0x8B52: n.uniform4fv.call(gl, location, values); break;
        case 0x8B53: case 0x8B57: n.uniform2iv.call(gl, location, values); break;
        case 0x8B54: case 0x8B58: n.uniform3iv.call(gl, location, values); break;
        case 0x8B55: case 0x8B59: n.uniform4iv.call(gl, location, values); break;
        case 0x1405: n.uniform1uiv.call(gl, location, values); break;
        case 0x8DC6: n.uniform2uiv.call(gl, location, values); break;
        case 0x8DC7: n.uniform3uiv.call(gl, location, values); break;
        case 0x8DC8: n.uniform4uiv.call(gl, location, values); break;
        case 0x8B5A: n.uniformMatrix2fv.call(gl, location, false, values); break;
        case 0x8B5B: n.uniformMatrix3fv.call(gl, location, false, values); break;
        case 0x8B5C: n.uniformMatrix4fv.call(gl, location, false, values); break;
        case 0x8B65: n.uniformMatrix2x3fv.call(gl, location, false, values); break;
        case 0x8B66: n.uniformMatrix2x4fv.call(gl, location, false, values); break;
        case 0x8B67: n.uniformMatrix3x2fv.call(gl, location, false, values); break;
        case 0x8B68: n.uniformMatrix3x4fv.call(gl, location, false, values); break;
        case 0x8B69: n.uniformMatrix4x2fv.call(gl, location, false, values); break;
        case 0x8B6A: n.uniformMatrix4x3fv.call(gl, location, false, values); break;
        // Integers, booleans and every kind of sampler.
        default: n.uniform1iv.call(gl, location, values); break;
    }
}

// The uniforms a linked program has, by the names a page may know them by.
function uniformsOf (n: Record<string, Fn>, gl: unknown, program: unknown): Map<string, ShadowUniform>
{
    const out = new G.Map() as Map<string, ShadowUniform>;
    const count: number = n.getProgramParameter.call(gl, program, 0x8B86) ?? 0;

    for (let i = 0; i < count; i++)
    {
        const active = n.getActiveUniform.call(gl, program, i);

        if (!active)
        {
            continue;
        }

        const entry = { location: n.getUniformLocation.call(gl, program, active.name), type: active.type as number };

        out.set(active.name, entry);

        // An array is "name[0]" to the browser and often plain "name" to the page.
        if (active.name.endsWith('[0]'))
        {
            out.set(active.name.slice(0, -3), entry);
        }
    }

    return out;
}

// ---- Applying patches around a draw ----

function matches (filter: Filter, program: number | undefined, index: number, t: GlTracker): boolean
{
    if (filter.program !== undefined && filter.program !== program)
    {
        return false;
    }

    if (filter.draws !== undefined && (index < filter.draws[0] || index > filter.draws[1]))
    {
        return false;
    }

    if (filter.texture !== undefined && !t.units.some((unit) => unit.t2d !== null && entryOf(unit.t2d)?.id === filter.texture))
    {
        return false;
    }

    return true;
}

function cap (n: Record<string, Fn>, gl: unknown, t: GlTracker, index: number, on: boolean, restores: Array<() => void>): void
{
    const was = t.caps[index] === 1;

    if (was === on)
    {
        return;
    }

    (on ? n.enable : n.disable).call(gl, CAPS[index]);
    restores.push(() => (was ? n.enable : n.disable).call(gl, CAPS[index]));
}

function applyState (n: Record<string, Fn>, gl: unknown, t: GlTracker, state: Record<string, any>, restores: Array<() => void>): void
{
    if (typeof state.blend === 'boolean') { cap(n, gl, t, BLEND, state.blend, restores); }
    if (typeof state.depth_test === 'boolean') { cap(n, gl, t, DEPTH, state.depth_test, restores); }
    if (typeof state.cull === 'boolean') { cap(n, gl, t, CULL, state.cull, restores); }

    if (typeof state.depth_write === 'boolean' && state.depth_write !== t.depthMask)
    {
        const was = t.depthMask;

        n.depthMask.call(gl, state.depth_write);
        restores.push(() => n.depthMask.call(gl, was));
    }

    if (G.Array.isArray(state.color_mask) && state.color_mask.length === 4)
    {
        const was = t.colorMask.slice();

        n.colorMask.call(gl, ...state.color_mask.map(G.Boolean));
        restores.push(() => n.colorMask.call(gl, ...was));
    }

    // Added to what is there, whatever the page's blend is: how the overdraw view counts.
    if (state.blend_add === true)
    {
        const was = [t.blendSrcRgb, t.blendDstRgb, t.blendSrcAlpha, t.blendDstAlpha, t.blendEquationRgb, t.blendEquationAlpha];

        cap(n, gl, t, BLEND, true, restores);
        n.blendFunc.call(gl, 1, 1);
        n.blendEquation.call(gl, 0x8006);
        restores.push(() =>
        {
            n.blendFuncSeparate.call(gl, was[0], was[1], was[2], was[3]);
            n.blendEquationSeparate.call(gl, was[4], was[5]);
        });
    }

    if (state.scissor === false)
    {
        cap(n, gl, t, SCISSOR, false, restores);
    }
    else if (G.Array.isArray(state.scissor) && state.scissor.length === 4)
    {
        const was = t.scissor.slice();

        cap(n, gl, t, SCISSOR, true, restores);
        n.scissor.call(gl, ...state.scissor);
        restores.push(() => n.scissor.call(gl, ...was));
    }
}

// Gives a shadow program, which is current, the values the page has given its own.
function sync (n: Record<string, Fn>, gl: unknown, program: number, shadow: { uniforms?: Map<string, ShadowUniform>; stale?: boolean }): void
{
    const slots: Map<string, UniformSlot> | undefined = find('program', program)?.p.uniforms;

    for (const [name, slot] of slots ?? [])
    {
        const uniform = shadow.uniforms!.get(name);

        if (uniform && uniform.location && slot.set >= 0)
        {
            setUniform(n, gl, uniform.location, uniform.type, slot.values);
        }
    }

    shadow.stale = false;
}

// A colour for an event, by its number: far apart for numbers that are close.
function colourOfDraw (index: number): [number, number, number, number]
{
    const hue = (index * 0.618033988749895) % 1;
    const part = (offset: number): number =>
    {
        const k = (offset + hue * 6) % 6;

        return 0.25 + 0.75 * G.Math.max(0, G.Math.min(1, G.Math.min(k, 4 - k)));
    };

    return [part(5), part(3), part(1), 1];
}

// Whether a texture the frame rendered into is bound for this draw, other than one the draw is
// rendering into now (a page often leaves a target bound while it draws into it, and cannot
// sample it there).
function samplesTarget (t: GlTracker): boolean
{
    const own = t.drawFramebuffer ? entryOf(t.drawFramebuffer)?.p?.attachments : undefined;
    const drawingInto = (id: number): boolean => own !== undefined && G.Object.values(own).some((value: any) => value?.texture === id);

    return t.units.some((unit) =>
    {
        const id = unit.t2d !== null ? entryOf(unit.t2d)?.id : undefined;

        return id !== undefined && t.renderTargets.has(id) && !drawingInto(id);
    });
}

function gate (c: Rec, gl: unknown): boolean
{
    const t = c.x as GlTracker | null;
    const state = t ? patched.get(t.info.id) : undefined;

    if (!t || !state)
    {
        return true;
    }

    // Its number among the frame's events: the draws so far, and the clears and blits between them.
    const index = state.seen++ + (c.clears - state.clears) + (c.blits - state.blits);
    const program = t.program ? entryOf(t.program)?.id : undefined;
    const n = t.info.natives;

    // What the last draw drew, now that it is known, for the wireframe view.
    if (state.previous !== undefined)
    {
        const vertices = (c as Rec & { lastVertices: number }).lastVertices;

        if (vertices > 6)
        {
            (state.large ??= new G.Set()).add(state.previous);
        }
        else if (vertices > 0)
        {
            (state.small ??= new G.Set()).add(state.previous);
        }
    }

    state.previous = program;

    // Whether it is drawn at all comes first: nothing is changed for a draw that is dropped.
    let isolating = false;
    let isolated = false;

    for (const patch of state.patches)
    {
        if (patch.kind !== 'draws' || patch.mode === 'solid')
        {
            continue;
        }

        const hit = matches(patch.filter, program, index, t);

        if (patch.mode === 'isolate')
        {
            isolating = true;
            isolated = isolated || hit;
        }
        else if (hit)
        {
            patch.hits++;

            return false;
        }

        if (hit)
        {
            patch.hits++;
        }
    }

    if (isolating && !isolated)
    {
        return false;
    }

    const restores = state.restores;

    restores.length = 0;

    // A full-screen pass under the wireframe view is drawn filled.
    if (program !== undefined && state.small?.has(program) && !state.large?.has(program) && state.patches.some((patch) => patch.view === 'wireframe')
        && samplesTarget(t))
    {
        const mode = n.getExtension.call(gl, 'WEBGL_polygon_mode');

        if (mode)
        {
            mode.polygonModeWEBGL(0x0408, 0x1B02);
            restores.push(() => mode.polygonModeWEBGL(0x0408, 0x1B01));
        }
    }

    for (const patch of state.patches)
    {
        if (patch.kind === 'state')
        {
            if (matches(patch.filter, program, index, t))
            {
                patch.hits++;
                applyState(n, gl, t, patch.state!, restores);
            }
        }
        else if (patch.kind === 'shader')
        {
            if (program === patch.program)
            {
                const own = t.program;

                patch.hits++;
                n.useProgram.call(gl, patch.shadow);

                if (patch.stale)
                {
                    sync(n, gl, patch.program!, patch);
                }

                restores.push(() => n.useProgram.call(gl, own));
            }
        }
        else if (patch.mode === 'solid' && program !== undefined && matches(patch.filter, program, index, t))
        {
            let solid = patch.solids!.get(program);

            if (solid === undefined)
            {
                try
                {
                    solid = makeSolid(t.info, t, program, patch.colour === 'depth');
                }
                catch
                {
                    // A program that cannot be given a stand-in is drawn as the page made it.
                    solid = null;
                    patch.unmade = (patch.unmade ?? 0) + 1;
                }

                patch.solids!.set(program, solid);
            }

            patch.hits++;

            if (solid)
            {
                const own = t.program;

                if (patch.state)
                {
                    applyState(n, gl, t, patch.state, restores);
                }

                n.useProgram.call(gl, solid.shadow);

                if (solid.stale)
                {
                    sync(n, gl, program, solid);
                }

                if (solid.colour)
                {
                    const colour = patch.colour === 'draw' ? colourOfDraw(index) : patch.colour as number[];

                    n.uniform4f.call(gl, solid.colour, colour[0], colour[1], colour[2], colour[3]);
                }

                restores.push(() => n.useProgram.call(gl, own));
            }
        }
        else if (patch.kind === 'texture' && matches(patch.filter, program, index, t))
        {
            let used = false;

            t.units.forEach((unit, at) =>
            {
                if (unit.t2d !== null && entryOf(unit.t2d)?.id === patch.texture)
                {
                    const own = unit.t2d;

                    used = true;
                    n.activeTexture.call(gl, 0x84C0 + at);
                    n.bindTexture.call(gl, 0x0DE1, patch.replacement);
                    restores.push(() =>
                    {
                        n.activeTexture.call(gl, 0x84C0 + at);
                        n.bindTexture.call(gl, 0x0DE1, own);
                    });
                }
            });

            if (used)
            {
                patch.hits++;
                restores.push(() => n.activeTexture.call(gl, 0x84C0 + t.unit));
            }
        }
    }

    c.after = restores.length ? after : null;

    return true;
}

function after (c: Rec): void
{
    const t = c.x as GlTracker | null;
    const state = t ? patched.get(t.info.id) : undefined;

    c.after = null;

    if (!state)
    {
        return;
    }

    // Last changed, first put back.
    for (let i = state.restores.length - 1; i >= 0; i--)
    {
        state.restores[i]();
    }

    state.restores.length = 0;
}

// The page has set a uniform. A held one is set back; a shadow program will need it again.
function onUniform (slot: UniformSlot): void
{
    for (const state of patched.values())
    {
        for (const patch of state.patches)
        {
            const solid = patch.solids?.get(slot.program);

            if (solid)
            {
                solid.stale = true;
            }

            if (patch.program !== slot.program)
            {
                continue;
            }

            if (patch.kind === 'shader')
            {
                patch.stale = true;
            }
            else if (patch.kind === 'uniform' && (patch.name === slot.name || `${patch.name}[0]` === slot.name) && patch.location)
            {
                // The page's program is current: it has just been given this uniform.
                setUniform(state.info.natives, state.info.ctx, patch.location, patch.type!, patch.value!);
            }
        }
    }
}

function wire (state: Patched): void
{
    // The wireframe view needs the gate too, to leave full-screen passes filled.
    const drawn = state.patches.some((patch) => patch.kind !== 'uniform');

    state.info.record.gate = drawn ? gate : null;

    if (!drawn)
    {
        state.info.record.after = null;
    }

    let watching = false;

    for (const other of patched.values())
    {
        watching = watching || other.patches.some((patch) => patch.kind === 'uniform' || patch.kind === 'shader' || patch.mode === 'solid');
    }

    uniformWatch.set = watching ? onUniform : null;

    // The overdraw view counts up from black, whatever the page clears to.
    let clearing = false;

    for (const other of patched.values())
    {
        clearing = clearing || other.patches.some((patch) => patch.view === 'overdraw');
    }

    clearWatch.set = clearing ? onClearColour : null;
}

// The page has set its clear colour while the overdraw view is on: black again.
function onClearColour (t: GlTracker): void
{
    if (patched.get(t.info.id)?.patches.some((patch) => patch.view === 'overdraw'))
    {
        t.info.natives.clearColor.call(t.info.ctx, 0, 0, 0, 1);
    }
}

// ---- Making patches ----

function context (id: number | undefined): { info: ContextInfo; t: GlTracker }
{
    const info = id === undefined
        ? allContexts().filter((candidate) => candidate.api === 'webgl' || candidate.api === 'webgl2').sort((a, b) => b.record.draws - a.record.draws)[0]
        : contextById(id);
    const t = info ? trackerFor(info) : null;

    if (!info || !t)
    {
        throw new Error(info?.api === 'webgpu'
            ? 'Live patches are built for WebGL. A WebGPU pipeline cannot be changed, only replaced, which is not built yet.'
            : 'There is no WebGL context to patch.');
    }

    return { info, t };
}

function programOf (info: ContextInfo, id: number): { entry: NonNullable<ReturnType<typeof find>>; object: unknown }
{
    const entry = find('program', id);
    const object = entry?.ref.deref();

    if (!entry || !object || entry.context !== info.id || entry.destroyed)
    {
        throw new Error(`There is no live program ${id} in this context.`);
    }

    return { entry, object };
}

// With the program current for a moment, and the page's own put back after.
function withProgram (info: ContextInfo, t: GlTracker, program: unknown, work: () => void): void
{
    const n = info.natives;

    n.useProgram.call(info.ctx, program);

    try
    {
        work();
    }
    finally
    {
        n.useProgram.call(info.ctx, t.program);
    }
}

function compile (n: Record<string, Fn>, gl: unknown, type: number, source: string): { shader: unknown; log: string; ok: boolean }
{
    const shader = n.createShader.call(gl, type);

    n.shaderSource.call(gl, shader, source);
    n.compileShader.call(gl, shader);

    return { shader, log: G.String(n.getShaderInfoLog.call(gl, shader) ?? '').trim(), ok: G.Boolean(n.getShaderParameter.call(gl, shader, 0x8B81)) };
}

// The edited text of one of a program's shaders.
function edited (source: string, spec: { source?: string; edits?: Array<{ find: string; replace: string }>; defines?: Record<string, string | number> }): { text: string; said: string }
{
    if (typeof spec.source === 'string')
    {
        return { text: spec.source, said: 'replaced with new source' };
    }

    let text = source;
    const said: string[] = [];

    for (const edit of spec.edits ?? [])
    {
        if (typeof edit.find !== 'string' || edit.find === '' || !text.includes(edit.find))
        {
            throw new Error(`The shader's source does not contain «${G.String(edit.find).slice(0, 120)}», so that edit cannot be made. resource(handle) shows the source.`);
        }

        text = text.split(edit.find).join(G.String(edit.replace ?? ''));
        said.push(`«${edit.find.slice(0, 60)}» → «${G.String(edit.replace ?? '').slice(0, 60)}»`);
    }

    const names: string[] = G.Object.keys(spec.defines ?? {});

    if (names.length)
    {
        // After the #version line, which has to stay first.
        const lines = text.split('\n');
        const at = lines.findIndex((line) => line.trim().startsWith('#version')) + 1;

        lines.splice(at, 0, ...names.map((name) => `#define ${name} ${spec.defines![name]}`));
        text = lines.join('\n');
        said.push(...names.map((name) => `#define ${name} ${spec.defines![name]}`));
    }

    if (said.length === 0)
    {
        throw new Error('A shader patch needs source, edits or defines.');
    }

    return { text, said: said.join('; ') };
}

// A second program linked from a program's own shaders, with one of them changed: every
// attribute where it was, and uniform blocks bound where the page's are.
function linkShadow (info: ContextInfo, t: GlTracker, program: number, which: number | undefined, change: (source: string) => string): { shadow: unknown; uniforms: Map<string, ShadowUniform>; type: number; log: string }
{
    const n = info.natives;
    const gl = info.ctx;
    const { entry, object } = programOf(info, program);
    const shaders = (entry.p.shaders as number[]).map((id) => find('shader', id)).filter(G.Boolean) as Array<NonNullable<ReturnType<typeof find>>>;
    const target = which !== undefined ? shaders.find((shader) => shader.id === which) : shaders.find((shader) => shader.p.type === 0x8B30);

    if (!target)
    {
        throw new Error(which !== undefined ? `Shader ${which} is not one of this program's.` : 'This program has no fragment shader to patch. Name one of its shaders.');
    }

    const text = change(G.String(target.p.source ?? ''));
    const shadow = n.createProgram.call(gl);
    const logs: string[] = [];
    const made: unknown[] = [];

    for (const shader of shaders)
    {
        const result = compile(n, gl, shader.p.type, shader === target ? text : G.String(shader.p.source ?? ''));

        made.push(result.shader);

        if (!result.ok)
        {
            for (const other of made) { n.deleteShader.call(gl, other); }
            n.deleteProgram.call(gl, shadow);

            throw new Error(`The patched shader does not compile, so nothing was changed.\n${result.log}`);
        }

        if (result.log)
        {
            logs.push(result.log);
        }

        n.attachShader.call(gl, shadow, result.shader);
    }

    // Every attribute where it was, so the page's vertex arrays still feed the right ones.
    const attributes: number = n.getProgramParameter.call(gl, object, 0x8B89) ?? 0;

    for (let i = 0; i < attributes; i++)
    {
        const active = n.getActiveAttrib.call(gl, object, i);
        const location: number = active ? n.getAttribLocation.call(gl, object, active.name) : -1;

        if (active && location >= 0)
        {
            n.bindAttribLocation.call(gl, shadow, location, active.name);
        }
    }

    n.linkProgram.call(gl, shadow);

    for (const shader of made)
    {
        n.deleteShader.call(gl, shader);
    }

    if (!n.getProgramParameter.call(gl, shadow, 0x8B82))
    {
        const log = G.String(n.getProgramInfoLog.call(gl, shadow) ?? '').trim();

        n.deleteProgram.call(gl, shadow);

        throw new Error(`The patched program does not link, so nothing was changed.\n${log}`);
    }

    // Uniform blocks bound where the page's are.
    if (t.gl2)
    {
        const blocks: number = n.getProgramParameter.call(gl, shadow, 0x8A36) ?? 0;

        for (let i = 0; i < blocks; i++)
        {
            const name = n.getActiveUniformBlockName.call(gl, shadow, i);
            const own: number = n.getUniformBlockIndex.call(gl, object, name);

            if (own !== 0xFFFFFFFF)
            {
                n.uniformBlockBinding.call(gl, shadow, i, n.getActiveUniformBlockParameter.call(gl, object, own, 0x8A3F));
            }
        }
    }

    return { shadow, uniforms: uniformsOf(n, gl, shadow), type: target.p.type, log: logs.join('\n') };
}

function makeShadow (info: ContextInfo, t: GlTracker, patch: Patch, spec: any): string
{
    let said = '';

    const made = linkShadow(info, t, patch.program!, spec.shader, (source) =>
    {
        const change = edited(source, spec);

        said = change.said;

        return change.text;
    });

    patch.shadow = made.shadow;
    patch.uniforms = made.uniforms;
    patch.stale = true;
    patch.description = `${made.type === 0x8B30 ? 'fragment' : 'vertex'} shader of program ${patch.program}: ${said}`;

    return made.log;
}

// A fragment shader that runs the page's own and then writes one colour (or the
// fragment's depth) to every colour it writes. The page's main() is renamed and called
// from a new one, so a fragment the page's shader discards is still discarded.
export function solidSource (source: string, depth: boolean): string
{
    if (!/\bvoid\s+main\s*\(/.test(source))
    {
        throw new Error('The fragment shader has no main() to wrap.');
    }

    const value = depth ? 'vec4(vec3(gl_FragCoord.z), 1.0)' : 'scanlineSolid';
    const plain = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const writes: string[] = [];

    if (/^\s*#version\s+300\s+es/m.test(source))
    {
        const parts: Record<string, string> = { vec4: '', vec3: '.rgb', vec2: '.rg', float: '.r' };

        for (const found of plain.matchAll(/\bout\s+(?:(?:lowp|mediump|highp)\s+)?(vec4|vec3|vec2|float)\s+(\w+)\s*(\[[^\]]*\])?\s*;/g))
        {
            writes.push(`${found[2]}${found[3] ? '[0]' : ''} = (${value})${parts[found[1]]};`);
        }

        if (writes.length === 0)
        {
            throw new Error('The fragment shader writes no colour.');
        }
    }
    else
    {
        writes.push(/\bgl_FragData\b/.test(plain) ? `gl_FragData[0] = ${value};` : `gl_FragColor = ${value};`);
    }

    return `${source.replace(/\bvoid\s+main\s*\(/, 'void scanline_main(')}
uniform mediump vec4 scanlineSolid;
void main ()
{
    scanline_main();
    ${writes.join('\n    ')}
}
`;
}

function makeSolid (info: ContextInfo, t: GlTracker, program: number, depth: boolean): Solid
{
    const made = linkShadow(info, t, program, undefined, (source) => solidSource(source, depth));

    return { shadow: made.shadow, uniforms: made.uniforms, stale: true, colour: depth ? null : info.natives.getUniformLocation.call(info.ctx, made.shadow, 'scanlineSolid') };
}

function makeTexture (info: ContextInfo, t: GlTracker, kind: string, image?: { width: number; height: number; pixels: Uint8Array }): unknown
{
    const n = info.natives;
    const gl = info.ctx;
    const texture = n.createTexture.call(gl);
    const size = 64;

    n.activeTexture.call(gl, 0x84C0 + t.unit);
    n.bindTexture.call(gl, 0x0DE1, texture);

    // The page's unpack settings would bend the upload.
    const flip = n.getParameter.call(gl, 0x9240);
    const premultiply = n.getParameter.call(gl, 0x9241);

    n.pixelStorei.call(gl, 0x9240, false);
    n.pixelStorei.call(gl, 0x9241, false);

    const level = (at: number, colour: (x: number, y: number) => [number, number, number]): void =>
    {
        const edge = G.Math.max(1, size >> at);
        const data = new G.Uint8Array(edge * edge * 4) as Uint8Array;

        for (let y = 0; y < edge; y++)
        {
            for (let x = 0; x < edge; x++)
            {
                const [r, g, b] = colour(x, y);

                data.set([r, g, b, 255], (y * edge + x) * 4);
            }
        }

        n.texImage2D.call(gl, 0x0DE1, at, 0x1908, edge, edge, 0, 0x1908, 0x1401, data);
    };

    if (image)
    {
        // Rows from the top, as an image is: the first row is where t is 0.
        const power = (edge: number): boolean => (edge & (edge - 1)) === 0;

        n.texImage2D.call(gl, 0x0DE1, 0, 0x1908, image.width, image.height, 0, 0x1908, 0x1401, image.pixels);
        n.texParameteri.call(gl, 0x0DE1, 0x2801, 0x2601);

        if (!t.gl2 && !(power(image.width) && power(image.height)))
        {
            // WebGL 1 samples a texture of any other size only when it does not repeat.
            n.texParameteri.call(gl, 0x0DE1, 0x2802, 0x812F);
            n.texParameteri.call(gl, 0x0DE1, 0x2803, 0x812F);
        }
    }
    else if (kind === 'mips')
    {
        // Each level its own colour, so the level a draw samples shows on screen.
        const colours: Array<[number, number, number]> = [[255, 0, 0], [255, 128, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255]];

        for (let at = 0; (size >> at) >= 1; at++)
        {
            level(at, () => colours[at % colours.length]);
        }

        n.texParameteri.call(gl, 0x0DE1, 0x2801, 0x2703);
    }
    else
    {
        level(0, kind === 'white' ? () => [255, 255, 255] : (kind === 'black' ? () => [0, 0, 0] : (x, y) => (((x >> 3) + (y >> 3)) & 1 ? [255, 0, 255] : [24, 24, 24])));
        n.texParameteri.call(gl, 0x0DE1, 0x2801, 0x2600);
    }

    n.texParameteri.call(gl, 0x0DE1, 0x2800, image ? 0x2601 : 0x2600);
    n.pixelStorei.call(gl, 0x9240, flip);
    n.pixelStorei.call(gl, 0x9241, premultiply);
    n.bindTexture.call(gl, 0x0DE1, t.units[t.unit]?.t2d ?? null);

    return texture;
}

function filterSaid (filter: Filter): string
{
    const parts: string[] = [];

    if (filter.program !== undefined) { parts.push(`that use program ${filter.program}`); }
    if (filter.texture !== undefined) { parts.push(`with texture ${filter.texture} bound`); }
    if (filter.draws !== undefined) { parts.push(filter.draws[0] === filter.draws[1] ? `at event ${filter.draws[0]} of the frame` : `at events ${filter.draws[0]} to ${filter.draws[1]} of the frame`); }

    return parts.length ? `draws ${parts.join(' and ')}` : 'every draw';
}

function drop (state: Patched, patch: Patch): void
{
    const n = state.info.natives;
    const gl = state.info.ctx;
    const t = trackerFor(state.info);

    for (const solid of patch.solids?.values() ?? [])
    {
        if (solid)
        {
            n.deleteProgram.call(gl, solid.shadow);
        }
    }

    if (patch.view === 'overdraw' && t)
    {
        // Back to the colour the page last asked for.
        n.clearColor.call(gl, t.clearColor[0], t.clearColor[1], t.clearColor[2], t.clearColor[3]);
    }

    if (patch.view === 'wireframe')
    {
        n.getExtension.call(gl, 'WEBGL_polygon_mode')?.polygonModeWEBGL(0x0408, 0x1B02);
    }

    if (patch.kind === 'shader' && patch.shadow)
    {
        n.deleteProgram.call(gl, patch.shadow);
    }
    else if (patch.kind === 'texture' && patch.replacement)
    {
        n.deleteTexture.call(gl, patch.replacement);
    }
    else if (patch.kind === 'uniform' && patch.location && t)
    {
        // Back to what the page last gave it, if it ever did.
        const entry = find('program', patch.program!);
        const slot: UniformSlot | undefined = entry?.p.uniforms.get(patch.name) ?? entry?.p.uniforms.get(`${patch.name}[0]`);
        const object = entry?.ref.deref();

        if (slot && slot.set >= 0 && object)
        {
            withProgram(state.info, t, object, () => setUniform(n, gl, patch.location, patch.type!, slot.values));
        }
    }
}

export function installPatches (): void
{
    onFrameBegin(() =>
    {
        gpuPatchFrame();

        for (const state of patched.values())
        {
            state.seen = 0;
            state.clears = state.info.record.clears;
            state.blits = state.info.record.blits;

            for (const patch of state.patches)
            {
                patch.lastHits = patch.hits;
                patch.hits = 0;
            }
        }
    });

    expose('patch.add', (args: any) =>
    {
        // A WebGPU page is patched through its pipelines (gpu/patch.ts).
        if (contextById(args.context)?.api === 'webgpu' || (args.context === undefined && !allContexts().some((info) => trackerFor(info)) && allContexts().some((info) => info.api === 'webgpu')))
        {
            return gpuPatchAdd(args, nextId++);
        }

        const { info, t } = context(args.context);
        const filter: Filter = {};

        if (typeof args.filter?.program === 'number') { filter.program = args.filter.program; }
        if (typeof args.filter?.texture === 'number') { filter.texture = args.filter.texture; }

        if (G.Array.isArray(args.filter?.draws))
        {
            filter.draws = [G.Number(args.filter.draws[0]) || 0, G.Number(args.filter.draws[args.filter.draws.length - 1]) || 0];
        }
        else if (typeof args.filter?.draws === 'number')
        {
            filter.draws = [args.filter.draws, args.filter.draws];
        }

        const patch: Patch = { id: nextId++, kind: args.kind, context: info.id, description: '', filter, hits: 0, lastHits: 0 };

        let log = '';

        switch (args.kind)
        {
            case 'draws':
                if (args.mode === 'solid')
                {
                    const colour: number[] = G.Array.isArray(args.colour) && args.colour.length >= 3 ? [G.Number(args.colour[0]), G.Number(args.colour[1]), G.Number(args.colour[2]), G.Number(args.colour[3] ?? 1)] : [1, 0, 1, 1];

                    patch.mode = 'solid';
                    patch.colour = colour;
                    patch.solids = new G.Map();
                    const every = filterSaid(filter) === 'every draw';

                    patch.description = `${filterSaid(filter)} ${every ? 'is' : 'are'} drawn in one flat colour (${colour.join(', ')}); what ${every ? 'its shader discards' : 'their shaders discard'} is still discarded`;
                    break;
                }

                patch.mode = args.mode === 'isolate' ? 'isolate' : 'skip';
                patch.description = patch.mode === 'isolate' ? `only ${filterSaid(filter)} are drawn` : `${filterSaid(filter)} are not drawn`;
                break;

            case 'view':
                patch.view = G.String(args.view);

                switch (patch.view)
                {
                    case 'wireframe':
                    {
                        const mode = info.natives.getExtension.call(info.ctx, 'WEBGL_polygon_mode');

                        if (!mode)
                        {
                            throw new Error('This browser has no WEBGL_polygon_mode for this context, which the live wireframe view draws with. view(capture, view: "wireframe") draws it from a capture.');
                        }

                        mode.polygonModeWEBGL(0x0408, 0x1B01);
                        patch.description = 'every triangle is drawn as its outline';
                        break;
                    }

                    case 'overdraw':
                        patch.mode = 'solid';
                        patch.colour = [0.125, 0.045, 0.015, 0];
                        patch.state = { blend_add: true, depth_test: false, depth_write: false };
                        patch.solids = new G.Map();
                        info.natives.clearColor.call(info.ctx, 0, 0, 0, 1);
                        patch.description = 'overdraw: the frame is cleared to black and every draw adds a little orange where it lands, with the depth test off, so brighter is drawn more often (eight layers reach full red)';
                        break;

                    case 'draw_id':
                        patch.mode = 'solid';
                        patch.colour = 'draw';
                        patch.state = { blend: false };
                        patch.solids = new G.Map();
                        patch.description = 'each draw is drawn in a flat colour of its own, by its event number, with blending off';
                        break;

                    case 'depth':
                        patch.mode = 'solid';
                        patch.colour = 'depth';
                        patch.state = { blend: false };
                        patch.solids = new G.Map();
                        patch.description = 'each draw writes its depth as grey (near is dark, far is light), with blending off';
                        break;

                    default:
                        throw new Error(`There is no live "${patch.view}" view. On the running page: overdraw, wireframe, draw_id and depth, and the views the page registered. view(capture, view) has stencil, mip and nan.`);
                }

                break;

            case 'state':
            {
                const state = args.state ?? {};
                const said = (G.Object.keys(state) as string[]).map((key) => `${key.replace('_', ' ')} ${G.Array.isArray(state[key]) ? state[key].join(', ') : (state[key] === true ? 'on' : (state[key] === false ? 'off' : state[key]))}`);

                if (said.length === 0)
                {
                    throw new Error('A state patch needs state: any of blend, depth_test, depth_write, cull (true or false), color_mask ([r, g, b, a]) and scissor ([x, y, w, h] or false).');
                }

                patch.state = state;
                patch.description = `${filterSaid(filter)}: ${said.join('; ')}`;
                break;
            }

            case 'uniform':
            {
                const { object } = programOf(info, args.program);
                const uniform = uniformsOf(info.natives, info.ctx, object).get(G.String(args.name));

                if (!uniform || !uniform.location)
                {
                    throw new Error(`Program ${args.program} has no active uniform named "${args.name}". resource(handle) lists its uniforms.`);
                }

                patch.program = args.program;
                patch.name = G.String(args.name);
                const value: number[] = G.Array.from(args.value as ArrayLike<number>, G.Number);

                patch.value = value;
                patch.location = uniform.location;
                patch.type = uniform.type;
                patch.description = `uniform ${patch.name} of program ${patch.program} held at ${value.join(', ')}`;

                withProgram(info, t, object, () => setUniform(info.natives, info.ctx, patch.location, patch.type!, patch.value!));
                break;
            }

            case 'shader':
                patch.program = args.program;
                log = makeShadow(info, t, patch, args);
                break;

            case 'texture':
            {
                const entry = find('texture', args.texture);

                if (!entry || entry.context !== info.id || entry.destroyed)
                {
                    throw new Error(`There is no live texture ${args.texture} in this context.`);
                }

                // For an experiment that stands in for every texture at once: only those a
                // small colour texture can stand in for without changing what the frame does.
                if (args.plain)
                {
                    const format: number = entry.p.internalFormat;
                    const integer = (format >= 0x8231 && format <= 0x823C) || (format >= 0x8D70 && format <= 0x8D8F) || format === 0x906F;

                    if (entry.p.target !== 0x0DE1 || entry.p.renderTarget || !entry.p.width || isDepthFormat(format) || integer)
                    {
                        throw new Error('not a plain 2D colour texture');
                    }
                }

                const kind = ['checker', 'white', 'black', 'mips', 'file'].includes(args.with) ? args.with : 'checker';
                const image = kind === 'file' ? imageOf(args) : undefined;

                patch.texture = args.texture;
                patch.replacement = makeTexture(info, t, kind, image);
                patch.description = `texture ${args.texture} drawn as ${image ? `the ${image.width}×${image.height} image given` : (kind === 'mips' ? 'a texture whose mip levels are each a different colour' : (kind === 'checker' ? 'a checkerboard' : `plain ${kind}`))}${filter.program !== undefined || filter.draws !== undefined ? ` for ${filterSaid(filter)}` : ''}`;
                break;
            }

            default:
                throw new Error(`There is no "${args.kind}" patch.`);
        }

        let state = patched.get(info.id);

        if (!state)
        {
            state = { info, patches: [], seen: 0, clears: info.record.clears, blits: info.record.blits, restores: [] };
            patched.set(info.id, state);
        }

        state.patches.push(patch);
        wire(state);

        return { patch: patch.id, kind: patch.kind, context: info.id, description: patch.description, log };
    });

    expose('patch.list', () =>
    {
        const out: unknown[] = [];

        for (const state of patched.values())
        {
            for (const patch of state.patches)
            {
                out.push({
                    patch: patch.id,
                    kind: patch.kind,
                    context: patch.context,
                    description: patch.description,
                    draws: G.Math.max(patch.hits, patch.lastHits),
                    view: patch.view,
                    failure: patch.unmade ? `${patch.unmade} program${patch.unmade === 1 ? '' : 's'} could not be given a flat-colour stand-in and ${patch.unmade === 1 ? 'is' : 'are'} drawn as the page made ${patch.unmade === 1 ? 'it' : 'them'}` : undefined
                });
            }
        }

        out.push(...gpuPatchList());

        return { patches: out };
    });

    expose('patch.remove', (args: { patch?: number; all?: boolean; views?: boolean }) =>
    {
        const gone: number[] = gpuPatchRemove(args);

        for (const state of patched.values())
        {
            const keep: Patch[] = [];

            for (const patch of state.patches)
            {
                if (args.all || patch.id === args.patch || (args.views && patch.kind === 'view'))
                {
                    drop(state, patch);
                    gone.push(patch.id);
                }
                else
                {
                    keep.push(patch);
                }
            }

            state.patches = keep;
            wire(state);
        }

        return { removed: gone.length, ids: gone };
    });
}
