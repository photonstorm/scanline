---
name: scanline-debuggable-rendering
description: Write WebGL or WebGPU rendering code so that it can be debugged with Scanline by name. Use when writing a renderer, a game or an engine feature that you (or a later agent) will debug: it covers labelling GPU objects, grouping draws, declaring game objects, exposing state, and registering debug views and tunable controls through the page protocol. Applies to raw WebGL 2, raw WebGPU, three.js and PixiJS.
---

# Rendering code that can be debugged by name

Scanline debugs any page. A page that describes itself is debugged faster: the draw list reads `main / opaque / Floor` and not `draw 14 (indexed, 3,612 triangles, prg_7)`, the game's state comes back with every step, and a shadow bias is a named control and not a uniform you have to find.

The page describes itself through one global, `__scanline`, which exists only inside Scanline. Use it only if it is there, so the same code runs unchanged in any browser:

```js
const dbg = globalThis.__scanline;   // undefined outside Scanline
dbg?.label(texture, 'atlas_main');
```

Or import `scanline-hooks`, which does nothing outside Scanline and needs no `?.`:

```js
import * as dbg from 'scanline-hooks';
dbg.label(texture, 'atlas_main');
```

With three.js, PixiJS or Phaser 4 you get most of this with no code at all: Scanline recognises the engine and names draws by the engine's own objects. Then the only work is to name your objects (`mesh.name`, `sprite.label`, `gameObject.setName`), and to add state, views and controls.

## The ten rules

1. **Label everything at creation.** Every texture, buffer, shader, program, pipeline, bind group and pass. In WebGPU set `label` in the descriptor. In WebGL, which has no labels of its own, call `dbg.label(object, name)`. Use the names a person would use: `player_atlas`, `shadow_depth`, `sprite.fragment`.
2. **Group the frame.** `dbg.group(name, fn)` around each pass, and inside it around each logical object or batch. Groups nest and become the pass tree. In WebGPU, `pushDebugGroup` and pass labels are read as well.
3. **Declare entities.** Where a draw belongs to a game object, say so inside its group: `dbg.entity(object, { type, name, id, path })`, plus anything small and useful (material, layer).
4. **Expose state.** `dbg.state.provide(() => ({ scene, level, player: { x, y }, enemies: n }))`. Keep it under about 1 KB. It is returned with every step, so it is what the agent steers by.
5. **Register a view** for every intermediate result worth seeing: `dbg.views.register({ id, label, description, set(on) })`. Shadow maps, depth, normals, collision shapes, each post stage. The page draws the view itself when `set(true)` is called.
6. **Register controls** for the numbers you are likely to tune: `dbg.controls.register({ id, label, type, min, max, get, set })`. Biases, exposure, sample counts, thresholds. Types are `number`, `boolean`, `enum` (with `options`), `color` and `vector`. Give ranges: a value outside them is refused.
7. **Keep time in one place.** Take the frame time from the `requestAnimationFrame` argument, step the simulation by a fixed amount, and take randomness from one seeded source. `dbg.time.deterministic()` returns `{ seed, fixedDt }` in a deterministic session and `null` otherwise: seed from it. Then a recorded run replays exactly.
8. **Make loading observable.** `dbg.mark('assets loaded')`, `dbg.mark('first frame')`, `dbg.mark('level 2')`. The agent can run until a mark.
9. **Do not branch on the debugger.** The page must render identically with and without it. The calls only describe. Never test `dbg.active` to decide what to draw.
10. **Say what the passes are for.** `dbg.passes.describe([{ name, purpose, targets }])`, once.

Optional: `dbg.checkpoint.provide({ save, restore })` lets the agent save the game's state and put it back, and `dbg.uniforms.expose(program, { bias: { min: 0, max: 0.01 } })` says which uniforms are meaningful to override.

Everything a page passes is treated as untrusted text: it is cut to length and shown between « ». Calls a newer protocol adds are ignored by an older Scanline, so there is nothing to version-check.

## What the agent then does

```
page()                                         everything the page offers
step(frames: 30)                               ...ends with the page's state
live_view(view: "shadow-cascades")             the page draws its own debug view
page(call: "set_control", id: "shadow.bias", value: -0.0005)
run_until(until: {mark: "level 2"})
capture()  then  pass_tree(capture)            the frame as the groups you named
draw_list(capture, filter: "path LIKE 'main / opaque%'")
```

## Raw WebGL 2

```js
import * as dbg from 'scanline-hooks';

const gl = canvas.getContext('webgl2');
const program = link(VERTEX, FRAGMENT);
dbg.label(program, 'sprite');                          // rule 1
const atlas = loadTexture('atlas.png');
dbg.label(atlas, 'atlas_main');

const game = { level: 1, bias: 0.002, showBounds: false, sprites: [] };
const random = seeded(dbg.time.deterministic()?.seed ?? 1);   // rule 7

dbg.state.provide(() => ({ level: game.level, sprites: game.sprites.length }));   // rule 4
dbg.controls.register({ id: 'shadow.bias', type: 'number', min: 0, max: 0.01,     // rule 6
    get: () => game.bias, set: (value) => { game.bias = value; } });
dbg.views.register({ id: 'bounds', label: 'Sprite bounds',                        // rule 5
    set: (on) => { game.showBounds = on; } });
dbg.passes.describe([{ name: 'shadow', purpose: 'Depth from the light', targets: 'shadow_depth' },
    { name: 'main', purpose: 'The scene, lit', targets: 'canvas' }]);              // rule 10

function frame (time)                                   // rule 7: time comes from here
{
    update(time);

    dbg.group('shadow', () => drawDepth(game.sprites));               // rule 2
    dbg.group('main', () =>
    {
        for (const sprite of game.sprites)
        {
            dbg.group(sprite.name, () =>
            {
                dbg.entity(sprite, { type: 'Sprite', name: sprite.name, id: sprite.id });   // rule 3
                drawSprite(sprite);
            });
        }
    });

    if (game.showBounds) { dbg.group('debug', () => drawBounds(game.sprites)); }

    requestAnimationFrame(frame);
}

dbg.mark('assets loaded');                              // rule 8
requestAnimationFrame(frame);
```

