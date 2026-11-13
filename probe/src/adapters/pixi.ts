// PixiJS, version 8 (05-PAGE-PROTOCOL.md, section 2.3).
//
// PixiJS calls two globals for its developer tools when an application or a renderer is
// made, so the probe defines them. A renderer draws by running a list of instructions,
// each through `renderPipes[instruction.renderPipeId].execute(instruction)`, looked up
// afresh every time. The adapter wraps `execute` on every pipe of the renderer it is
// handed, so each instruction's draws fall in a group of their own.
//
// Most of what PixiJS draws is batched: one instruction, one draw, many display objects.
// A batch's group says which objects went into it and why the batch ended, read from the
// instruction that follows it.

import { provideEngineState } from '../protocol';
import { provideWatchable, type Watchable } from '../watch';
import { G } from '../natives';
import { adapter as register } from './index';
import { announce, around, fail, newAdapter, note, short, type Adapter } from './wrap';

const TESTED = '8.22';

// The instruction that follows each one in its list, as of the last time the list was run.
const following = new G.WeakMap() as WeakMap<object, object | null>;

function index (set: any): void
{
    const list = set?.instructions;
    const size = set?.instructionSize ?? 0;

    if (!list)
    {
        return;
    }

    for (let i = 0; i < size; i++)
    {
        if (list[i] && typeof list[i] === 'object')
        {
            following.set(list[i], i + 1 < size ? list[i + 1] : null);
        }
    }
}

function nameOf (object: any): string
{
    return short(object?.label || `${object?.renderPipeId ?? 'container'} ${object?.uid ?? ''}`, 60);
}

function textureName (source: any): string
{
    return short(source?.label || `${source?.pixelWidth ?? '?'}×${source?.pixelHeight ?? '?'}`, 60);
}

// Why a batch ended where it did.
function ended (batch: any): string
{
    if (!following.has(batch))
    {
        return 'unknown';
    }

    const next: any = following.get(batch);

    if (!next)
    {
        return 'the end of its render group';
    }

    if (next.renderPipeId !== 'batch')
    {
        return `a ${short(next.renderPipeId, 24)}${next.action ? ` (${short(next.action, 24)})` : ''} came next, which cannot be batched`;
    }

    if (next.action === 'renderBatch')
    {
        if (next.blendMode !== batch.blendMode)
        {
            return `the blend mode changed (${short(batch.blendMode, 24)} to ${short(next.blendMode, 24)})`;
        }

        if (next.topology !== batch.topology)
        {
            return `the topology changed (${short(batch.topology, 24)} to ${short(next.topology, 24)})`;
        }

        return `the texture limit was reached (${batch.textures?.count ?? '?'} textures in one batch)`;
    }

    return 'the batcher was broken and begun again';
}

const tally: Record<string, number> = {};
let batches = 0;
let filterPasses = 0;

