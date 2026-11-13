// PlayCanvas.
//
// A PlayCanvas application announces itself to a devtools hook, if one is there when it
// is made: globalThis[Symbol.for('playcanvas.inspector')].register(app, { version, … }).
// The adapter is that hook, and passes each call on to a hook that was there before it.
// A version of the engine from before the hook is still seen: every application assigns
// `defaultLayerWorld` as it sets itself up, and nothing else in a page is likely to, so a
// setter of that name on Object.prototype sees each one. The assignment still lands on
// the application as an ordinary property.
//
// The engine draws a frame as a list of passes (its frame graph), and inside a pass loops
// over mesh instances, setting each one up and then calling the device's draw. There is
// no function that is "draw this mesh instance", so the adapter listens for the last
// thing the loop does for a mesh instance before it draws, and names the draw that
// follows. Wrapped, each on the prototype that owns it:
//
//   AppBase.render                      the frame
//   Renderer.buildFrameGraph            after it, the frame's passes are known
//   FramePass.render, RenderPass.render  a pass: a camera's layers, a shadow map, an effect
//   Renderer.setMeshInstanceMatrices    which mesh instance the next draw is for
//   GraphicsDevice.draw                 the draw, named for that mesh instance
//
// Both devices (WebGL 2 and WebGPU) draw through these.

import { addControl, provideEngineState } from '../protocol';
import { provideWatchable, type Watchable } from '../watch';
import { G } from '../natives';
import { adapter as register } from './index';
import { announce, around, fail, newAdapter, note, ownerOf, short, watch } from './wrap';

const TESTED = '2.24.0';

function className (object: any): string
{
    return short(object?.constructor?.name ?? 'Object', 40);
}

// What a pass draws to, in words: the canvas, a named texture with its size, or nothing
// (a pass that only computes).
function targetOf (pass: any): string
{
    const target = pass.renderTarget;

    if (target === undefined)
    {
        return '';
    }

    if (target === null)
    {
        return ' → canvas';
    }

    const name = short(target.name || 'render target', 60);

    return typeof target.width === 'number' ? ` → ${name} ${target.width}×${target.height}` : ` → ${name}`;
}

function passName (pass: any): string
{
    // A camera's pass over some layers.
    if (G.Array.isArray(pass.layerRenderSteps))
    {
        const layers: string[] = [];

        for (const step of pass.layerRenderSteps)
        {
            const name = short(step?.layer?.name || '', 30);

            if (name && !layers.includes(name) && layers.length < 6)
            {
                layers.push(name);
            }
        }

        const camera = short(pass.cameraComponent?.entity?.name || '', 40);

        return `${layers.length ? layers.join(', ') : 'layers'}${camera ? ` (camera ${camera})` : ''}${targetOf(pass)}`;
    }

    // A light's shadow map.
    if (pass.light && pass.shadowRenderer)
    {
        return `shadow map of ${short(pass.light._node?.name || 'a light', 40)}${targetOf(pass)}`;
    }

    return `${short(pass.name || className(pass), 60)}${targetOf(pass)}`;
}

function meshEntity (instance: any, shadow: boolean): { name: string; entity: Record<string, unknown> }
{
    const node = instance.node;
    const name = short(node?.name || '', 80);
    const material = instance.material;
    const entity: Record<string, unknown> = {
        type: 'MeshInstance',
        name,
        id: instance.id,
        material: material ? { type: className(material), name: short(material.name || '', 60) } : null
    };

    // Where it is in the scene, for two things of one name.
    const path = node?.path;

    if (typeof path === 'string' && path && path !== name)
    {
        entity.path = short(path, 160);
    }

    const instances = instance.instancingData?.count;

    if (typeof instances === 'number' && instances > 0)
    {
        entity.instances = instances;
    }

    if (shadow)
    {
        entity.shadowPass = true;
    }

    return { name: name || `MeshInstance ${instance.id ?? ''}`.trim(), entity };
}

