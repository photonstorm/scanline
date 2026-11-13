// Babylon.js.
//
// Babylon announces itself to nobody. A page that loads the usual build sets
// `window.BABYLON`; a page that bundles it as modules sets nothing. Either way every scene
// assigns `_renderingManager` as it is constructed, and nothing else in a page is likely
// to, so a setter of that name on Object.prototype sees each scene as it is made. The
// assignment still lands on the object as an ordinary property.
//
// From a scene the adapter finds the classes it needs by looking at what the scene holds
// (its meshes, its lights' shadow generators, its render targets), each frame before the
// scene renders, and wraps on their prototypes:
//
//   Scene.render                              the frame's pass
//   RenderTargetTexture.render                a pass to a texture: a shadow map, a mirror
//   Mesh.render                               one mesh's draws, with its material
//   ShadowGenerator._renderSubMeshForShadowMap  one mesh's draw into a shadow map
//   PostProcessManager                        the post-process chain
//   SpriteManager.render, particle systems, layers and effect layers
//
// Both engines (WebGL and WebGPU) draw through these.

import { addControl, provideEngineState } from '../protocol';
import { provideWatchable, type Watchable } from '../watch';
import { G } from '../natives';
import { adapter as register } from './index';
import { announce, around, fail, newAdapter, note, ownerOf, short, type Adapter } from './wrap';

const TESTED = '9.35.0';

function className (object: any): string
{
    try
    {
        return short(typeof object?.getClassName === 'function' ? object.getClassName() : (object?.constructor?.name ?? 'Object'), 40);
    }
    catch
    {
        return 'Object';
    }
}

function meshEntity (mesh: any, subMesh: any, extra?: Record<string, unknown>): { name: string; entity: Record<string, unknown> }
{
    const type = className(mesh);
    const name = short(mesh?.name || '', 80);
    const material = subMesh && typeof subMesh.getMaterial === 'function' ? subMesh.getMaterial() : mesh?.material;
    const entity: Record<string, unknown> = {
        type,
        name,
        id: mesh?.uniqueId,
        material: material ? { type: className(material), name: short(material.name || '', 60) } : null
    };

    const instances = (mesh?.instances?.length ?? 0) + (mesh?.thinInstanceCount ?? 0);

    if (instances > 0)
    {
        entity.instances = instances;
    }

    if (subMesh && (mesh?.subMeshes?.length ?? 0) > 1)
    {
        entity.subMesh = mesh.subMeshes.indexOf(subMesh);
    }

    if (extra)
    {
        G.Object.assign(entity, extra);
    }

    return { name: name || `${type} ${mesh?.uniqueId ?? ''}`.trim(), entity };
}

function sizeOf (target: any): string
{
    try
    {
        const size = target.getSize?.() ?? target.getRenderSize?.();

        if (typeof size === 'number')
        {
            return ` ${size}×${size}`;
        }

        return size && size.width ? ` ${size.width}×${size.height}` : '';
    }
    catch
    {
        return '';
    }
}

// Wraps a method on whichever prototype of an instance's chain owns it. Once per owner.
function wrapOn (adapter: Adapter, instance: any, method: string, describe: Parameters<typeof around>[3]): boolean
{
    const owner = instance ? ownerOf(instance, method) : null;

    return owner ? around(adapter, owner, method, describe) : false;
}