function describeBatch (batch: any): { name: string; entity: Record<string, unknown> }
{
    const seen = new G.Set() as Set<object>;
    const names: string[] = [];
    const kinds: Record<string, number> = {};

    for (const element of batch.elements ?? [])
    {
        const object = element?.renderable;

        if (!object || seen.has(object))
        {
            continue;
        }

        seen.add(object);

        const kind = short(object.renderPipeId ?? 'object', 24);

        kinds[kind] = (kinds[kind] ?? 0) + 1;

        if (names.length < 8)
        {
            names.push(nameOf(object));
        }
    }

    const textures: string[] = [];
    const count = batch.textures?.count ?? 0;

    for (let i = 0; i < count && i < 8; i++)
    {
        textures.push(textureName(batch.textures.textures[i]));
    }

    const why = ended(batch);
    const reason = why.replace(/ \(.*$/, '');

    tally[reason] = (tally[reason] ?? 0) + 1;
    batches++;

    return {
        name: `batch ${batches} (${seen.size === 1 ? names[0] : `${seen.size} objects`})`,
        entity: {
            type: 'Batch',
            name: seen.size === 1 ? names[0] : `${seen.size} objects`,
            objects: seen.size,
            kinds,
            first: names,
            textures,
            textureCount: count,
            blendMode: short(batch.blendMode, 24),
            ended: why
        }
    };
}

function describeObject (pipe: string, object: any): { name: string; entity: Record<string, unknown> }
{
    return {
        name: nameOf(object),
        entity: { type: pipe, name: short(object?.label || '', 60), uid: object?.uid, unbatched: true }
    };
}

function wrapRenderer (adapter: Adapter, renderer: any): void
{
    adapter.report.renderer = short(renderer.name ?? '', 20);

    // A whole render: the stage to the canvas, or a container to a texture.
    around(adapter, renderer, 'render', (self, [given]) =>
    {
        const options = given && given.container ? given : { container: given };
        const target = options.target;
        const toScreen = !target || target === self.view?.renderTarget || target === self.view?.texture;

        // Counted from the start of each render to the canvas.
        if (toScreen)
        {
            for (const key in tally)
            {
                delete tally[key];
            }

            batches = 0;
            filterPasses = 0;
        }

        const what = options.container?.label ? nameOf(options.container) : (options.container?.parent ? nameOf(options.container) : 'stage');

        return { name: `${what} → ${toScreen ? 'canvas' : `texture ${textureName(target.source ?? target)}`}` };
    });

    // The root group's instructions are run by the render group system.
    if (renderer.renderGroup)
    {
        around(adapter, renderer.renderGroup, 'render', (_self, [options]) =>
        {
            index(options?.container?.renderGroup?.instructionSet);

            return null;
        });
    }

    let pipes = 0;

    for (const key in renderer.renderPipes ?? {})
    {
        const pipe = renderer.renderPipes[key];

        if (!pipe || typeof pipe.execute !== 'function')
        {
            continue;
        }

        const did = around(adapter, pipe, 'execute', (_self, [instruction]) =>
        {
            if (!instruction)
            {
                return null;
            }

            switch (key)
            {
                case 'batch':
                    return describeBatch(instruction);

                case 'renderGroup':
                    index(instruction.instructionSet);

                    return { name: `render group ${nameOf(instruction.root)}${instruction.isCachedAsTexture ? ' (cached as a texture)' : ''}` };

                case 'filter':
                case 'alphaMask':
                case 'stencilMask':
                case 'colorMask':
                    return { name: `${key} ${short(instruction.action ?? '', 24)}`.trim() };

                default:
                    return describeObject(key, instruction);
            }
        });

        pipes += did ? 1 : 0;
    }

    // Each pass of a filter is one full-screen draw.
    if (renderer.filter)
    {
        around(adapter, renderer.filter, 'applyFilter', (self) =>
        {
            const on = self._activeFilterData?.container;

            filterPasses++;

            return {
                name: `filter pass ${filterPasses}`,
                entity: { type: 'FilterPass', name: on ? `filter on ${nameOf(on)}` : 'filter', container: on ? nameOf(on) : null }
            };
        });
    }

    adapter.report.status = pipes > 0 ? 'active' : 'partial';

    if (pipes === 0)
    {
        note(adapter, 'The renderer has no render pipes to wrap (the canvas renderer has none), so draws are not mapped to objects.');
    }

    announce(adapter);
}

function install (): void
{
    const adapter = newAdapter('PixiJS', TESTED);
    const apps: Array<WeakRef<any>> = [];
    const renderers: Array<WeakRef<any>> = [];

    const version = (given: unknown): void =>
    {
        adapter.report.version = short(given, 16);

        if (!adapter.report.version.startsWith('8.'))
        {
            note(adapter, 'The adapter is written for PixiJS 8. Earlier versions draw differently and are not mapped.');
        }
        else if (!adapter.report.version.startsWith(TESTED))
        {
            note(adapter, `This is not the version the adapter was tested with (${TESTED}), so it may be partial.`);
        }
    };

    const state = (): Record<string, unknown> =>
    {
        const out: Record<string, unknown> = { renderers: [], stages: [], lastFrame: { batches, batchEndedBecause: { ...tally } } };

        for (const reference of renderers)
        {
            const renderer = reference.deref();

            if (renderer)
            {
                (out.renderers as unknown[]).push({ kind: short(renderer.name, 20), width: renderer.width, height: renderer.height, resolution: renderer.resolution });
            }
        }

        for (const reference of apps)
        {
            const stage = reference.deref()?.stage;

            if (!stage)
            {
                continue;
            }

            const kinds: Record<string, number> = {};
            const walk = [stage];
            let objects = 0;

            while (walk.length > 0 && objects < 20000)
            {
                const object = walk.pop();
                const kind = short(object.renderPipeId ?? 'container', 24);

                objects++;
                kinds[kind] = (kinds[kind] ?? 0) + 1;

                for (const child of object.children ?? [])
                {
                    walk.push(child);
                }
            }

            (out.stages as unknown[]).push({ name: short(stage.label || 'stage', 60), objects, kinds });
        }

        return out;
    };

    G.__PIXI_RENDERER_INIT__ = (renderer: any, given: unknown): void =>
    {
        if (!adapter.on || !renderer)
        {
            return;
        }

        try
        {
            version(given);
            renderers.push(new G.WeakRef(renderer));
            wrapRenderer(adapter, renderer);
            provideEngineState('PixiJS', state);
        }
        catch (error)
        {
            fail(adapter, 'the renderer hook', error);
        }
    };

    G.__PIXI_APP_INIT__ = (app: any, given: unknown): void =>
    {
        try
        {
            version(given);

            if (app)
            {
                apps.push(new G.WeakRef(app));
                provideWatchable('PixiJS', () =>
                {
                    const out: Watchable[] = [];

                    apps.forEach((reference) =>
                    {
                        const stage = reference.deref()?.stage;
                        const walk: Array<[any, string]> = stage ? [[stage, 'stage']] : [];

                        while (walk.length > 0 && out.length < 5000)
                        {
                            const [object, path] = walk.shift()!;

                            if (object !== stage)
                            {
                                out.push({ path, name: short(object.label ?? '', 60), type: short(object.constructor?.name ?? 'Container', 40), kind: 'sprite', object });
                            }

                            (object.children ?? []).forEach((child: any, place: number) => walk.push([child, `${path}/${short(child.label || `${child.constructor?.name ?? 'Container'}#${place}`, 60)}`]));
                        }
                    });

                    return out;
                });
            }

            announce(adapter);
            provideEngineState('PixiJS', state);
        }
        catch (error)
        {
            fail(adapter, 'the application hook', error);
        }
    };
}

register(install);
