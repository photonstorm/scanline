// Phaser 4 (05-PAGE-PROTOCOL.md, section 2.1; the published engine, WebGL renderer).
//
// Phaser keeps no list of its games. A page that loads the usual build sets `window.Phaser`,
// and the adapter catches that and wraps `Game.prototype.boot`. A page that bundles Phaser
// as a module sets nothing, so the adapter also watches for the one property only Phaser's
// WebGL renderer assigns (`cameraRenderNode`), with a setter on Object.prototype.
//
// Phaser draws in batches. A game object is submitted to a batch as it is rendered, and the
// batch is drawn later, when it is full or something else needs the GPU. So the adapter
// keeps, for each batch, the game objects that went into it and where; and when the
// renderer issues a draw it names the objects in that part of the batch and says why the
// batch was flushed.

import { provideEngineState } from '../protocol';
import { provideWatchable, type Watchable } from '../watch';
import { G } from '../natives';
import { adapter as register } from './index';
import { announce, around, fail, newAdapter, note, ownerOf, short, watch, type Adapter } from './wrap';

const TESTED = '4.2';

interface Entry { object: any; first: number; last: number }

function nameOf (object: any): string
{
    return short(object?.name || `${object?.type ?? 'GameObject'}`, 60);
}

function entityOf (object: any): Record<string, unknown>
{
    const entity: Record<string, unknown> = { type: short(object.type ?? 'GameObject', 40), name: short(object.name || '', 60) };

    try
    {
        if (object.texture?.key && object.texture.key !== '__DEFAULT')
        {
            entity.texture = short(object.texture.key, 60);
            entity.frame = short(object.frame?.name ?? '', 40);
        }

        entity.scene = short(object.scene?.sys?.settings?.key ?? '', 40);
        entity.depth = object.depth;

        if (object.parentContainer)
        {
            entity.parent = nameOf(object.parentContainer);
        }
    }
    catch
    {
        // Whatever could be read is enough.
    }

    return entity;
}