function install (): void
{
    const adapter = newAdapter('Babylon.js', TESTED);
    const scenes: Array<WeakRef<any>> = [];
    const known = new G.WeakSet() as WeakSet<object>;

    let announced = false;
    let controlled = false;

    // What a scene holds that has not been looked at yet: each kind of thing once is
    // enough, since the wrap is on a prototype, but a scene may gain a new kind later.
    const discover = (scene: any): void =>
    {
        const look = (items: any, visit: (item: any) => void): void =>
        {
            for (const item of items ?? [])
            {
                if (item && typeof item === 'object' && !known.has(item))
                {
                    known.add(item);
                    visit(item);
                }
            }
        };

        const target = (texture: any): void =>
        {
            wrapOn(adapter, texture, 'render', (self) => ({ name: `${short(self.name || 'render target', 60)}${sizeOf(self)}` }));
        };

        look(scene.meshes, (mesh) =>
        {
            wrapOn(adapter, mesh, 'render', (self, [subMesh]) => meshEntity(self, subMesh));
        });

        look(scene.lights, (light) =>
        {
            // One generator for each camera the light casts shadows for, or just one.
            const generators = typeof light.getShadowGenerators === 'function' ? light.getShadowGenerators() : null;
            const all: any[] = generators && typeof generators.values === 'function' ? [...generators.values()] : (light.getShadowGenerator?.() ? [light.getShadowGenerator()] : []);

            for (const generator of all)
            {
                wrapOn(adapter, generator, '_renderSubMeshForShadowMap', (_self, [subMesh, , mesh]) =>
                    meshEntity(mesh ?? subMesh?.getRenderingMesh?.() ?? subMesh?.getMesh?.(), subMesh, { shadowPass: true }));

                const map = generator.getShadowMap?.();

                if (map)
                {
                    target(map);
                }
            }

            // A light that gains a shadow generator later is looked at again.
            if (all.length === 0)
            {
                known.delete(light);
            }
        });

        look(scene.customRenderTargets, target);

        look(scene.spriteManagers, (manager) =>
        {
            wrapOn(adapter, manager, 'render', (self) => ({
                name: `sprites ${short(self.name || '', 60)}`.trim(),
                entity: { type: className(self), name: short(self.name || '', 80), sprites: self.sprites?.length ?? 0 }
            }));
        });

        look(scene.particleSystems, (system) =>
        {
            wrapOn(adapter, system, 'render', (self) => ({
                name: `particles ${short(self.name || '', 60)}`.trim(),
                entity: { type: className(self), name: short(self.name || '', 80), capacity: self.getCapacity?.() }
            }));
        });

        look(scene.layers, (layer) =>
        {
            wrapOn(adapter, layer, 'render', (self) => ({ name: `layer ${short(self.name || '', 60)}`.trim(), entity: { type: 'Layer', name: short(self.name || '', 80) } }));
        });

        look(scene.effectLayers, (layer) =>
        {
            wrapOn(adapter, layer, 'render', (self) => ({ name: `effect layer ${short(self.name || '', 60)}`.trim(), entity: { type: className(self), name: short(self.name || '', 80) } }));
        });

        const post = scene.postProcessManager;

        if (post && !known.has(post))
        {
            known.add(post);
            wrapOn(adapter, post, '_finalizeFrame', () => ({ name: 'post-processes' }));
            wrapOn(adapter, post, 'directRender', () => ({ name: 'post-processes' }));
        }
    };

    const controls = (scene: any, engine: any): void =>
    {
        if (controlled)
        {
            return;
        }

        controlled = true;

        const flag = (id: string, label: string, key: string): void =>
        {
            if (typeof scene[key] === 'boolean')
            {
                addControl({ id: `babylon.${id}`, label, type: 'boolean', get: () => Boolean(scene[key]), set: (value: boolean) => { scene[key] = value; } });
            }
        };

        flag('shadows', 'Shadows enabled', 'shadowsEnabled');
        flag('postProcesses', 'Post-processes enabled', 'postProcessesEnabled');
        flag('lights', 'Lights enabled', 'lightsEnabled');
        flag('textures', 'Textures enabled', 'texturesEnabled');
        flag('particles', 'Particles enabled', 'particlesEnabled');
        flag('sprites', 'Sprites enabled', 'spritesEnabled');
        flag('fog', 'Fog enabled', 'fogEnabled');
        flag('wireframe', 'Force wireframe', 'forceWireframe');

        if (typeof engine?.getHardwareScalingLevel === 'function' && typeof engine.setHardwareScalingLevel === 'function')
        {
            addControl({ id: 'babylon.hardwareScaling', label: 'Hardware scaling level (2 renders at half size)', type: 'number', min: 0.25, max: 8, get: () => engine.getHardwareScalingLevel(), set: (value: number) => engine.setHardwareScalingLevel(value) });
        }
    };

    // A scene, seen as it is constructed or at its first frame.
    const adopt = (scene: any): void =>
    {
        if (!scene || known.has(scene) || !adapter.on)
        {
            return;
        }

        known.add(scene);
        scenes.push(new G.WeakRef(scene));

        if (scenes.length > 16)
        {
            scenes.shift();
        }

        wrapOn(adapter, scene, 'render', (self) =>
        {
            const engine = self.getEngine?.();

            if (!announced && engine)
            {
                announced = true;
                adapter.report.version = short(engine.constructor?.Version ?? G.BABYLON?.Engine?.Version ?? '', 20);
                adapter.report.renderer = engine.isWebGPU ? 'WebGPUEngine, WebGPU' : `Engine, WebGL ${engine.webGLVersion ?? ''}`.trim();
                adapter.report.status = 'active';

                if (adapter.report.version !== TESTED)
                {
                    note(adapter, `This is not the version the adapter was tested with (${TESTED}), so it may be partial.`);
                }

                note(adapter, 'Draws made by a depth renderer, a bounding-box or outline renderer, or a GUI texture are grouped by their pass and not named by mesh.');
                announce(adapter);
                provideEngineState('Babylon.js', state);
                provideWatchable('Babylon.js', () =>
                {
                    const out: Watchable[] = [];

                    scenes.forEach((reference, index) =>
                    {
                        const scene = reference.deref();

                        for (const node of [...(scene?.meshes ?? []), ...(scene?.transformNodes ?? []), ...(scene?.lights ?? []), ...(scene?.cameras ?? [])].slice(0, 5000))
                        {
                            out.push({ path: `scene${index}/${short(node.name || className(node), 60)}#${node.uniqueId ?? ''}`, name: short(node.name ?? '', 60), type: className(node), kind: 'object3d', object: node });
                        }
                    });

                    return out;
                });
            }

            adopt(self);
            discover(self);
            controls(self, engine);

            const camera = self.activeCamera ?? self.activeCameras?.[0];

            return { name: `Scene${camera?.name ? ` (camera ${short(camera.name, 40)})` : ''} → canvas` };
        });
    };

    const state = (): Record<string, unknown> =>
    {
        const out: Record<string, unknown> = { scenes: [] };

        for (const reference of scenes)
        {
            const scene = reference.deref();

            if (!scene || scene.isDisposed)
            {
                continue;
            }

            const engine = scene.getEngine?.();
            const byType: Record<string, number> = {};

            for (const mesh of (scene.meshes ?? []).slice(0, 20000))
            {
                const type = className(mesh);

                byType[type] = (byType[type] ?? 0) + 1;
            }

            (out.scenes as unknown[]).push({
                meshes: scene.meshes?.length ?? 0,
                activeMeshes: scene.getActiveMeshes?.().length,
                byType,
                materials: scene.materials?.length ?? 0,
                textures: scene.textures?.length ?? 0,
                lights: scene.lights?.length ?? 0,
                cameras: scene.cameras?.length ?? 0,
                particleSystems: scene.particleSystems?.length ?? 0,
                activeCamera: short(scene.activeCamera?.name ?? '', 60),
                frame: scene.getFrameId?.(),
                fps: typeof engine?.getFps === 'function' ? G.Math.round(engine.getFps()) : undefined,
                hardwareScaling: engine?.getHardwareScalingLevel?.()
            });
        }

        return out;
    };

    try
    {
        G.Object.defineProperty(G.Object.prototype, '_renderingManager', {
            configurable: true,
            enumerable: false,
            get: () => undefined,
            set (this: any, value: unknown)
            {
                // An ordinary property from here on, as the engine meant it.
                G.Object.defineProperty(this, '_renderingManager', { value, writable: true, configurable: true, enumerable: true });

                try
                {
                    // A scene has an engine and can render; a render target has a manager too, and is not one.
                    if (adapter.on && this && typeof this.getEngine === 'function' && typeof this.render === 'function' && typeof this.getActiveMeshes === 'function')
                    {
                        adopt(this);
                    }
                }
                catch (error)
                {
                    fail(adapter, 'a new scene', error);
                }
            }
        });
    }
    catch
    {
        // The page, or another tool, has claimed the name: Babylon goes unrecognised.
    }
}

register(install);
