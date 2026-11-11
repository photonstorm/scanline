// three.js (05-PAGE-PROTOCOL.md, section 2.2).
//
// three.js announces itself, its renderers and its scenes to a `__THREE_DEVTOOLS__` event
// target when one exists, so the probe defines one. From a renderer the adapter wraps:
//
//   WebGLRenderer    render (a pass), renderBufferDirect (one object's draw), and
//                    shadowMap.render. All are properties of the instance.
//   WebGPURenderer   _renderScene on the shared Renderer prototype (a pass), and the
//                    backend's draw (one object's draw). The backend is only settled once
//                    the renderer has initialised, so its draw is wrapped on first use.
//
// The object's own render functions are not wrapped: in the WebGPU renderer whole nested
// passes (shadow maps, scene passes) run from inside them, before the object's draw.

import { addControl, provideEngineState } from '../protocol';
import { G } from '../natives';
import { adapter as register } from './index';
import { announce, around, fail, newAdapter, note, ownerOf, short, type Adapter } from './wrap';

const TESTED = 'r187';

function kindOf (object: any): string
{
    if (object.isInstancedMesh)
    {
        return 'InstancedMesh';
    }

    if (object.isBatchedMesh)
    {
        return 'BatchedMesh';
    }

    if (object.isQuadMesh)
    {
        return 'QuadMesh';
    }

    return short(object.type || 'Object3D', 40);
}

function entityOf (object: any, material: any, geometry: any, extra?: Record<string, unknown>): { name: string; entity: Record<string, unknown> }
{
    const type = kindOf(object);
    const name = short(object.name || '', 80);
    const entity: Record<string, unknown> = {
        type,
        name,
        id: object.id,
        uuid: object.uuid,
        material: material ? { type: short(material.type, 40), name: short(material.name || '', 60) } : null,
        geometry: geometry ? short(geometry.type, 40) : null
    };

    if (object.isInstancedMesh)
    {
        entity.instances = object.count;
    }

    if (extra)
    {
        G.Object.assign(entity, extra);
    }

    return { name: name || `${type} ${object.id}`, entity };
}

function targetName (target: any): string
{
    if (!target)
    {
        return 'canvas';
    }

    const name = target.texture?.name || target.name || '';

    return `${short(name || 'render target', 40)} ${target.width}×${target.height}`;
}

function passName (scene: any, target: any): string
{
    const what = scene?.isQuadMesh ? short(scene.name || 'full-screen quad', 60) : short(scene?.name || scene?.type || 'scene', 60);

    return `${what} → ${targetName(target)}`;
}

function webgl (adapter: Adapter, renderer: any): void
{
    adapter.report.renderer = 'WebGLRenderer';

    const pass = around(adapter, renderer, 'render', (self, [scene]) => ({ name: passName(scene, self.getRenderTarget?.()) }));

    const object = around(adapter, renderer, 'renderBufferDirect', (_self, [, scene, geometry, material, mesh, group]) =>
    {
        if (!mesh)
        {
            return null;
        }

        const extra: Record<string, unknown> = {};

        // A shadow map draws the scene's own objects with a depth material and no scene.
        if (scene === null || material?.isMeshDepthMaterial || material?.isMeshDistanceMaterial)
        {
            extra.shadowPass = true;
        }

        if (group && typeof group.materialIndex === 'number')
        {
            extra.materialIndex = group.materialIndex;
        }

        return entityOf(mesh, material, geometry, extra);
    });

    const shadows = (): void =>
    {
        around(adapter, renderer.shadowMap, 'render', () => ({ name: 'shadow maps' }));
    };

    shadows();

    // A restored context is given a new shadow map object.
    try
    {
        renderer.domElement?.addEventListener('webglcontextrestored', () => G.setTimeout(shadows, 0));
    }
    catch
    {
        // No canvas to listen on.
    }

    adapter.report.status = pass && object ? 'active' : 'partial';

    if (!object)
    {
        note(adapter, 'renderBufferDirect could not be wrapped, so draws are not mapped to objects.');
    }

    controls(renderer, true);
}

function webgpu (adapter: Adapter, renderer: any): void
{
    adapter.report.renderer = 'WebGPURenderer';

    const owner = ownerOf(renderer, '_renderScene');

    const wrapBackend = (self: any): void =>
    {
        const backend = self.backend;

        if (!backend || typeof backend.draw !== 'function')
        {
            return;
        }

        const did = around(adapter, backend, 'draw', (_backend, [renderObject]) =>
        {
            if (!renderObject?.object)
            {
                return null;
            }

            const extra: Record<string, unknown> = {};

            if (renderObject.material?.isShadowPassMaterial)
            {
                extra.shadowPass = true;
            }

            return entityOf(renderObject.object, renderObject.material, renderObject.geometry, extra);
        });

        if (did)
        {
            adapter.report.renderer = backend.isWebGPUBackend ? 'WebGPURenderer, WebGPU' : 'WebGPURenderer on its WebGL 2 fallback';
            adapter.report.status = 'active';
            announce(adapter);
        }
    };

    const pass = owner !== null && around(adapter, owner, '_renderScene', (self, [scene]) =>
    {
        // The backend can be replaced while the renderer initialises, so it is looked at
        // on every pass. Wrapping twice is refused.
        wrapBackend(self);

        return { name: passName(scene, self.getRenderTarget?.()) };
    });

    if (!pass)
    {
        note(adapter, 'The renderer has no _renderScene to wrap, so neither passes nor objects are named.');
    }
    else
    {
        note(adapter, 'Objects drawn from a reused render bundle are replayed by the GPU and are not named one by one.');
    }

    controls(renderer, false);
}

