// Live patches: changes to how a running page draws, made from outside it and undone at will
// (03-INSPECTION.md, section 9).
//
// A patch never edits what the page owns. Draws pass through a gate (hooks/generated.ts):
// it can drop a draw, or change something just before the draw and put it back just after.
//
//   draws     drop the draws that match, or all but those that match
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
// WebGL only. A WebGPU pipeline cannot be changed, only replaced, which is not built.

import { onFrameBegin } from './clock/gate';
import { allContexts, contextById, type ContextInfo } from './contexts';
import { trackerFor, uniformWatch, type GlTracker, type UniformSlot } from './gl/tracker';
import { gpuPatchAdd, gpuPatchFrame, gpuPatchList, gpuPatchRemove } from './gpu/patch';
import type { Rec } from './hooks/hub';
import { G, type Fn } from './natives';
import { entryOf, find } from './registry';
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

interface Patch
{
    id: number;
    kind: 'draws' | 'state' | 'uniform' | 'shader' | 'texture';
    context: number;
    description: string;
    filter: Filter;

    mode?: 'skip' | 'isolate';
    state?: Record<string, unknown>;

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

// Gives the shadow program the values the page has given its own.
function sync (n: Record<string, Fn>, gl: unknown, patch: Patch): void
{
    const slots: Map<string, UniformSlot> | undefined = find('program', patch.program!)?.p.uniforms;

    for (const [name, slot] of slots ?? [])
    {
        const uniform = patch.uniforms!.get(name);

        if (uniform && uniform.location && slot.set >= 0)
        {
            setUniform(n, gl, uniform.location, uniform.type, slot.values);
        }
    }

    patch.stale = false;
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

    // Whether it is drawn at all comes first: nothing is changed for a draw that is dropped.
    let isolating = false;
    let isolated = false;

    for (const patch of state.patches)
    {
        if (patch.kind !== 'draws')
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
                    sync(n, gl, patch);
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
    const drawn = state.patches.some((patch) => patch.kind !== 'uniform');

    state.info.record.gate = drawn ? gate : null;

    if (!drawn)
    {
        state.info.record.after = null;
    }

    let watching = false;

    for (const other of patched.values())
    {
        watching = watching || other.patches.some((patch) => patch.kind === 'uniform' || patch.kind === 'shader');
    }

    uniformWatch.set = watching ? onUniform : null;
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

function makeShadow (info: ContextInfo, t: GlTracker, patch: Patch, spec: any): string
{
    const n = info.natives;
    const gl = info.ctx;
    const { entry, object } = programOf(info, patch.program!);
    const shaders = (entry.p.shaders as number[]).map((id) => find('shader', id)).filter(G.Boolean) as Array<NonNullable<ReturnType<typeof find>>>;
    const target = spec.shader !== undefined ? shaders.find((shader) => shader.id === spec.shader) : shaders.find((shader) => shader.p.type === 0x8B30);

    if (!target)
    {
        throw new Error(spec.shader !== undefined ? `Shader ${spec.shader} is not one of this program's.` : 'This program has no fragment shader to patch. Name one of its shaders.');
    }

    const change = edited(G.String(target.p.source ?? ''), spec);
    const shadow = n.createProgram.call(gl);
    const logs: string[] = [];
    const made: unknown[] = [];

    for (const shader of shaders)
    {
        const result = compile(n, gl, shader.p.type, shader === target ? change.text : G.String(shader.p.source ?? ''));

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

    patch.shadow = shadow;
    patch.uniforms = uniformsOf(n, gl, shadow);
    patch.stale = true;
    patch.description = `${target.p.type === 0x8B30 ? 'fragment' : 'vertex'} shader of program ${patch.program}: ${change.said}`;

    return logs.join('\n');
}

function makeTexture (info: ContextInfo, t: GlTracker, kind: string): unknown
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

    if (kind === 'mips')
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

    n.texParameteri.call(gl, 0x0DE1, 0x2800, 0x2600);
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
                patch.mode = args.mode === 'isolate' ? 'isolate' : 'skip';
                patch.description = patch.mode === 'isolate' ? `only ${filterSaid(filter)} are drawn` : `${filterSaid(filter)} are not drawn`;
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

                const kind = ['checker', 'white', 'black', 'mips'].includes(args.with) ? args.with : 'checker';

                patch.texture = args.texture;
                patch.replacement = makeTexture(info, t, kind);
                patch.description = `texture ${args.texture} drawn as ${kind === 'mips' ? 'a texture whose mip levels are each a different colour' : (kind === 'checker' ? 'a checkerboard' : `plain ${kind}`)}${filter.program !== undefined || filter.draws !== undefined ? ` for ${filterSaid(filter)}` : ''}`;
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
                out.push({ patch: patch.id, kind: patch.kind, context: patch.context, description: patch.description, draws: G.Math.max(patch.hits, patch.lastHits) });
            }
        }

        out.push(...gpuPatchList());

        return { patches: out };
    });

    expose('patch.remove', (args: { patch?: number; all?: boolean }) =>
    {
        let removed = gpuPatchRemove(args);

        for (const state of patched.values())
        {
            const keep: Patch[] = [];

            for (const patch of state.patches)
            {
                if (args.all || patch.id === args.patch)
                {
                    drop(state, patch);
                    removed++;
                }
                else
                {
                    keep.push(patch);
                }
            }

            state.patches = keep;
            wire(state);
        }

        return { removed };
    });
}
