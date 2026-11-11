# scanline-hooks

Tell the [Scanline](../../README.md) debugger what your draw calls mean. Outside Scanline every call does nothing, so it is safe to leave in.

```js
import * as dbg from 'scanline-hooks';

dbg.label(texture, 'atlas_main');                       // name a WebGL or WebGPU object

dbg.group('main', () =>                                 // draws inside fall in a named group
{
    dbg.group(sprite.name, () =>
    {
        dbg.entity(sprite, { type: 'Sprite', name: sprite.name });   // ...that belongs to a game object
        draw(sprite);
    });
});

dbg.state.provide(() => ({ level: game.level, score: game.score }));  // returned with every step

dbg.controls.register({ id: 'shadow.bias', type: 'number', min: 0, max: 0.01,
    get: () => game.bias, set: (value) => { game.bias = value; } });

dbg.views.register({ id: 'bounds', label: 'Sprite bounds', set: (on) => { game.showBounds = on; } });

dbg.mark('level loaded');                               // the debugger can run until a mark
```

It is a thin wrapper round the `__scanline` global that Scanline defines in the page. The global is the contract; this package only saves the `?.` at each call site. `group(name, fn)` always runs `fn`. `active` says whether the page is inside Scanline: use it to skip building a debug string, never to draw differently.

| Call | What it is for |
|---|---|
| `label(object, name)` | Names a WebGL or WebGPU object. For WebGPU it also sets the object's `label` if that is empty. |
| `group(name, fn)`, `push(name)` / `pop()` | A named group round the draws inside. Groups nest and make the pass tree. |
| `entity(reference, info)` | The draws in the current group belong to a game object: `{ type, name, id, path }` and anything small. |
| `mark(name, data?)` | A point on the timeline. |
| `state.provide(fn)`, `state.describe(schema)` | The game's own account of itself, as a small plain object. |
| `controls.register({ id, label, type, min?, max?, options?, get, set })` | A value the debugger may read and set. Types: `number`, `boolean`, `enum`, `color`, `vector`. |
| `views.register({ id, label, description, set(on) })` | A debug view the page draws itself. |
| `uniforms.expose(program, names?)` | Which uniforms are meaningful to override. |
| `passes.describe([{ name, purpose, targets }])` | The frame's passes, in words. |
| `time.deterministic(fn?)` | `{ seed, fixedDt }` in a deterministic session, else `null`. Seed your random source from it. |
| `time.provide({ pause, resume, step, setScale })` | The engine's own time control. |
| `checkpoint.provide({ save, restore })` | Save the game's state and put it back. |
| `frame.begin()` / `frame.end()` | Frame markers, for loops not driven by `requestAnimationFrame`. |

The full guide, with a worked example for raw WebGL 2, raw WebGPU, three.js and PixiJS, is the `scanline-debuggable-rendering` skill in [`skills/`](../../skills/scanline-debuggable-rendering/SKILL.md).

The PolyForm Shield License 1.0.0, as the rest of Scanline: see `LICENSE.md` at the top of the repository. A page or a game that imports this package does not compete with Scanline, so the licence allows it, in a game you sell as much as in any other.
