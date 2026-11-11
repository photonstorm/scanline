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

import { hub, type Rec } from '../hooks/hub';
import { natives } from '../hooks/install';
import { G } from '../natives';
import { all, deviceFor, entryOf, find, type Entry } from '../registry';
import { madeFromOf, viewOf } from './tracker';

export interface GpuPatch
{
    id: number;
    kind: 'draws' | 'state' | 'shader' | 'texture';
    description: string;
    hits: number;
    lastHits: number;

    // Which draws: those of one pipeline, or every draw.
    pipeline?: number;

    // draws
    mode?: 'skip' | 'isolate';

    // state
    state?: Record<string, any>;

    // shader: the module replaced, and what replaces it
    module?: number;
    replacement?: object;

    // texture: the texture stood in for, and the view that stands in
    texture?: number;
    standIn?: object;
}

const patches: GpuPatch[] = [];

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
    size: [number, number] | null;
    swapped: Plan | null;
}

const passes = new G.WeakMap() as WeakMap<object, PassState>;

function stateOf (pass: object): PassState
{
    let state = passes.get(pass);

    if (!state)
    {
        state = { pipeline: null, groups: [], scissor: null, size: null, swapped: null };
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
    hits: GpuPatch[];
    groups: WeakMap<object, Map<number, object | null>>;   // the page's group -> its shadow, by index
}

const plans = new G.WeakMap() as WeakMap<object, { version: number; plan: Plan | null }>;

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

function planFor (pipeline: object): Plan | null
{
    const cached = plans.get(pipeline);

    if (cached && cached.version === version)
    {
        return cached.plan;
    }

    let plan: Plan | null = null;

    try
    {
        plan = makePlan(pipeline);
    }
    catch (error: any)
    {
        // A pipeline that cannot be rebuilt is drawn as the page made it.
        plan = null;
        failure = `a pipeline could not be rebuilt: ${G.String(error?.message ?? error).slice(0, 200)}`;
    }

    plans.set(pipeline, { version, plan });

    return plan;
}

function makePlan (pipeline: object): Plan | null
{
    const entry = entryOf(pipeline);

    if (!entry || entry.p.type !== 'render')
    {
        return null;
    }

    const hits = patches.filter((patch) => matches(patch, entry));
    const isolating = patches.some((patch) => patch.kind === 'draws' && patch.mode === 'isolate');

    if (hits.length === 0 && !isolating)
    {
        return null;
    }

    const plan: Plan = { skip: false, shadow: null, auto: false, textures: new G.Map(), scissor: null, hits, groups: new G.WeakMap() };

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

    const rebuilt = hits.some((patch) => patch.kind === 'shader' || (patch.kind === 'state' && G.Object.keys(patch.state!).some((key: string) => key !== 'scissor')));

    if (rebuilt)
    {
        const device = deviceFor(pipeline) as any;

        plan.shadow = natives.GPUDevice.createRenderPipeline.call(device, shadowDescriptor(entry, hits, device));
        plan.auto = entry.p.descriptor?.layout === 'auto';
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
    const state = passes.get(pass);

    if (!state || !state.pipeline)
    {
        return true;
    }

    const plan = planFor(state.pipeline);

    if (plan === null)
    {
        return true;
    }

    for (const patch of plan.hits)
    {
        patch.hits++;
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
}

// ---- What a pass has set, followed while a patch is in force ----

type Post = (record: Rec, self: any, result: any, ...args: any[]) => void;

export const gpuPatchHandlers: Record<string, Post> = {

    'GPURenderPassEncoder.setPipeline' (_c, pass, _result, pipeline)
    {
        if (patches.length > 0)
        {
            stateOf(pass).pipeline = pipeline;
        }
    },

    'GPURenderPassEncoder.setBindGroup' (_c, pass, _result, index, group, a, b, c)
    {
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
    }
};

// Called as a render pass begins: how large its targets are, for putting a scissor box back.
export function gpuPassBegan (pass: object, descriptor: any): void
{
    if (patches.length === 0 || !pass)
    {
        return;
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

// A small texture to stand in for another: a checkerboard, or one flat colour.
function makeStandIn (device: any, kind: string, format: string): object
{
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

    if (args.filter?.draws !== undefined || args.filter?.texture !== undefined)
    {
        throw new G.Error('On WebGPU a filter names a pipeline ({"pipeline": "pip_2"}) or is left out for every draw. Event numbers and textures are not filters here yet.');
    }

    if (named !== undefined)
    {
        pipelineEntry(named);
        patch.pipeline = named;
    }

    const where = patch.pipeline === undefined ? 'every draw' : `draws that use pipeline ${patch.pipeline}`;
    let log = '';

    switch (args.kind)
    {
        case 'draws':
            patch.mode = args.mode === 'isolate' ? 'isolate' : 'skip';
            patch.description = patch.mode === 'skip' ? `${where} ${patch.pipeline === undefined ? 'is' : 'are'} not drawn` : `only ${where} ${patch.pipeline === undefined ? 'is' : 'are'} drawn`;
            break;

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
                throw new G.Error('The mips stand-in is for WebGL. On WebGPU use checker, white or black.');
            }

            patch.texture = entry.id;
            patch.standIn = makeStandIn(deviceFor(object), args.with ?? 'checker', entry.p.format.startsWith('bgra') ? 'bgra8unorm' : 'rgba8unorm');
            patch.description = `${where}: texture ${entry.id} replaced by a ${args.with ?? 'checker'} texture`;
            break;
        }

        default:
            throw new G.Error(`A "${args.kind}" patch is not built for WebGPU. What works here: draws, state, shader and texture. Uniforms live in buffers, which need WGSL reflection to patch by name.`);
    }

    patches.push(patch);
    wire();

    // Build the shadows now, so that a pipeline the browser will not make is reported and
    // not found out by a missing draw.
    const failed = await rehearse(patch);

    if (failed)
    {
        patches.splice(patches.indexOf(patch), 1);
        wire();

        throw new G.Error(`The patched pipeline is not valid, so nothing was changed.\n${failed}`);
    }

    return { patch: patch.id, kind: patch.kind, context: args.context, description: patch.description, log };
}

// Makes the shadow of every pipeline a patch applies to, inside an error scope. Returns
// what the browser said if one was refused.
async function rehearse (patch: GpuPatch): Promise<string | null>
{
    if (patch.kind === 'draws' || (patch.kind === 'state' && G.Object.keys(patch.state!).every((key: string) => key === 'scissor')) || patch.kind === 'texture')
    {
        return null;
    }

    const scopes: Array<Promise<any>> = [];

    for (const entry of all('pipeline'))
    {
        const pipeline = entry.ref.deref();

        if (!pipeline || entry.destroyed || entry.p.type !== 'render' || !matches(patch, entry))
        {
            continue;
        }

        const device = deviceFor(pipeline) as any;

        device.pushErrorScope('validation');
        planFor(pipeline);
        scopes.push(device.popErrorScope());
    }

    for (const scope of scopes)
    {
        const error = await scope;

        if (error)
        {
            return G.String(error.message).slice(0, 600);
        }
    }

    return null;
}

export function gpuPatchList (): Array<Record<string, unknown>>
{
    return patches.map((patch) => ({ patch: patch.id, kind: patch.kind, context: 0, description: patch.description, draws: G.Math.max(patch.hits, patch.lastHits), failure }));
}

export function gpuPatchRemove (args: { patch?: number; all?: boolean }): number
{
    const before = patches.length;

    for (let index = patches.length - 1; index >= 0; index--)
    {
        if (args.all || patches[index].id === args.patch)
        {
            patches.splice(index, 1);
        }
    }

    if (patches.length !== before)
    {
        wire();
    }

    return before - patches.length;
}

export function gpuPatchFrame (): void
{
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

