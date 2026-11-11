// Live patches for WebGPU (04-AGENT-INTERFACE.md, section 3.7).
//
// A WebGPU draw takes its shader and nearly all of its state from its pipeline, and a
// pipeline cannot be changed once made. So a patch that edits a shader or overrides state
// builds a second pipeline, the shadow, from the page's own descriptor with the change
// made, and the draw gate swaps it in round each draw that uses the page's pipeline:
// setPipeline(shadow), draw, setPipeline(the page's). The page's objects are never touched.
//
// A pipeline with layout 'auto' has bind group layouts of its own, and a bind group made
// for the page's pipeline will not fit its shadow. For those, each bound group is made
// again for the shadow from the page's descriptor, and swapped in and out with it.
//
// To do any of this the probe has to know, at each draw, which pipeline and bind groups
// the pass has. It follows setPipeline, setBindGroup and setScissorRect, but only while a
// patch is in force.
//
// A flat colour, and the live views built on it, keep the page's fragment shader: a second
// entry point is written into its module that calls the page's own and then replaces the
// colour (shared/wgsl.ts), so the same resources are used and the same fragments discarded.
//
// A uniform is held by name: the reader of WGSL says where in which binding's buffer the
// name lives, each draw says which buffer that is, and the held bytes are written there
// again whenever the page writes the buffer.
//
// A shadow pipeline is checked by the browser before it is used. A draw made with an
// invalid pipeline would take the page's whole command buffer with it, so until the
// browser has answered, and if it says no, the draw is issued as the page made it.

import * as wgsl from '../../../shared/wgsl';
import { currentFrame } from '../clock/gate';
import { gpuTopology, hub, type Rec } from '../hooks/hub';
import { natives } from '../hooks/install';
import { G, nativeNow } from '../natives';
import { all, deviceFor, entryOf, find, gpuUse, type Entry } from '../registry';
import { imageOf } from '../standin';
import { recordIntercepted } from './rec';
import { bufferWatch, madeFromOf, noteCopyTo, viewOf, wholeWritten } from './tracker';

export interface GpuPatch
{
    id: number;
    kind: 'draws' | 'state' | 'shader' | 'texture' | 'view' | 'uniform';
    description: string;
    hits: number;
    lastHits: number;

    // Which draws: those of one pipeline, those at some of the frame's events, those that
    // have a texture in a bind group, or every draw.
    pipeline?: number;
    draws?: [number, number];
    sampled?: number;

    // solid: the colour, or 'draw' for one of each draw's own. Views add to what is there
    // (overdraw) and switch the depth test off.
    colour?: number[] | 'draw' | 'depth';
    additive?: boolean;

    // uniform: where the name lives, the bytes held there, and each place they have been written.
    name?: string;
    group?: number;
    binding?: number;
    offset?: number;
    bytes?: Uint8Array;
    held?: Held[];

    // draws
    mode?: 'skip' | 'isolate' | 'solid';

    // A live view (overdraw, draw_id): what it is called.
    view?: string;

    // state
    state?: Record<string, any>;

    // shader: the module replaced, and what replaces it
    module?: number;
    replacement?: object;

    // texture: the texture stood in for, and the view that stands in
    texture?: number;
    standIn?: object;
}

interface Held { buffer: object; offset: number; saved: Uint8Array | null }

const patches: GpuPatch[] = [];

// The frame's events so far, counted as a capture counts them: draws, bundles run,
// dispatches, passes that clear as they begin, and copies into a texture.
let events = 0;

// Why a patch could not be applied to some draw, if that has happened: the draw was issued
// as the page made it, and the list of patches says so.
let failure: string | null = null;

// Changes whenever the set of patches does: what was worked out for a pipeline under one
// set is not used under another.
let version = 0;

interface Bound { group: object; rest: unknown[] }

interface PassState
{
    pipeline: object | null;
    groups: Array<Bound | undefined>;
    scissor: number[] | null;
    blendConstant: unknown;
    size: [number, number] | null;
    swapped: Plan | null;
}

const passes = new G.WeakMap() as WeakMap<object, PassState>;

function stateOf (pass: object): PassState
{
    let state = passes.get(pass);

    if (!state)
    {
        state = { pipeline: null, groups: [], scissor: null, blendConstant: null, size: null, swapped: null };
        passes.set(pass, state);
    }

    return state;
}

// What to do with the draws of one pipeline.
interface Plan
{
    skip: boolean;
    shadow: object | null;
    auto: boolean;                        // the shadow has bind group layouts of its own
    textures: Map<number, object>;        // texture ID -> the view standing in for it
    scissor: number[] | null;
    perDraw: boolean;                     // each draw is given a colour of its own, as the blend constant
    hits: GpuPatch[];
    groups: WeakMap<object, Map<number, object | null>>;   // the page's group -> its shadow, by index
}

// What was worked out for one pipeline under one set of patches. `plan` is null while the
// browser is still checking a shadow, and for good if it said no.
interface Slot { plan: Plan | null; checking: Promise<string | null> | null }

const plans = new G.WeakMap() as WeakMap<object, { version: number; slots: Map<string, Slot> }>;

// Shader modules read, and the modules made from rewritten source, so each is done once.
const scanned = new G.Map() as Map<number, wgsl.Module | null>;
const written = new G.Map() as Map<string, object>;

function moduleOf (id: number): wgsl.Module | null
{
    if (!scanned.has(id))
    {
        let read: wgsl.Module | null = null;

        try
        {
            read = wgsl.scan(G.String(find('shader', id)?.p.source ?? ''));
        }
        catch
        {
            read = null;
        }

        scanned.set(id, read);
    }

    return scanned.get(id)!;
}

// A colour for an event, by its number: far apart for numbers that are close.
function colourOfDraw (index: number): number[]
{
    const hue = (index * 0.618033988749895) % 1;
    const part = (offset: number): number =>
    {
        const k = (offset + hue * 6) % 6;

        return 0.25 + 0.75 * G.Math.max(0, G.Math.min(1, G.Math.min(k, 4 - k)));
    };

    return [part(5), part(3), part(1), 1];
}

// ---- Descriptors, from the copies the tracker keeps ----

// A kept descriptor turned back into one the browser takes. References become the page's
// live objects; a texture view is made again from its texture. `swap` replaces objects.
// Objects the page has let go of that a pipeline or bind group still uses, made again
// from what the tracker kept: a shader module from its source, a layout or a sampler from
// its descriptor. The page's pipeline holds the GPU's own copy; only the page's handle on
// it has gone, and a handle is what a new descriptor needs.
const remade = new G.Map() as Map<string, object>;