function wrapRenderer (adapter: Adapter, renderer: any, version: string): void
{
    const manager = renderer.renderNodes;

    adapter.report.version = version;
    adapter.report.renderer = 'WebGL';

    if (!manager || typeof renderer.drawElements !== 'function')
    {
        adapter.report.status = 'off';
        note(adapter, 'The adapter is written for Phaser 4, whose renderer draws through render nodes. This one does not, so draws are not mapped.');

        return;
    }

    if (version && !version.startsWith(TESTED))
    {
        note(adapter, `This is not the version the adapter was tested with (${TESTED}), so it may be partial.`);
    }

    // The game objects being rendered, innermost last.
    const rendering: any[] = [];

    // What each batch holds, and why the next flush will happen.
    const held = new G.Map() as Map<object, Entry[]>;
    let why: string | null = null;
    let submitting: { node: any; full: boolean } | null = null;
    let camera: any = null;
    let numbered = 0;

    const record = (node: any, before: number): void =>
    {
        const after = node.instanceCount ?? 0;
        let list = held.get(node);

        if (!list || after <= before || before === 0)
        {
            // The batch was drawn and begun again, by this call or since the last one.
            list = [];
            held.set(node, list);
        }

        const object = rendering.length > 0 ? rendering[rendering.length - 1] : null;
        const first = after > before ? before : 0;
        const tail = list[list.length - 1];

        if (tail && tail.object === object && tail.last === first)
        {
            tail.last = after;
        }
        else
        {
            list.push({ object, first, last: after });
        }
    };

    const wrapNode = (node: any): void =>
    {
        if (!node || typeof node !== 'object')
        {
            return;
        }

        for (const method of ['batch', 'batchWithUV', 'batchStrip', 'batchTriangles'])
        {
            if (typeof node[method] === 'function' && typeof node.instanceCount === 'number')
            {
                watch(adapter, node, method,
                    (self) =>
                    {
                        const token = { before: self.instanceCount ?? 0, outer: submitting };

                        submitting = { node: self, full: self.instanceCount === self.instancesPerBatch };

                        return token;
                    },
                    (self, _args, token: any) =>
                    {
                        submitting = token.outer;
                        record(self, token.before);
                    });
            }
        }
    };

    for (const key in manager._nodes ?? {})
    {
        wrapNode(manager._nodes[key]);
    }

    watch(adapter, manager, 'addNode', () => null, (_self, [, node]) => wrapNode(node));

    // A flush, and what asked for it.
    watch(adapter, manager, 'setCurrentBatchNode',
        (self, [node]) =>
        {
            wrapNode(node);

            const token = why;

            if (self.currentBatchNode && node !== self.currentBatchNode)
            {
                why = why ?? (node ? `a different kind of batch began (${short(node.name, 40)})` : 'the camera had drawn everything it sees');
            }

            return token;
        },
        (_self, _args, token) => { why = token as string | null; });

    watch(adapter, manager, 'startStandAloneRender', () => { const token = why; why = why ?? 'a draw that cannot be batched came next'; return token; }, (_self, _args, token) => { why = token as string | null; });

    const context = renderer.baseDrawingContext ? G.Object.getPrototypeOf(renderer.baseDrawingContext) : null;

    for (const [method, reason] of [['use', 'the drawing context changed (a camera, a blend mode, a framebuffer or a filter began)'], ['release', 'the drawing context was released (a camera, a framebuffer or the frame ended)'], ['clear', 'the target was cleared']] as const)
    {
        watch(adapter, context, method, () => { const token = why; why = why ?? reason; return token; }, (_self, _args, token) => { why = token as string | null; });
    }

    // The draw itself: which objects are in this part of the batch.
    const describeDraw = (self: any, count: number, offset: number): { name: string; entity?: Record<string, unknown> } | null =>
    {
        const node = self.renderNodes?.currentBatchNode;
        const list = node ? held.get(node) : undefined;

        if (!node || !list || list.length === 0)
        {
            // A stand-alone draw belongs to the object being rendered, if any.
            const object = rendering.length > 0 ? rendering[rendering.length - 1] : null;

            return object ? { name: nameOf(object), entity: { ...entityOf(object), unbatched: true } } : { name: 'engine draw' };
        }

        const perIndex = node.bytesPerIndexPerInstance;
        const perInstance = node.indicesPerInstance;
        const total = node.instanceCount ?? 0;
        const start = perIndex ? G.Math.round(offset / perIndex) : 0;
        const size = perInstance ? G.Math.round(count / perInstance) : total;
        const end = start + size;

        const seen = new G.Set() as Set<object>;
        const names: string[] = [];
        const kinds: Record<string, number> = {};
        let engine = 0;

        for (const entry of list)
        {
            if (entry.last <= start || entry.first >= end)
            {
                continue;
            }

            if (!entry.object)
            {
                engine++;
                continue;
            }

            if (seen.has(entry.object))
            {
                continue;
            }

            seen.add(entry.object);

            const kind = short(entry.object.type ?? 'GameObject', 40);

            kinds[kind] = (kinds[kind] ?? 0) + 1;

            if (names.length < 8)
            {
                names.push(nameOf(entry.object));
            }
        }

        let ended: string;

        if (end < total)
        {
            ended = 'the texture changed: a batch holds only so many textures, or one in single-texture mode';
        }
        else if (submitting && submitting.node === node)
        {
            ended = submitting.full ? `the batch was full (${total} instances)` : 'the render options changed (lighting, texturing or how alpha is handled)';
        }
        else
        {
            ended = why ?? 'unknown';
        }

        numbered++;

        if (seen.size === 0)
        {
            // Quads the engine submits itself: a camera's background, flash or fade, or a
            // camera or filter being composited.
            const of = short(camera?.name || camera?.id || 'camera', 40);

            return { name: `batch ${numbered} (camera ${of})`, entity: { type: 'Camera', name: of, what: engine > 0 ? 'its background, flash or fade, or its picture being composited' : 'nothing recorded', node: short(node.name ?? '', 40), instances: size, ended } };
        }

        return {
            name: `batch ${numbered} (${seen.size === 1 ? names[0] : `${seen.size} objects`})`,
            entity: {
                type: 'Batch',
                name: seen.size === 1 ? names[0] : `${seen.size} objects`,
                objects: seen.size,
                kinds,
                first: names,
                instances: size,
                node: short(node.name ?? '', 40),
                ended
            }
        };
    };

    const draws = around(adapter, renderer, 'drawElements', (self, [, , , , count, offset]) => describeDraw(self, count, offset));

    around(adapter, renderer, 'drawInstancedArrays', () =>
    {
        const object = rendering.length > 0 ? rendering[rendering.length - 1] : null;

        return object ? { name: nameOf(object), entity: { ...entityOf(object), unbatched: true } } : { name: 'engine draw' };
    });

    // A pass: one camera's view of one scene.
    let steps = false;

    const wrapSteps = (object: any): void =>
    {
        const owner = ownerOf(object, 'renderWebGLStep');

        if (!owner)
        {
            return;
        }

        steps = watch(adapter, owner, 'renderWebGLStep',
            (self) => { rendering.push(self); return null; },
            () => { rendering.pop(); }) || steps;

        if (steps)
        {
            adapter.report.status = draws ? 'active' : 'partial';
            announce(adapter);
        }
    };

    around(adapter, renderer, 'render', (_self, [scene, children, viewing]) =>
    {
        if (!steps && children && children.length > 0)
        {
            wrapSteps(children[0]);
        }

        camera = viewing;

        const key = short(scene?.sys?.settings?.key ?? 'scene', 40);

        return { name: `scene ${key}, camera ${short(viewing?.name || viewing?.id || 'main', 40)}` };
    });

    watch(adapter, renderer, 'preRender', () => { numbered = 0; return null; });

    // The frame's last flush comes as the base context is released.
    around(adapter, renderer, 'postRender', () => ({ name: 'end of frame' }));

    const known = G.Phaser?.GameObjects?.GameObject?.prototype;

    if (known)
    {
        wrapSteps(known);
    }

    adapter.report.status = steps && draws ? 'active' : 'partial';

    if (!draws)
    {
        note(adapter, 'The renderer\'s drawElements could not be wrapped, so draws are not mapped to game objects.');
    }

    announce(adapter);

    const game = renderer.game;

    // Each scene's display list, by scene key and the object's name (or type and place).
    provideWatchable('Phaser', () =>
    {
        const out: Watchable[] = [];

        for (const scene of game?.scene?.scenes ?? [])
        {
            const key = short(scene.sys?.settings?.key ?? 'scene', 40);

            (scene.sys?.displayList?.list ?? []).slice(0, 5000).forEach((object: any, place: number) =>
            {
                const type = short(object.type ?? 'GameObject', 40);

                out.push({ path: `${key}/${short(object.name || `${type}#${place}`, 60)}`, name: short(object.name ?? '', 60), type, kind: 'sprite', object });
            });
        }

        return out;
    });

    provideEngineState('Phaser', () =>
    {
        const scenes: unknown[] = [];

        for (const scene of game?.scene?.scenes ?? [])
        {
            const kinds: Record<string, number> = {};
            const list = scene.sys?.displayList?.list ?? [];

            for (const object of list)
            {
                const kind = short(object.type ?? 'GameObject', 40);

                kinds[kind] = (kinds[kind] ?? 0) + 1;
            }

            scenes.push({ key: short(scene.sys?.settings?.key ?? '', 40), active: Boolean(scene.sys?.settings?.active), visible: Boolean(scene.sys?.settings?.visible), objects: list.length, kinds, cameras: scene.cameras?.cameras?.length });
        }

        return { scenes, frame: game?.loop?.frame, fps: game?.loop?.actualFps, paused: Boolean(game?.isPaused), batchSize: renderer.config?.batchSize };
    });
}

function install (): void
{
    const adapter = newAdapter('Phaser', TESTED);
    const seen = new G.WeakSet() as WeakSet<object>;

    const found = (renderer: any): void =>
    {
        if (!renderer || seen.has(renderer) || !adapter.on)
        {
            return;
        }

        seen.add(renderer);

        try
        {
            wrapRenderer(adapter, renderer, short(G.Phaser?.VERSION ?? '', 16));
        }
        catch (error)
        {
            fail(adapter, 'finding the renderer', error);
        }
    };

    // The usual build: window.Phaser. Its games boot later, and boot makes the renderer.
    let phaser: any = G.Phaser;

    const patch = (value: any): void =>
    {
        try
        {
            const prototype = value?.Game?.prototype;

            if (prototype)
            {
                watch(adapter, prototype, 'boot', () => null, (game) =>
                {
                    // The WebGL renderer makes its render nodes later, once the textures
                    // are ready. The setter below sees that happen.
                    if (game.renderer?.renderNodes)
                    {
                        found(game.renderer);
                    }
                    else if (game.renderer && !game.renderer.gl)
                    {
                        adapter.report.version = short(value.VERSION ?? '', 16);
                        adapter.report.renderer = 'Canvas';
                        adapter.report.status = 'off';
                        note(adapter, 'This game uses the Canvas renderer, which issues no WebGL or WebGPU draws.');
                    }
                });
            }
        }
        catch (error)
        {
            fail(adapter, 'watching for games', error);
        }
    };

    if (phaser)
    {
        patch(phaser);
    }
    else
    {
        try
        {
            G.Object.defineProperty(G, 'Phaser', {
                configurable: true,
                enumerable: true,
                get: () => phaser,
                set: (value: any) =>
                {
                    phaser = value;
                    patch(value);
                }
            });
        }
        catch
        {
            // The page has made the name its own already.
        }
    }

    // A bundled Phaser sets no global. Its WebGL renderer is the only thing that assigns a
    // property of this name, first thing after `this.game`, so a setter on Object.prototype
    // sees every renderer as it is made and nothing else. The assignment still lands on the
    // object as an ordinary property.
    try
    {
        G.Object.defineProperty(G.Object.prototype, 'cameraRenderNode', {
            configurable: true,
            enumerable: false,
            get: () => undefined,
            set (this: any, value: unknown)
            {
                const plainly = (target: any, held: unknown): void =>
                {
                    G.Object.defineProperty(target, 'cameraRenderNode', { value: held, writable: true, configurable: true, enumerable: true });
                };

                // Anything but a Phaser renderer under construction: an ordinary property.
                if (value !== null || !this || !this.game || !this.game.config || seen.has(this))
                {
                    plainly(this, value);

                    return;
                }

                // The renderer assigns null as it is constructed, and the camera's node
                // once it has booted and its render nodes exist. Until then the property
                // is an accessor on the renderer itself, to see that second assignment.
                const renderer = this;
                let held: unknown = value;

                G.Object.defineProperty(renderer, 'cameraRenderNode', {
                    configurable: true,
                    enumerable: true,
                    get: () => held,
                    set: (next: unknown) =>
                    {
                        held = next;

                        if (next)
                        {
                            plainly(renderer, next);

                            // Its boot is still running.
                            G.queueMicrotask(() => G.queueMicrotask(() =>
                            {
                                if (renderer.renderNodes)
                                {
                                    found(renderer);
                                }
                            }));
                        }
                    }
                });
            }
        });
    }
    catch
    {
        // Only the window.Phaser route is left.
    }
}

register(install);