function install (): void
{
    const adapter = newAdapter('PlayCanvas', TESTED);
    const apps: Array<WeakRef<any>> = [];
    const known = new G.WeakSet() as WeakSet<object>;

    let announced = false;
    let controlled = false;
    let version = '';

    // The mesh instance the engine has just set up, whose draw comes next; and whether the
    // pass being drawn is a shadow map.
    let next: any = null;
    let shadow = false;

    const on = (instance: any, method: string): any => (instance ? ownerOf(instance, method) : null);

    // The passes of the frame about to be drawn. Each kind of pass once is enough, since
    // the wrap is on a prototype, and wrapping one that is wrapped already does nothing.
    const passes = (frameGraph: any): void =>
    {
        for (const pass of frameGraph?.passes ?? [])
        {
            around(adapter, on(pass, 'render'), 'render', (self) =>
            {
                // A pass that is switched off draws nothing, and is no group.
                if (self.enabled === false)
                {
                    return null;
                }

                next = null;
                shadow = Boolean(self.light && self.shadowRenderer);

                return { name: passName(self) };
            });
        }
    };

    const discover = (app: any): void =>
    {
        const renderer = app.renderer;

        if (renderer && !known.has(renderer))
        {
            known.add(renderer);

            watch(adapter, on(renderer, 'setMeshInstanceMatrices'), 'setMeshInstanceMatrices', (_self, [instance]) =>
            {
                next = instance;
            });

            watch(adapter, on(renderer, 'buildFrameGraph'), 'buildFrameGraph', () => undefined, (_self, [frameGraph]) =>
            {
                passes(frameGraph);
            });
        }

        const device = app.graphicsDevice;

        if (device && !known.has(device))
        {
            known.add(device);

            around(adapter, on(device, 'draw'), 'draw', (_self, args) =>
            {
                const instance = next;

                // In XR one mesh instance is drawn once for each eye: `last` says which is the last.
                if (args[5] !== false)
                {
                    next = null;
                }

                // A draw with no mesh instance (the quad of an effect or a blur) stays in its pass.
                return instance ? meshEntity(instance, shadow) : null;
            });
        }
    };

    const controls = (app: any): void =>
    {
        if (controlled)
        {
            return;
        }

        controlled = true;

        // The engine has no one switch for shadows: each light casts them or does not. Off
        // stops every light that was casting, and on starts those same lights again.
        if (typeof app.root?.findComponents === 'function')
        {
            const stopped: any[] = [];
            const lights = (): any[] => app.root.findComponents('light') ?? [];

            addControl({
                id: 'playcanvas.shadows',
                label: 'Lights cast shadows (off stops every light that was casting them)',
                type: 'boolean',
                get: () => lights().some((light) => light.castShadows === true),
                set: (value: boolean) =>
                {
                    if (value)
                    {
                        for (const light of stopped.splice(0))
                        {
                            light.castShadows = true;
                        }
                    }
                    else
                    {
                        for (const light of lights())
                        {
                            if (light.castShadows === true)
                            {
                                light.castShadows = false;
                                stopped.push(light);
                            }
                        }
                    }
                }
            });
        }

        if (typeof app.timeScale === 'number')
        {
            addControl({ id: 'playcanvas.timeScale', label: 'Time scale of the application', type: 'number', min: 0, max: 8, get: () => app.timeScale, set: (value: number) => { app.timeScale = value; } });
        }

        if (typeof app.scene?.exposure === 'number')
        {
            addControl({ id: 'playcanvas.exposure', label: 'Scene exposure', type: 'number', min: 0, max: 16, get: () => app.scene.exposure, set: (value: number) => { app.scene.exposure = value; } });
        }

        const device = app.graphicsDevice;

        if (typeof device?.maxPixelRatio === 'number')
        {
            addControl({ id: 'playcanvas.maxPixelRatio', label: 'Most device pixels to a CSS pixel (0.5 renders at half size)', type: 'number', min: 0.25, max: 4, get: () => device.maxPixelRatio, set: (value: number) => { device.maxPixelRatio = value; } });
        }
    };

    const state = (): Record<string, unknown> =>
    {
        const out: Record<string, unknown> = { applications: [] };

        for (const reference of apps)
        {
            const app = reference.deref();

            if (!app || !app.graphicsDevice)
            {
                continue;
            }

            const layers = (app.scene?.layers?.layerList ?? []).slice(0, 64).map((layer: any) => ({
                name: short(layer?.name || '', 40),
                enabled: Boolean(layer?.enabled),
                meshInstances: layer?.meshInstances?.length ?? 0
            }));
            const drawCalls = app.stats?.drawCalls;

            (out.applications as unknown[]).push({
                layers,
                cameras: app.scene?.layers?.cameras?.length ?? 0,
                frame: app.frame,
                timeScale: app.timeScale,
                fps: app.stats?.frame?.fps,
                drawCalls: drawCalls ? { total: drawCalls.total, forward: drawCalls.forward, shadow: drawCalls.shadow, culled: drawCalls.culled, instanced: drawCalls.instanced } : undefined,
                canvas: [app.graphicsDevice.width, app.graphicsDevice.height]
            });
        }

        return out;
    };

    // An application, seen as it is made or as it announces itself.
    const adopt = (app: any): void =>
    {
        if (!app || known.has(app) || !adapter.on)
        {
            return;
        }

        known.add(app);
        apps.push(new G.WeakRef(app));

        if (apps.length > 8)
        {
            apps.shift();
        }

        around(adapter, on(app, 'render'), 'render', (self) =>
        {
            const device = self.graphicsDevice;

            if (!announced && device)
            {
                announced = true;
                adapter.report.version = version || short(G.pc?.version ?? '', 20);
                adapter.report.renderer = device.isWebGPU ? 'WebgpuGraphicsDevice, WebGPU' : `WebglGraphicsDevice, WebGL ${device.isWebGL2 === false ? 1 : 2}`;
                adapter.report.status = 'active';

                if (!adapter.report.version)
                {
                    note(adapter, 'The engine did not say which version it is: versions before the devtools hook do not.');
                }
                else if (adapter.report.version !== TESTED)
                {
                    note(adapter, `This is not the version the adapter was tested with (${TESTED}), so it may be partial.`);
                }

                note(adapter, 'A draw made without a mesh instance (the full-screen quad of a post effect or a blur) is grouped by its pass and not named by object.');
                announce(adapter);
                provideEngineState('PlayCanvas', state);
                provideWatchable('PlayCanvas', () =>
                {
                    const out: Watchable[] = [];

                    apps.forEach((reference) =>
                    {
                        const root = reference.deref()?.root;
                        const walk: Array<[any, string]> = root ? [[root, 'root']] : [];

                        while (walk.length > 0 && out.length < 5000)
                        {
                            const [entity, path] = walk.shift()!;

                            if (entity !== root)
                            {
                                out.push({ path, name: short(entity.name ?? '', 60), type: 'Entity', kind: 'object3d', object: entity });
                            }

                            (entity.children ?? []).forEach((child: any, place: number) => walk.push([child, `${path}/${short(child.name || `Entity#${place}`, 60)}`]));
                        }
                    });

                    return out;
                });
            }

            adopt(self);
            discover(self);
            controls(self);
            next = null;
            shadow = false;

            return { name: 'Application' };
        });

        // What is there already. The renderer is made after the application begins to set
        // itself up, so the first frame looks again.
        discover(app);
    };

    // The devtools hook. One that was there first still hears everything.
    try
    {
        const key = G.Symbol.for('playcanvas.inspector');
        const earlier = G[key];

        G.Object.defineProperty(G, key, {
            configurable: true,
            writable: true,
            enumerable: false,
            value: {
                register (app: unknown, info: any): void
                {
                    try
                    {
                        if (typeof info?.version === 'string')
                        {
                            version = short(info.version, 20);
                        }

                        adopt(app);
                    }
                    catch (error)
                    {
                        fail(adapter, 'a new application', error);
                    }

                    earlier?.register?.(app, info);
                },
                unregister (app: unknown): void
                {
                    earlier?.unregister?.(app);
                }
            }
        });
    }
    catch
    {
        // The page, or another tool, has fixed the name: the setter below still sees the engine.
    }

    try
    {
        G.Object.defineProperty(G.Object.prototype, 'defaultLayerWorld', {
            configurable: true,
            enumerable: false,
            get: () => undefined,
            set (this: any, value: unknown)
            {
                // An ordinary property from here on, as the engine meant it.
                G.Object.defineProperty(this, 'defaultLayerWorld', { value, writable: true, configurable: true, enumerable: true });

                try
                {
                    // An application has a root to draw and a device to draw it with.
                    if (adapter.on && this && typeof this.render === 'function' && this.graphicsDevice && this.root)
                    {
                        adopt(this);
                    }
                }
                catch (error)
                {
                    fail(adapter, 'a new application', error);
                }
            }
        });
    }
    catch
    {
        // The page, or another tool, has claimed the name: only the hook sees the engine.
    }
}

register(install);