function remake (kind: string, id: number, device: any, swap: Swap): object | undefined
{
    const key = `${kind}:${id}`;
    const cached = remade.get(key);

    if (cached)
    {
        return cached;
    }

    const entry = find(kind as any, id);
    let made: object | undefined;

    if (!entry || !device)
    {
        return undefined;
    }

    if (kind === 'shader' && typeof entry.p.source === 'string')
    {
        made = natives.GPUDevice.createShaderModule.call(device, { label: entry.label ?? undefined, code: entry.p.source });
    }
    else if (kind === 'sampler' && entry.p.descriptor !== undefined)
    {
        made = natives.GPUDevice.createSampler.call(device, revive(entry.p.descriptor, swap, device) ?? {});
    }
    else if (kind === 'layout' && entry.p.descriptor && entry.p.type === 'bind group')
    {
        made = natives.GPUDevice.createBindGroupLayout.call(device, revive(entry.p.descriptor, swap, device));
    }
    else if (kind === 'layout' && entry.p.descriptor && entry.p.type === 'pipeline')
    {
        made = natives.GPUDevice.createPipelineLayout.call(device, revive(entry.p.descriptor, swap, device));
    }

    if (made)
    {
        remade.set(key, made);
    }

    return made;
}

type Swap = (kind: string, id: number, view: boolean) => object | undefined;

function revive (value: any, swap: Swap, device?: any): any
{
    if (value === null || typeof value !== 'object')
    {
        return value ?? undefined;
    }

    if (G.Array.isArray(value))
    {
        return value.map((item: unknown) => revive(item, swap, device));
    }

    if (typeof value.ref === 'string' && typeof value.id === 'number')
    {
        const replaced = swap(value.ref, value.id, 'view' in value);

        if (replaced)
        {
            return replaced;
        }

        const object = find(value.ref, value.id)?.ref.deref() ?? remake(value.ref, value.id, device, swap);

        if (!object)
        {
            throw new G.Error(`the ${value.ref.replace('_', ' ')} it uses no longer exists`);
        }

        return 'view' in value ? natives.GPUTexture.createView.call(object, revive(value.view, swap, device)) : object;
    }

    if (typeof value.object === 'string')
    {
        if (value.object.startsWith('GPU'))
        {
            throw new G.Error(`it uses a ${value.object} that Scanline has no record of`);
        }

        return undefined;
    }

    const out: Record<string, unknown> = {};

    for (const key in value)
    {
        const member = revive(value[key], swap, device);

        if (member !== undefined)
        {
            out[key] = member;
        }
    }

    return out;
}

function usesModule (descriptor: any, module: number): boolean
{
    return descriptor?.vertex?.module?.id === module || descriptor?.fragment?.module?.id === module;
}

function matches (patch: GpuPatch, entry: Entry): boolean
{
    if (patch.kind === 'shader' && patch.pipeline === undefined)
    {
        return usesModule(entry.p.descriptor, patch.module!);
    }

    return patch.pipeline === undefined || patch.pipeline === entry.id;
}

// The textures a bind group holds views of, by ID.
const sampledBy = new G.WeakMap() as WeakMap<object, Set<number>>;

function samples (state: PassState, texture: number): boolean
{
    for (const bound of state.groups)
    {
        if (!bound)
        {
            continue;
        }

        let held = sampledBy.get(bound.group);

        if (!held)
        {
            held = new G.Set() as Set<number>;

            for (const entry of madeFromOf(bound.group)?.entries ?? [])
            {
                const id = entry?.resource ? viewOf(entry.resource)?.texture?.id : undefined;

                if (id !== undefined)
                {
                    held.add(id);
                }
            }

            sampledBy.set(bound.group, held);
        }

        if (held.has(texture))
        {
            return true;
        }
    }

    return false;
}

// Whether a patch applies to one draw: its pipeline, its place in the frame, what it samples.
function applies (patch: GpuPatch, entry: Entry, index: number, state: PassState): boolean
{
    return matches(patch, entry)
        && (patch.draws === undefined || (index >= patch.draws[0] && index <= patch.draws[1]))
        && (patch.sampled === undefined || samples(state, patch.sampled));
}