## Raw WebGPU

WebGPU has labels and debug groups of its own, and Scanline reads them. The protocol adds what WebGPU has no place for: entities, state, views and controls.

```js
import * as dbg from 'scanline-hooks';

const pipeline = device.createRenderPipeline({ label: 'sprite', layout, vertex, fragment, primitive });
const atlas = device.createTexture({ label: 'atlas_main', size, format, usage });
const uniforms = device.createBuffer({ label: 'frame uniforms', size: 64, usage });
const group = device.createBindGroup({ label: 'frame', layout: pipeline.getBindGroupLayout(0), entries });

const game = { exposure: 1, showNormals: false, sprites: [] };

dbg.state.provide(() => ({ sprites: game.sprites.length, exposure: game.exposure }));
dbg.controls.register({ id: 'exposure', type: 'number', min: 0, max: 8,
    get: () => game.exposure, set: (value) => { game.exposure = value; } });
dbg.views.register({ id: 'normals', label: 'World normals', set: (on) => { game.showNormals = on; } });

function frame (time)
{
    update(time);

    const encoder = device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass({ label: 'main', colorAttachments, depthStencilAttachment });

    pass.setPipeline(game.showNormals ? normalsPipeline : pipeline);
    pass.setBindGroup(0, group);

    for (const sprite of game.sprites)
    {
        dbg.group(sprite.name, () =>                                    // rule 2
        {
            dbg.entity(sprite, { type: 'Sprite', name: sprite.name });  // rule 3
            pass.setVertexBuffer(0, sprite.vertices);
            pass.draw(sprite.count);
        });
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
}

dbg.mark('assets loaded');
requestAnimationFrame(frame);
```

The pass's label (`main`) is the outer group here, and `pass.pushDebugGroup(name)` would make a group too. Use `dbg.group` where a draw belongs to a game object: `dbg.entity` attaches to the innermost `dbg.group`, not to a WebGPU debug group.

## three.js

Scanline's adapter names every draw by its `Object3D`: type, `name`, material and geometry, with the shadow pass and each render target as groups. So name things, and add what the adapter cannot know.

```js
import * as THREE from 'three';
import * as dbg from 'scanline-hooks';

const scene = new THREE.Scene();
scene.name = 'Level';                                   // the pass is "Level → canvas"

const floor = new THREE.Mesh(floorGeometry, floorMaterial);
floor.name = 'Floor';                                   // rule 1: names, on objects and materials
floorMaterial.name = 'Stone';
scene.add(floor);

const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.name = 'Sun';                                       // its shadow pass is "Shadow Map [ Sun ]"
sun.castShadow = true;
scene.add(sun);

const helper = new THREE.CameraHelper(sun.shadow.camera);
helper.visible = false;
scene.add(helper);

dbg.state.provide(() => ({ objects: scene.children.length, camera: camera.position.toArray() }));
dbg.controls.register({ id: 'sun.shadow.bias', type: 'number', min: -0.01, max: 0.01,
    get: () => sun.shadow.bias, set: (value) => { sun.shadow.bias = value; } });
dbg.views.register({ id: 'shadow-frustum', label: 'The sun\'s shadow camera',
    set: (on) => { helper.visible = on; } });

renderer.setAnimationLoop((time) =>                     // rule 7
{
    update(time);
    renderer.render(scene, camera);
});

dbg.mark('scene built');
```

The adapter also registers `three.exposure`, `three.toneMapping`, `three.shadows` and (WebGL) `three.pixelRatio` as controls.

## PixiJS

Scanline's adapter says, for every batch, which display objects went into it and why the batch ended ("the blend mode changed", "a filter came next", "the texture limit was reached"). That needs labels to be useful.

```js
import { Application, Container, Sprite } from 'pixi.js';
import * as dbg from 'scanline-hooks';

const app = new Application();
await app.init({ width: 800, height: 600 });

app.stage.label = 'Stage';

const world = new Container();
world.label = 'World';                                  // rule 1: label containers and sprites
app.stage.addChild(world);

const player = new Sprite(playerTexture);
player.label = 'Player';
playerTexture.source.label = 'player_atlas';            // a batch lists its textures by label
world.addChild(player);

const hitboxes = new Container();
hitboxes.label = 'Hitboxes';
hitboxes.visible = false;
app.stage.addChild(hitboxes);

const game = { speed: 3, score: 0 };

dbg.state.provide(() => ({ score: game.score, player: { x: player.x, y: player.y } }));
dbg.controls.register({ id: 'player.speed', type: 'number', min: 0, max: 20,
    get: () => game.speed, set: (value) => { game.speed = value; } });
dbg.views.register({ id: 'hitboxes', label: 'Collision boxes', set: (on) => { hitboxes.visible = on; } });

app.ticker.add((ticker) => update(ticker.deltaMS));     // rule 7: one clock

dbg.mark('assets loaded');
```

## Checking your work

Launch the page in Scanline and call `page()`. It lists what the page offers and, under "Last frame's draws by named group", how many draws fell outside every group. Aim for none. Then `capture()` and `pass_tree(capture)`: the tree should read like a description of the frame.