function controls (renderer: any, classic: boolean): void
{
    addControl({ id: 'three.exposure', label: 'Tone mapping exposure', type: 'number', min: 0, max: 16, get: () => renderer.toneMappingExposure, set: (value: number) => { renderer.toneMappingExposure = value; } });
    addControl({ id: 'three.toneMapping', label: 'Tone mapping (0 none, 1 linear, 2 Reinhard, 3 Cineon, 4 ACES, 6 AgX, 7 neutral)', type: 'number', min: 0, max: 7, get: () => renderer.toneMapping, set: (value: number) => { renderer.toneMapping = value; } });
    addControl({ id: 'three.shadows', label: 'Shadow maps enabled', type: 'boolean', get: () => Boolean(renderer.shadowMap?.enabled), set: (value: boolean) => { renderer.shadowMap.enabled = value; } });

    if (classic)
    {
        addControl({ id: 'three.pixelRatio', label: 'Pixel ratio', type: 'number', min: 0.1, max: 4, get: () => renderer.getPixelRatio(), set: (value: number) => renderer.setPixelRatio(value) });
    }
}

function install (): void
{
    const adapter = newAdapter('three.js', TESTED);
    const scenes: Array<WeakRef<any>> = [];
    const renderers: Array<WeakRef<any>> = [];

    let target: EventTarget = G.__THREE_DEVTOOLS__;

    if (!target || typeof target.addEventListener !== 'function')
    {
        target = new G.EventTarget();
        G.Object.defineProperty(G, '__THREE_DEVTOOLS__', { value: target, configurable: true, writable: true, enumerable: false });
    }

    target.addEventListener('register', (event: any) =>
    {
        adapter.report.version = `r${short(event?.detail?.revision, 12)}`;

        if (adapter.report.version !== TESTED)
        {
            note(adapter, `This is not the version the adapter was tested with (${TESTED}), so it may be partial.`);
        }

        announce(adapter);
    });

    target.addEventListener('observe', (event: any) =>
    {
        const seen = event?.detail;

        if (!seen || !adapter.on)
        {
            return;
        }

        try
        {
            if (seen.isScene)
            {
                scenes.push(new G.WeakRef(seen));

                if (scenes.length > 32)
                {
                    scenes.shift();
                }
            }
            else if (seen.isWebGLRenderer)
            {
                renderers.push(new G.WeakRef(seen));
                webgl(adapter, seen);
                announce(adapter);
                provideEngineState('three.js', state);
            }
            else if (seen.isWebGPURenderer)
            {
                renderers.push(new G.WeakRef(seen));
                webgpu(adapter, seen);
                announce(adapter);
                provideEngineState('three.js', state);
            }
        }
        catch (error)
        {
            fail(adapter, 'observe', error);
        }
    });

    // The scene graph in outline, and the engine's own counts.
    const state = (): Record<string, unknown> =>
    {
        const out: Record<string, unknown> = { scenes: [], renderers: [] };

        for (const reference of scenes)
        {
            const scene = reference.deref();

            if (!scene || (scene.children?.length ?? 0) === 0)
            {
                continue;
            }

            const byType: Record<string, number> = {};
            let objects = 0;
            const walk = [scene];

            while (walk.length > 0 && objects < 20000)
            {
                const object = walk.pop();
                const type = kindOf(object);

                objects++;
                byType[type] = (byType[type] ?? 0) + 1;

                for (const child of object.children ?? [])
                {
                    walk.push(child);
                }
            }

            (out.scenes as unknown[]).push({ name: short(scene.name || '', 60), objects, byType });
        }

        for (const reference of renderers)
        {
            const renderer = reference.deref();

            if (renderer?.info)
            {
                (out.renderers as unknown[]).push({
                    kind: renderer.isWebGPURenderer ? 'WebGPURenderer' : 'WebGLRenderer',
                    render: { calls: renderer.info.render?.calls, drawCalls: renderer.info.render?.drawCalls, triangles: renderer.info.render?.triangles, frame: renderer.info.render?.frame ?? renderer.info.frame },
                    memory: { geometries: renderer.info.memory?.geometries, textures: renderer.info.memory?.textures },
                    toneMapping: renderer.toneMapping,
                    shadows: Boolean(renderer.shadowMap?.enabled)
                });
            }
        }

        return out;
    };
}

register(install);