// The page's pipeline descriptor with the patches' changes made.
function shadowDescriptor (entry: Entry, hits: GpuPatch[], device: any): any
{
    const modules = new G.Map() as Map<number, object>;

    for (const patch of hits)
    {
        if (patch.kind === 'shader')
        {
            modules.set(patch.module!, patch.replacement!);
        }
    }

    // The page's own layout and modules, where it has let go of them but the pipeline has not.
    const pipeline = entry.ref.deref();
    const sources = pipeline ? madeFromOf(pipeline) : undefined;
    const kept: object[] = sources ? [sources.layout, ...sources.modules].filter((object: unknown) => object && typeof object === 'object') : [];

    const descriptor = revive(entry.p.descriptor, (kind, id) =>
    {
        if (kind === 'shader' && modules.has(id))
        {
            return modules.get(id);
        }

        return kept.find((object) =>
        {
            const known = entryOf(object);

            return known?.kind === kind && known.id === id;
        });
    }, device);

    descriptor.label = `${descriptor.label ?? ''} (Scanline patch)`.trim();

    // A flat colour: the page's fragment stage, called by an entry point that then writes
    // the colour. The last such patch is the one that shows.
    const solid = hits.filter((patch) => patch.colour !== undefined).pop();

    if (solid)
    {
        const stage = entry.p.descriptor?.fragment;
        const module = stage?.module ? moduleOf(stage.module.id) : null;
        const fn = module ? wgsl.entryPoint(module, 'fragment', stage.entryPoint ?? null) : null;
        const source = module && fn ? wgsl.fragmentWriting(module, fn, null, solid.colour === 'draw' ? [1, 1, 1, 1] : solid.colour as number[] | 'depth') : null;

        if (!source)
        {
            throw new G.Error(stage ? 'its fragment shader could not be given an entry point that writes a flat colour' : 'it has no fragment stage, so it writes no colour');
        }

        let made = written.get(source);

        if (!made)
        {
            made = natives.GPUDevice.createShaderModule.call(device, { label: 'Scanline: a flat colour', code: source }) as object;
            written.set(source, made);
        }

        const replace = { srcFactor: 'one', dstFactor: 'zero', operation: 'add' };
        const add = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
        const blend = solid.additive
            ? { color: add, alpha: add }
            : (solid.colour === 'draw' ? { color: { srcFactor: 'constant', dstFactor: 'zero', operation: 'add' }, alpha: replace } : undefined);

        descriptor.fragment = {
            ...descriptor.fragment,
            module: made,
            entryPoint: wgsl.FRAGMENT_ENTRY,
            targets: G.Array.from(descriptor.fragment.targets ?? [], (target: any) =>
            {
                if (!target)
                {
                    return target;
                }

                const next = { ...target, writeMask: 0xF };

                if (blend)
                {
                    next.blend = blend;
                }
                else if (solid.view !== undefined)
                {
                    delete next.blend;
                }

                return next;
            })
        };

        if (solid.additive && descriptor.depthStencil)
        {
            descriptor.depthStencil = { ...descriptor.depthStencil, depthCompare: 'always', depthWriteEnabled: false };
        }
    }

    for (const patch of hits)
    {
        const state = patch.kind === 'state' ? patch.state! : null;

        if (!state)
        {
            continue;
        }

        if (state.cull === false)
        {
            descriptor.primitive = { ...descriptor.primitive, cullMode: 'none' };
        }

        if (descriptor.depthStencil)
        {
            if (state.depth_test === false)
            {
                descriptor.depthStencil = { ...descriptor.depthStencil, depthCompare: 'always' };
            }

            if (state.depth_write !== undefined)
            {
                descriptor.depthStencil = { ...descriptor.depthStencil, depthWriteEnabled: Boolean(state.depth_write) };
            }
        }

        if (descriptor.fragment?.targets && (state.blend !== undefined || state.color_mask))
        {
            descriptor.fragment = {
                ...descriptor.fragment,
                targets: descriptor.fragment.targets.map((target: any) =>
                {
                    if (!target)
                    {
                        return target;
                    }

                    const next = { ...target };

                    if (state.blend === false)
                    {
                        delete next.blend;
                    }
                    else if (state.blend === true && !next.blend)
                    {
                        const alpha = { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' };

                        next.blend = { color: alpha, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
                    }

                    if (state.color_mask)
                    {
                        const [r, g, b, a] = state.color_mask;

                        next.writeMask = (r ? 1 : 0) | (g ? 2 : 0) | (b ? 4 : 0) | (a ? 8 : 0);
                    }

                    return next;
                })
            };
        }
    }

    return descriptor;
}

// The patches that apply to every draw of a pipeline, whatever its place in the frame.
function always (entry: Entry): GpuPatch[]
{
    return patches.filter((patch) => matches(patch, entry) && patch.draws === undefined && patch.sampled === undefined);
}

function slotFor (pipeline: object, entry: Entry, hits: GpuPatch[]): Slot
{
    let cached = plans.get(pipeline);

    if (!cached || cached.version !== version)
    {
        cached = { version, slots: new G.Map() };
        plans.set(pipeline, cached);
    }

    const key = hits.map((patch) => patch.id).join(',');
    const known = cached.slots.get(key);

    if (known)
    {
        return known;
    }

    const slot: Slot = { plan: null, checking: null };
    const device = deviceFor(pipeline) as any;

    cached.slots.set(key, slot);

    let plan: Plan | null = null;

    device?.pushErrorScope('validation');

    try
    {
        plan = makePlan(pipeline, entry, hits);
    }
    catch (error: any)
    {
        // A pipeline that cannot be rebuilt is drawn as the page made it.
        plan = null;
        failure = `a pipeline could not be rebuilt: ${G.String(error?.message ?? error).slice(0, 200)}`;
    }

    const scope: Promise<any> = device ? device.popErrorScope() : G.Promise.resolve(null);

    if (!plan || !plan.shadow)
    {
        // Nothing for the browser to check.
        slot.plan = plan;

        return slot;
    }

    const made = plan;

    slot.checking = scope.then((error: any) =>
    {
        slot.checking = null;

        if (error)
        {
            failure = `a rebuilt pipeline is not valid, so its draws are issued as the page made them: ${G.String(error.message).slice(0, 300)}`;

            return G.String(error.message).slice(0, 600);
        }

        slot.plan = made;

        return null;
    }, () => null);

    return slot;
}

function makePlan (pipeline: object, entry: Entry, hits: GpuPatch[]): Plan | null
{
    if (entry.p.type !== 'render')
    {
        return null;
    }

    const isolating = patches.some((patch) => patch.kind === 'draws' && patch.mode === 'isolate');

    if (hits.length === 0 && !isolating)
    {
        return null;
    }

    const plan: Plan = { skip: false, shadow: null, auto: false, textures: new G.Map(), scissor: null, perDraw: false, hits, groups: new G.WeakMap() };

    if (hits.some((patch) => patch.kind === 'draws' && patch.mode === 'skip'))
    {
        plan.skip = true;
    }

    // With draws isolated, everything they do not name is left out.
    if (isolating && !hits.some((patch) => patch.kind === 'draws' && patch.mode === 'isolate'))
    {
        plan.skip = true;
    }

    if (plan.skip)
    {
        return plan;
    }

    for (const patch of hits)
    {
        if (patch.kind === 'texture')
        {
            plan.textures.set(patch.texture!, patch.standIn!);
        }

        if (patch.kind === 'state' && G.Array.isArray(patch.state!.scissor))
        {
            plan.scissor = patch.state!.scissor;
        }
    }

    const rebuilt = hits.some((patch) => patch.kind === 'shader' || patch.colour !== undefined || (patch.kind === 'state' && G.Object.keys(patch.state!).some((key: string) => key !== 'scissor')));

    if (rebuilt)
    {
        const device = deviceFor(pipeline) as any;

        plan.shadow = natives.GPUDevice.createRenderPipeline.call(device, shadowDescriptor(entry, hits, device));
        plan.auto = entry.p.descriptor?.layout === 'auto';
        plan.perDraw = hits.filter((patch) => patch.colour !== undefined).pop()?.colour === 'draw';
    }

    return plan;
}

// A bind group for the shadow pipeline that holds what the page's group holds. Null when
// the page's own group will do.
function shadowGroup (plan: Plan, pipeline: object, index: number, group: object): object | null
{
    let made = plan.groups.get(group);

    if (!made)
    {
        made = new G.Map() as Map<number, object | null>;
        plan.groups.set(group, made);
    }

    if (made.has(index))
    {
        return made.get(index)!;
    }

    let shadow: object | null = null;

    try
    {
        const sources = madeFromOf(group);
        const standIn = (resource: any): object | undefined => plan.textures.get(viewOf(resource)?.texture?.id ?? -1);
        const sampled = plan.textures.size > 0 && sources?.entries.some((entry: any) => entry.resource && standIn(entry.resource));

        if (sources && ((plan.shadow && plan.auto) || sampled))
        {
            // From the page's own resources: the same buffers, samplers and views, but
            // for a stand-in texture, in a group laid out for the shadow pipeline.
            shadow = natives.GPUDevice.createBindGroup.call(deviceFor(pipeline) as any, {
                label: `${sources.label ?? ''} (Scanline patch)`.trim(),
                layout: plan.shadow && plan.auto ? natives.GPURenderPipeline.getBindGroupLayout.call(plan.shadow, index) : sources.layout,
                entries: sources.entries.map((entry: any) => ({ binding: entry.binding, resource: (entry.resource && standIn(entry.resource)) || entry.resource }))
            });
        }
        else if (!sources && plan.shadow && plan.auto)
        {
            failure = 'a bind group made before Scanline could follow it cannot be remade for a rebuilt pipeline';
        }
    }
    catch (error: any)
    {
        shadow = null;
        failure = `a bind group could not be remade for a rebuilt pipeline: ${G.String(error?.message ?? error).slice(0, 200)}`;
    }

    made.set(index, shadow);

    return shadow;
}

// ---- The gate round every draw ----

function gate (_c: Rec, pass: any): boolean
{
    // Its number among the frame's events, whether or not anything is done to it. The
    // draws of a bundle are one event.
    const index = unbundling >= 0 ? unbundling : events++;
    const state = passes.get(pass);
    const entry = state?.pipeline ? entryOf(state.pipeline) : undefined;

    if (!state || !state.pipeline || !entry)
    {
        return true;
    }

    const hits = patches.filter((patch) => applies(patch, entry, index, state));

    for (const patch of hits)
    {
        patch.hits++;

        if (patch.kind === 'uniform')
        {
            hold(patch, state);
        }
    }

    const plan = slotFor(state.pipeline, entry, hits).plan;

    if (plan === null)
    {
        return true;
    }

    if (plan.skip)
    {
        return false;
    }

    const n = natives.GPURenderPassEncoder;
    let swapped = false;

    if (plan.shadow)
    {
        n.setPipeline.call(pass, plan.shadow);
        swapped = true;

        if (plan.perDraw)
        {
            n.setBlendConstant.call(pass, colourOfDraw(index));
        }
    }

    if ((plan.shadow && plan.auto) || plan.textures.size > 0)
    {
        for (let index = 0; index < state.groups.length; index++)
        {
            const bound = state.groups[index];
            const shadow = bound ? shadowGroup(plan, state.pipeline, index, bound.group) : null;

            if (shadow)
            {
                n.setBindGroup.call(pass, index, shadow, ...bound!.rest);
                swapped = true;
            }
        }
    }

    // A scissor box can only be put back if the probe knows what to put back.
    if (plan.scissor && (state.scissor || state.size))
    {
        const [x, y, width, height] = plan.scissor;
        const [most, tallest] = state.size ?? [x + width, y + height];

        n.setScissorRect.call(pass, G.Math.min(x, most - 1), G.Math.min(y, tallest - 1), G.Math.min(width, most - x), G.Math.min(height, tallest - y));
        swapped = true;
    }

    state.swapped = swapped ? plan : null;

    return true;
}

function after (_c: Rec, pass: any): void
{
    const state = passes.get(pass);
    const plan = state?.swapped;

    if (!state || !plan)
    {
        return;
    }

    const n = natives.GPURenderPassEncoder;

    state.swapped = null;

    if (plan.shadow)
    {
        n.setPipeline.call(pass, state.pipeline);

        if (plan.perDraw)
        {
            n.setBlendConstant.call(pass, state.blendConstant ?? [0, 0, 0, 0]);
        }
    }

    if ((plan.shadow && plan.auto) || plan.textures.size > 0)
    {
        for (let index = 0; index < state.groups.length; index++)
        {
            const bound = state.groups[index];

            if (bound && plan.groups.get(bound.group)?.get(index))
            {
                n.setBindGroup.call(pass, index, bound.group, ...bound.rest);
            }
        }
    }

    if (plan.scissor && (state.scissor || state.size))
    {
        const [x, y, width, height] = state.scissor ?? [0, 0, state.size![0], state.size![1]];

        n.setScissorRect.call(pass, x, y, width, height);
    }
}

function wire (): void
{
    version++;
    failure = null;
    hub.gpu.gate = patches.length > 0 ? gate : null;
    hub.gpu.after = patches.length > 0 ? after : null;
    bufferWatch.written = patches.some((patch) => patch.kind === 'uniform') ? onBufferWritten : null;
}

// ---- A uniform held by name ----

// The offsets given with a bind group go, in order, to the bindings that take one.
function movedBy (bound: Bound, sources: any, binding: number): number
{
    const layout = sources?.layout ? entryOf(sources.layout) : undefined;
    const moving: number[] = (layout?.p.descriptor?.entries ?? [])
        .filter((entry: any) => entry?.buffer?.hasDynamicOffset)
        .map((entry: any) => G.Number(entry.binding))
        .sort((a: number, b: number) => a - b);
    const at = moving.indexOf(binding);
    const given: any = bound.rest[0];

    if (at < 0 || !given)
    {
        return 0;
    }

    return G.Number(given[at + (G.Number(bound.rest[1]) || 0)]) || 0;
}

function writeHeld (patch: GpuPatch, held: Held, bytes: Uint8Array): void
{
    const device = deviceFor(held.buffer) as any;

    if (device)
    {
        natives.GPUQueue.writeBuffer.call(device.queue, held.buffer, held.offset, bytes);
    }

    void patch;
}

// At a draw the patch applies to: finds the buffer its name lives in, keeps what is there
// and writes the held value over it.
function hold (patch: GpuPatch, state: PassState): void
{
    const bound = state.groups[patch.group!];
    const sources = bound ? madeFromOf(bound.group) : undefined;
    const resource = sources?.entries.find((entry: any) => entry.binding === patch.binding)?.resource;
    const buffer: any = resource?.buffer;

    if (!bound || !buffer)
    {
        return;
    }

    const offset = (G.Number(resource.offset) || 0) + movedBy(bound, sources, patch.binding!) + patch.offset!;

    if (patch.held!.some((held) => held.buffer === buffer && held.offset === offset))
    {
        return;
    }

    const held: Held = { buffer, offset, saved: null };
    const device = deviceFor(buffer) as any;
    const size = patch.bytes!.length;

    patch.held!.push(held);

    // What the page had there, read before it is written over, for when the patch is undone.
    if (device && (buffer.usage & 0x0004) !== 0 && offset + size <= buffer.size)
    {
        try
        {
            const copy = natives.GPUDevice.createBuffer.call(device, { label: 'Scanline: a held uniform, as it was', size, usage: 0x0001 | 0x0008 });
            const encoder = natives.GPUDevice.createCommandEncoder.call(device);

            natives.GPUCommandEncoder.copyBufferToBuffer.call(encoder, buffer, offset, copy, 0, size);
            natives.GPUQueue.submit.call(device.queue, [natives.GPUCommandEncoder.finish.call(encoder)]);

            natives.GPUBuffer.mapAsync.call(copy, 0x0001).then(() =>
            {
                // Unless the page has written it since, which is newer.
                held.saved ??= new G.Uint8Array(natives.GPUBuffer.getMappedRange.call(copy)).slice();
                natives.GPUBuffer.unmap.call(copy);
                natives.GPUBuffer.destroy.call(copy);
            }, () => undefined);
        }
        catch
        {
            // It goes back to whatever the page next writes.
        }
    }

    writeHeld(patch, held, patch.bytes!);
}

// The page has written a buffer (or unmapped it). What it wrote is what to put back when
// the patch is undone; for now, the held value goes over it again.
function onBufferWritten (buffer: object, offset?: number, data?: any, dataOffset?: number, size?: number): void
{
    for (const patch of patches)
    {
        for (const held of patch.held ?? [])
        {
            if (held.buffer !== buffer)
            {
                continue;
            }

            const length = patch.bytes!.length;

            if (data && typeof offset === 'number')
            {
                try
                {
                    const view = G.ArrayBuffer.isView(data);
                    const each: number = view ? (data.BYTES_PER_ELEMENT ?? 1) : 1;
                    const all = view ? new G.Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new G.Uint8Array(data);
                    const start = (dataOffset ?? 0) * each;
                    const span = size === undefined ? all.length - start : size * each;
                    const from = held.offset - offset;

                    if (from >= 0 && from + length <= span)
                    {
                        held.saved = all.slice(start + from, start + from + length);
                    }
                }
                catch
                {
                    // What was kept before stands.
                }
            }

            writeHeld(patch, held, patch.bytes!);
        }
    }
}

// The bytes of a value of one leaf's type.
function encode (leaf: wgsl.Leaf, values: number[]): Uint8Array
{
    if (leaf.scalar === 'f16')
    {
        throw new G.Error('A 16-bit float uniform cannot be held yet.');
    }

    if (values.length !== leaf.columns * leaf.rows)
    {
        throw new G.Error(`${leaf.name} is a ${leaf.type}, which takes ${leaf.columns * leaf.rows} number${leaf.columns * leaf.rows === 1 ? '' : 's'}, and ${values.length} ${values.length === 1 ? 'was' : 'were'} given.`);
    }

    const bytes = new G.Uint8Array((leaf.columns - 1) * leaf.stride + leaf.rows * 4) as Uint8Array;
    const view = new G.DataView(bytes.buffer) as DataView;

    for (let column = 0; column < leaf.columns; column++)
    {
        for (let row = 0; row < leaf.rows; row++)
        {
            const at = column * leaf.stride + row * 4;
            const value = values[column * leaf.rows + row];

            if (leaf.scalar === 'f32') { view.setFloat32(at, value, true); }
            else if (leaf.scalar === 'i32') { view.setInt32(at, value, true); }
            else { view.setUint32(at, value, true); }
        }
    }

    return bytes;
}

// Where a name lives among the uniform buffers a pipeline's shaders declare.
function uniformNamed (entry: Entry, name: string): { group: number; binding: number; leaf: wgsl.Leaf }
{
    const found = new G.Map() as Map<string, { group: number; binding: number; leaf: wgsl.Leaf }>;
    const known: string[] = [];

    for (const stage of [entry.p.descriptor?.vertex, entry.p.descriptor?.fragment])
    {
        const module = typeof stage?.module?.id === 'number' ? moduleOf(stage.module.id) : null;

        for (const global of module?.globals.values() ?? [])
        {
            if (global.space !== 'uniform' || global.group === null || global.binding === null)
            {
                continue;
            }

            let leaves: wgsl.Leaf[] = [];

            try
            {
                leaves = wgsl.layout(module!, global, 4096).leaves;
            }
            catch
            {
                continue;
            }

            for (const leaf of leaves)
            {
                if (!known.includes(leaf.name))
                {
                    known.push(leaf.name);
                }

                if (leaf.name === name || leaf.name.endsWith(`.${name}`))
                {
                    found.set(`${global.group}:${global.binding}:${leaf.offset}`, { group: global.group, binding: global.binding, leaf });
                }
            }
        }
    }

    const all = [...found.values()];

    if (all.length === 1)
    {
        return all[0];
    }

    if (all.length > 1)
    {
        throw new G.Error(`"${name}" is more than one uniform of this pipeline: ${all.map((one) => one.leaf.name).join(', ')}. Give the whole name.`);
    }

    throw new G.Error(known.length
        ? `This pipeline's shaders declare no uniform named "${name}". They have: ${known.slice(0, 24).join(', ')}${known.length > 24 ? ', …' : ''}.`
        : 'No uniform buffer could be read from this pipeline\'s shaders.');
}

// A pipeline's topology as the WebGL mode it corresponds to, with its registry entry,
// worked out once.
const known = new G.WeakMap() as WeakMap<object, { mode: number; entry: Entry | undefined }>;
const MODES: Record<string, number> = { 'point-list': 0, 'line-list': 1, 'line-strip': 3, 'triangle-list': 4, 'triangle-strip': 5 };

function knownPipeline (pipeline: object): { mode: number; entry: Entry | undefined }
{
    let found = known.get(pipeline);

    if (found === undefined)
    {
        const entry = entryOf(pipeline);

        found = { mode: MODES[G.String(entry?.p.descriptor?.primitive?.topology ?? 'triangle-list')] ?? -1, entry };
        known.set(pipeline, found);
    }

    return found;
}

// Notes an object as used in the frame under way. Called only on the frames use is sampled on.
function noteUsed (object: unknown): void
{
    const entry = object && typeof object === 'object' ? entryOf(object) : undefined;

    if (entry)
    {
        entry.used = gpuUse.frame;
    }
}

// A texture, buffer or sampler is used when a bind group that holds it is. That is worked
// out when the inventory is read, not while the page draws.
export function gpuPropagateUse (): void
{
    const visit = (value: any, frame: number, depth: number): void =>
    {
        if (!value || typeof value !== 'object' || depth > 6)
        {
            return;
        }

        if (G.Array.isArray(value))
        {
            for (const item of value)
            {
                visit(item, frame, depth + 1);
            }

            return;
        }

        if (typeof value.ref === 'string' && typeof value.id === 'number')
        {
            const entry = find(value.ref, value.id);

            if (entry && entry.kind !== 'layout' && entry.used < frame)
            {
                entry.used = frame;
            }

            return;
        }

        for (const key in value)
        {
            visit(value[key], frame, depth + 1);
        }
    };

    // Bundles first: a bind group a bundle sets is then followed to what it holds.
    for (const kind of ['bundle', 'bind_group'] as const)
    {
        for (const entry of all(kind))
        {
            if (entry.used >= 0)
            {
                visit(kind === 'bundle' ? entry.p.commands : entry.p.descriptor?.entries, entry.used, 0);
            }
        }
    }
}

// ---- What a pass has set, followed while a patch is in force ----

type Post = (record: Rec, self: any, result: any, ...args: any[]) => void;

export const gpuPatchHandlers: Record<string, Post> = {

    'GPURenderPassEncoder.setPipeline' (_c, pass, _result, pipeline)
    {
        // Always: what the draws that follow are made of, for the frame's triangle count.
        const found = knownPipeline(pipeline);

        gpuTopology.mode = found.mode;

        if (gpuUse.sampling && found.entry)
        {
            found.entry.used = gpuUse.frame;
        }

        if (patches.length > 0)
        {
            stateOf(pass).pipeline = pipeline;
        }
    },

    'GPURenderPassEncoder.setBindGroup' (_c, pass, _result, index, group, a, b, c)
    {
        if (gpuUse.sampling)
        {
            noteUsed(group);
        }

        if (patches.length > 0)
        {
            const rest = c !== undefined ? [a, b, c] : (a !== undefined ? [a] : []);

            stateOf(pass).groups[index] = group ? { group, rest } : undefined;
        }
    },

    'GPURenderPassEncoder.setScissorRect' (_c, pass, _result, x, y, width, height)
    {
        if (patches.length > 0)
        {
            stateOf(pass).scissor = [x, y, width, height];
        }
    },

    'GPURenderPassEncoder.setBlendConstant' (_c, pass, _result, colour)
    {
        if (patches.length > 0)
        {
            stateOf(pass).blendConstant = colour;
        }
    },

    'GPURenderPassEncoder.setVertexBuffer' (_c, _pass, _result, _slot, buffer)
    {
        if (gpuUse.sampling)
        {
            noteUsed(buffer);
        }
    },

    'GPURenderPassEncoder.setIndexBuffer' (_c, _pass, _result, buffer)
    {
        if (gpuUse.sampling)
        {
            noteUsed(buffer);
        }
    },

    'GPUComputePassEncoder.setPipeline' (_c, _pass, _result, pipeline)
    {
        if (gpuUse.sampling)
        {
            noteUsed(pipeline);
        }
    },

    'GPUComputePassEncoder.setBindGroup' (_c, _pass, _result, _index, group)
    {
        if (gpuUse.sampling)
        {
            noteUsed(group);
        }
    },

    // The rest are events of the frame, counted so that a patch can name a draw by its number.
    'GPUComputePassEncoder.dispatchWorkgroups' ()
    {
        events++;
    },

    'GPUComputePassEncoder.dispatchWorkgroupsIndirect' ()
    {
        events++;
    },

    'GPUCommandEncoder.copyTextureToTexture' (_c, _encoder, _result, _source, destination)
    {
        events++;
        noteCopyTo(destination);
    },

    'GPUCommandEncoder.copyBufferToTexture' (_c, _encoder, _result, _source, destination)
    {
        events++;
        noteCopyTo(destination);
    },

    'GPUCommandEncoder.copyBufferToBuffer' (_c, _encoder, _result, _source, _from, destination)
    {
        wholeWritten(destination);
    }
};

// A call a bundle recorded, with the page's live objects in place of the references kept.
// Null when one of them has gone.
function liveCall (given: unknown[]): unknown[] | null
{
    const out: unknown[] = [];

    for (const value of given as any[])
    {
        if (value && typeof value === 'object' && typeof value.ref === 'string' && typeof value.id === 'number')
        {
            const object = find(value.ref, value.id)?.ref.deref();

            if (!object)
            {
                return null;
            }

            out.push(object);
        }
        else
        {
            out.push(value ?? undefined);
        }
    }

    return out;
}

// The event number the draws of a bundle being issued one by one all share, or -1.
let unbundling = -1;

export const gpuPatchIntercepts: Record<string, (self: any, native: (...args: any[]) => unknown, args: IArguments) => unknown> = {

    // A bundle's pipelines were set when it was built, so a patch cannot reach its draws
    // as a bundle. While a patch is in force, what the bundle recorded is issued on the
    // pass instead, call by call, through the same wrappers the page's own calls go
    // through: the gate sees each draw. It draws the same.
    'GPURenderPassEncoder.executeBundles' (pass, native, args)
    {
        const c = hub.gpu;
        const index = events++;

        c.calls++;

        let calls: Array<[string, unknown[]]> | null = patches.length > 0 ? [] : null;
        const counted: any[] = [];

        try
        {
            for (const bundle of G.Array.from(args[0] as Iterable<object> ?? []))
            {
                const entry = entryOf(bundle);

                if (entry && gpuUse.sampling)
                {
                    entry.used = gpuUse.frame;
                }

                if (entry?.p.counts)
                {
                    counted.push(entry.p.counts);
                }

                for (const [name, given] of (calls && entry ? entry.p.commands : []) as Array<[string, unknown[]]>)
                {
                    const live = liveCall(given);

                    if (!live)
                    {
                        calls = null;
                        break;
                    }

                    calls!.push([name, live]);
                }

                if (!entry)
                {
                    calls = null;
                }
            }
        }
        catch
        {
            calls = null;
        }

        if (calls === null)
        {
            const result = native.apply(pass, args as any);

            // What the bundles draw is counted in the frame they run in.
            for (const counts of counted)
            {
                c.draws += counts.draws;
                c.instances += counts.instances;
                c.vertices += counts.vertices;
                c.triangles += counts.triangles;
            }

            recordIntercepted('GPURenderPassEncoder.executeBundles', pass, result, args);

            return result;
        }

        const wrapped = G.GPURenderPassEncoder.prototype;

        unbundling = index;

        try
        {
            for (const [name, live] of calls)
            {
                wrapped[name].apply(pass, live);
            }
        }
        finally
        {
            unbundling = -1;
        }

        // As a bundle leaves it: nothing set.
        const state = passes.get(pass);

        if (state)
        {
            state.pipeline = null;
            state.groups = [];
        }

        return undefined;
    }
};

// Whether a render pass clears anything as it begins, which makes it an event.
function clears (descriptor: any): boolean
{
    try
    {
        const depth = descriptor?.depthStencilAttachment;

        return G.Array.from(descriptor?.colorAttachments ?? []).some((attachment: any) => attachment?.loadOp === 'clear') || depth?.depthLoadOp === 'clear' || depth?.stencilLoadOp === 'clear';
    }
    catch
    {
        return false;
    }
}

// The descriptor a render pass is begun with. While the overdraw view is on, a pass that
// clears a colour clears it to black, so that the count starts from nothing.
export function gpuPassGiven (descriptor: any): any
{
    if (!patches.some((patch) => patch.additive) || !descriptor || typeof descriptor !== 'object')
    {
        return descriptor;
    }

    try
    {
        return {
            ...descriptor,
            colorAttachments: G.Array.from(descriptor.colorAttachments ?? [], (attachment: any) => (attachment && attachment.loadOp === 'clear' ? { ...attachment, clearValue: [0, 0, 0, 1] } : attachment))
        };
    }
    catch
    {
        return descriptor;
    }
}

// Called as a render pass begins: how large its targets are, for putting a scissor box back.
export function gpuPassBegan (pass: object, descriptor: any): void
{
    // What a pass draws to is used by it.
    if (gpuUse.sampling)
    {
        try
        {
            for (const attachment of [...G.Array.from(descriptor?.colorAttachments ?? []), descriptor?.depthStencilAttachment] as any[])
            {
                for (const view of [attachment?.view, attachment?.resolveTarget])
                {
                    const texture = view ? viewOf(view)?.texture : undefined;

                    if (texture)
                    {
                        texture.used = gpuUse.frame;
                    }
                }
            }
        }
        catch
        {
            // A descriptor the probe cannot read is the page's business.
        }
    }

    if (patches.length === 0 || !pass)
    {
        return;
    }

    if (clears(descriptor))
    {
        events++;
    }

    try
    {
        const view = descriptor?.colorAttachments?.find?.((attachment: any) => attachment?.view)?.view ?? descriptor?.depthStencilAttachment?.view;
        const size = view ? viewOf(view)?.size : undefined;

        if (size && size[0] > 0)
        {
            stateOf(pass).size = size;
        }
    }
    catch
    {
        // The size stays unknown, and a scissor patch is not applied to this pass.
    }
}

// ---- Adding and removing ----

function edited (source: string, spec: { source?: string; edits?: Array<{ find: string; replace: string }> }): string
{
    if (typeof spec.source === 'string')
    {
        return spec.source;
    }

    let out = source;

    for (const edit of spec.edits ?? [])
    {
        if (typeof edit?.find !== 'string' || typeof edit?.replace !== 'string' || edit.find === '')
        {
            throw new G.Error('Each edit is {find, replace}, both text, and find is not empty.');
        }

        if (!out.includes(edit.find))
        {
            throw new G.Error(`The shader does not contain "${edit.find}". resource(handle) shows its source.`);
        }

        out = out.split(edit.find).join(edit.replace);
    }

    return out;
}

function pipelineEntry (id: number): { entry: Entry; object: object }
{
    const entry = find('pipeline', id);
    const object = entry?.ref.deref();

    if (!entry || !object)
    {
        throw new G.Error('That pipeline no longer exists.');
    }

    if (entry.p.type !== 'render')
    {
        throw new G.Error('That is a compute pipeline. Live patches change render pipelines.');
    }

    return { entry, object };
}

// A small texture to stand in for another: a checkerboard, one flat colour, or an image.
function makeStandIn (device: any, kind: string, format: string, image?: { width: number; height: number; pixels: Uint8Array }): object
{
    if (image)
    {
        const data = image.pixels.slice();

        // The file is RGBA; a bgra texture wants its bytes the other way round.
        if (format.startsWith('bgra'))
        {
            for (let i = 0; i < data.length; i += 4)
            {
                const red = data[i];

                data[i] = data[i + 2];
                data[i + 2] = red;
            }
        }

        const made = natives.GPUDevice.createTexture.call(device, { label: 'Scanline stand-in (an image)', size: [image.width, image.height], format, usage: 0x04 | 0x02 });

        natives.GPUQueue.writeTexture.call(device.queue, { texture: made }, data, { bytesPerRow: image.width * 4 }, [image.width, image.height]);

        return natives.GPUTexture.createView.call(made);
    }

    const size = 64;
    const pixels = new G.Uint8Array(size * size * 4);

    for (let y = 0; y < size; y++)
    {
        for (let x = 0; x < size; x++)
        {
            const dark = ((x >> 3) + (y >> 3)) % 2 === 0;
            const colour = kind === 'white' ? [255, 255, 255] : kind === 'black' ? [0, 0, 0] : (dark ? [255, 0, 255] : [32, 32, 32]);

            pixels.set([...colour, 255], (y * size + x) * 4);
        }
    }

    const texture = natives.GPUDevice.createTexture.call(device, { label: `Scanline stand-in (${kind})`, size: [size, size], format, usage: 0x04 | 0x02 });

    natives.GPUQueue.writeTexture.call(device.queue, { texture }, pixels, { bytesPerRow: size * 4 }, [size, size]);

    return natives.GPUTexture.createView.call(texture);
}

export async function gpuPatchAdd (args: any, id: number): Promise<Record<string, unknown>>
{
    const patch: GpuPatch = { id, kind: args.kind, description: '', hits: 0, lastHits: 0 };
    const named = typeof args.filter?.pipeline === 'number' ? args.filter.pipeline : (typeof args.filter?.program === 'number' ? args.filter.program : undefined);

    if (named !== undefined)
    {
        pipelineEntry(named);
        patch.pipeline = named;
    }

    if (G.Array.isArray(args.filter?.draws))
    {
        patch.draws = [G.Number(args.filter.draws[0]) || 0, G.Number(args.filter.draws[args.filter.draws.length - 1]) || 0];
    }
    else if (typeof args.filter?.draws === 'number')
    {
        patch.draws = [args.filter.draws, args.filter.draws];
    }

    if (typeof args.filter?.texture === 'number')
    {
        patch.sampled = args.filter.texture;
    }

    const parts: string[] = [];

    if (patch.pipeline !== undefined) { parts.push(`that use pipeline ${patch.pipeline}`); }
    if (patch.sampled !== undefined) { parts.push(`with texture ${patch.sampled} in a bind group`); }
    if (patch.draws !== undefined) { parts.push(patch.draws[0] === patch.draws[1] ? `at event ${patch.draws[0]} of the frame` : `at events ${patch.draws[0]} to ${patch.draws[1]} of the frame`); }

    const where = parts.length ? `draws ${parts.join(' and ')}` : 'every draw';
    const one = parts.length === 0;
    let log = '';

    switch (args.kind)
    {
        case 'draws':
            if (args.mode === 'solid')
            {
                const colour: number[] = G.Array.isArray(args.colour) && args.colour.length >= 3 ? [G.Number(args.colour[0]), G.Number(args.colour[1]), G.Number(args.colour[2]), G.Number(args.colour[3] ?? 1)] : [1, 0, 1, 1];

                patch.mode = 'solid';
                patch.colour = colour;
                patch.description = `${where} ${one ? 'is' : 'are'} drawn in one flat colour (${colour.join(', ')}); what ${one ? 'its shader discards' : 'their shaders discard'} is still discarded`;
                break;
            }

            patch.mode = args.mode === 'isolate' ? 'isolate' : 'skip';
            patch.description = patch.mode === 'skip' ? `${where} ${one ? 'is' : 'are'} not drawn` : `only ${where} ${one ? 'is' : 'are'} drawn`;
            break;

        case 'view':
            patch.view = G.String(args.view);
            patch.mode = 'solid';

            if (patch.view === 'overdraw')
            {
                patch.colour = [0.125, 0.045, 0.015, 0];
                patch.additive = true;
                patch.description = 'overdraw: a pass that clears a colour clears it to black, and every draw adds a little orange where it lands, with the depth test off, so brighter is drawn more often (eight layers reach full red)';
            }
            else if (patch.view === 'draw_id')
            {
                patch.colour = 'draw';
                patch.description = 'each draw is drawn in a flat colour of its own, by its event number, with blending off';
            }
            else if (patch.view === 'depth')
            {
                patch.colour = 'depth';
                patch.description = 'depth: each draw is drawn in grey by the depth of each fragment (black is nearest, white farthest), with blending off';
            }
            else
            {
                throw new G.Error(patch.view === 'wireframe'
                    ? 'The live wireframe view is for WebGL. On a WebGPU page: overdraw, draw_id and depth live, and view(capture, view: "wireframe") from a capture.'
                    : `There is no live "${patch.view}" view. On a WebGPU page: overdraw, draw_id and depth, and the views the page registered. view(capture, view) has the rest.`);
            }

            break;

        case 'uniform':
        {
            const { entry } = pipelineEntry(args.pipeline);
            const { group, binding, leaf } = uniformNamed(entry, G.String(args.name));
            const value: number[] = G.Array.from(args.value as ArrayLike<number>, G.Number);

            patch.pipeline = entry.id;
            patch.name = leaf.name;
            patch.group = group;
            patch.binding = binding;
            patch.offset = leaf.offset;
            patch.bytes = encode(leaf, value);
            patch.held = [];
            patch.description = `uniform ${leaf.name} (${leaf.type}) held at ${value.join(', ')} for draws that use pipeline ${entry.id}`;
            break;
        }

        case 'state':
        {
            const state = args.state ?? {};
            const said: string[] = [];

            for (const key of G.Object.keys(state))
            {
                if (key === 'scissor' && state.scissor === false)
                {
                    throw new G.Error('A WebGPU pass always has a scissor box; it cannot be switched off. Give scissor as [x, y, w, h].');
                }

                said.push(key === 'scissor' || key === 'color_mask' ? `${key.replace('_', ' ')} ${state[key].join(', ')}` : `${key.replace('_', ' ')} ${state[key] ? 'on' : 'off'}`);
            }

            if (state.cull === true || state.depth_test === true)
            {
                throw new G.Error('cull and depth_test can be switched off here, not on: which faces to cull and how to compare are the pipeline\'s to say.');
            }

            patch.state = state;
            patch.description = `${where}: ${said.join(', ')}`;
            break;
        }

        case 'shader':
        {
            let module: Entry | undefined;
            let device: any;

            if (typeof args.module === 'number')
            {
                module = find('shader', args.module);

                // The page may have let go of the module itself. A pipeline that uses it
                // says which device it belongs to.
                const user = all('pipeline').find((entry) => !entry.destroyed && entry.ref.deref() && usesModule(entry.p.descriptor, args.module));

                device = module?.ref.deref() ? deviceFor(module.ref.deref()!) : (user ? deviceFor(user.ref.deref()!) : undefined);
            }
            else if (typeof args.pipeline === 'number')
            {
                const { entry, object } = pipelineEntry(args.pipeline);
                const stage = args.stage === 'vertex' ? 'vertex' : 'fragment';

                module = find('shader', entry.p.descriptor?.[stage]?.module?.id ?? -1);
                device = deviceFor(object);
                patch.pipeline = args.pipeline;
            }

            if (!module || typeof module.p.source !== 'string')
            {
                throw new G.Error('Scanline has no record of that shader module\'s source.');
            }

            if (!device)
            {
                throw new G.Error('No pipeline that is still alive uses that shader module, so there is nothing to patch.');
            }

            const source = edited(G.String(module.p.source ?? ''), args);
            const made = natives.GPUDevice.createShaderModule.call(device, { label: `${module.label ?? 'module'} (Scanline patch)`, code: source });
            const info = await made.getCompilationInfo();
            const messages: string[] = info.messages.map((message: any) => `${message.type} at line ${message.lineNum}: ${message.message}`);

            if (info.messages.some((message: any) => message.type === 'error'))
            {
                throw new G.Error(`The edited shader does not compile, so nothing was changed.\n${messages.join('\n')}`);
            }

            log = messages.join('\n');
            patch.module = module.id;
            patch.replacement = made;
            patch.description = `shader ${module.id}${patch.pipeline === undefined ? '' : ` for pipeline ${patch.pipeline}`}: ${typeof args.source === 'string' ? 'new source' : (args.edits ?? []).map((edit: any) => `«${edit.find}» → «${edit.replace}»`).join(', ')}`;
            break;
        }

        case 'texture':
        {
            const entry = find('texture', args.texture);
            const object = entry?.ref.deref();

            if (!entry || !object)
            {
                throw new G.Error('That texture no longer exists.');
            }

            if (entry.p.dimension !== '2d' || entry.p.depthOrArrayLayers !== 1 || !['rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm', 'bgra8unorm-srgb'].includes(entry.p.format))
            {
                throw new G.Error(`A stand-in can be made for a plain 2D colour texture (rgba8unorm or bgra8unorm). This one is ${entry.p.dimension} ${entry.p.format}.`);
            }

            if (args.with === 'mips')
            {
                throw new G.Error('The mips stand-in is for WebGL. On WebGPU use checker, white, black or a PNG file.');
            }

            // For an experiment that stands in for every texture at once: not one a pass draws to.
            if (args.plain && (entry.p.renderTarget || (typeof entry.p.usage === 'number' && (entry.p.usage & 0x18) !== 0)))
            {
                throw new G.Error('not a plain 2D colour texture');
            }

            const image = args.with === 'file' ? imageOf(args) : undefined;

            patch.texture = entry.id;
            patch.standIn = makeStandIn(deviceFor(object), args.with ?? 'checker', entry.p.format.startsWith('bgra') ? 'bgra8unorm' : 'rgba8unorm', image);
            patch.description = `${where}: texture ${entry.id} replaced by ${image ? `the ${image.width}×${image.height} image given` : `a ${args.with ?? 'checker'} texture`}`;
            break;
        }

        default:
            throw new G.Error(`There is no "${args.kind}" patch.`);
    }

    patches.push(patch);
    wire();

    // Build the shadows now, so that a pipeline the browser will not make is reported and
    // not found out by a missing draw.
    const failed = await rehearse(patch);

    // A patch that names its change exactly is all or nothing. A flat colour over many
    // pipelines is not: those it cannot be given to are drawn as the page made them, and
    // the list of patches says so.
    if (failed && patch.colour === undefined)
    {
        patches.splice(patches.indexOf(patch), 1);
        wire();

        throw new G.Error(`The patched pipeline is not valid, so nothing was changed.\n${failed}`);
    }

    return { patch: patch.id, kind: patch.kind, context: args.context, description: patch.description, log };
}

// Makes the shadow of every pipeline a patch applies to, and waits for the browser to
// check each. Returns what the browser said if one was refused.
async function rehearse (patch: GpuPatch): Promise<string | null>
{
    const checks: Array<Promise<string | null>> = [];

    for (const entry of all('pipeline'))
    {
        const pipeline = entry.ref.deref();

        if (!pipeline || entry.destroyed || entry.p.type !== 'render' || !matches(patch, entry))
        {
            continue;
        }

        // Under the patches its draws will meet together: those that always apply, and
        // this one with them if it is choosier.
        const usual = always(entry);

        for (const hits of usual.includes(patch) ? [usual] : [usual, [...usual, patch].sort((a, b) => patches.indexOf(a) - patches.indexOf(b))])
        {
            const slot = slotFor(pipeline, entry, hits);

            if (slot.checking)
            {
                checks.push(slot.checking);
            }
        }
    }

    const said = (await G.Promise.all(checks)).filter(G.Boolean) as string[];

    return said.length ? said[0] : null;
}

export function gpuPatchList (): Array<Record<string, unknown>>
{
    return patches.map((patch) => ({ patch: patch.id, kind: patch.kind, context: 0, description: patch.description, draws: G.Math.max(patch.hits, patch.lastHits), view: patch.view, failure }));
}

export function gpuPatchRemove (args: { patch?: number; all?: boolean; views?: boolean }): number[]
{
    const gone: number[] = [];

    for (let index = patches.length - 1; index >= 0; index--)
    {
        if (args.all || patches[index].id === args.patch || (args.views && patches[index].view !== undefined))
        {
            // A held uniform goes back to what the page last had there.
            for (const held of patches[index].held ?? [])
            {
                if (held.saved)
                {
                    writeHeld(patches[index], held, held.saved);
                }
            }

            gone.push(patches[index].id);
            patches.splice(index, 1);
        }
    }

    if (gone.length > 0)
    {
        wire();
    }

    return gone;
}

let sampledFrame = -16;
let sampledAt = 0;

export function gpuPatchFrame (): void
{
    events = 0;
    gpuUse.frame = currentFrame();

    // Use is sampled on a frame in sixteen, or on a frame a quarter of a second after the
    // last one sampled: so frames stepped by hand are each looked at.
    const now = nativeNow();

    gpuUse.sampling = gpuUse.frame - sampledFrame >= 16 || gpuUse.frame < sampledFrame || now - sampledAt >= 250;

    if (gpuUse.sampling)
    {
        sampledFrame = gpuUse.frame;
        sampledAt = now;
    }

    for (const patch of patches)
    {
        patch.lastHits = patch.hits;
        patch.hits = 0;
    }
}

export function gpuPatched (): boolean
{
    return patches.length > 0;
}

